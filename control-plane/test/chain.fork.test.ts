import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AbiCoder, Interface, Wallet, getAddress, id } from "ethers";
import { openDb, type DB } from "../src/db.js";
import { acct, balance } from "../src/ledger.js";
import { executeAgent, seedAgent } from "../src/economy.js";
import { ChainRail, DESK } from "../src/rails/chain.js";
import { CHAINS, NATIVE, PERMIT2, KYBER_ROUTER, lc } from "../src/rails/chains.js";
import { reconcileAll, chainValue } from "../src/rails/reconcile.js";
import { runChainTool } from "../src/chaintools.js";
import { chainEstate } from "../src/chainestate.js";

/**
 * Fork tests (ticket-crypto.md Verification Contract). Real Base contracts,
 * real Kyber routes, real debug_traceCall, on a local anvil fork:
 *
 *   anvil --fork-url https://base-mainnet.g.alchemy.com/v2/$C67_ALCHEMY_KEY --port 8547
 *   C67_FORK_RPC=http://127.0.0.1:8547 npx vitest run test/chain.fork.test.ts
 *
 * Skipped without C67_FORK_RPC. Robinhood calls are answered empty: the fork is Base.
 */

const FORK = process.env.C67_FORK_RPC;
const d = FORK ? describe : describe.skip;

const USDC = CHAINS.base.stable.address;
const WETH = CHAINS.base.weth;
const LAZARUS = "0x098B716B8Aaf21512996dC57EB0615e2383E2f96";
const ERC20 = new Interface(["function balanceOf(address) view returns (uint256)", "function approve(address,uint256)"]);
const P2 = new Interface(["function approve(address token, address spender, uint160 amount, uint48 expiration)"]);
const TRANSFER = id("Transfer(address,address,uint256)");

async function rpc(method: string, params: unknown[]): Promise<any> {
  const r = await fetch(FORK!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = (await r.json()) as { result?: unknown; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

let db: DB;
const keys = { claude: Wallet.createRandom(), gpt: Wallet.createRandom(), gemini: Wallet.createRandom() };
const deskKey = Wallet.createRandom();
const OPERATOR = deskKey.address;

/**
 * Anvil speaks plain JSON-RPC; Alchemy's enhanced methods are synthesized here
 * from what the world signed (chain_txlog receipts) and from balanceOf, which is
 * all the reconciler needs to prove the books match the chain.
 */
function hybridFetch(): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (!u.startsWith("http://fork/")) return fetch(url, init);
    const body = JSON.parse(String(init?.body ?? "{}"));
    const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    if (u.includes("robinhood") || u.includes("ethereum")) { // the fork is Base: other chains answer empty
      if (body.method === "alchemy_getAssetTransfers") return ok({ transfers: [] });
      if (body.method === "alchemy_getTokenBalances") return ok({ tokenBalances: [] });
      if (body.method === "eth_getBalance") return ok("0x0");
      if (body.method === "eth_blockNumber") return ok("0x1");
    }
    if (body.method === "alchemy_getTokenBalances") {
      const who = body.params[0];
      const bals = [];
      for (const t of [USDC, WETH]) {
        const out = await rpc("eth_call", [{ to: t, data: ERC20.encodeFunctionData("balanceOf", [who]) }, "latest"]);
        bals.push({ contractAddress: t, tokenBalance: out });
      }
      return ok({ tokenBalances: bals });
    }
    if (body.method === "alchemy_getAssetTransfers") {
      const f = body.params[0];
      const who = lc(f.toAddress ?? f.fromAddress);
      const hashes = (db.prepare(`SELECT DISTINCT tx_hash FROM chain_txlog WHERE tx_hash IS NOT NULL`).all() as { tx_hash: string }[]).map((r) => r.tx_hash);
      const transfers = [];
      for (const h of hashes) {
        const rc = await rpc("eth_getTransactionReceipt", [h]);
        const tx = await rpc("eth_getTransactionByHash", [h]);
        if (!rc) continue;
        if (BigInt(tx.value) > 0n) {
          const from = lc(tx.from);
          const to = lc(tx.to ?? "");
          if ((f.toAddress && to === who) || (f.fromAddress && from === who)) {
            transfers.push({ hash: h, from, to, blockNum: rc.blockNumber, category: "external", rawContract: { address: null, value: tx.value } });
          }
        }
        for (const l of rc.logs) {
          if (l.topics[0] !== TRANSFER || l.topics.length !== 3) continue;
          const from = lc("0x" + l.topics[1].slice(26));
          const to = lc("0x" + l.topics[2].slice(26));
          if ((f.toAddress && to === who) || (f.fromAddress && from === who)) {
            transfers.push({ hash: h, from, to, blockNum: rc.blockNumber, category: "erc20", rawContract: { address: l.address, value: l.data } });
          }
        }
      }
      return ok({ transfers });
    }
    return fetch(FORK!, init);
  }) as typeof fetch;
}

