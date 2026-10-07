import { beforeEach, describe, expect, it } from "vitest";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { createApproveInstruction, createSetAuthorityInstruction, AuthorityType, getAssociatedTokenAddressSync } from "@solana/spl-token";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { openDb, type DB } from "../src/db.js";
import { acct, balance } from "../src/ledger.js";
import { seedAgent } from "../src/economy.js";
import { reserveFunding } from "../src/chainledger.js";
import { SolanaRail, solKeysFromEnv, solLookalikeOf, looksLikeTransaction, isSolAddress } from "../src/rails/solana.js";
import { SOLANA } from "../src/rails/chains.js";
import { classifySol, logSol } from "../src/solchain.js";
import { redactWalletSecrets } from "../src/scrub.js";

const USDC = SOLANA.stable.address;
const agentKp = Keypair.generate();
const deskKp = Keypair.generate();
const W = agentKp.publicKey.toBase58();
const DESK_ADDR = deskKp.publicKey.toBase58();
process.env.C67_SOL_KEY_CLAUDE = bs58.encode(agentKp.secretKey);
process.env.C67_SOL_KEY_DESK = bs58.encode(deskKp.secretKey);

// a real OFAC-listed shape: any valid base58 key stands in for a listed address
const LISTED = Keypair.generate().publicKey.toBase58();
const OFAC_CSV = `"123","SOME, ENTITY","individual",...,"Digital Currency Address - SOL ${LISTED}; Digital Currency Address - ETH 0xabc"` + " ".repeat(200_000);

function fakeFetch(handlers: Record<string, (params: unknown[]) => unknown>, ofac = OFAC_CSV): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("ofac")) return new Response(ofac);
    const body = JSON.parse(String(init?.body ?? "{}")) as { method: string; params: unknown[] };
    const h = handlers[body.method];
    if (!h) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -1, message: `no fake for ${body.method}` } }));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: h(body.params) }));
  }) as typeof fetch;
}

const BLOCKHASH = Keypair.generate().publicKey.toBase58();
const baseRpc = {
  getLatestBlockhash: () => ({ value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1 } }),
  getMultipleAccounts: (p: unknown[]) => ({ value: (p[0] as string[]).map(() => null) }),
  simulateTransaction: (p: unknown[]) => ({ value: { err: null, accounts: ((p[1] as { accounts: { addresses: string[] } }).accounts.addresses).map(() => null) } }),
};

const v0 = (payer: PublicKey, ixs: ReturnType<typeof SystemProgram.transfer>[]) =>
  new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: BLOCKHASH, instructions: ixs }).compileToV0Message());

let db: DB;
beforeEach(() => {
  db = openDb(":memory:");
  seedAgent(db, "claude", "Claude", "claude-opus-5-5");
  seedAgent(db, "gpt", "Gpt", "gpt-6-astra");
});

describe("solana rail: keys, addresses, look-alikes", () => {
  it("derives addresses from the env keys, keeps base58 case, and spots a planted look-alike", () => {
    const keys = solKeysFromEnv();
    expect(keys.find((k) => k.agentId === "claude")?.address).toBe(W);
    expect(keys.find((k) => k.agentId === "desk")?.address).toBe(DESK_ADDR);
    expect(isSolAddress(W)).toBe(true);
    // lowercasing does not make an address invalid; it makes it someone else's
    const lower = W.toLowerCase();
    if (isSolAddress(lower)) expect(new PublicKey(lower).toBase58()).not.toBe(W);
    const fake = W.slice(0, 4) + "x".repeat(W.length - 8) + W.slice(-4);
    expect(solLookalikeOf(fake, [W])).toBe(W);
    expect(solLookalikeOf(W, [W])).toBeNull();
  });

  it("signs messages with ed25519, proves ownership, and refuses to sign a transaction disguised as a message", () => {
    const rail = new SolanaRail(solKeysFromEnv(), { fetchImpl: fakeFetch({}) });
    const r = rail.signMessage("claude", "hello world");
    expect(r.signature).toBeTruthy();
    expect(SolanaRail.verifyOwnership("hello world", r.signature!, W)).toBe(true);
    expect(SolanaRail.verifyOwnership("hello world", r.signature!, DESK_ADDR)).toBe(false);
    const tx = v0(agentKp.publicKey, [SystemProgram.transfer({ fromPubkey: agentKp.publicKey, toPubkey: deskKp.publicKey, lamports: 1 })]);
    expect(looksLikeTransaction(tx.serialize())).toBe(true);
    expect(looksLikeTransaction(tx.message.serialize())).toBe(true);
    expect(looksLikeTransaction(new TextEncoder().encode("Sign in to Superteam, nonce 42"))).toBe(false);
  });
});

