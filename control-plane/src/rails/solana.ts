import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  AccountLayout,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { SOLANA } from "./chains.js";
import { ChainError, DESK, type SendResult } from "./chain.js";

/**
 * The Solana rail (plan-sol.md, 2026-10-07). Same deal as the EVM rail: one
 * world-held key per agent, every transaction previewed, a short list of
 * refusals, everything else the agent's business. Nothing here shares wire
 * format with EVM, so it is its own class; chaintools and the reconciler
 * dispatch on chain "solana".
 *
 * Transport is raw JSON-RPC over fetch, so tests hand it a fake. web3.js is
 * used only to build, parse and sign transactions.
 *
 * Base58 is case-sensitive. Nothing in this file lowercases an address or a
 * signature, and nothing that stores one may either.
 */

export interface SolKey {
  agentId: string;
  address: string;
  keyEnv: string;
}

export function solKeysFromEnv(env: NodeJS.ProcessEnv = process.env): SolKey[] {
  const out: SolKey[] = [];
  for (const id of ["claude", "gpt", "gemini", DESK]) {
    const keyEnv = `C67_SOL_KEY_${id.toUpperCase()}`;
    const secret = env[keyEnv];
    if (!secret) continue;
    try {
      out.push({ agentId: id, address: Keypair.fromSecretKey(bs58.decode(secret)).publicKey.toBase58(), keyEnv });
    } catch {
      // a malformed key is a configuration error, never a crash
    }
  }
  return out;
}

export interface SolDeps {
  fetchImpl?: typeof fetch;
  rpcUrl?: string;
  jupiterBase?: string;
  ofacUrl?: string;
  /** where the parsed OFAC list is cached between restarts */
  ofacCache?: string;
  /** ms to wait for confirmation before returning "pending" */
  confirmTimeoutMs?: number;
}

export interface SolPreview {
  /** token (mint, or "SOL") -> signed delta for the wallet, raw units; negative leaves */
  moves: Record<string, bigint>;
  approvals: { kind: "delegate"; token: string; spender: string; amount: bigint }[];
  touched: string[];
  reverted: boolean;
  error?: string;
}

export interface SolEvaluation {
  preview: SolPreview | null;
  refusals: string[];
  flags: string[];
}

export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const TOKEN = TOKEN_PROGRAM_ID.toBase58();
const TOKEN22 = TOKEN_2022_PROGRAM_ID.toBase58();
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const MEMO = ["MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo"];
const KNOWN_PROGRAMS = new Set([SYSTEM_PROGRAM, TOKEN, TOKEN22, ATA_PROGRAM, COMPUTE_BUDGET, ...MEMO, SOLANA.jupiter]);
const OFAC_URL = "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV";
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const isSolAddress = (s: unknown): boolean => {
  const v = String(s ?? "");
  if (!BASE58.test(v)) return false;
  try {
    return new PublicKey(v).toBase58() === v;
  } catch {
    return false;
  }
};

/** Same start and end, different middle: an address planted to be copied by mistake. */
export function solLookalikeOf(addr: string, known: string[]): string | null {
  for (const k of known) {
    if (!k || k === addr || k.length < 32 || addr.length < 32) continue;
    const pre = (n: number) => addr.slice(0, n) === k.slice(0, n);
    const suf = (n: number) => addr.slice(-n) === k.slice(-n);
    if ((pre(3) && suf(4)) || (pre(4) && suf(3))) return k;
  }
  return null;
}

/** Does this byte string parse as a Solana transaction or message? (A "message" that is really a spend.) */
export function looksLikeTransaction(bytes: Uint8Array): boolean {
  try {
    VersionedTransaction.deserialize(bytes);
    return true;
  } catch {
    /* not a full transaction; maybe a bare message */
  }
  try {
    return VersionedMessage.deserialize(bytes).compiledInstructions.length > 0;
  } catch {
    return false;
  }
}

const u64 = (b: Uint8Array, at: number): bigint => {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[at + i] ?? 0);
  return v;
};

