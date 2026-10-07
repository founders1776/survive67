import { AbiCoder, Interface, Wallet, getAddress, isAddress, parseUnits, verifyMessage, type TypedDataField } from "ethers";
import { CHAINS, KYBER_ROUTER, NATIVE, SANCTIONS_ORACLE, lc, sameAddr, type ChainCfg, type ChainKey } from "./chains.js";
import { decodeTopLevel, decodeTrace, judgeApprovals, lookalikeOf, permitsInTypedData, topLevelRecipients, type Preview, type TraceFrame, type TypedData } from "./decode.js";

/**
 * Crypto rails (plan-crypto.md, ship 1): one control-plane-held key per agent
 * signs on Base and Robinhood Chain. Agents get near-total freedom; the world
 * refuses exactly four things at signing (approvals or permits above the wallet
 * balance, permits longer than 24h, sanctioned counterparties, raw-hash signing)
 * and previews everything else first. Keys never leave this process.
 *
 * Transport is plain JSON-RPC over fetch (Alchemy), so tests point it at a fake
 * or at an anvil fork without touching anything else.
 */

export interface AgentKey {
  agentId: string;
  address: string;
  /** env var holding the private key, read only when signing */
  keyEnv: string;
}

export function agentKeysFromEnv(env: NodeJS.ProcessEnv = process.env): AgentKey[] {
  const out: AgentKey[] = [];
  for (const id of ["claude", "gpt", "gemini"]) {
    const addr = env[`C67_USDC_ADDR_${id.toUpperCase()}`];
    if (addr) out.push({ agentId: id, address: getAddress(addr), keyEnv: `C67_USDC_KEY_${id.toUpperCase()}` });
  }
  // The exchange desk (2026-10-01): the operator's experiment wallet, signing
  // fills without a human. Same signer and nonce queue as the agents.
  if (env.C67_OPERATOR_ADDR && env.C67_OPERATOR_KEY) {
    out.push({ agentId: DESK, address: getAddress(env.C67_OPERATOR_ADDR), keyEnv: "C67_OPERATOR_KEY" });
  }
  return out;
}

/** The pseudo-agent id the exchange desk signs as. Never an agent. */
export const DESK = "desk";

export interface ChainDeps {
  fetchImpl?: typeof fetch;
  /** JSON-RPC endpoint per chain; default Alchemy with C67_ALCHEMY_KEY */
  rpcUrl?: (c: ChainCfg) => string;
  kyberBase?: string;
  now?: () => number;
  /** ms to wait for a receipt before returning "pending" */
  receiptTimeoutMs?: number;
}

export class ChainError extends Error {}

const ERC20 = new Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
]);

export interface TxRequest {
  to?: string | null;
  data?: string;
  value?: bigint;
}

export interface Evaluation {
  preview: Preview | null;
  simulated: boolean;
  refusals: string[];
  flags: string[];
}

export interface SendResult {
  txHash: string;
  status: "confirmed" | "failed" | "pending";
  explorer: string;
}

export class ChainRail {
  private fetchImpl: typeof fetch;
  private rpcUrl: (c: ChainCfg) => string;
  private kyberBase: string;
  private now: () => number;
  private receiptTimeoutMs: number;
  /** per wallet+chain send queue: a bot and a session must never race a nonce */
  private queues = new Map<string, Promise<unknown>>();
  /**
   * Last nonce this process used per wallet+chain. Alchemy load-balances reads,
   * and a node one block behind answers a stale "pending" count: two fast sends
   * would then reuse a nonce (seen live 2026-10-01: a balance read right after a
   * confirmed swap returned the pre-swap value).
   */
  private lastNonce = new Map<string, number>();
  private rpcId = 0;
  /** Wallets the world knows beyond the agents' own: the operator desk, registered wallets. */
  private extraKnown: () => string[] = () => [];

  constructor(private keys: AgentKey[], deps: ChainDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    const alchemyKey = process.env.C67_ALCHEMY_KEY ?? "";
    this.rpcUrl = deps.rpcUrl ?? ((c) => (alchemyKey ? `https://${c.alchemy}.g.alchemy.com/v2/${alchemyKey}` : ""));
    this.kyberBase = deps.kyberBase ?? "https://aggregator-api.kyberswap.com";
    this.now = deps.now ?? (() => Date.now());
    this.receiptTimeoutMs = deps.receiptTimeoutMs ?? 30_000;
  }

  setKnownAddresses(fn: () => string[]): void {
    this.extraKnown = fn;
  }

