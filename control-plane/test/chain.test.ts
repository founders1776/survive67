import { beforeEach, describe, expect, it } from "vitest";
import { AbiCoder, Wallet, getAddress, id } from "ethers";
import { openDb, usd, type DB } from "../src/db.js";
import { acct, balance } from "../src/ledger.js";
import { executeAgent, seedAgent } from "../src/economy.js";
import { selfView, netWorth } from "../src/views.js";
import {
  bookExit,
  chainBasis,
  chainProfit,
  exitTax,
  landChainRevenue,
  landGrant,
  reserveFunding,
  revalue,
  toppedUp,
  cancelFunding,
} from "../src/chainledger.js";
import { decodeTopLevel, decodeTrace, judgeApprovals, permitsInTypedData, TOPIC, type TraceFrame } from "../src/rails/decode.js";
import { ChainRail } from "../src/rails/chain.js";
import { CHAINS, NATIVE, PERMIT2, SANCTIONS_ORACLE } from "../src/rails/chains.js";
import { reconcileAll, chainPaused } from "../src/rails/reconcile.js";
import { redactSecrets, setKnownHash, setSecretAlarm } from "../src/scrub.js";
import { runChainTool } from "../src/chaintools.js";

const W = getAddress("0x3FebD5b30D549da73e348BBEC63f83f7b2cD2fBF");
const ROUTER = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5";
const USDC = CHAINS.base.stable.address;
const WETH = CHAINS.base.weth;
const MAXU = (1n << 256n) - 1n;
const pad = (a: string) => "0x" + a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const word = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");

let db: DB;
beforeEach(() => {
  db = openDb(":memory:");
  seedAgent(db, "claude", "Claude", "claude-opus-5-5");
  seedAgent(db, "gpt", "Gpt", "gpt-6-astra");
  seedAgent(db, "gemini", "Gemini", "gemini-3.1-pro");
});

describe("trace decoding (preview)", () => {
  it("reads native out from call values, token in from Transfer logs, and ignores reverted frames", () => {
    const trace: TraceFrame = {
      from: W,
      to: ROUTER,
      value: "0x38d7ea4c68000", // 0.001 ETH
      calls: [
        { from: ROUTER, to: USDC, logs: [{ address: USDC, topics: [TOPIC.transfer, pad(ROUTER), pad(W)], data: word(2_690_314n) }] },
        // a reverted branch would have paid more: it must not count
        { from: ROUTER, to: USDC, error: "execution reverted", logs: [{ address: USDC, topics: [TOPIC.transfer, pad(ROUTER), pad(W)], data: word(999n) }] },
      ],
    };
    const p = decodeTrace(trace, W);
    expect(p.moves[NATIVE.toLowerCase()]).toBe(-1_000_000_000_000_000n);
    expect(p.moves[USDC.toLowerCase()]).toBe(2_690_314n);
    expect(p.reverted).toBe(false);
  });

  it("finds ERC-20, Permit2 and ApprovalForAll approvals granted by the wallet", () => {
    const permit2Data = AbiCoder.defaultAbiCoder().encode(["uint160", "uint48"], [(1n << 160n) - 1n, 2n ** 48n - 1n]);
    const p = decodeTrace(
      {
        from: W,
        to: ROUTER,
        logs: [
          { address: USDC, topics: [TOPIC.approval, pad(W), pad(ROUTER)], data: word(MAXU) },
          { address: PERMIT2, topics: [TOPIC.permit2Approval, pad(W), pad(USDC), pad(ROUTER)], data: permit2Data },
          { address: "0x" + "ab".repeat(20), topics: [TOPIC.approvalForAll, pad(W), pad(ROUTER)], data: word(1n) },
        ],
      },
      W
    );
    expect(p.approvals.map((a) => a.kind)).toEqual(["erc20", "permit2", "all"]);
    expect(p.approvals[0].amount).toBe(MAXU);
  });
});