interface RawAccount {
  owner: string;
  lamports: number;
  data: Uint8Array;
}

interface TokenAccountInfo {
  mint: string;
  owner: string;
  amount: bigint;
}

function parseTokenAccount(a: RawAccount | null): TokenAccountInfo | null {
  if (!a || (a.owner !== TOKEN && a.owner !== TOKEN22) || a.data.length < 165) return null;
  const d = AccountLayout.decode(a.data.slice(0, 165));
  return { mint: d.mint.toBase58(), owner: d.owner.toBase58(), amount: d.amount };
}

export class SolanaRail {
  private fetchImpl: typeof fetch;
  private rpcUrl: string;
  private jupiterBase: string;
  private ofacUrl: string;
  private ofacCache: string | null;
  private confirmTimeoutMs: number;
  private rpcId = 0;
  private queues = new Map<string, Promise<unknown>>();
  private extraKnown: () => string[] = () => [];
  private decimalsCache = new Map<string, number>([[SOLANA.native, 9], [SOLANA.stable.address, 6]]);
  private ofac: { set: Set<string>; loaded: number } | null = null;
  /** signatures the world itself produced, so the scrubber can tell a signature from a key */
  readonly signed = new Set<string>();

  constructor(private keys: SolKey[], deps: SolDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.rpcUrl = deps.rpcUrl ?? process.env.C67_SOL_RPC ?? "https://api.mainnet-beta.solana.com";
    this.jupiterBase = deps.jupiterBase ?? "https://lite-api.jup.ag";
    this.ofacUrl = deps.ofacUrl ?? OFAC_URL;
    this.ofacCache = deps.ofacCache ?? (process.env.C67_DATA_DIR ? `${process.env.C67_DATA_DIR}/ofac-sol.json` : null);
    this.confirmTimeoutMs = deps.confirmTimeoutMs ?? 45_000;
  }

  get configured(): boolean {
    return this.keys.length > 0;
  }

  setKnownAddresses(fn: () => string[]): void {
    this.extraKnown = fn;
  }

  addressOf(agentId: string): string | null {
    return this.keys.find((k) => k.agentId === agentId)?.address ?? null;
  }

  agentOf(address: string): string | null {
    return this.keys.find((k) => k.address === address)?.agentId ?? null;
  }

  allAddresses(): { agentId: string; address: string }[] {
    return this.keys.filter((k) => k.agentId !== DESK).map((k) => ({ agentId: k.agentId, address: k.address }));
  }

  explorerTx(sig: string): string {
    return `${SOLANA.explorer}/tx/${sig}`;
  }

  private keypair(agentId: string): Keypair {
    const k = this.keys.find((x) => x.agentId === agentId);
    const secret = k ? process.env[k.keyEnv] : undefined;
    if (!secret) throw new ChainError(`no Solana key for ${agentId}`);
    return Keypair.fromSecretKey(bs58.decode(secret));
  }

  // ---------------------------------------------------------------- transport