describe("solana rail: the refusals", () => {
  it("refuses a counterparty on the OFAC list (positive control) and refuses when the list cannot load", async () => {
    const rail = new SolanaRail(solKeysFromEnv(), { fetchImpl: fakeFetch(baseRpc) });
    const tx = await rail.transferTx(W, LISTED, SOLANA.native, 1000n);
    const ev = await rail.evaluate(tx, W);
    expect(ev.refusals.join(" ")).toMatch(/sanctions list/);
    const clean = await rail.evaluate(await rail.transferTx(W, DESK_ADDR, SOLANA.native, 1000n), W);
    expect(clean.refusals).toEqual([]);
    const dark = new SolanaRail(solKeysFromEnv(), { fetchImpl: fakeFetch(baseRpc, "nope") });
    const ev2 = await dark.evaluate(await dark.transferTx(W, DESK_ADDR, SOLANA.native, 1000n), W);
    expect(ev2.refusals.join(" ")).toMatch(/could not be loaded/);
  });

  it("refuses a wallet reassign, a token account handed away, and a delegate above the balance", () => {
    const rail = new SolanaRail(solKeysFromEnv(), { fetchImpl: fakeFetch({}) });
    const ata = getAssociatedTokenAddressSync(new PublicKey(USDC), agentKp.publicKey);
    const thief = Keypair.generate().publicKey;
    const judge = (ixs: Parameters<typeof v0>[1]) => {
      const tx = v0(agentKp.publicKey, ixs);
      const keys = tx.message.staticAccountKeys.map((k) => ({ key: k.toBase58() }));
      return rail.decodeInstructions(tx, keys, W, new Map([[ata.toBase58(), { mint: USDC, owner: W, amount: 5_000_000n }]]));
    };
    expect(judge([SystemProgram.assign({ accountPubkey: agentKp.publicKey, programId: thief })]).refusals.join(" ")).toMatch(/reassigns your wallet/);
    expect(judge([createSetAuthorityInstruction(ata, agentKp.publicKey, AuthorityType.AccountOwner, thief)]).refusals.join(" ")).toMatch(/ownership/);
    expect(judge([createApproveInstruction(ata, thief, agentKp.publicKey, 9_000_000n)]).refusals.join(" ")).toMatch(/more than it holds/);
    const ok = judge([createApproveInstruction(ata, thief, agentKp.publicKey, 2_000_000n)]);
    expect(ok.refusals).toEqual([]);
    expect(ok.approvals[0].amount).toBe(2_000_000n);
  });

  it("refuses to sign anything that does not ask its wallet to sign", async () => {
    const rail = new SolanaRail(solKeysFromEnv(), { fetchImpl: fakeFetch(baseRpc) });
    const other = Keypair.generate();
    const tx = v0(other.publicKey, [SystemProgram.transfer({ fromPubkey: other.publicKey, toPubkey: deskKp.publicKey, lamports: 1 })]);
    expect((await rail.evaluate(tx, W)).refusals.join(" ")).toMatch(/does not ask your wallet/);
  });
});