describe("the approval rules (Security Q12-Q16)", () => {
  const now = 1_790_000_000;
  const held = () => 10_000_000n; // 10 USDC
  const erc = (amount: bigint) => [{ kind: "erc20" as const, token: USDC.toLowerCase(), spender: ROUTER.toLowerCase(), amount }];

  it("refuses max, 2^255 and balance+1; signs exact and revokes", () => {
    expect(judgeApprovals(erc(MAXU), held, now).refusals).toHaveLength(1);
    expect(judgeApprovals(erc(1n << 255n), held, now).refusals).toHaveLength(1);
    expect(judgeApprovals(erc(10_000_001n), held, now).refusals).toHaveLength(1);
    expect(judgeApprovals(erc(10_000_000n), held, now).refusals).toHaveLength(0);
    expect(judgeApprovals(erc(0n), held, now).refusals).toHaveLength(0);
  });

  it("refuses Permit2 allowances past 24h or never-expiring; signs one within the hour", () => {
    const p2 = (expiration: number) => [{ kind: "permit2" as const, token: USDC.toLowerCase(), spender: ROUTER.toLowerCase(), amount: 1_000_000n, expiration }];
    expect(judgeApprovals(p2(now + 25 * 3600), held, now).refusals).toHaveLength(1);
    expect(judgeApprovals(p2(2 ** 48 - 1), held, now).refusals).toHaveLength(1);
    expect(judgeApprovals(p2(now + 3600), held, now).refusals).toHaveLength(0);
  });

  it("allows setApprovalForAll with a flag", () => {
    const r = judgeApprovals([{ kind: "all", token: "0x" + "ab".repeat(20), spender: ROUTER.toLowerCase(), amount: 1n }], held, now);
    expect(r.refusals).toHaveLength(0);
    expect(r.flags[0]).toMatch(/ALL of your NFTs/);
  });

  it("decodes top-level approve calldata when there is no simulator", () => {
    const data = "0x095ea7b3" + pad(ROUTER).slice(2) + word(MAXU).slice(2);
    expect(decodeTopLevel(USDC, data)[0]).toMatchObject({ kind: "erc20", amount: MAXU });
  });

  it("reads permits out of EIP-712 typed data", () => {
    const single = permitsInTypedData({
      domain: { name: "Permit2", chainId: 8453, verifyingContract: PERMIT2 },
      types: {},
      primaryType: "PermitSingle",
      message: { details: { token: USDC, amount: String(MAXU >> 96n), expiration: String(2 ** 48 - 1), nonce: "0" }, spender: ROUTER, sigDeadline: String(now + 600) },
    });
    expect(judgeApprovals(single, held, now).refusals.length).toBeGreaterThan(0);
    const eip2612 = permitsInTypedData({
      domain: { name: "USD Coin", verifyingContract: USDC },
      types: {},
      primaryType: "Permit",
      message: { owner: W, spender: ROUTER, value: "5000000", nonce: "0", deadline: MAXU.toString() },
    });
    expect(judgeApprovals(eip2612, held, now).refusals[0]).toMatch(/24 hours/);
  });
});

// ------------------------------------------------------------------ a fake chain for the rail

interface FakeTransfer {
  hash: string;
  from: string;
  to: string;
  token: string; // NATIVE or ERC-20
  amount: bigint;
}

function fakeChain(opts: {
  transfers?: FakeTransfer[];
  initiators?: Record<string, string>;
  holdings?: Record<string, bigint>; // token -> amount for W on base
  quotes?: Record<string, bigint>; // token -> stable out for any amount
  sanctioned?: string[];
  trace?: TraceFrame;
}) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith("http://kyber/")) {
      const q = new URL(u);
      const tin = (q.searchParams.get("tokenIn") ?? "").toLowerCase();
      const out = opts.quotes?.[tin];
      return new Response(JSON.stringify(out !== undefined ? { code: 0, data: { routeSummary: { amountOut: out.toString() } } } : { code: 4011, message: "no route" }));
    }
    const body = JSON.parse(String(init?.body ?? "{}"));
    const chain = u.includes("robinhood") ? "robinhood" : u.includes("ethereum") ? "ethereum" : "base";
    calls.push(`${chain}:${body.method}`);
    const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    const p = body.params ?? [];
    switch (body.method) {
      case "eth_blockNumber":
        return ok("0x1000");
      case "alchemy_getAssetTransfers": {
        if (chain !== "base") return ok({ transfers: [] });
        const f = p[0];
        const list = (opts.transfers ?? []).filter((t) =>
          f.toAddress ? t.to.toLowerCase() === f.toAddress.toLowerCase() : t.from.toLowerCase() === f.fromAddress.toLowerCase()
        );
        return ok({
          transfers: list.map((t) => ({
            hash: t.hash,
            from: t.from,
            to: t.to,
            blockNum: "0x10",
            category: t.token === NATIVE ? "external" : "erc20",
            rawContract: { address: t.token === NATIVE ? null : t.token, value: "0x" + t.amount.toString(16) },
          })),
        });
      }
      case "eth_getTransactionByHash":
        return ok({ from: opts.initiators?.[p[0]] ?? "0x0" });
      case "eth_getBalance":
        return ok("0x" + (chain === "base" && p[0].toLowerCase() === W.toLowerCase() ? opts.holdings?.[NATIVE] ?? 0n : 0n).toString(16));
      case "alchemy_getTokenBalances": {
        const hs = chain === "base" && p[0].toLowerCase() === W.toLowerCase() ? opts.holdings ?? {} : {};
        return ok({
          tokenBalances: Object.entries(hs)
            .filter(([t]) => t !== NATIVE)
            .map(([t, a]) => ({ contractAddress: t, tokenBalance: "0x" + a.toString(16) })),
        });
      }
      case "eth_call": {
        const { to, data } = p[0];
        if (to.toLowerCase() === SANCTIONS_ORACLE.toLowerCase()) {
          const who = "0x" + data.slice(-40);
          return ok(word((opts.sanctioned ?? []).map((s) => s.toLowerCase()).includes(who.toLowerCase()) ? 1n : 0n));
        }
        if (data.startsWith("0x70a08231")) return ok(word(opts.holdings?.[to.toLowerCase()] ?? 0n)); // balanceOf
        if (data.startsWith("0x313ce567")) return ok(word(to.toLowerCase() === USDC.toLowerCase() ? 6n : 18n)); // decimals
        return ok("0x");
      }
      case "debug_traceCall":
        return opts.trace ? ok(opts.trace) : new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32600, message: "not available" } }));
      default:
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: `fake: ${body.method}` } }));
    }
  }) as typeof fetch;
  const rail = new ChainRail(
    [
      { agentId: "claude", address: W, keyEnv: "T_KEY_CLAUDE" },
      { agentId: "gpt", address: "0x2255646E90E1B522bEEC101a68f9861777b282c2", keyEnv: "T_KEY_GPT" },
    ],
    { fetchImpl, rpcUrl: (c) => `http://rpc/${c.key}`, kyberBase: "http://kyber" }
  );
  return { rail, calls };
}