  /** Refusal lines for any touched address that imitates a wallet the world knows. */
  poisoned(addresses: string[]): string[] {
    const known = [...this.keys.map((k) => k.address), ...this.extraKnown().filter(Boolean)];
    const out: string[] = [];
    for (const a of new Set(addresses.filter((x) => isAddress(x)).map(lc))) {
      const real = lookalikeOf(a, known);
      if (real) {
        out.push(
          `look-alike address: ${a} imitates ${real} (same start and end, different middle). This is address poisoning: a scammer planted it in wallet histories. Never copy addresses from history; use crypto_address, the board, or the desk tools.`
        );
      }
    }
    return out;
  }

  get configured(): boolean {
    return this.keys.length > 0 && !!this.rpcUrl(CHAINS.base);
  }

  addressOf(agentId: string): string | null {
    return this.keys.find((k) => k.agentId === agentId)?.address ?? null;
  }

  agentOf(address: string): string | null {
    return this.keys.find((k) => sameAddr(k.address, address))?.agentId ?? null;
  }

  allAddresses(): { agentId: string; address: string }[] {
    return this.keys.filter((k) => k.agentId !== DESK).map((k) => ({ agentId: k.agentId, address: k.address }));
  }

  // ---------------------------------------------------------------- transport

  async rpc<T = unknown>(c: ChainCfg, method: string, params: unknown[]): Promise<T> {
    const url = this.rpcUrl(c);
    if (!url) throw new ChainError("crypto rail not configured (no RPC)");
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.rpcId, method, params }),
    });
    const j = (await res.json()) as { result?: T; error?: { code: number; message: string } };
    if (j.error) throw new ChainError(`${method}: ${j.error.message}`);
    return j.result as T;
  }

  private async call(c: ChainCfg, to: string, data: string): Promise<string> {
    return this.rpc<string>(c, "eth_call", [{ to, data }, "latest"]);
  }

  async balanceOf(c: ChainCfg, token: string, owner: string): Promise<bigint> {
    if (sameAddr(token, NATIVE)) return BigInt(await this.rpc<string>(c, "eth_getBalance", [owner, "latest"]));
    const out = await this.call(c, token, ERC20.encodeFunctionData("balanceOf", [owner]));
    return out && out !== "0x" ? BigInt(out) : 0n;
  }

  private decimalsCache = new Map<string, number>();
  async decimals(c: ChainCfg, token: string): Promise<number> {
    if (sameAddr(token, NATIVE)) return 18;
    const k = `${c.key}:${lc(token)}`;
    const hit = this.decimalsCache.get(k);
    if (hit !== undefined) return hit;
    const out = await this.call(c, token, ERC20.encodeFunctionData("decimals"));
    const d = Number(BigInt(out));
    this.decimalsCache.set(k, d);
    return d;
  }

  // ---------------------------------------------------------------- screening

  /** Addresses on the US sanctions list, via the Chainalysis oracle on Base (plan Q10). Fails closed. */
  async sanctioned(addresses: string[]): Promise<string[]> {
    const uniq = [...new Set(addresses.filter((a) => isAddress(a)).map(lc))].slice(0, 60);
    const hits = await Promise.all(
      uniq.map(async (a) => {
        const out = await this.call(CHAINS.base, SANCTIONS_ORACLE, "0xdf592f7d" + a.slice(2).padStart(64, "0"));
        return BigInt(out) === 1n ? a : null;
      })
    );
    return hits.filter((h): h is string => h !== null);
  }

  // ---------------------------------------------------------------- simulate + judge

  async simulate(c: ChainCfg, from: string, tx: TxRequest): Promise<Preview | null> {
    try {
      const trace = await this.rpc<TraceFrame>(c, "debug_traceCall", [
        { from, to: tx.to ?? undefined, data: tx.data ?? "0x", value: "0x" + (tx.value ?? 0n).toString(16) },
        "latest",
        { tracer: "callTracer", tracerConfig: { withLog: true } },
      ]);
      return decodeTrace(trace, from);
    } catch {
      return null; // simulator unavailable: the caller flags it (plan Q5)
    }
  }

  /** Preview and the four refusals for one transaction from one agent's wallet. */
  async evaluate(c: ChainCfg, from: string, tx: TxRequest): Promise<Evaluation> {
    const preview = await this.simulate(c, from, tx);
    const approvals = preview ? preview.approvals : tx.to ? decodeTopLevel(tx.to, tx.data ?? "0x") : [];
    const balances = new Map<string, bigint>();
    for (const a of approvals) {
      if (a.kind === "all" || balances.has(a.token)) continue;
      balances.set(a.token, isAddress(a.token) ? await this.balanceOf(c, a.token, from).catch(() => 0n) : 0n);
    }
    const { refusals, flags } = judgeApprovals(approvals, (t) => balances.get(lc(t)) ?? 0n, Math.floor(this.now() / 1000));
    const touched = [...(preview?.touched ?? []), ...(tx.to ? [tx.to] : []), ...approvals.map((a) => a.spender), ...topLevelRecipients(tx.data ?? "0x")];
    refusals.push(...this.poisoned(touched));
    const bad = await this.sanctioned(touched);
    for (const b of bad) refusals.push(`sanctioned counterparty: ${b} is on the US sanctions list (OFAC). The world will not sign anything that touches it.`);
    if (!preview) flags.push("no preview: the simulator did not answer, so only the top level of this transaction was checked");
    else if (preview.reverted) flags.push(`this transaction would revert: ${preview.error ?? "unknown reason"}. Sending it still costs gas.`);
    return { preview, simulated: !!preview, refusals, flags };
  }

  // ---------------------------------------------------------------- signing

  private wallet(agentId: string): Wallet {
    const k = this.keys.find((x) => x.agentId === agentId);
    if (!k) throw new ChainError("no wallet for agent");
    const key = process.env[k.keyEnv];
    if (!key) throw new ChainError("wallet key not loaded");
    return new Wallet(key);
  }

  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.queues.set(key, next.catch(() => undefined));
    return next;
  }

  /** Sign and broadcast. The caller has already evaluated and the agent has confirmed. */
  async send(c: ChainCfg, agentId: string, tx: TxRequest, wait = true): Promise<SendResult> {
    const w = this.wallet(agentId);
    return this.serial(`${agentId}:${c.key}`, async () => {
      const from = w.address;
      const base = { from, to: tx.to ?? undefined, data: tx.data ?? "0x", value: "0x" + (tx.value ?? 0n).toString(16) };
      const [nonceHex, gasHex, block, tipHex] = await Promise.all([
        this.rpc<string>(c, "eth_getTransactionCount", [from, "pending"]),
        this.rpc<string>(c, "eth_estimateGas", [base]),
        this.rpc<{ baseFeePerGas?: string }>(c, "eth_getBlockByNumber", ["latest", false]),
        this.rpc<string>(c, "eth_maxPriorityFeePerGas", []).catch(() => "0x0"),
      ]);
      const baseFee = BigInt(block.baseFeePerGas ?? "0x0");
      const tip = BigInt(tipHex);
      const qk = `${agentId}:${c.key}`;
      const nonce = Math.max(Number(BigInt(nonceHex)), (this.lastNonce.get(qk) ?? -1) + 1);
      const raw = await w.signTransaction({
        type: 2,
        chainId: c.chainId,
        nonce,
        to: tx.to ?? null,
        data: tx.data ?? "0x",
        value: tx.value ?? 0n,
        gasLimit: (BigInt(gasHex) * 12n) / 10n,
        maxPriorityFeePerGas: tip,
        maxFeePerGas: baseFee * 2n + tip,
      });
      const txHash = await this.rpc<string>(c, "eth_sendRawTransaction", [raw]);
      this.lastNonce.set(qk, nonce);
      const explorer = `${c.explorer}/tx/${txHash}`;
      if (!wait) return { txHash, status: "pending" as const, explorer };
      return { txHash, status: await this.waitReceipt(c, txHash), explorer };
    });
  }

  async waitReceipt(c: ChainCfg, txHash: string): Promise<"confirmed" | "failed" | "pending"> {
    const until = this.now() + this.receiptTimeoutMs;
    for (;;) {
      const r = await this.rpc<{ status?: string; blockNumber?: string } | null>(c, "eth_getTransactionReceipt", [txHash]);
      if (r) {
        // Give lagging read nodes a moment to reach the receipt's block, so the
        // next balance read (a swap back, a balance check) sees the new state.
        const want = r.blockNumber ? Number(BigInt(r.blockNumber)) : 0;
        for (let i = 0; i < 5 && want; i++) {
          if ((await this.blockNumber(c).catch(() => want)) >= want) break;
          await new Promise((res) => setTimeout(res, 800));
        }
        return BigInt(r.status ?? "0x0") === 1n ? "confirmed" : "failed";
      }
      if (this.now() >= until) return "pending";
      await new Promise((res) => setTimeout(res, 1000));
    }
  }

  /** personal_sign or EIP-712. Raw-hash eth_sign is never offered: it can sign a transaction (plan R12). */
  async signMessage(
    c: ChainCfg,
    agentId: string,
    kind: string,
    payload: unknown
  ): Promise<{ signature?: string; refusals: string[]; flags: string[] }> {
    const w = this.wallet(agentId);
    if (kind === "personal") return { signature: await w.signMessage(String(payload ?? "")), refusals: [], flags: [] };
    if (kind !== "typed") {
      return { refusals: [`kind "${kind}" is not signed. Use "personal" (a text message) or "typed" (EIP-712). Raw-hash signing is refused because it can sign a transaction.`], flags: [] };
    }
    const td = (typeof payload === "string" ? JSON.parse(payload) : payload) as TypedData;
    if (!td || typeof td !== "object" || !td.types || !td.primaryType || !td.message) {
      return { refusals: ["typed data needs domain, types, primaryType and message"], flags: [] };
    }
    const permits = permitsInTypedData(td);
    const balances = new Map<string, bigint>();
    for (const p of permits) {
      if (!balances.has(p.token)) balances.set(p.token, isAddress(p.token) ? await this.balanceOf(c, p.token, w.address).catch(() => 0n) : 0n);
    }
    const { refusals, flags } = judgeApprovals(permits, (t) => balances.get(lc(t)) ?? 0n, Math.floor(this.now() / 1000));
    refusals.push(...this.poisoned(permits.map((p) => p.spender)));
    const bad = await this.sanctioned([...permits.map((p) => p.spender), String(td.domain?.verifyingContract ?? "")]);
    for (const b of bad) refusals.push(`sanctioned counterparty: ${b} is on the US sanctions list (OFAC).`);
    if (refusals.length) return { refusals, flags };
    const types: Record<string, TypedDataField[]> = { ...td.types };
    delete types.EIP712Domain;
    return { signature: await w.signTypedData(td.domain as never, types, td.message), refusals, flags };
  }

  // ---------------------------------------------------------------- swaps and value

  private kyberHeaders = { "x-client-id": "survive67", "content-type": "application/json" };

  /** What `amount` of `token` would sell for in the chain's stable coin right now (6 dp). 0n if unsellable. */
  async sellQuote(c: ChainCfg, token: string, amount: bigint): Promise<bigint> {
    if (amount <= 0n) return 0n;
    if (sameAddr(token, c.stable.address)) return amount;
    try {
      const u = `${this.kyberBase}/${c.kyber}/api/v1/routes?tokenIn=${token}&tokenOut=${c.stable.address}&amountIn=${amount}`;
      const j = (await (await this.fetchImpl(u, { headers: this.kyberHeaders })).json()) as {
        code?: number;
        data?: { routeSummary?: { amountOut?: string } };
      };
      return j.code === 0 && j.data?.routeSummary?.amountOut ? BigInt(j.data.routeSummary.amountOut) : 0n;
    } catch {
      return 0n;
    }
  }

  /** Kyber route + build for the swap helper. */
  async kyberSwap(
    c: ChainCfg,
    from: string,
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
    slippageBps: number
  ): Promise<{ to: string; data: string; value: bigint; amountOut: bigint; minOut: bigint }> {
    const H = this.kyberHeaders;
    const q = (await (
      await this.fetchImpl(`${this.kyberBase}/${c.kyber}/api/v1/routes?tokenIn=${tokenIn}&tokenOut=${tokenOut}&amountIn=${amountIn}`, { headers: H })
    ).json()) as { code?: number; message?: string; data?: { routeSummary?: Record<string, unknown> } };
    if (q.code !== 0 || !q.data?.routeSummary) throw new ChainError(`no route: ${q.message ?? "aggregator found none"}`);
    const b = (await (
      await this.fetchImpl(`${this.kyberBase}/${c.kyber}/api/v1/route/build`, {
        method: "POST",
        headers: H,
        body: JSON.stringify({ routeSummary: q.data.routeSummary, sender: from, recipient: from, slippageTolerance: slippageBps }),
      })
    ).json()) as { code?: number; message?: string; data?: { routerAddress: string; data: string; amountIn: string; amountOut: string } };
    if (b.code !== 0 || !b.data) throw new ChainError(`route build failed: ${b.message ?? "unknown"}`);
    const amountOut = BigInt(b.data.amountOut);
    return {
      to: b.data.routerAddress,
      data: b.data.data,
      value: sameAddr(tokenIn, NATIVE) ? BigInt(b.data.amountIn) : 0n,
      amountOut,
      minOut: (amountOut * BigInt(10_000 - slippageBps)) / 10_000n,
    };
  }

  isRouter(c: ChainCfg, to: string): boolean {
    return c.routers.some((r) => sameAddr(r, to)) || sameAddr(to, KYBER_ROUTER);
  }

  async allowance(c: ChainCfg, token: string, owner: string, spender: string): Promise<bigint> {
    const out = await this.call(c, token, ERC20.encodeFunctionData("allowance", [owner, spender]));
    return out && out !== "0x" ? BigInt(out) : 0n;
  }

  approveData(spender: string, amount: bigint): string {
    return ERC20.encodeFunctionData("approve", [spender, amount]);
  }

  transferData(to: string, amount: bigint): string {
    return ERC20.encodeFunctionData("transfer", [to, amount]);
  }

  async parseAmount(c: ChainCfg, token: string, human: unknown): Promise<bigint> {
    const s = String(human ?? "").trim();
    if (!/^\d+(\.\d+)?$/.test(s)) throw new ChainError(`bad amount: ${s} (a plain decimal like "12.5")`);
    return parseUnits(s, await this.decimals(c, token));
  }

  /** Non-zero holdings of one address: native plus every ERC-20 Alchemy knows it holds. */
  async holdings(c: ChainCfg, address: string): Promise<{ token: string; amount: bigint }[]> {
    const out: { token: string; amount: bigint }[] = [];
    const native = await this.balanceOf(c, NATIVE, address);
    if (native > 0n) out.push({ token: lc(NATIVE), amount: native });
    const r = await this.rpc<{ tokenBalances: { contractAddress: string; tokenBalance: string | null }[] }>(c, "alchemy_getTokenBalances", [address]);
    for (const t of r.tokenBalances ?? []) {
      const amt = t.tokenBalance ? BigInt(t.tokenBalance) : 0n;
      if (amt > 0n) out.push({ token: lc(t.contractAddress), amount: amt });
    }
    return out;
  }

  /** Every external/ERC-20 transfer touching `address` from `fromBlock` (inclusive). */
  async transfers(
    c: ChainCfg,
    address: string,
    fromBlock: number
  ): Promise<{ hash: string; from: string; to: string; token: string; amount: bigint; block: number }[]> {
    const out: { hash: string; from: string; to: string; token: string; amount: bigint; block: number }[] = [];
    for (const dir of ["toAddress", "fromAddress"] as const) {
      let pageKey: string | undefined;
      do {
        const r = await this.rpc<{
          transfers: { hash: string; from: string; to: string | null; rawContract: { address: string | null; value: string | null }; blockNum: string; category: string }[];
          pageKey?: string;
        }>(c, "alchemy_getAssetTransfers", [
          {
            [dir]: address,
            fromBlock: "0x" + fromBlock.toString(16),
            toBlock: "latest",
            // Robinhood Chain rejects "internal" (probed 2026-10-01); Base and Ethereum accept it.
            category: c.key === "robinhood" ? ["external", "erc20"] : ["external", "internal", "erc20"],
            withMetadata: false,
            excludeZeroValue: true,
            ...(pageKey ? { pageKey } : {}),
          },
        ]);
        for (const t of r.transfers ?? []) {
          const token = t.category === "erc20" && t.rawContract.address ? lc(t.rawContract.address) : lc(NATIVE);
          out.push({
            hash: t.hash,
            from: lc(t.from),
            to: lc(t.to ?? ""),
            token,
            amount: t.rawContract.value ? BigInt(t.rawContract.value) : 0n,
            block: Number(BigInt(t.blockNum)),
          });
        }
        pageKey = r.pageKey;
      } while (pageKey);
    }
    return out;
  }

  async txFrom(c: ChainCfg, hash: string): Promise<string> {
    const t = await this.rpc<{ from: string } | null>(c, "eth_getTransactionByHash", [hash]);
    return lc(t?.from ?? "");
  }

  async blockNumber(c: ChainCfg): Promise<number> {
    return Number(BigInt(await this.rpc<string>(c, "eth_blockNumber", [])));
  }

  static verifyOwnership(message: string, signature: string, address: string): boolean {
    try {
      return sameAddr(verifyMessage(message, signature), address);
    } catch {
      return false;
    }
  }

  static encodeAbi(types: string[], values: unknown[]): string {
    return AbiCoder.defaultAbiCoder().encode(types, values);
  }
}

export type { ChainKey };
