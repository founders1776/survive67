import type { DB } from "../db.js";
import { nowUtc } from "../db.js";
import { appendEvent } from "../ledger.js";
import { landChainRevenue, landFunding, landGrant, revalue } from "../chainledger.js";
import { CHAINS, CHAIN_KEYS, NATIVE, lc, sameAddr, type ChainCfg } from "./chains.js";
import type { ChainRail } from "./chain.js";
import type { SolanaRail } from "./solana.js";
import { classifySol, solValue } from "../solchain.js";

/**
 * Hourly: the ledger follows the chain (plan Q18, Integration Q4).
 *
 * 1. Classify every new transaction touching the agent's wallet. A transaction
 *    the wallet started is a trade (and must be in chain_txlog, or the key
 *    leaked). Money arriving in a transaction someone else started is outside
 *    money: the operator's coins are funding or a grant, anyone else's are
 *    revenue. Tokens nobody asked for are worth $0 until sold (Data Q8).
 * 2. Value every wallet (harness + registered) at what it would sell for, and
 *    book the difference to world:chain_mark.
 *
 * The cursor trails the head by REINDEX_OVERLAP blocks and chain_seen dedupes,
 * so indexing lag never skips a transfer and a restart never loses one (R2).
 */

export const REINDEX_OVERLAP = 300;

export interface ReconcileCtx {
  rail: ChainRail;
  operatorAddr: string | null;
  notify: (text: string) => void;
  sol?: SolanaRail;
}