describe("ledger follows chain (the reconciler)", () => {
  const OP = "0x2d43Be7B2a3F785aF170A837a01893d0Ac96b516";
  const X = "0x" + "77".repeat(20);
  const SPAM = "0x" + "5a".repeat(20);
  const GPT = "0x2255646E90E1B522bEEC101a68f9861777b282c2";
  const h = (n: number) => "0x" + n.toString(16).padStart(64, "0");
  const scenario = () => ({
    transfers: [
      { hash: h(1), from: OP, to: W, token: NATIVE, amount: 1_840_000_000_000_000n }, // the $5 gas
      { hash: h(2), from: W, to: ROUTER, token: USDC, amount: 1_000_000n }, // its own swap, out
      { hash: h(2), from: ROUTER, to: W, token: WETH.toLowerCase(), amount: 700_000_000_000_000n }, // its own swap, in
      { hash: h(3), from: X, to: W, token: USDC, amount: 3_000_000n }, // a customer pays
      { hash: h(4), from: X, to: W, token: SPAM, amount: 10n ** 24n }, // airdropped spam
      { hash: h(5), from: GPT, to: W, token: USDC, amount: 1_000_000n }, // a rival pays
    ],
    initiators: { [h(1)]: OP, [h(2)]: W, [h(3)]: X, [h(4)]: X, [h(5)]: GPT },
    holdings: {
      [NATIVE]: 1_840_000_000_000_000n,
      [USDC.toLowerCase()]: 3_000_000n,
      [WETH.toLowerCase()]: 700_000_000_000_000n,
      [SPAM]: 10n ** 24n,
    },
    quotes: { [NATIVE.toLowerCase()]: 5_000_000n, [WETH.toLowerCase()]: 2_000_000n, [SPAM]: 9_999_000_000n },
  });

  it("books gas as a grant, customers and rivals as revenue, its own swap as nothing, spam as $0", async () => {
    const { rail } = fakeChain(scenario());
    db.prepare(`INSERT INTO chain_txlog (ts, agent_id, chain, kind, tx_hash, summary) VALUES ('t','claude','base','swap',?, 'swap')`).run(h(2));
    const notes: string[] = [];
    const r = await reconcileAll(db, { rail, operatorAddr: OP, notify: (t) => notes.push(t) });
    expect(r.ok).toBe(true);
    const revs = db.prepare(`SELECT subtype, payload FROM events WHERE type = 'revenue' AND agent_id = 'claude'`).all() as { payload: string }[];
    expect(revs.map((x) => JSON.parse(x.payload).gross).sort()).toEqual([1_000_000, 3_000_000]); // never the swap output
    expect(chainBasis(db, "claude")).toBe(5_000_000); // the grant
    // value = gas $5 + USDC $3 + WETH $2; the spam token quotes $9,999 but counts $0
    expect(balance(db, acct.chain("claude"))).toBe(10_000_000);
    expect(chainProfit(db, "claude")).toBe(5_000_000);
    expect(selfView(db, "claude").funnel.sold).toBe(2);
    expect(chainPaused(db, "claude")).toBeNull();
  });

  it("re-running across the same blocks books nothing twice (restart, reindex overlap)", async () => {
    const { rail } = fakeChain(scenario());
    db.prepare(`INSERT INTO chain_txlog (ts, agent_id, chain, kind, tx_hash, summary) VALUES ('t','claude','base','swap',?, 'swap')`).run(h(2));
    const ctx = { rail, operatorAddr: OP, notify: () => {} };
    await reconcileAll(db, ctx);
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number }).n;
    db.prepare(`DELETE FROM chain_seen`).run(); // as if the dedupe table were lost: external refs still hold
    await reconcileAll(db, ctx);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number }).n).toBe(n);
    expect(balance(db, acct.chain("claude"))).toBe(10_000_000);
  });

  it("a wallet-started transaction the world never signed pauses crypto and alarms (plan Q4)", async () => {
    const { rail } = fakeChain(scenario()); // h(2) is NOT in chain_txlog
    const notes: string[] = [];
    await reconcileAll(db, { rail, operatorAddr: OP, notify: (t) => notes.push(t) });
    expect(chainPaused(db, "claude")).toMatch(/breach/);
    expect(notes.join("\n")).toMatch(/never signed/);
    const [st, body] = await runChainTool({ db, rail, operatorAddr: OP, notify: () => {} }, "claude", "crypto_tx", { chain: "base", to: W, data: "0x" });
    expect(st).toBe(409);
    expect(String(body.error)).toMatch(/paused/);
  });

  it("a desk fill is booked when it is made and never again by the reconciler (desk D1)", async () => {
    const id = reserveFunding(db, "claude", "base", 2_000_000);
    const { landFunding, deskSettlement } = await import("../src/chainledger.js");
    db.prepare(`INSERT INTO chain_txlog (ts, agent_id, chain, kind, tx_hash, summary) VALUES ('t','claude','base','desk',?, 'desk')`).run(h(11));
    landFunding(db, id, h(11), true);
    expect(deskSettlement(db, "claude")).toBe(2_000_000);
    const { rail } = fakeChain({
      transfers: [{ hash: h(11), from: OP, to: W, token: USDC, amount: 2_000_000n }],
      initiators: { [h(11)]: OP },
      holdings: { [USDC.toLowerCase()]: 2_000_000n },
    });
    await reconcileAll(db, { rail, operatorAddr: OP, notify: () => {} });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM events WHERE subtype IN ('chain:grant','revenue:crypto')`).get()).toEqual({ n: 0 });
    expect(balance(db, acct.chain("claude"))).toBe(2_000_000);
    expect(chainBasis(db, "claude")).toBe(2_000_000);
  });

  it("operator coins matching a pending request land as funding (float -> transit -> chain, into basis)", async () => {
    const id = reserveFunding(db, "claude", "base", 2_000_000);
    expect(balance(db, acct.float("claude"))).toBe(usd(65));
    expect(balance(db, acct.transit("claude"))).toBe(2_000_000);
    const { rail } = fakeChain({
      transfers: [{ hash: h(9), from: OP, to: W, token: USDC, amount: 2_000_000n }],
      initiators: { [h(9)]: OP },
      holdings: { [USDC.toLowerCase()]: 2_000_000n },
    });
    await reconcileAll(db, { rail, operatorAddr: OP, notify: () => {} });
    expect(balance(db, acct.transit("claude"))).toBe(0);
    expect(balance(db, acct.chain("claude"))).toBe(2_000_000);
    expect(chainBasis(db, "claude")).toBe(2_000_000);
    expect((db.prepare(`SELECT status FROM chain_requests WHERE id = ?`).get(id) as { status: string }).status).toBe("done");
    expect(chainProfit(db, "claude")).toBe(0); // converted float is not profit (the bounty rule)
  });
});

describe("chain exits: tax only on gain beyond basis (Data Q2-Q10)", () => {
  it("taxes 5% of the part beyond basis, holds float in transit until topped up", () => {
    landGrant(db, "claude", 5_000_000, "base", "0xg", "gas"); // basis $5
    landChainRevenue(db, "claude", 15_000_000, "base", "0xr", "0xcustomer", USDC); // untaxed on arrival
    expect(balance(db, acct.fund)).toBe(0);
    const before = netWorth(db, "claude");
    const x = bookExit(db, "claude", "float", "base", 12_000_000, "0xexit");
    expect(x.gain).toBe(7_000_000); // 12 - 5 basis
    expect(x.tax).toBe(350_000);
    expect(balance(db, acct.transit("claude"))).toBe(11_650_000);
    expect(chainBasis(db, "claude")).toBe(0);
    expect(netWorth(db, "claude")).toBe(before - 350_000);
    toppedUp(db, x.requestId);
    expect(balance(db, acct.float("claude"))).toBe(usd(67) + 11_650_000);
    expect(exitTax(db, "claude", 1_000_000).gain).toBe(1_000_000); // basis used up: all gain now
  });

  it("with the desk, a withdrawal lands in float at once and the card is owed the net", async () => {
    const { deskSettlement, clearSettlement } = await import("../src/chainledger.js");
    landChainRevenue(db, "claude", 4_000_000, "base", "0xr3", "0xc", USDC);
    const x = bookExit(db, "claude", "float", "base", 4_000_000, "0xexit3", true);
    expect(balance(db, acct.float("claude"))).toBe(usd(67) + x.net);
    expect(balance(db, acct.transit("claude"))).toBe(0);
    expect(deskSettlement(db, "claude")).toBe(-x.net);
    expect(clearSettlement(db, "claude")).toBe(-x.net);
    expect(deskSettlement(db, "claude")).toBe(0);
  });

  it("buying credits from chain lands credits at once, same tax", () => {
    landChainRevenue(db, "claude", 4_000_000, "base", "0xr2", "0xc", USDC);
    const before = balance(db, acct.credits("claude"));
    const x = bookExit(db, "claude", "credits", "base", 4_000_000, "0xexit2");
    expect(balance(db, acct.credits("claude"))).toBe(before + 3_800_000);
    expect(x.tax).toBe(200_000);
  });

  it("a cancelled funding request returns the float", () => {
    const id = reserveFunding(db, "claude", "robinhood", 3_000_000);
    cancelFunding(db, id, "no");
    expect(balance(db, acct.float("claude"))).toBe(usd(67));
    expect(balance(db, acct.transit("claude"))).toBe(0);
  });

  it("revaluation books the gap and marks only real moves for the public feed", () => {
    landGrant(db, "claude", 5_000_000, "base", "0xg2", "gas");
    const small = revalue(db, "claude", 5_200_000, []);
    expect(small.delta).toBe(200_000);
    const big = revalue(db, "claude", 9_000_000, []);
    const feeds = (db.prepare(`SELECT json_extract(payload,'$.feed') AS f FROM events WHERE subtype = 'chain:reval' ORDER BY id`).all() as { f: number }[]).map((r) => r.f);
    expect(feeds).toEqual([0, 1]);
    expect(big.delta).toBe(3_800_000);
  });

  it("execution passes transit like float; chain value waits for the on-chain estate transfers", () => {
    landGrant(db, "claude", 5_000_000, "base", "0xg3", "gas");
    reserveFunding(db, "claude", "base", 1_000_000);
    executeAgent(db, "claude", ["gpt", "gemini"], "test");
    expect(balance(db, acct.transit("claude"))).toBe(0);
    expect(balance(db, acct.chain("claude"))).toBe(5_000_000); // moves only with real transfers (chainEstate)
  });
});

describe("sanctions and signing refusals", () => {
  it("refuses a transaction to a sanctioned address (oracle true)", async () => {
    const LAZARUS = "0x098B716B8Aaf21512996dC57EB0615e2383E2f96";
    const { rail } = fakeChain({ sanctioned: [LAZARUS] });
    process.env.T_KEY_CLAUDE = Wallet.createRandom().privateKey;
    const [st, body] = await runChainTool({ db, rail, operatorAddr: null, notify: () => {} }, "claude", "crypto_tx", { chain: "base", to: LAZARUS, data: "0x" });
    expect(st).toBe(200);
    expect(body.refused).toBe(true);
    expect(String((body.refusals as string[])[0])).toMatch(/sanctions/);
  });

  it("an unlimited approval in calldata is refused even without a simulator", async () => {
    const { rail } = fakeChain({ holdings: { [USDC.toLowerCase()]: 5_000_000n } });
    const data = "0x095ea7b3" + pad(ROUTER).slice(2) + word(MAXU).slice(2);
    const [, body] = await runChainTool({ db, rail, operatorAddr: null, notify: () => {} }, "claude", "crypto_tx", { chain: "base", to: USDC, data });
    expect(body.refused).toBe(true);
    expect(String((body.refusals as string[])[0])).toMatch(/unlimited approval/);
  });

  it("previews without signing until confirm, and says when it could not simulate", async () => {
    const { rail } = fakeChain({});
    const [st, body] = await runChainTool({ db, rail, operatorAddr: null, notify: () => {} }, "claude", "crypto_tx", { chain: "base", to: ROUTER, data: "0x" });
    expect(st).toBe(200);
    expect(body.signed).toBe(false);
    expect((body.flags as string[]).join(" ")).toMatch(/no preview/);
  });

  it("raw-hash signing is never offered", async () => {
    const { rail } = fakeChain({});
    process.env.T_KEY_CLAUDE = Wallet.createRandom().privateKey;
    const [, body] = await runChainTool({ db, rail, operatorAddr: null, notify: () => {} }, "claude", "crypto_sign_message", {
      chain: "base",
      kind: "eth_sign",
      message: "0x" + "11".repeat(32),
    });
    expect(body.refused).toBe(true);
    expect(String((body.refusals as string[])[0])).toMatch(/Raw-hash/);
  });

  it("register_wallet proves control with a signature", async () => {
    const { rail } = fakeChain({});
    const own = Wallet.createRandom();
    const ctx = { db, rail, operatorAddr: null, notify: () => {} };
    const [, first] = await runChainTool(ctx, "claude", "register_wallet", { address: own.address });
    const [, bad] = await runChainTool(ctx, "claude", "register_wallet", { address: own.address, signature: await Wallet.createRandom().signMessage(String(first.sign_this)) });
    expect(String(bad.error)).toMatch(/does not prove/);
    const [, good] = await runChainTool(ctx, "claude", "register_wallet", { address: own.address, signature: await own.signMessage(String(first.sign_this)) });
    expect(good.registered).toBe(true);
  });
});

describe("address poisoning (look-alikes seen live 2026-10-01)", () => {
  // The real dust senders, verbatim from Base, against the real wallets they imitate.
  const PAIRS: [string, string][] = [
    ["0x3fe410c3b682665299f38e2cf81089ebd0472fbf", "0x3FebD5b30D549da73e348BBEC63f83f7b2cD2fBF"],
    ["0x3fe44850e9a5de3e615cb465f66f8fb1e9472fbf", "0x3FebD5b30D549da73e348BBEC63f83f7b2cD2fBF"],
    ["0x225a66532b6d23ae627ef6b6f225760265c682c2", "0x2255646E90E1B522bEEC101a68f9861777b282c2"],
    ["0x225abd9bd362dcf2ca7157a867a5307d2f1682c2", "0x2255646E90E1B522bEEC101a68f9861777b282c2"],
    ["0xe3ead9374d1c6af778a688a0d79a8e8a11f6cf50", "0xE3Ed5DFB737683dB1073E0fB495135d4D91CCF50"],
    ["0xe3ea28aff416ebf1578b9a14b75ff4a6f0d6cf50", "0xE3Ed5DFB737683dB1073E0fB495135d4D91CCF50"],
    ["0x2d4356aeb28c79aaf478eac893882471adc6b516", "0x2d43Be7B2a3F785aF170A837a01893d0Ac96b516"],
  ];
  it("flags every real poisoner and never the real wallet", async () => {
    const { lookalikeOf } = await import("../src/rails/decode.js");
    const known = [...new Set(PAIRS.map((p) => p[1]))];
    for (const [fake, real] of PAIRS) expect(lookalikeOf(fake, known)?.toLowerCase()).toBe(real.toLowerCase());
    for (const real of known) expect(lookalikeOf(real, known)).toBeNull();
    expect(lookalikeOf("0x" + "12".repeat(20), known)).toBeNull();
  });

  it("refuses a send to the fake operator and to a fake rival; the real rival goes through to the preview", async () => {
    const { rail } = fakeChain({ holdings: { [USDC.toLowerCase()]: 5_000_000n } });
    rail.setKnownAddresses(() => ["0x2d43Be7B2a3F785aF170A837a01893d0Ac96b516"]);
    const ctx = { db, rail, operatorAddr: null, notify: () => {} };
    const [, fakeOp] = await runChainTool(ctx, "claude", "crypto_tx", { chain: "base", to: "0x2d4356aeb28c79aaf478eac893882471adc6b516", data: "0x", value_wei: "1" });
    expect(fakeOp.refused).toBe(true);
    expect(String((fakeOp.refusals as string[])[0])).toMatch(/look-alike/);
    const [, fakeRival] = await runChainTool(ctx, "claude", "crypto_send", { chain: "base", to: "0x225a66532b6d23ae627ef6b6f225760265c682c2", amount_usd: 1 });
    expect(fakeRival.refused).toBe(true);
    const [, realRival] = await runChainTool(ctx, "claude", "crypto_tx", { chain: "base", to: "0x2255646E90E1B522bEEC101a68f9861777b282c2", data: "0x", value_wei: "1" });
    expect(realRival.refused).toBeUndefined();
    expect(realRival.signed).toBe(false); // previewed, waiting for confirm
  });
});

describe("nonces under a lagging node", () => {
  it("two fast sends never reuse a nonce even when the node keeps answering the old pending count", async () => {
    const key = Wallet.createRandom();
    process.env.T_NONCE_KEY = key.privateKey;
    const nonces: number[] = [];
    const fetchImpl = (async (_u: string, init?: RequestInit) => {
      const b = JSON.parse(String(init?.body));
      const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: b.id, result }));
      switch (b.method) {
        case "eth_getTransactionCount": return ok("0x7"); // stale: never moves
        case "eth_estimateGas": return ok("0x5208");
        case "eth_getBlockByNumber": return ok({ baseFeePerGas: "0x1" });
        case "eth_maxPriorityFeePerGas": return ok("0x1");
        case "eth_sendRawTransaction": {
          const { Transaction } = await import("ethers");
          nonces.push(Transaction.from(b.params[0]).nonce);
          return ok("0x" + String(nonces.length).padStart(64, "0"));
        }
        default: return ok(null);
      }
    }) as typeof fetch;
    const rail = new ChainRail([{ agentId: "claude", address: key.address, keyEnv: "T_NONCE_KEY" }], { fetchImpl, rpcUrl: () => "http://rpc" });
    await Promise.all([
      rail.send(CHAINS.base, "claude", { to: W, data: "0x", value: 1n }, false),
      rail.send(CHAINS.base, "claude", { to: W, data: "0x", value: 1n }, false),
    ]);
    expect(nonces).toEqual([7, 8]);
  });
});

describe("wallet secrets never reach the public site", () => {
  it("masks a seed phrase and a bare key, alarms, and leaves explorer links and known hashes alone", () => {
    const alarms: string[] = [];
    setSecretAlarm((k) => alarms.push(k));
    const known = "0x" + "ab".repeat(32);
    setKnownHash((x) => x === known);
    const seed = Wallet.createRandom().mnemonic!.phrase;
    const key = Wallet.createRandom().privateKey;
    const out = redactSecrets(`my words are ${seed} and my key is ${key.slice(2)} ok`);
    expect(out).not.toContain(seed.split(" ")[3] + " " + seed.split(" ")[4]);
    expect(out).toContain("[seed phrase redacted]");
    expect(out).toContain("[key redacted]");
    expect(alarms.length).toBeGreaterThan(0);
    const link = `see https://basescan.org/tx/0x${"cd".repeat(32)} and ${known}`;
    expect(redactSecrets(link)).toBe(link);
    const prose = "I wrote to the studio about their broken checkout and they did not answer";
    expect(redactSecrets(prose)).toBe(prose);
    setSecretAlarm(null);
    setKnownHash(() => false);
  });
});