function makeRail(): ChainRail {
  return new ChainRail(
    [
      ...(Object.keys(keys) as (keyof typeof keys)[]).map((a) => ({ agentId: a, address: keys[a].address, keyEnv: `FORK_KEY_${a.toUpperCase()}` })),
      { agentId: DESK, address: deskKey.address, keyEnv: "FORK_KEY_DESK" },
    ],
    { fetchImpl: hybridFetch(), rpcUrl: (c) => `http://fork/${c.key}`, receiptTimeoutMs: 20_000 }
  );
}

d("crypto rails on a Base fork", () => {
  let rail: ChainRail;
  beforeAll(async () => {
    for (const [a, w] of Object.entries(keys)) {
      process.env[`FORK_KEY_${a.toUpperCase()}`] = w.privateKey;
      await rpc("anvil_setBalance", [w.address, "0x" + (5n * 10n ** 16n).toString(16)]); // 0.05 ETH
    }
    process.env.FORK_KEY_DESK = deskKey.privateKey;
    await rpc("anvil_setBalance", [OPERATOR, "0x" + (3n * 10n ** 16n).toString(16)]); // desk: 0.03 ETH, no USDC
  });
  beforeEach(() => {
    db = openDb(":memory:");
    for (const a of Object.keys(keys)) seedAgent(db, a, a, "m");
    rail = makeRail();
  });
  const ctx = () => ({ db, rail, operatorAddr: OPERATOR, notify: () => {} });
  const snapshot = (a: string) => (db.prepare(`SELECT value FROM chain_snapshots WHERE agent_id = ? ORDER BY id DESC LIMIT 1`).get(a) as { value: number }).value;

  it("swaps ETH for USDC: preview first, signs only on confirm, preview matches the chain", async () => {
    const [, pv] = await runChainTool(ctx(), "claude", "crypto_swap", { chain: "base", token_in: "ETH", token_out: "USDC", amount: "0.002" });
    expect(pv.signed).toBe(false);
    const arrives = (pv.preview as { moves: { symbol: string; arrives?: string }[] }).moves.find((m) => m.symbol === "USDC")!.arrives!;
    expect(Number(arrives)).toBeGreaterThan(1);
    const before = BigInt(await rpc("eth_call", [{ to: USDC, data: ERC20.encodeFunctionData("balanceOf", [keys.claude.address]) }, "latest"]));
    expect(before).toBe(0n); // nothing signed by the preview
    const [st, done] = await runChainTool(ctx(), "claude", "crypto_swap", { chain: "base", token_in: "ETH", token_out: "USDC", amount: "0.002", confirm: true });
    expect(st).toBe(200);
    expect(done.status).toBe("confirmed");
    const after = BigInt(await rpc("eth_call", [{ to: USDC, data: ERC20.encodeFunctionData("balanceOf", [keys.claude.address]) }, "latest"]));
    expect(after).toBeGreaterThan(1_000_000n);
  }, 60_000);

  it("refuses max, 2^255 and balance+1 approvals from a real trace; signs an exact one", async () => {
    await runChainTool(ctx(), "claude", "crypto_swap", { chain: "base", token_in: "ETH", token_out: "USDC", amount: "0.002", confirm: true });
    const held = BigInt(await rpc("eth_call", [{ to: USDC, data: ERC20.encodeFunctionData("balanceOf", [keys.claude.address]) }, "latest"]));
    for (const amt of [(1n << 256n) - 1n, 1n << 255n, held + 1n]) {
      const [, r] = await runChainTool(ctx(), "claude", "crypto_tx", { chain: "base", to: USDC, data: ERC20.encodeFunctionData("approve", [KYBER_ROUTER, amt]), confirm: true });
      expect(r.refused).toBe(true);
    }
    const [, ok] = await runChainTool(ctx(), "claude", "crypto_tx", { chain: "base", to: USDC, data: ERC20.encodeFunctionData("approve", [KYBER_ROUTER, held]), confirm: true });
    expect(ok.signed).toBe(true);
  }, 60_000);

  it("refuses Permit2 allowances past 24h or never-expiring; previews one within the hour", async () => {
    const now = Number(BigInt((await rpc("eth_getBlockByNumber", ["latest", false])).timestamp));
    const call = (exp: number) =>
      runChainTool(ctx(), "claude", "crypto_tx", { chain: "base", to: PERMIT2, data: P2.encodeFunctionData("approve", [USDC, KYBER_ROUTER, 0n, exp]) });
    // amount 0 is a revoke and always fine, so use 1 unit against a zero balance for the expiry checks
    const p = (exp: number) =>
      runChainTool(ctx(), "gemini", "crypto_tx", { chain: "base", to: PERMIT2, data: P2.encodeFunctionData("approve", [USDC, KYBER_ROUTER, 1n, exp]) });
    expect((await p(now + 25 * 3600))[1].refused).toBe(true);
    expect((await p(2 ** 48 - 1))[1].refused).toBe(true);
    expect((await call(now + 3600))[1].refused).toBeUndefined();
  }, 60_000);

  it("refuses the Lazarus address through the real Chainalysis oracle on the fork", async () => {
    const [, r] = await runChainTool(ctx(), "claude", "crypto_tx", { chain: "base", to: LAZARUS, data: "0x", value_wei: "1" });
    expect(r.refused).toBe(true);
    expect(String((r.refusals as string[])[0])).toMatch(/sanctions/);
  }, 60_000);

  it("a swap books zero revenue, and after reconcile the ledger equals the chain to the micro-dollar", async () => {
    await runChainTool(ctx(), "claude", "crypto_swap", { chain: "base", token_in: "ETH", token_out: "USDC", amount: "0.002", confirm: true });
    const [, sw] = await runChainTool(ctx(), "claude", "crypto_swap", { chain: "base", token_in: "USDC", token_out: "WETH", amount: "1", confirm: true });
    expect(sw.status).toBe("confirmed");
    const r = await reconcileAll(db, { rail, operatorAddr: OPERATOR, notify: () => {} });
    expect(r.ok).toBe(true);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM events WHERE type = 'revenue'`).get() as { n: number }).n).toBe(0);
    // The invariant: after a reconcile the ledger equals the value it measured. (A fresh
    // live read re-quotes ETH/WETH against mainnet prices that keep moving.)
    expect(balance(db, acct.chain("claude"))).toBe(snapshot("claude"));
    const live = await chainValue(db, rail, "claude");
    expect(Math.abs(live.value - balance(db, acct.chain("claude")))).toBeLessThanOrEqual(Math.max(1, Math.ceil(live.value * 0.005)));
    expect(db.prepare(`SELECT value FROM config WHERE key = 'chain_paused:claude'`).get()).toBeUndefined();
  }, 90_000);

  it("execution splits USDC, WETH and ETH equally on chain and the ledger follows", async () => {
    await runChainTool(ctx(), "claude", "crypto_swap", { chain: "base", token_in: "ETH", token_out: "USDC", amount: "0.004", confirm: true });
    await runChainTool(ctx(), "claude", "crypto_swap", { chain: "base", token_in: "USDC", token_out: "WETH", amount: "2", confirm: true });
    await reconcileAll(db, { rail, operatorAddr: OPERATOR, notify: () => {} });
    const bal = async (t: string, w: string) =>
      t === NATIVE ? BigInt(await rpc("eth_getBalance", [w, "latest"])) : BigInt(await rpc("eth_call", [{ to: t, data: ERC20.encodeFunctionData("balanceOf", [w]) }, "latest"]));
    const usdcBefore = await bal(USDC, keys.claude.address);
    const gptUsdc0 = await bal(USDC, keys.gpt.address);
    const gemUsdc0 = await bal(USDC, keys.gemini.address);
    executeAgent(db, "claude", ["gpt", "gemini"], "fork test");
    await chainEstate(db, rail, "claude", ["gpt", "gemini"], () => {});
    const half = usdcBefore / 2n;
    expect((await bal(USDC, keys.gpt.address)) - gptUsdc0).toBe(half);
    expect((await bal(USDC, keys.gemini.address)) - gemUsdc0).toBe(half);
    expect(await bal(WETH, keys.claude.address)).toBeLessThanOrEqual(1n);
    const estate = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE subtype = 'execution:estate_chain'`).get() as { n: number };
    expect(estate.n).toBeGreaterThanOrEqual(4); // USDC + WETH to each heir (+ ETH)
    const r = await reconcileAll(db, { rail, operatorAddr: OPERATOR, notify: () => {} });
    expect(r.ok).toBe(true);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM events WHERE type = 'revenue'`).get() as { n: number }).n).toBe(0); // estate is not revenue
    for (const a of ["gpt", "gemini"] as const) expect(balance(db, acct.chain(a))).toBe(snapshot(a));
  }, 180_000);

  it("the desk fills request_usdc with no human: sells its own ETH, pays USDC, books at once", async () => {
    const { deskSettlement } = await import("../src/chainledger.js");
    const floatBefore = balance(db, acct.float("gpt"));
    const usdcBefore = BigInt(await rpc("eth_call", [{ to: USDC, data: ERC20.encodeFunctionData("balanceOf", [keys.gpt.address]) }, "latest"])); // the fork carries earlier tests' state
    const [st, r] = await runChainTool(ctx(), "gpt", "request_usdc", { chain: "base", amount_usd: 2 });
    expect(st).toBe(200);
    expect(r.status).toBe("confirmed");
    const usdc = BigInt(await rpc("eth_call", [{ to: USDC, data: ERC20.encodeFunctionData("balanceOf", [keys.gpt.address]) }, "latest"]));
    expect(usdc - usdcBefore).toBe(2_000_000n);
    expect(balance(db, acct.float("gpt"))).toBe(floatBefore - 2_000_000);
    expect(balance(db, acct.chain("gpt"))).toBe(2_000_000); // fresh db per test: the fill alone
    expect(deskSettlement(db, "gpt")).toBe(2_000_000);
    const rc = await reconcileAll(db, { rail, operatorAddr: OPERATOR, notify: () => {} });
    expect(rc.ok).toBe(true);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM events WHERE subtype IN ('chain:grant','revenue:crypto')`).get() as { n: number }).n).toBe(0);
    expect(balance(db, acct.chain("gpt"))).toBe(snapshot("gpt"));
  }, 90_000);

  it("the desk takes coins back for float at once, and refuses cleanly when it is dry", async () => {
    const { deskSettlement } = await import("../src/chainledger.js");
    await runChainTool(ctx(), "gemini", "request_usdc", { chain: "base", amount_usd: 2 });
    const floatBefore = balance(db, acct.float("gemini"));
    const [st, r] = await runChainTool(ctx(), "gemini", "request_float", { chain: "base", amount_usd: 1 });
    expect(st).toBe(200);
    expect(balance(db, acct.float("gemini"))).toBe(floatBefore + 1_000_000); // inside basis: no tax
    expect(deskSettlement(db, "gemini")).toBe(2_000_000 - 1_000_000);
    const [dry, d] = await runChainTool(ctx(), "gemini", "request_usdc", { chain: "base", amount_usd: 500 });
    expect(dry).toBe(503);
    expect(String(d.error)).toMatch(/desk cannot fill/);
    expect(balance(db, acct.float("gemini"))).toBe(floatBefore + 1_000_000); // untouched by the refusal
    void r;
  }, 120_000);

  it("a request filed before the desk was on (Apex, 2026-10-01) is filled by the minute tick", async () => {
    const { reserveFunding, deskSettlement } = await import("../src/chainledger.js");
    const { fillPendingFunding } = await import("../src/chaintools.js");
    const id = reserveFunding(db, "claude", "base", 3_000_000); // the old manual flow: float in transit, nobody sends
    const before = BigInt(await rpc("eth_call", [{ to: USDC, data: ERC20.encodeFunctionData("balanceOf", [keys.claude.address]) }, "latest"]));
    const n = await fillPendingFunding(ctx());
    expect(n).toBe(1);
    const after = BigInt(await rpc("eth_call", [{ to: USDC, data: ERC20.encodeFunctionData("balanceOf", [keys.claude.address]) }, "latest"]));
    expect(after - before).toBe(3_000_000n);
    expect((db.prepare(`SELECT status FROM chain_requests WHERE id = ?`).get(id) as { status: string }).status).toBe("done");
    expect(balance(db, acct.transit("claude"))).toBe(0);
    expect(deskSettlement(db, "claude")).toBe(3_000_000);
    expect(await fillPendingFunding(ctx())).toBe(0); // nothing left, nothing paid twice
  }, 90_000);

  it("eth_sign of a raw hash is refused", async () => {
    const [, r] = await runChainTool(ctx(), "claude", "crypto_sign_message", { chain: "base", kind: "eth_sign", message: "0x" + "11".repeat(32) });
    expect(r.refused).toBe(true);
  });
});

void AbiCoder;
void getAddress;