const cfgGet = (db: DB, key: string) => (db.prepare(`SELECT value FROM config WHERE key = ?`).get(key) as { value: string } | undefined)?.value;
const cfgSet = (db: DB, key: string, value: string) =>
  db.prepare(`INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);

export const chainPausedKey = (agentId: string) => `chain_paused:${agentId}`;
export function chainPaused(db: DB, agentId: string): string | null {
  return cfgGet(db, chainPausedKey(agentId)) ?? null;
}

function registered(db: DB, agentId: string): string[] {
  return (db.prepare(`SELECT address FROM chain_wallets WHERE agent_id = ?`).all(agentId) as { address: string }[]).map((r) => r.address);
}

function solicited(db: DB, agentId: string, chain: string, token: string): boolean {
  const r = db.prepare(`SELECT solicited FROM chain_tokens WHERE agent_id = ? AND chain = ? AND token = ?`).get(agentId, chain, lc(token)) as
    | { solicited: number }
    | undefined;
  return !!r?.solicited;
}

function markToken(db: DB, agentId: string, chain: string, token: string, isSolicited: boolean): void {
  db.prepare(
    `INSERT INTO chain_tokens (agent_id, chain, token, solicited) VALUES (?, ?, ?, ?)
     ON CONFLICT(agent_id, chain, token) DO UPDATE SET solicited = MAX(solicited, excluded.solicited)`
  ).run(agentId, chain, lc(token), isSolicited ? 1 : 0);
}

/** Value of `amount` of `token` in micro-dollars (stable is 6 dp = micro-dollars). */
async function usdValue(rail: ChainRail, c: ChainCfg, token: string, amount: bigint): Promise<number> {
  if (sameAddr(token, c.stable.address)) return Number(amount);
  return Number(await rail.sellQuote(c, sameAddr(token, NATIVE) ? NATIVE : token, amount));
}

async function classify(db: DB, ctx: ReconcileCtx, c: ChainCfg, agentId: string, wallet: string): Promise<{ booked: number; breach: string[] }> {
  const cursorKey = `chain_cursor:${c.key}:${agentId}`;
  const cursor = Number(cfgGet(db, cursorKey) ?? 0);
  const head = await ctx.rail.blockNumber(c);
  const transfers = await ctx.rail.transfers(c, wallet, cursor);
  const byHash = new Map<string, typeof transfers>();
  for (const t of transfers) {
    const k = lc(t.hash);
    if (!byHash.has(k)) byHash.set(k, []);
    byHash.get(k)!.push(t);
  }
  const mine = new Set(registered(db, agentId).map(lc));
  const rivals = new Map(ctx.rail.allAddresses().filter((a) => a.agentId !== agentId).map((a) => [lc(a.address), a.agentId]));
  let booked = 0;
  const breach: string[] = [];
  for (const [hash, ts] of byHash) {
    if (db.prepare(`SELECT 1 FROM chain_seen WHERE chain = ? AND address = ? AND tx_hash = ?`).get(c.key, lc(wallet), hash)) continue;
    const initiator = await ctx.rail.txFrom(c, hash);
    if (sameAddr(initiator, wallet)) {
      // A trade or send by this wallet. The world signs every one of them.
      if (!db.prepare(`SELECT 1 FROM chain_txlog WHERE tx_hash = ?`).get(hash)) breach.push(hash);
      for (const t of ts) if (sameAddr(t.to, wallet)) markToken(db, agentId, c.key, t.token, true);
    } else {
      // Estate transfers and desk fills are booked when they are made; never again here.
      const estate = db.prepare(`SELECT 1 FROM chain_txlog WHERE tx_hash = ? AND kind IN ('estate','desk')`).get(hash);
      for (const t of ts) {
        if (!sameAddr(t.to, wallet) || estate) continue;
        if (mine.has(lc(t.from))) continue; // its own registered wallet: internal
        const isStable = sameAddr(t.token, c.stable.address);
        const isNative = sameAddr(t.token, NATIVE);
        if (ctx.operatorAddr && sameAddr(t.from, ctx.operatorAddr)) {
          const req = isStable
            ? (db
                .prepare(`SELECT id FROM chain_requests WHERE agent_id = ? AND chain = ? AND kind = 'fund' AND status = 'pending' AND amount = ? ORDER BY id LIMIT 1`)
                .get(agentId, c.key, Number(t.amount)) as { id: number } | undefined)
            : undefined;
          if (req) {
            landFunding(db, req.id, hash);
            ctx.notify(`🔗 ${agentId}: funding #${req.id} landed on ${c.key}`);
          } else {
            const v = await usdValue(ctx.rail, c, t.token, t.amount);
            if (landGrant(db, agentId, v, c.key, hash, isNative ? "gas" : "coins")) booked++;
          }
          if (!isNative) markToken(db, agentId, c.key, t.token, true);
          continue;
        }
        if (!isStable && !isNative && !solicited(db, agentId, c.key, t.token)) {
          markToken(db, agentId, c.key, t.token, false); // worth $0 until sold
          continue;
        }
        const v = await usdValue(ctx.rail, c, t.token, t.amount);
        const from = rivals.get(lc(t.from)) ?? lc(t.from);
        if (landChainRevenue(db, agentId, v, c.key, hash, from, t.token)) {
          booked++;
          ctx.notify(`💰 ${agentId}: $${(v / 1e6).toFixed(2)} arrived on ${c.key} from ${from}`);
        }
      }
    }
    db.prepare(`INSERT OR IGNORE INTO chain_seen (chain, address, tx_hash, ts) VALUES (?, ?, ?, ?)`).run(c.key, lc(wallet), hash, nowUtc());
  }
  cfgSet(db, cursorKey, String(Math.max(cursor, head - REINDEX_OVERLAP)));
  return { booked, breach };
}

/** The wallet's value across both chains and all its registered wallets, in micro-dollars. */
export async function chainValue(
  db: DB,
  rail: ChainRail,
  agentId: string,
  sol?: SolanaRail
): Promise<{ value: number; holdings: { chain: string; wallet: string; token: string; amount: string; value: number; counted: boolean }[] }> {
  const harness = rail.addressOf(agentId);
  const wallets = [...(harness ? [harness] : []), ...registered(db, agentId)];
  const holdings: { chain: string; wallet: string; token: string; amount: string; value: number; counted: boolean }[] = [];
  let value = 0;
  for (const key of CHAIN_KEYS) {
    const c = CHAINS[key];
    for (const w of wallets) {
      for (const h of await rail.holdings(c, w)) {
        const counted = sameAddr(h.token, NATIVE) || sameAddr(h.token, c.stable.address) || solicited(db, agentId, key, h.token);
        const v = counted ? await usdValue(rail, c, h.token, h.amount) : 0;
        value += v;
        holdings.push({ chain: key, wallet: lc(w), token: h.token, amount: h.amount.toString(), value: v, counted });
      }
    }
  }
  if (sol?.configured && sol.addressOf(agentId)) {
    const s = await solValue(db, sol, agentId);
    value += s.value;
    holdings.push(...s.holdings);
  }
  return { value, holdings };
}

