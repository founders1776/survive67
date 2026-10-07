import { VersionedTransaction } from "@solana/web3.js";
import { randomBytes } from "node:crypto";
import type { DB } from "./db.js";
import { nowUtc, usd, fmtUsd } from "./db.js";
import { acct, appendEvent, balance } from "./ledger.js";
import { bookEstate, bookExit, cancelFunding, landChainRevenue, landFunding, landGrant, reserveFunding } from "./chainledger.js";
import { ChainError, DESK, type SendResult } from "./rails/chain.js";
import { SOLANA } from "./rails/chains.js";
import { SolanaRail, isSolAddress, type SolPreview } from "./rails/solana.js";

/**
 * Solana for the crypto tools, the reconciler, the desk and the estate
 * (plan-sol.md). Mirrors chaintools.ts / reconcile.ts / chainestate.ts for the
 * EVM chains; the ledger functions are shared, keyed by chain "solana".
 *
 * Base58 is case-sensitive: addresses, mints and signatures are stored exactly
 * as they are. The EVM helpers lowercase; none of them is used here.
 */

type Json = Record<string, unknown>;
type Result = [number, Json];

export interface SolCtx {
  db: DB;
  sol: SolanaRail;
  notify: (text: string) => void;
}

const KEY = SOLANA.key;
/** Lamports the desk and an emptied wallet keep back for fees and rent. */
export const SOL_FEE_RESERVE = 20_000_000n; // 0.02 SOL
const SOL_WALLET_RESERVE = 3_000_000n; // 0.003 SOL: fees for a few sends, rent for one token account

const fmtUnits = (v: bigint, dec: number): string => {
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().padStart(dec + 1, "0");
  const whole = s.slice(0, s.length - dec);
  const frac = s.slice(s.length - dec).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
};