describe("event ids used in this file are real topics", () => {
  it("Transfer topic", () => expect(TOPIC.transfer).toBe(id("Transfer(address,address,uint256)")));
});

describe("Google quota day follows Pacific time (fixed 2026-10-01)", () => {
  it("starts at 07:05 UTC in summer and 08:05 UTC after the clocks go back", async () => {
    const { quotaDayStart, quotaDayEnd } = await import("../src/proxy.js");
    expect(quotaDayStart(Date.UTC(2026, 9, 1, 18, 0))).toBe("2026-10-01T07:05:00.000Z");
    expect(quotaDayStart(Date.UTC(2026, 9, 1, 6, 0))).toBe("2026-09-30T07:05:00.000Z");
    expect(quotaDayStart(Date.UTC(2026, 10, 2, 7, 30))).toBe("2026-11-01T07:05:00.000Z"); // still yesterday's day until 08:05
    expect(quotaDayStart(Date.UTC(2026, 10, 2, 8, 10))).toBe("2026-11-02T08:05:00.000Z");
    expect(quotaDayEnd(Date.UTC(2026, 10, 1, 12, 0))).toBe("2026-11-02T08:05:00.000Z"); // Nov 1 is 25 hours long
    expect(quotaDayEnd(Date.UTC(2026, 9, 1, 18, 0))).toBe("2026-10-02T07:05:00.000Z");
    expect(quotaDayEnd(Date.UTC(2027, 2, 13, 12, 0))).toBe("2027-03-14T08:05:00.000Z"); // midnight Mar 14 is still PST
    expect(quotaDayEnd(Date.UTC(2027, 2, 14, 12, 0))).toBe("2027-03-15T07:05:00.000Z"); // the 23-hour spring day
  });
});