describe("solana reconcile", () => {
  /** A rail whose history methods are scripted. */
  function scripted(over: Partial<Record<"tokenAccounts" | "signaturesSince" | "movesFor" | "sellQuote", unknown>>) {
    const rail = new SolanaRail(solKeysFromEnv(), { fetchImpl: fakeFetch({}) });
    return Object.assign(rail, over) as SolanaRail;
  }
  const ATA = getAssociatedTokenAddressSync(new PublicKey(USDC), agentKp.publicKey).toBase58();
  const SIG = bs58.encode(nacl.randomBytes(64)); // mixed case, like every real signature

  it("books USDC that arrived in a token account the transfer named instead of the wallet, as revenue, keeping case", async () => {
    const stranger = Keypair.generate().publicKey.toBase58();
    const rail = scripted({
      tokenAccounts: async () => [{ address: ATA, mint: USDC, amount: 5_000_000n }],
      signaturesSince: async (addr: string) => (addr === ATA ? [{ signature: SIG, err: null }] : []),
      movesFor: async () => ({ initiator: stranger, failed: false, moves: [{ token: USDC, delta: 5_000_000n, from: stranger }] }),
      sellQuote: async (_t: string, a: bigint) => a,
    });
    const r = await classifySol(db, { db, sol: rail, notify: () => {} }, "claude");
    expect(r.booked).toBe(1);
    expect(balance(db, acct.chain("claude"))).toBe(5_000_000);
    const seen = db.prepare(`SELECT tx_hash FROM chain_seen WHERE chain = 'solana'`).get() as { tx_hash: string };
    expect(seen.tx_hash).toBe(SIG); // exact case
    // a second pass books nothing twice
    expect((await classifySol(db, { db, sol: rail, notify: () => {} }, "claude")).booked).toBe(0);
  });

  it("matches desk coins to a pending float conversion, and flags an outgoing transaction the world never signed", async () => {
    const id = reserveFunding(db, "claude", "solana", 3_000_000);
    const DESK_SIG = bs58.encode(nacl.randomBytes(64));
    const rail = scripted({
      tokenAccounts: async () => [],
      signaturesSince: async () => [
        { signature: DESK_SIG, err: null },
        { signature: SIG, err: null },
      ],
      movesFor: async (sig: string) =>
        sig === DESK_SIG
          ? { initiator: DESK_ADDR, failed: false, moves: [{ token: USDC, delta: 3_000_000n, from: DESK_ADDR }] }
          : { initiator: W, failed: false, moves: [{ token: USDC, delta: -1_000_000n, from: null }] },
      sellQuote: async (_t: string, a: bigint) => a,
    });
    const r = await classifySol(db, { db, sol: rail, notify: () => {} }, "claude");
    expect((db.prepare(`SELECT status FROM chain_requests WHERE id = ?`).get(id) as { status: string }).status).toBe("done");
    expect(r.breach).toEqual([SIG]);
    // once the world logs it, it is no breach
    logSol(db, "claude", "send", SIG, "test");
    db.prepare(`DELETE FROM chain_seen`).run();
    db.prepare(`DELETE FROM config WHERE key LIKE 'chain_cursor:%'`).run();
    expect((await classifySol(db, { db, sol: rail, notify: () => {} }, "claude")).breach).toEqual([]);
  });

  it("does not move its cursor past a transaction the node has not indexed yet", async () => {
    let indexed = false;
    const rail = scripted({
      tokenAccounts: async () => [],
      signaturesSince: async (_a: string, until: string | null) => (until === SIG ? [] : [{ signature: SIG, err: null }]),
      movesFor: async () => (indexed ? { initiator: Keypair.generate().publicKey.toBase58(), failed: false, moves: [{ token: USDC, delta: 1_000_000n, from: null }] } : null),
      sellQuote: async (_t: string, a: bigint) => a,
    });
    expect((await classifySol(db, { db, sol: rail, notify: () => {} }, "claude")).booked).toBe(0);
    indexed = true;
    expect((await classifySol(db, { db, sol: rail, notify: () => {} }, "claude")).booked).toBe(1);
  });
});

describe("solana secrets in agent text", () => {
  it("redacts a base58 secret key and a keygen array, and leaves a transaction signature alone", () => {
    const kp = Keypair.generate();
    const sig = bs58.encode(nacl.randomBytes(64));
    const out = redactWalletSecrets(`key ${bs58.encode(kp.secretKey)} and ${JSON.stringify(Array.from(kp.secretKey))} and tx ${sig}`);
    expect(out).not.toContain(bs58.encode(kp.secretKey));
    expect(out).not.toContain(JSON.stringify(Array.from(kp.secretKey)));
    expect(out.match(/\[key redacted\]/g)?.length).toBe(2);
    expect(out).toContain(sig);
  });
});

describe("solana reads are fresh", () => {
  it("asks every balance and account read for confirmed commitment (a finalized read lags ~13 s behind a swap)", async () => {
    const seen: Record<string, unknown[]> = {};
    const rec = (m: string, result: unknown) => (p: unknown[]) => ((seen[m] = p), result);
    const rail = new SolanaRail(solKeysFromEnv(), {
      fetchImpl: fakeFetch({
        getTokenAccountsByOwner: rec("getTokenAccountsByOwner", { value: [] }),
        getBalance: rec("getBalance", { value: 0 }),
        getMultipleAccounts: rec("getMultipleAccounts", { value: [null] }),
      }),
    });
    await rail.holdings(W);
    expect(JSON.stringify(seen.getTokenAccountsByOwner)).toContain('"commitment":"confirmed"');
    expect(JSON.stringify(seen.getBalance)).toContain('"commitment":"confirmed"');
  });
});