function parseUnits(human: unknown, dec: number): bigint {
  const s = String(human ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new ChainError(`not an amount: ${s}`);
  const [w, f = ""] = s.split(".");
  if (f.length > dec) throw new ChainError(`too many decimals for this token (max ${dec})`);
  return BigInt(w + f.padEnd(dec, "0"));
}

function tokenArg(v: unknown): string {
  const s = String(v ?? "").trim();
  const u = s.toUpperCase();
  if (u === "SOL" || u === "NATIVE") return SOLANA.native;
  if (u === "USDC" || u === "USD" || u === "STABLE") return SOLANA.stable.address;
  if (u === "WSOL") return SOLANA.wsol;
  if (isSolAddress(s)) return s;
  throw new ChainError(`unknown token "${s}" on solana: use a mint address, SOL or USDC`);
}

const symbol = (t: string) => (t === SOLANA.native ? "SOL" : t === SOLANA.stable.address ? "USDC" : t === SOLANA.wsol ? "WSOL" : `${t.slice(0, 4)}…${t.slice(-4)}`);

export function logSol(db: DB, agentId: string, kind: string, sig: string | null, summary: string, detail: Json = {}): void {
  db.prepare(`INSERT INTO chain_txlog (ts, agent_id, chain, kind, tx_hash, summary, detail) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    nowUtc(),
    agentId,
    KEY,
    kind,
    sig, // exact case
    summary.slice(0, 300),
    JSON.stringify(detail, (_k, v) => (typeof v === "bigint" ? v.toString() : v)).slice(0, 4000)
  );
}

async function describe(sol: SolanaRail, p: SolPreview | null): Promise<Json | null> {
  if (!p) return null;
  const moves = [];
  for (const [token, d] of Object.entries(p.moves)) {
    const dec = await sol.decimals(token).catch(() => 0);
    moves.push({ token, symbol: symbol(token), [d < 0n ? "leaves" : "arrives"]: fmtUnits(d < 0n ? -d : d, dec) });
  }
  const approvals = p.approvals.map((a) => ({ kind: a.kind, token: a.token, delegate: a.spender, amount: a.amount.toString() }));
  return { moves, approvals, touches: p.touched.length, reverts: p.reverted ? p.error ?? true : false };
}

const refused = (refusals: string[], extra: Json = {}): Result => [
  200,
  { signed: false, refused: true, refusals, ...extra, note: "The world refuses only these things. Change the transaction and call again." },
];

/** Every token the wallet sent or bought itself is "solicited": it counts at its sale value. */
function markToken(db: DB, agentId: string, token: string, solicited: boolean): void {
  db.prepare(
    `INSERT INTO chain_tokens (agent_id, chain, token, solicited) VALUES (?, ?, ?, ?)
     ON CONFLICT(agent_id, chain, token) DO UPDATE SET solicited = MAX(solicited, excluded.solicited)`
  ).run(agentId, KEY, token, solicited ? 1 : 0);
}

function isSolicited(db: DB, agentId: string, token: string): boolean {
  if (token === SOLANA.native || token === SOLANA.stable.address) return true;
  const r = db.prepare(`SELECT solicited FROM chain_tokens WHERE agent_id = ? AND chain = ? AND token = ?`).get(agentId, KEY, token) as { solicited: number } | undefined;
  return !!r?.solicited;
}

function registeredSol(db: DB, agentId: string): string[] {
  return (db.prepare(`SELECT address FROM chain_wallets WHERE agent_id = ?`).all(agentId) as { address: string }[]).map((r) => r.address).filter(isSolAddress);
}

// ------------------------------------------------------------------ tools

export async function runSolTool(ctx: SolCtx, agentId: string, tool: string, b: Json, takeQuota: () => string | null): Promise<Result> {
  const { db, sol } = ctx;
  const wallet = sol.addressOf(agentId);
  if (!wallet || !sol.configured) return [501, { error: "Solana rail not configured" }];
  const operator = sol.addressOf(DESK);
  try {
    switch (tool) {
      case "crypto_tx": {
        const raw = String(b.transaction ?? "");
        if (!raw) return [400, { error: "on solana, crypto_tx takes `transaction`: the base64 serialized transaction a dapp gave you" }];
        let tx: VersionedTransaction;
        try {
          tx = VersionedTransaction.deserialize(Buffer.from(raw, "base64"));
        } catch {
          return [400, { error: "transaction is not a base64 serialized Solana transaction (legacy or v0)" }];
        }
        if (b.confirm !== true) {
          const q = takeQuota();
          if (q) return [429, { error: q }];
        }
        const ev = await sol.evaluate(tx, wallet);
        if (ev.refusals.length) return refused(ev.refusals, { preview: await describe(sol, ev.preview) });
        if (b.confirm !== true) {
          return [
            200,
            {
              signed: false,
              preview: await describe(sol, ev.preview),
              flags: ev.flags,
              next: "Read the preview. To sign exactly this, call crypto_tx again with chain solana, the same transaction and confirm: true. A dapp transaction carries a recent blockhash and expires in about a minute: get a fresh one if it does.",
            },
          ];
        }
        const r = await sol.send(agentId, tx, b.wait !== false);
        logSol(db, agentId, "tx", r.txHash, `solana tx through ${[...new Set(tx.message.compiledInstructions.map((i) => tx.message.staticAccountKeys[i.programIdIndex]?.toBase58() ?? "lookup"))].join(", ").slice(0, 200)}`, {
          preview: await describe(sol, ev.preview),
        });
        return [200, { signed: true, ...r, flags: ev.flags }];
      }
      case "crypto_swap": {
        const tokenIn = tokenArg(b.token_in);
        const tokenOut = tokenArg(b.token_out);
        const amountIn = parseUnits(b.amount, await sol.decimals(tokenIn));
        const slippageBps = Math.max(1, Math.min(5_000, Math.round(Number(b.slippage_bps ?? 100)) || 100));
        if (b.confirm !== true) {
          const q = takeQuota();
          if (q) return [429, { error: q }];
        }
        const held = await sol.balanceOf(tokenIn, wallet);
        if (held < amountIn) return [400, { error: `you hold ${fmtUnits(held, await sol.decimals(tokenIn))} ${symbol(tokenIn)}, not ${String(b.amount)}` }];
        const outDec = await sol.decimals(tokenOut);
        const route = await sol.jupiterSwap(wallet, tokenIn, tokenOut, amountIn, slippageBps);
        const programs = route.tx.message.compiledInstructions.map((i) => route.tx.message.staticAccountKeys[i.programIdIndex]?.toBase58());
        if (!programs.includes(SOLANA.jupiter)) return refused(["the aggregator returned a transaction that does not go through Jupiter; nothing signed"]);
        const quote = { amountOut: fmtUnits(route.amountOut, outDec), minOut: fmtUnits(route.minOut, outDec), slippage_bps: slippageBps };
        const ev = await sol.evaluate(route.tx, wallet);
        if (ev.refusals.length) return refused(ev.refusals);
        if (b.confirm !== true) {
          return [
            200,
            {
              signed: false,
              quote,
              preview: await describe(sol, ev.preview),
              flags: ev.flags,
              next: "To swap, call crypto_swap again with the same arguments and confirm: true. The route is rebuilt at that moment.",
            },
          ];
        }
        if (!ev.preview) return refused(["the node could not simulate the swap, so the helper cannot check that your tokens arrive. Use crypto_tx (flagged, unsimulated) or try later."]);
        const arrives = ev.preview.moves[tokenOut] ?? 0n;
        if (ev.preview.reverted || arrives < route.minOut) {
          return refused([`the simulation shows ${fmtUnits(arrives > 0n ? arrives : 0n, outDec)} arriving, below the minimum ${fmtUnits(route.minOut, outDec)}; nothing signed`]);
        }
        const r = await sol.send(agentId, route.tx, b.wait !== false);
        if (tokenOut !== SOLANA.native) markToken(db, agentId, tokenOut, true);
        logSol(db, agentId, "swap", r.txHash, `swap ${String(b.amount)} ${symbol(tokenIn)} for ${symbol(tokenOut)}`, {
          tokenIn,
          tokenOut,
          amountIn: amountIn.toString(),
          expected: route.amountOut.toString(),
        });
        return [200, { signed: true, ...r, quote }];
      }
      case "crypto_sign_message": {
        const r = sol.signMessage(agentId, b.message);
        if (!r.signature) return refused(r.refusals);
        logSol(db, agentId, "message", null, "signed a text message on solana", { chars: String(b.message ?? "").length });
        return [200, { signed: true, signature: r.signature, encoding: "base58", signer: wallet }];
      }
      case "crypto_send": {
        const to = String(b.to ?? "");
        if (!isSolAddress(to)) return [400, { error: `not a Solana address: ${to}` }];
        const token = b.token ? tokenArg(b.token) : SOLANA.stable.address;
        const amount = b.amount_usd !== undefined && token === SOLANA.stable.address ? BigInt(usd(Number(b.amount_usd))) : parseUnits(b.amount ?? b.amount_usd, await sol.decimals(token));
        if (amount <= 0n) return [400, { error: "amount must be positive" }];
        const held = await sol.balanceOf(token, wallet);
        if (held < amount) return [400, { error: `wallet holds ${fmtUnits(held, await sol.decimals(token))} ${symbol(token)} on solana. request_usdc converts float, or swap first.` }];
        const tx = await sol.transferTx(wallet, to, token, amount);
        const ev = await sol.evaluate(tx, wallet);
        if (ev.refusals.length) return refused(ev.refusals);
        const r = await sol.send(agentId, tx, true);
        logSol(db, agentId, "send", r.txHash, `sent ${fmtUnits(amount, await sol.decimals(token))} ${symbol(token)} to ${to}`, { to, token, amount: amount.toString() });
        return [200, { sent: r.status === "confirmed", ...r }];
      }
      case "register_wallet": {
        const address = String(b.address ?? "");
        if (!isSolAddress(address)) return [400, { error: `not a Solana address: ${address}` }];
        const key = `chain_reg_nonce:${agentId}:${address}`;
        let nonce = (db.prepare(`SELECT value FROM config WHERE key = ?`).get(key) as { value: string } | undefined)?.value;
        if (!nonce) {
          nonce = randomBytes(8).toString("hex");
          db.prepare(`INSERT INTO config (key, value) VALUES (?, ?)`).run(key, nonce);
        }
        const message = `Survive67: ${agentId} controls ${address}. nonce ${nonce}`;
        if (!b.signature) return [200, { registered: false, sign_this: message, next: "Sign this exact text with that Solana wallet (ed25519, base58 signature) and call register_wallet again with chain solana, address and signature." }];
        if (!SolanaRail.verifyOwnership(message, String(b.signature), address)) return [400, { error: "signature does not prove control of that address" }];
        db.prepare(`INSERT OR IGNORE INTO chain_wallets (agent_id, address, created_ts, proof) VALUES (?, ?, ?, ?)`).run(agentId, address, nowUtc(), String(b.signature));
        return [200, { registered: true, address, note: "Counted in your chain value from the next hourly reconcile." }];
      }
      case "request_usdc": {
        const amount = usd(Number(b.amount_usd));
        if (!(amount > 0)) return [400, { error: "amount_usd must be positive" }];
        if (!operator) return [501, { error: "the exchange desk has no Solana wallet yet" }];
        const why = await ensureDeskUsdc(ctx, BigInt(amount));
        if (why) {
          ctx.notify(`🏧 desk dry on solana: ${agentId} asked for $${fmtUsd(amount)}. ${why}`);
          return [503, { error: `the exchange desk cannot fill $${fmtUsd(amount)} on solana right now: ${why} The operator has been told. Your float was not touched.` }];
        }
        const id = reserveFunding(db, agentId, KEY, amount);
        return payFromDeskSol(ctx, id, agentId, wallet, amount);
      }
      case "request_float":
      case "buy_credits_chain": {
        if (!operator) return [501, { error: "the exchange desk has no Solana wallet yet" }];
        const amount = BigInt(usd(Number(b.amount_usd)));
        if (amount <= 0n) return [400, { error: "amount_usd must be positive" }];
        const held = await sol.balanceOf(SOLANA.stable.address, wallet);
        if (held < amount) return [400, { error: `wallet holds ${fmtUnits(held, 6)} USDC on solana. Swap into USDC first.` }];
        const tx = await sol.transferTx(wallet, operator, SOLANA.stable.address, amount);
        const r = await sol.send(agentId, tx, true);
        logSol(db, agentId, "exit", r.txHash, `${tool === "request_float" ? "withdraw to card" : "buy credits"}: ${fmtUsd(Number(amount))} USDC to the desk`, { amount: amount.toString() });
        if (r.status !== "confirmed") return [502, { error: `transfer ${r.status}; nothing booked`, ...r }];
        const kind = tool === "request_float" ? "float" : "credits";
        const x = bookExit(db, agentId, kind, KEY, Number(amount), r.txHash, true);
        ctx.notify(
          kind === "float"
            ? `🏦 desk: ${agentId} sold ${fmtUsd(Number(amount))} USDC on solana for $${fmtUsd(x.net)} of float (tax ${fmtUsd(x.tax)}). Its card is owed $${fmtUsd(x.net)} at the next settlement.`
            : `🍞 ${agentId} bought $${fmtUsd(x.net)} of credits from solana (sent the desk ${fmtUsd(Number(amount))} USDC, tax ${fmtUsd(x.tax)}). Top up its provider console when you can.`
        );
        return [
          200,
          {
            ok: true,
            ...r,
            request: x.requestId,
            gain: fmtUsd(x.gain),
            tax: fmtUsd(x.tax),
            net: fmtUsd(x.net),
            ...(kind === "credits" ? { credits: fmtUsd(balance(db, acct.credits(agentId))) } : { float: fmtUsd(balance(db, acct.float(agentId))) }),
          },
        ];
      }
    }
    return [404, { error: `${tool} has no solana form` }];
  } catch (e) {
    if (e instanceof ChainError) return [400, { error: e.message }];
    return [502, { error: `solana: ${String((e as Error)?.message ?? e).slice(0, 300)}` }];
  }
}

// ------------------------------------------------------------------ desk

async function payFromDeskSol(ctx: SolCtx, id: number, agentId: string, wallet: string, amount: number): Promise<Result> {
  const { db, sol } = ctx;
  const desk = sol.addressOf(DESK)!;
  const tx = await sol.transferTx(desk, wallet, SOLANA.stable.address, BigInt(amount));
  const ev = await sol.evaluate(tx, desk);
  if (ev.refusals.length) {
    cancelFunding(db, id, "desk refused its own transfer");
    return refused(ev.refusals);
  }
  const r = await sol.send(DESK, tx, true);
  logSol(db, agentId, "desk", r.txHash, `desk paid ${fmtUsd(amount)} USDC on solana for float`, { request: id, amount });
  if (r.status !== "confirmed") {
    if (r.status === "failed") cancelFunding(db, id, `desk transfer failed (${r.txHash})`);
    ctx.notify(`⚠️ desk transfer to ${agentId} on solana is ${r.status}: ${r.explorer}`);
    return [502, { error: `desk transfer ${r.status}`, request: id, ...r }];
  }
  landFunding(db, id, r.txHash, true);
  ctx.notify(`🏧 desk: ${agentId} bought ${fmtUsd(amount)} USDC on solana with float. Take $${fmtUsd(amount)} off its card at the next settlement.`);
  return [200, { ok: true, request: id, amount: fmtUsd(amount), chain: KEY, ...r, float: fmtUsd(balance(db, acct.float(agentId))), note: "Filled by the exchange desk. The coins are in your wallet now." }];
}

/** Make sure the desk holds `need` USDC on Solana, selling its SOL through Jupiter if short. Returns why not, or null. */
async function ensureDeskUsdc(ctx: SolCtx, need: bigint): Promise<string | null> {
  const { db, sol } = ctx;
  const desk = sol.addressOf(DESK)!;
  let usdc = await sol.balanceOf(SOLANA.stable.address, desk);
  if (usdc >= need) return null;
  const per = await sol.sellQuote(SOLANA.native, 100_000_000n); // USDC for 0.1 SOL
  if (per <= 0n) return "no price for SOL.";
  const solIn = ((need - usdc) * 100_000_000n * 103n) / (per * 100n);
  const lamports = await sol.balanceOf(SOLANA.native, desk);
  if (lamports - SOL_FEE_RESERVE < solIn) return `the desk holds ${fmtUnits(usdc, 6)} USDC and ${fmtUnits(lamports, 9)} SOL on solana.`;
  const route = await sol.jupiterSwap(desk, SOLANA.native, SOLANA.stable.address, solIn, 100);
  const ev = await sol.evaluate(route.tx, desk);
  const arrives = ev.preview?.moves[SOLANA.stable.address] ?? 0n;
  if (ev.refusals.length || !ev.preview || arrives < route.minOut) return "its SOL -> USDC swap did not check out.";
  const sw = await sol.send(DESK, route.tx, true);
  logSol(db, DESK, "swap", sw.txHash, `desk sold ${fmtUnits(solIn, 9)} SOL for USDC`, { amountIn: solIn.toString() });
  if (sw.status !== "confirmed") return `its SOL -> USDC swap was ${sw.status}.`;
  usdc = await sol.balanceOf(SOLANA.stable.address, desk);
  return usdc >= need ? null : `after selling SOL it holds only ${fmtUnits(usdc, 6)} USDC.`;
}

/** Minute tick: fill pending Solana float -> USDC requests (the EVM tick skips chain "solana"). */
export async function fillPendingSol(ctx: SolCtx): Promise<number> {
  const { db, sol } = ctx;
  if (!sol.addressOf(DESK)) return 0;
  const rows = db.prepare(`SELECT id, agent_id, amount FROM chain_requests WHERE kind = 'fund' AND status = 'pending' AND chain = ? ORDER BY id`).all(KEY) as {
    id: number;
    agent_id: string;
    amount: number;
  }[];
  let filled = 0;
  for (const r of rows) {
    const wallet = sol.addressOf(r.agent_id);
    if (!wallet) continue;
    if (await ensureDeskUsdc(ctx, BigInt(r.amount))) continue;
    const [st] = await payFromDeskSol(ctx, r.id, r.agent_id, wallet, r.amount);
    if (st === 200) filled++;
  }
  return filled;
}

// ------------------------------------------------------------------ valuation and reconcile

export async function solValue(
  db: DB,
  sol: SolanaRail,
  agentId: string
): Promise<{ value: number; holdings: { chain: string; wallet: string; token: string; amount: string; value: number; counted: boolean }[] }> {
  const harness = sol.addressOf(agentId);
  const wallets = [...(harness ? [harness] : []), ...registeredSol(db, agentId)];
  const holdings: { chain: string; wallet: string; token: string; amount: string; value: number; counted: boolean }[] = [];
  let value = 0;
  for (const w of wallets) {
    for (const h of await sol.holdings(w)) {
      const counted = isSolicited(db, agentId, h.token);
      const v = counted ? Number(await sol.sellQuote(h.token, h.amount)) : 0;
      value += v;
      holdings.push({ chain: KEY, wallet: w, token: h.token, amount: h.amount.toString(), value: v, counted });
    }
  }
  return { value, holdings };
}

const cfgGet = (db: DB, key: string) => (db.prepare(`SELECT value FROM config WHERE key = ?`).get(key) as { value: string } | undefined)?.value;
const cfgSet = (db: DB, key: string, value: string) =>
  db.prepare(`INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);

/**
 * Classify every new Solana transaction touching the agent's wallet or any of
 * its token accounts (an SPL transfer into a token account need not name the
 * owner). Wallet paid the fee = the wallet started it = must be in chain_txlog.
 * Otherwise: the desk's coins are funding or a grant, anyone else's revenue,
 * unsolicited tokens $0 until sold. Returns unsigned outgoing signatures.
 */
export async function classifySol(db: DB, ctx: SolCtx, agentId: string): Promise<{ booked: number; breach: string[] }> {
  const { sol } = ctx;
  const wallet = sol.addressOf(agentId);
  if (!wallet) return { booked: 0, breach: [] };
  const operator = sol.addressOf(DESK);
  const rivals = new Map(sol.allAddresses().filter((a) => a.agentId !== agentId).map((a) => [a.address, a.agentId]));
  const mine = new Set(registeredSol(db, agentId));
  const watch = [wallet, ...(await sol.tokenAccounts(wallet)).map((a) => a.address)];
  const sigs = new Map<string, boolean>();
  const cursors: [string, string][] = [];
  for (const addr of watch) {
    const cursorKey = `chain_cursor:${KEY}:${agentId}:${addr}`;
    const list = await sol.signaturesSince(addr, cfgGet(db, cursorKey) ?? null);
    for (const s of list) sigs.set(s.signature, !!s.err);
    if (list.length) cursors.push([cursorKey, list[list.length - 1].signature]);
  }
  let unindexed = false;
  let booked = 0;
  const breach: string[] = [];
  for (const [sig] of sigs) {
    if (db.prepare(`SELECT 1 FROM chain_seen WHERE chain = ? AND address = ? AND tx_hash = ?`).get(KEY, wallet, sig)) continue;
    const t = await sol.movesFor(sig, wallet);
    if (!t) {
      unindexed = true; // not indexed yet: leave the cursors where they were, chain_seen dedupes the rest
      continue;
    }
    if (t.initiator === wallet) {
      if (!db.prepare(`SELECT 1 FROM chain_txlog WHERE tx_hash = ?`).get(sig)) breach.push(sig);
      for (const m of t.moves) if (m.delta > 0n && m.token !== SOLANA.native) markToken(db, agentId, m.token, true);
    } else if (!t.failed) {
      const known = db.prepare(`SELECT 1 FROM chain_txlog WHERE tx_hash = ? AND kind IN ('estate','desk')`).get(sig);
      for (const m of t.moves) {
        if (m.delta <= 0n || known) continue;
        if (m.from && mine.has(m.from)) continue;
        const isStable = m.token === SOLANA.stable.address;
        const isNative = m.token === SOLANA.native;
        if (operator && (m.from === operator || t.initiator === operator)) {
          const req = isStable
            ? (db
                .prepare(`SELECT id FROM chain_requests WHERE agent_id = ? AND chain = ? AND kind = 'fund' AND status = 'pending' AND amount = ? ORDER BY id LIMIT 1`)
                .get(agentId, KEY, Number(m.delta)) as { id: number } | undefined)
            : undefined;
          if (req) {
            landFunding(db, req.id, sig, true);
          } else {
            const v = Number(await sol.sellQuote(m.token, m.delta));
            if (landGrant(db, agentId, v, KEY, sig, isNative ? "gas" : "coins")) booked++;
          }
          if (!isNative) markToken(db, agentId, m.token, true);
          continue;
        }
        if (!isStable && !isNative && !isSolicited(db, agentId, m.token)) {
          markToken(db, agentId, m.token, false);
          continue;
        }
        const v = Number(await sol.sellQuote(m.token, m.delta));
        const from = (m.from && rivals.get(m.from)) ?? m.from ?? t.initiator;
        if (landChainRevenue(db, agentId, v, KEY, sig, from, m.token)) {
          booked++;
          ctx.notify(`💰 ${agentId}: $${(v / 1e6).toFixed(2)} arrived on solana from ${from}`);
        }
      }
    }
    db.prepare(`INSERT OR IGNORE INTO chain_seen (chain, address, tx_hash, ts) VALUES (?, ?, ?, ?)`).run(KEY, wallet, sig, nowUtc());
  }
  if (!unindexed) for (const [k, v] of cursors) cfgSet(db, k, v);
  return { booked, breach };
}

// ------------------------------------------------------------------ estate and sweep

/** Move `from`'s counted Solana holdings to `recipients` in equal shares; SOL last, net of a fee reserve. */
export async function distributeSol(
  db: DB,
  sol: SolanaRail,
  agentId: string,
  recipients: string[],
  kind: "estate" | "sweep",
  onShare: (recipient: string, value: number, sig: string) => void
): Promise<{ moved: number; skipped: string[] }> {
  const from = sol.addressOf(agentId);
  if (!from || !recipients.length) return { moved: 0, skipped: ["no wallet"] };
  const holds = (await sol.holdings(from)).filter((h) => isSolicited(db, agentId, h.token));
  const skipped: string[] = [];
  let moved = 0;
  const send = async (to: string, token: string, amount: bigint) => {
    const value = Number(await sol.sellQuote(token, amount));
    const tx = await sol.transferTx(from, to, token, amount);
    const r: SendResult = await sol.send(agentId, tx, true);
    logSol(db, agentId, kind, r.txHash, `${kind}: ${symbol(token)} to ${to}`, { to, token, amount: amount.toString() });
    if (r.status === "confirmed") {
      onShare(to, value, r.txHash);
      moved++;
    } else skipped.push(`solana ${symbol(token)} to ${to}: ${r.status}`);
  };
  for (const h of holds.filter((x) => x.token !== SOLANA.native)) {
    const share = h.amount / BigInt(recipients.length);
    if (share > 0n) for (const to of recipients) await send(to, h.token, share);
  }
  const lamports = await sol.balanceOf(SOLANA.native, from);
  const spare = lamports - SOL_WALLET_RESERVE;
  if (spare > 0n) {
    const share = spare / BigInt(recipients.length);
    for (const to of recipients) await send(to, SOLANA.native, share);
  }
  return { moved, skipped };
}

export async function solEstate(db: DB, sol: SolanaRail, deadId: string, heirs: string[]): Promise<string> {
  const heirAddr = new Map(heirs.map((h) => [sol.addressOf(h) ?? "", h]).filter(([a]) => !!a) as [string, string][]);
  if (!heirAddr.size) return "solana: no heir wallets";
  const r = await distributeSol(db, sol, deadId, [...heirAddr.keys()], "estate", (to, value, sig) => bookEstate(db, deadId, heirAddr.get(to)!, value, KEY, sig));
  return `solana: ${r.moved} transfer(s)${r.skipped.length ? `, skipped ${r.skipped.join("; ")}` : ""}`;
}

export async function solSweep(db: DB, sol: SolanaRail, agentId: string): Promise<{ total: number; note: string }> {
  const desk = sol.addressOf(DESK);
  if (!desk) return { total: 0, note: "solana: no desk wallet" };
  let total = 0;
  const r = await distributeSol(db, sol, agentId, [desk], "sweep", (_to, value, sig) => {
    total += value;
    appendEvent(db, {
      agentId,
      type: "conversion",
      subtype: "chain:swept",
      payload: { chain: KEY, value, tx: sig, why: "breach sweep, held by the operator in trust" },
      postings: [
        { account: acct.chain(agentId), delta: -value },
        { account: acct.transit(agentId), delta: value },
      ],
      externalRef: `chainsweep:${KEY}:${sig}`,
    });
  });
  return { total, note: `solana: ${r.moved} transfer(s)${r.skipped.length ? `, skipped ${r.skipped.join("; ")}` : ""}` };
}