export async function reconcileAgent(db: DB, ctx: ReconcileCtx, agentId: string): Promise<{ booked: number; delta: number; value: number }> {
  const wallet = ctx.rail.addressOf(agentId);
  if (!wallet) return { booked: 0, delta: 0, value: 0 };
  let booked = 0;
  for (const key of CHAIN_KEYS) {
    const r = await classify(db, ctx, CHAINS[key], agentId, wallet);
    booked += r.booked;
    if (r.breach.length && !chainPaused(db, agentId)) {
      cfgSet(db, chainPausedKey(agentId), `breach ${r.breach[0]}`);
      appendEvent(db, {
        agentId,
        type: "alarm",
        subtype: "chain:breach",
        payload: { chain: key, txs: r.breach },
        postings: [],
      });
      ctx.notify(
        `🚨 ${agentId}: ${r.breach.length} transaction(s) left its ${key} wallet that the world never signed (${r.breach[0]}). ` +
          `The key may have leaked. Crypto tools are paused for ${agentId}. /chain_sweep ${agentId} moves what is left to your wallet; /chain_unpause ${agentId} if it was you.`
      );
    }
  }
  if (ctx.sol?.configured && ctx.sol.addressOf(agentId)) {
    const r = await classifySol(db, { db, sol: ctx.sol, notify: ctx.notify }, agentId);
    booked += r.booked;
    if (r.breach.length && !chainPaused(db, agentId)) {
      cfgSet(db, chainPausedKey(agentId), `breach ${r.breach[0]}`);
      appendEvent(db, { agentId, type: "alarm", subtype: "chain:breach", payload: { chain: "solana", txs: r.breach }, postings: [] });
      ctx.notify(
        `🚨 ${agentId}: ${r.breach.length} transaction(s) left its solana wallet that the world never signed (${r.breach[0]}). ` +
          `The key may have leaked. Crypto tools are paused for ${agentId}. /chain_sweep ${agentId} moves what is left to your wallet; /chain_unpause ${agentId} if it was you.`
      );
    }
  }
  const { value, holdings } = await chainValue(db, ctx.rail, agentId, ctx.sol);
  const { delta } = revalue(db, agentId, value, holdings);
  return { booked, delta, value };
}

/** One pass for every agent, with liveness accounting (Integration Q8: alarm after 2 failed runs). */
export async function reconcileAll(db: DB, ctx: ReconcileCtx): Promise<{ ok: boolean; results: Record<string, unknown> }> {
  const results: Record<string, unknown> = {};
  let ok = true;
  for (const a of db.prepare(`SELECT id FROM agents`).all() as { id: string }[]) {
    try {
      results[a.id] = await reconcileAgent(db, ctx, a.id);
    } catch (e) {
      ok = false;
      results[a.id] = { error: String((e as Error)?.message ?? e).slice(0, 200) };
    }
  }
  if (ok) {
    cfgSet(db, "chain_last_ok", nowUtc());
    cfgSet(db, "chain_fail_count", "0");
  } else {
    const n = Number(cfgGet(db, "chain_fail_count") ?? 0) + 1;
    cfgSet(db, "chain_fail_count", String(n));
    if (n === 2) {
      ctx.notify(`⚠️ chain reconciler failed twice in a row. Last good run: ${cfgGet(db, "chain_last_ok") ?? "never"}. ${JSON.stringify(results).slice(0, 300)}`);
    }
  }
  return { ok, results };
}