describe("on-chain bounty reminder (2026-10-02)", () => {
  it("reminds every agent with live standings until someone crosses $25, then names the winner once and stops", async () => {
    const { chainBountyNotice, checkChainBounty, chainBountyWinner } = await import("../src/chainledger.js");
    landGrant(db, "claude", 5_000_000, "base", "0xgb1", "gas");
    revalue(db, "claude", 9_000_000, []); // $4 profit
    const n = chainBountyNotice(db, "claude")!;
    expect(n).toMatch(/BOUNTY IS OPEN: \$500/);
    expect(n).toMatch(/Your on-chain profit now: \$4\.00/);
    expect(n).toMatch(/1\. Claude \(you\): \$4\.00 profit, \$21\.00 to go/);
    expect(chainBountyNotice(db, "gpt")!).toMatch(/1\. Claude: \$4\.00 profit, \$21\.00 to go/); // rivals see the leader
    expect(n).not.toMatch(/—/);
    const told: string[] = [];
    expect(checkChainBounty(db, (t) => told.push(t))).toBeNull(); // not yet
    // converted float is not profit
    reserveFunding(db, "gpt", "base", 30_000_000);
    const { landFunding } = await import("../src/chainledger.js");
    landFunding(db, (db.prepare(`SELECT id FROM chain_requests ORDER BY id DESC LIMIT 1`).get() as { id: number }).id, "0xfund", true);
    expect(checkChainBounty(db, (t) => told.push(t))).toBeNull();
    revalue(db, "claude", 30_500_000, []); // $25.50 profit
    expect(checkChainBounty(db, (t) => told.push(t))).toBe("claude");
    expect(told.join(" ")).toMatch(/bounty is won/);
    expect(chainBountyWinner(db)?.agentId).toBe("claude");
    expect(chainBountyNotice(db, "gpt")).toBeNull();
    expect(checkChainBounty(db, (t) => told.push(t))).toBeNull(); // once
  });
});