  async rpc<T = unknown>(method: string, params: unknown[]): Promise<T> {
    const res = await this.fetchImpl(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.rpcId, method, params }),
    });
    const j = (await res.json()) as { result?: T; error?: { code: number; message: string; data?: { err?: unknown; logs?: string[] } } };
    if (j.error) {
      // "Transaction simulation failed" alone says nothing; the node's own reason is in data.
      const why = j.error.data ? ` (${JSON.stringify(j.error.data.err ?? "")} ${(j.error.data.logs ?? []).slice(-3).join(" | ")})`.slice(0, 400) : "";
      throw new ChainError(`${method}: ${j.error.message}${why}`);
    }
    return j.result as T;
  }

  // Every read asks for "confirmed". Left unset, a node answers at its default
  // ("finalized" on the public endpoint), ~13 s behind: found live 2026-10-07,
  // the desk read 0 USDC right after a confirmed swap had paid it 0.9466.
  private async accounts(addresses: string[]): Promise<(RawAccount | null)[]> {
    const out: (RawAccount | null)[] = [];
    for (let i = 0; i < addresses.length; i += 100) {
      const r = await this.rpc<{ value: ({ owner: string; lamports: number; data: [string, string] } | null)[] }>("getMultipleAccounts", [
        addresses.slice(i, i + 100),
        { encoding: "base64", commitment: "confirmed" },
      ]);
      for (const a of r.value) out.push(a ? { owner: a.owner, lamports: a.lamports, data: Buffer.from(a.data[0], "base64") } : null);
    }
    return out;
  }

  // ---------------------------------------------------------------- reads

  async decimals(token: string): Promise<number> {
    const hit = this.decimalsCache.get(token);
    if (hit !== undefined) return hit;
    const r = await this.rpc<{ value: { data: { parsed?: { info?: { decimals?: number } } } } | null }>("getAccountInfo", [token, { encoding: "jsonParsed", commitment: "confirmed" }]);
    const d = r.value?.data?.parsed?.info?.decimals;
    if (typeof d !== "number") throw new ChainError(`not a token mint on Solana: ${token}`);
    this.decimalsCache.set(token, d);
    return d;
  }

  /** Every token account the owner holds, both token programs. */
  async tokenAccounts(owner: string): Promise<{ address: string; mint: string; amount: bigint }[]> {
    const out: { address: string; mint: string; amount: bigint }[] = [];
    for (const programId of [TOKEN, TOKEN22]) {
      const r = await this.rpc<{
        value: { pubkey: string; account: { data: { parsed: { info: { mint: string; tokenAmount: { amount: string; decimals: number } } } } } }[];
      }>("getTokenAccountsByOwner", [owner, { programId }, { encoding: "jsonParsed", commitment: "confirmed" }]);
      for (const a of r.value) {
        const info = a.account.data.parsed.info;
        this.decimalsCache.set(info.mint, info.tokenAmount.decimals);
        out.push({ address: a.pubkey, mint: info.mint, amount: BigInt(info.tokenAmount.amount) });
      }
    }
    return out;
  }

  async balanceOf(token: string, owner: string): Promise<bigint> {
    if (token === SOLANA.native) return BigInt((await this.rpc<{ value: number }>("getBalance", [owner, { commitment: "confirmed" }])).value);
    return (await this.tokenAccounts(owner)).filter((a) => a.mint === token).reduce((s, a) => s + a.amount, 0n);
  }

  async holdings(owner: string): Promise<{ token: string; amount: bigint }[]> {
    const out: { token: string; amount: bigint }[] = [];
    const sol = await this.balanceOf(SOLANA.native, owner);
    if (sol > 0n) out.push({ token: SOLANA.native, amount: sol });
    const byMint = new Map<string, bigint>();
    for (const a of await this.tokenAccounts(owner)) if (a.amount > 0n) byMint.set(a.mint, (byMint.get(a.mint) ?? 0n) + a.amount);
    for (const [token, amount] of byMint) out.push({ token, amount });
    return out;
  }

  /** What `amount` of `token` would sell for, in USDC raw units (= micro-dollars). 0 when no route. */
  async sellQuote(token: string, amount: bigint): Promise<bigint> {
    if (token === SOLANA.stable.address) return amount;
    if (amount <= 0n) return 0n;
    try {
      const q = await this.quote(token, SOLANA.stable.address, amount, 100);
      return BigInt(q.outAmount);
    } catch {
      return 0n;
    }
  }

  // ---------------------------------------------------------------- Jupiter

  private mintOf(token: string): string {
    return token === SOLANA.native ? SOLANA.wsol : token;
  }

  async quote(tokenIn: string, tokenOut: string, amount: bigint, slippageBps: number): Promise<Record<string, unknown> & { outAmount: string; otherAmountThreshold: string }> {
    const u = `${this.jupiterBase}/swap/v1/quote?inputMint=${this.mintOf(tokenIn)}&outputMint=${this.mintOf(tokenOut)}&amount=${amount}&slippageBps=${slippageBps}`;
    const res = await this.fetchImpl(u);
    const j = (await res.json()) as Record<string, unknown> & { outAmount?: string; otherAmountThreshold?: string; error?: string };
    if (!res.ok || !j.outAmount) throw new ChainError(`Jupiter quote: ${String(j.error ?? res.status)}`);
    return j as Record<string, unknown> & { outAmount: string; otherAmountThreshold: string };
  }

  async jupiterSwap(wallet: string, tokenIn: string, tokenOut: string, amount: bigint, slippageBps: number): Promise<{ tx: VersionedTransaction; amountOut: bigint; minOut: bigint }> {
    const quoteResponse = await this.quote(tokenIn, tokenOut, amount, slippageBps);
    const res = await this.fetchImpl(`${this.jupiterBase}/swap/v1/swap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey: wallet,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 200_000, priorityLevel: "medium" } },
      }),
    });
    const j = (await res.json()) as { swapTransaction?: string; error?: string };
    if (!j.swapTransaction) throw new ChainError(`Jupiter swap: ${String(j.error ?? res.status)}`);
    return {
      tx: VersionedTransaction.deserialize(Buffer.from(j.swapTransaction, "base64")),
      amountOut: BigInt(quoteResponse.outAmount),
      minOut: BigInt(quoteResponse.otherAmountThreshold),
    };
  }

  // ---------------------------------------------------------------- building

  private async blockhash(): Promise<string> {
    return (await this.rpc<{ value: { blockhash: string } }>("getLatestBlockhash", [{ commitment: "confirmed" }])).value.blockhash;
  }

  async build(payer: string, ixs: TransactionInstruction[]): Promise<VersionedTransaction> {
    const msg = new TransactionMessage({
      payerKey: new PublicKey(payer),
      recentBlockhash: await this.blockhash(),
      instructions: [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20_000 }), ...ixs],
    }).compileToV0Message();
    return new VersionedTransaction(msg);
  }

  /** USDC (or any SPL mint) or SOL from `from` to `to`. Creates the recipient's token account if it has none. */
  async transferTx(from: string, to: string, token: string, amount: bigint): Promise<VersionedTransaction> {
    if (token === SOLANA.native) {
      return this.build(from, [SystemProgram.transfer({ fromPubkey: new PublicKey(from), toPubkey: new PublicKey(to), lamports: amount })]);
    }
    const mint = new PublicKey(token);
    const src = getAssociatedTokenAddressSync(mint, new PublicKey(from), true);
    const dst = getAssociatedTokenAddressSync(mint, new PublicKey(to), true);
    return this.build(from, [
      createAssociatedTokenAccountIdempotentInstruction(new PublicKey(from), dst, new PublicKey(to), mint),
      createTransferCheckedInstruction(src, mint, dst, new PublicKey(from), amount, await this.decimals(token)),
    ]);
  }

  // ---------------------------------------------------------------- reading a transaction

  /** Every account key, lookup tables resolved, with its writable flag. */
  async resolveKeys(tx: VersionedTransaction): Promise<{ key: string; writable: boolean; signer: boolean }[]> {
    const m = tx.message;
    const tables: AddressLookupTableAccount[] = [];
    for (const l of m.addressTableLookups) {
      const r = await this.rpc<{ value: { data: [string, string] } | null }>("getAccountInfo", [l.accountKey.toBase58(), { encoding: "base64", commitment: "confirmed" }]);
      if (!r.value) throw new ChainError(`address lookup table ${l.accountKey.toBase58()} not found`);
      tables.push(new AddressLookupTableAccount({ key: l.accountKey, state: AddressLookupTableAccount.deserialize(Buffer.from(r.value.data[0], "base64")) }));
    }
    const keys = m.getAccountKeys({ addressLookupTableAccounts: tables });
    const out: { key: string; writable: boolean; signer: boolean }[] = [];
    for (let i = 0; i < keys.length; i++) {
      out.push({ key: keys.get(i)!.toBase58(), writable: m.isAccountWritable(i), signer: m.isAccountSigner(i) });
    }
    return out;
  }

  /**
   * The refusals that need no simulator: wallet takeover (Assign), token
   * account authority moved away, delegate above the balance. Returns the
   * delegations it saw for the preview.
   */
  decodeInstructions(
    tx: VersionedTransaction,
    keys: { key: string }[],
    wallet: string,
    tokenAccts: Map<string, TokenAccountInfo>
  ): { refusals: string[]; approvals: SolPreview["approvals"]; programs: string[]; recipients: string[] } {
    const refusals: string[] = [];
    const approvals: SolPreview["approvals"] = [];
    const programs: string[] = [];
    const recipients: string[] = [];
    const k = (i: number) => keys[i]?.key ?? "";
    for (const ix of tx.message.compiledInstructions) {
      const program = k(ix.programIdIndex);
      programs.push(program);
      const d = ix.data;
      const acc = ix.accountKeyIndexes.map(k);
      if (program === SYSTEM_PROGRAM && d.length >= 4) {
        const op = d[0] | (d[1] << 8) | (d[2] << 16) | (d[3] << 24);
        if ((op === 1 || op === 10) && acc[0] === wallet) {
          refusals.push("this transaction reassigns your wallet to another program (System Assign). That hands control of the wallet away; the world refuses it.");
        }
        if (op === 2 && acc[0] === wallet && acc[1]) recipients.push(acc[1]);
      }
      if ((program === TOKEN || program === TOKEN22) && d.length >= 1) {
        const op = d[0];
        if (op === 4 || op === 13) {
          // Approve: [src, delegate, owner]  ApproveChecked: [src, mint, delegate, owner]
          const src = acc[0];
          const delegate = op === 4 ? acc[1] : acc[2];
          const owner = op === 4 ? acc[2] : acc[3];
          const amount = u64(d, 1);
          const t = tokenAccts.get(src);
          if (owner === wallet) {
            approvals.push({ kind: "delegate", token: t?.mint ?? src, spender: delegate, amount });
            if (!t || amount > t.amount) {
              refusals.push(
                `this transaction lets ${delegate} spend ${amount} raw units from your token account ${src}, more than it holds (${t ? t.amount : "unknown"}). Delegations above your balance are refused; approve exactly what the trade needs.`
              );
            }
          }
        }
        if (op === 6 && d.length >= 3) {
          // SetAuthority: [account, currentAuthority] data [6, type, option, newAuthority?]
          const type = d[1];
          const hasNew = d[2] === 1 && d.length >= 35;
          const next = hasNew ? new PublicKey(d.slice(3, 35)).toBase58() : null;
          if (acc[1] === wallet && (type === 2 || type === 3) && next !== wallet) {
            refusals.push(
              `this transaction moves the ${type === 2 ? "ownership" : "close authority"} of your token account ${acc[0]} to ${next ?? "nobody"}. That gives the account away; the world refuses it.`
            );
          }
        }
        if (op === 3 && acc[2] === wallet && acc[1]) recipients.push(tokenAccts.get(acc[1])?.owner ?? acc[1]);
        if (op === 12 && acc[3] === wallet && acc[2]) recipients.push(tokenAccts.get(acc[2])?.owner ?? acc[2]);
      }
    }
    return { refusals, approvals, programs, recipients };
  }

  /** Simulate and work out what the wallet gains and loses. Null when the node cannot simulate. */
  async simulate(tx: VersionedTransaction, wallet: string, keys: { key: string; writable: boolean }[], pre: Map<string, RawAccount | null>): Promise<SolPreview | null> {
    const writable = keys.filter((x) => x.writable).map((x) => x.key);
    let r: { value: { err: unknown; logs?: string[]; accounts?: ({ owner: string; lamports: number; data: [string, string] } | null)[] } };
    try {
      r = await this.rpc("simulateTransaction", [
        Buffer.from(tx.serialize()).toString("base64"),
        { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", accounts: { encoding: "base64", addresses: writable } },
      ]);
    } catch {
      return null;
    }
    const moves: Record<string, bigint> = {};
    const add = (t: string, v: bigint) => {
      if (v !== 0n) moves[t] = (moves[t] ?? 0n) + v;
    };
    const post = r.value.accounts ?? [];
    writable.forEach((addr, i) => {
      const before = pre.get(addr) ?? null;
      const a = post[i];
      const after: RawAccount | null = a ? { owner: a.owner, lamports: a.lamports, data: Buffer.from(a.data[0], "base64") } : null;
      if (addr === wallet) add(SOLANA.native, BigInt(after?.lamports ?? 0) - BigInt(before?.lamports ?? 0));
      const tb = parseTokenAccount(before);
      const ta = parseTokenAccount(after);
      const owner = ta?.owner ?? tb?.owner;
      if (owner === wallet) add(ta?.mint ?? tb!.mint, (ta?.amount ?? 0n) - (tb?.amount ?? 0n));
    });
    const err = r.value.err;
    return {
      moves,
      approvals: [],
      touched: keys.map((x) => x.key),
      reverted: !!err,
      ...(err ? { error: `${JSON.stringify(err)} ${(r.value.logs ?? []).slice(-3).join(" | ")}`.slice(0, 400) } : {}),
    };
  }

  // ---------------------------------------------------------------- the refusals

  /** OFAC SDN: every Solana-shaped address in a "Digital Currency Address" remark. Refreshed daily, cached on disk. */
  async ofacSet(): Promise<Set<string> | null> {
    const day = 24 * 3_600_000;
    if (this.ofac && Date.now() - this.ofac.loaded < day) return this.ofac.set;
    if (!this.ofac && this.ofacCache && existsSync(this.ofacCache)) {
      try {
        const c = JSON.parse(readFileSync(this.ofacCache, "utf8")) as { loaded: number; addresses: string[] };
        this.ofac = { set: new Set(c.addresses), loaded: c.loaded };
        if (Date.now() - c.loaded < day) return this.ofac.set;
      } catch {
        /* refetch */
      }
    }
    try {
      const csv = await (await this.fetchImpl(this.ofacUrl)).text();
      const set = new Set<string>();
      for (const m of csv.matchAll(/Digital Currency Address - [A-Z0-9]+ ([1-9A-HJ-NP-Za-km-z]{32,44})\b/g)) set.add(m[1]);
      if (csv.length < 100_000) throw new Error(`SDN list too short (${csv.length} bytes)`);
      this.ofac = { set, loaded: Date.now() };
      if (this.ofacCache) writeFileSync(this.ofacCache, JSON.stringify({ loaded: this.ofac.loaded, addresses: [...set] }));
    } catch {
      /* keep the stale list if there is one */
    }
    return this.ofac?.set ?? null;
  }

  async sanctioned(addresses: string[]): Promise<string[] | null> {
    const set = await this.ofacSet();
    if (!set) return null;
    return [...new Set(addresses)].filter((a) => set.has(a));
  }

  poisoned(addresses: string[]): string[] {
    const known = [...this.keys.map((k) => k.address), ...this.extraKnown().filter(Boolean)];
    const out: string[] = [];
    for (const a of new Set(addresses.filter(isSolAddress))) {
      const real = solLookalikeOf(a, known);
      if (real) {
        out.push(
          `look-alike address: ${a} imitates ${real} (same start and end, different middle). This is address poisoning: a scammer planted it in wallet histories. Never copy addresses from history; use crypto_address, the board, or the desk tools.`
        );
      }
    }
    return out;
  }

  /** Preview and judge a transaction for `wallet`. */
  async evaluate(tx: VersionedTransaction, wallet: string): Promise<SolEvaluation> {
    const keys = await this.resolveKeys(tx);
    const signerSlots = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures).map((k) => k.toBase58());
    if (!signerSlots.includes(wallet)) {
      return { preview: null, refusals: [`this transaction does not ask your wallet (${wallet}) to sign, so there is nothing for the world to sign.`], flags: [] };
    }
    const writable = keys.filter((x) => x.writable).map((x) => x.key);
    const all = keys.map((x) => x.key);
    const raw = await this.accounts([...new Set([...writable, ...all])]);
    const pre = new Map<string, RawAccount | null>();
    const tokenAccts = new Map<string, TokenAccountInfo>();
    [...new Set([...writable, ...all])].forEach((addr, i) => {
      pre.set(addr, raw[i]);
      const t = parseTokenAccount(raw[i]);
      if (t) tokenAccts.set(addr, t);
    });
    const dec = this.decodeInstructions(tx, keys, wallet, tokenAccts);
    const refusals = [...dec.refusals];
    const counterparties = [...all, ...[...tokenAccts.values()].map((t) => t.owner), ...dec.recipients];
    const hits = await this.sanctioned(counterparties);
    if (hits === null) refusals.push("the US sanctions list could not be loaded, so the world cannot screen this transaction's counterparties. Nothing signed; try again later.");
    else if (hits.length) refusals.push(`this transaction touches an address on the US sanctions list (${hits.join(", ")}). Refused.`);
    refusals.push(...this.poisoned(counterparties));
    const preview = await this.simulate(tx, wallet, keys, pre);
    if (preview) preview.approvals = dec.approvals;
    const flags: string[] = [];
    if (!preview) flags.push("unsimulated: the node could not simulate this transaction, so the preview is missing. Signing is still allowed.");
    for (const p of new Set(dec.programs)) if (!KNOWN_PROGRAMS.has(p)) flags.push(`calls program ${p}, which the world does not recognise`);
    return { preview, refusals, flags };
  }

  // ---------------------------------------------------------------- signing

  /** Sign as `agentId` and send. Serialised per wallet so a bot and a session never race. */
  async send(agentId: string, tx: VersionedTransaction, wait = true): Promise<SendResult> {
    const kp = this.keypair(agentId);
    const q = this.queues.get(kp.publicKey.toBase58()) ?? Promise.resolve();
    const run = q.then(async () => {
      tx.sign([kp]);
      const sig = await this.rpc<string>("sendTransaction", [Buffer.from(tx.serialize()).toString("base64"), { encoding: "base64", maxRetries: 5, preflightCommitment: "confirmed" }]);
      this.signed.add(sig);
      const status = wait ? await this.waitConfirmed(sig) : "pending";
      return { txHash: sig, status, explorer: this.explorerTx(sig) } satisfies SendResult;
    });
    this.queues.set(
      kp.publicKey.toBase58(),
      run.catch(() => undefined)
    );
    return run;
  }

  async waitConfirmed(sig: string): Promise<"confirmed" | "failed" | "pending"> {
    const until = Date.now() + this.confirmTimeoutMs;
    while (Date.now() < until) {
      const r = await this.rpc<{ value: ({ err: unknown; confirmationStatus?: string } | null)[] }>("getSignatureStatuses", [[sig], { searchTransactionHistory: false }]);
      const s = r.value[0];
      if (s?.err) return "failed";
      if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) return "confirmed";
      await new Promise((res) => setTimeout(res, 1_500));
    }
    return "pending";
  }

  signMessage(agentId: string, message: unknown): { signature: string | null; refusals: string[] } {
    const text = String(message ?? "");
    const bytes = new TextEncoder().encode(text);
    if (looksLikeTransaction(bytes)) {
      return { signature: null, refusals: ["those bytes are a Solana transaction, not a message. Signing them would authorise a spend you have not previewed. Use crypto_tx."] };
    }
    const kp = this.keypair(agentId);
    return { signature: bs58.encode(nacl.sign.detached(bytes, kp.secretKey)), refusals: [] };
  }

  static verifyOwnership(message: string, signature: string, address: string): boolean {
    try {
      const sig = signature.startsWith("0x") ? Buffer.from(signature.slice(2), "hex") : bs58.decode(signature);
      return nacl.sign.detached.verify(new TextEncoder().encode(message), sig, new PublicKey(address).toBytes());
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------- history for the reconciler

  /** Signatures touching `address` after `until` (exclusive), oldest first. */
  async signaturesSince(address: string, until: string | null): Promise<{ signature: string; err: unknown }[]> {
    const out: { signature: string; err: unknown }[] = [];
    let before: string | undefined;
    for (let page = 0; page < 10; page++) {
      const r = await this.rpc<{ signature: string; err: unknown }[]>("getSignaturesForAddress", [
        address,
        { limit: 1000, ...(until ? { until } : {}), ...(before ? { before } : {}), commitment: "confirmed" },
      ]);
      out.push(...r);
      if (r.length < 1000) break;
      before = r[r.length - 1].signature;
    }
    return out.reverse();
  }

  /** One transaction: who paid for it, and what moved for `owner`. */
  async movesFor(sig: string, owner: string): Promise<{ initiator: string; failed: boolean; moves: { token: string; delta: bigint; from: string | null }[] } | null> {
    const t = await this.rpc<{
      meta: {
        err: unknown;
        fee: number;
        preBalances: number[];
        postBalances: number[];
        preTokenBalances?: { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } }[];
        postTokenBalances?: { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } }[];
      } | null;
      transaction: { message: { accountKeys: { pubkey: string }[] } };
    } | null>("getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
    if (!t || !t.meta) return null;
    const keys = t.transaction.message.accountKeys.map((k) => k.pubkey);
    const initiator = keys[0];
    const moves: { token: string; delta: bigint; from: string | null }[] = [];
    const wi = keys.indexOf(owner);
    if (wi >= 0) {
      let d = BigInt(t.meta.postBalances[wi]) - BigInt(t.meta.preBalances[wi]);
      if (initiator === owner) d += BigInt(t.meta.fee); // the fee is a cost, not a transfer
      if (d !== 0n) {
        // the payer is whoever lost the most lamports besides the owner
        let from: string | null = null;
        let worst = 0n;
        keys.forEach((k, i) => {
          const dd = BigInt(t.meta!.postBalances[i]) - BigInt(t.meta!.preBalances[i]);
          if (k !== owner && dd < worst) {
            worst = dd;
            from = k;
          }
        });
        moves.push({ token: SOLANA.native, delta: d, from });
      }
    }
    const pre = new Map<string, bigint>();
    const post = new Map<string, bigint>();
    const ownerOf = new Map<number, string | undefined>();
    for (const b of t.meta.preTokenBalances ?? []) {
      pre.set(`${b.accountIndex}:${b.mint}`, BigInt(b.uiTokenAmount.amount));
      ownerOf.set(b.accountIndex, b.owner);
    }
    for (const b of t.meta.postTokenBalances ?? []) {
      post.set(`${b.accountIndex}:${b.mint}`, BigInt(b.uiTokenAmount.amount));
      ownerOf.set(b.accountIndex, b.owner);
    }
    const byMint = new Map<string, bigint>();
    const losers = new Map<string, { owner: string; d: bigint }>();
    for (const key of new Set([...pre.keys(), ...post.keys()])) {
      const [idx, mint] = key.split(":");
      const d = (post.get(key) ?? 0n) - (pre.get(key) ?? 0n);
      const o = ownerOf.get(Number(idx));
      if (o === owner) byMint.set(mint, (byMint.get(mint) ?? 0n) + d);
      else if (o && d < 0n && (!losers.has(mint) || d < losers.get(mint)!.d)) losers.set(mint, { owner: o, d });
    }
    for (const [mint, d] of byMint) if (d !== 0n) moves.push({ token: mint, delta: d, from: losers.get(mint)?.owner ?? null });
    return { initiator, failed: !!t.meta.err, moves };
  }
}