describe("Ethereum on the rails (2026-10-04)", () => {
  it("is a known chain with USDC, the shared Kyber router, and is reconciled with the others", async () => {
    const { chainCfg, CHAIN_KEYS, KYBER_ROUTER } = await import("../src/rails/chains.js");
    const c = chainCfg("ethereum");
    expect(c.chainId).toBe(1);
    expect(c.stable.symbol).toBe("USDC");
    expect(c.routers).toContain(KYBER_ROUTER);
    expect(chainCfg("eth").key).toBe("ethereum");
    expect(CHAIN_KEYS).toEqual(["base", "robinhood", "ethereum"]);
    expect(() => chainCfg("solana")).toThrow(/use "base", "robinhood" or "ethereum"/);
  });
});

describe("bounty: rival money never wins it", () => {
  it("does not declare a winner who crosses $25 only with a rival's money, alerts the operator once, privately", async () => {
    const { checkChainBounty, chainBountyWinner, chainBountyNotice } = await import("../src/chainledger.js");
    landGrant(db, "gemini", 5_000_000, "base", "0xgr", "gas");
    revalue(db, "gemini", 19_400_000, []); // $14.40 of real profit
    landChainRevenue(db, "gemini", 11_000_000, "base", "0xrival", "gpt", USDC); // $11 from Patch
    const told: string[] = [];
    expect(checkChainBounty(db, (t) => told.push(t))).toBeNull();
    expect(chainBountyWinner(db)).toBeNull();
    expect(told.join(" ")).toMatch(/PRIVATE: .*\$11\.00 of it came from rival agents/);
    expect(checkChainBounty(db, (t) => told.push(t))).toBeNull();
    expect(told.length).toBe(1); // once
    // the agents' wake line still shows plain profit: nothing gives the rule away
    expect(chainBountyNotice(db, "gemini")!).toMatch(/Your on-chain profit now: \$25\.40/);
    expect(chainBountyNotice(db, "gemini")!).not.toMatch(/rival/i);
    // a customer's money still counts
    landChainRevenue(db, "gemini", 11_000_000, "base", "0xcust", "0xabc0000000000000000000000000000000000001", USDC);
    expect(checkChainBounty(db, (t) => told.push(t))).toBe("gemini");
  });
});

describe("score: a dollar earned counts twice (constitution v1.15)", () => {
  it("ranks by net worth plus earned profit, and the dead below the living", async () => {
    const { score, earnedProfit, rankTable, netWorth } = await import("../src/views.js");
    // gpt keeps more money; claude earns $10 on chain
    landGrant(db, "claude", 5_000_000, "base", "0xgs", "gas");
    revalue(db, "claude", 15_000_000, []); // +$10 profit
    db.prepare(`UPDATE balances SET balance = balance + 6000000 WHERE account = 'agent:gpt:float'`).run(); // gpt simply holds $6 more
    expect(earnedProfit(db, "claude")).toBe(10_000_000);
    expect(score(db, "claude")).toBe(netWorth(db, "claude") + 10_000_000);
    const r = rankTable(db);
    expect(r[0].agentId).toBe("claude");
    db.prepare(`UPDATE agents SET status = 'dead' WHERE id = 'claude'`).run();
    expect(rankTable(db)[2].agentId).toBe("claude");
  });
});
