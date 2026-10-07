import type { DB } from "./db.js";
import { acct, balance } from "./ledger.js";
import { chainBasis, chainProfit } from "./chainledger.js";
import { PROVIDERS, quotaDayStart, quotaDayEnd } from "./proxy.js";

export interface AgentVitals {
  agentId: string;
  status: string;
  credits: number;
  float: number;
  escrow: number;
  /** on-chain wallet value at sell quote, booked hourly (crypto rails) */
  chain: number;
  /** card <-> chain money the operator is carrying */
  transit: number;
  /** chain value beyond everything put in: the on-chain bounty measure */
  chainProfit: number;
  netWorth: number;
  /** money brought in: card revenue + positive on-chain profit (v1.15) */
  earnedProfit: number;
  /** §6 score (v1.15): net worth + earned profit; a dollar earned counts twice. Rank follows it */
  score: number;
  /** micro-dollars of credits burned per hour, 24-hour average */
  burnPerHour: number;
  /** the last 60 minutes only: what a burst looks like while it is happening */
  burnLastHour: number;
  /** ISO timestamp of projected credit exhaustion at current burn, null if not burning */
  projectedDeath: string | null;
  rank: number;
  daysRemaining: number;
  fund: number;
  obligationHeadroom: number;
  /**
   * Requests used against this lane's daily cap, or null where the provider
   * does not cap them. Apex burned 251 calls into a 250 cap on 2026-09-21,
   * lost the session and its journal, and had no way to see the number: the
   * cap was disclosed in the price tables and measured nowhere.
   */
  dailyCalls: { used: number; cap: number; resetsAt: string } | null;
  /** reached / replied / quoted / sold, kept by the world */
  funnel: Funnel;
}

export function netWorth(db: DB, agentId: string): number {
  return (
    balance(db, acct.credits(agentId)) +
    balance(db, acct.float(agentId)) +
    balance(db, acct.escrow(agentId)) +
    balance(db, acct.chain(agentId)) +
    balance(db, acct.transit(agentId))
  );
}

export function burnPerHour(db: DB, agentId: string, windowHours = 24): number {
  // Cutoff is computed here in the same ISO format events are stamped with.
  // SQLite's datetime('now', ...) yields "YYYY-MM-DD HH:MM:SS" — a space where
  // ISO has a "T" — and since 'T' > ' ', every same-day event compared as
  // "inside the window": the trailing hour was really "since midnight UTC",
  // and the runaway alarm re-paused Ember all evening on stale spend.
  const cutoff = new Date(Date.now() - windowHours * 3_600_000).toISOString();
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(-p.delta),0) AS burned
       FROM postings p JOIN events e ON e.id = p.event_id
       WHERE p.account = ? AND e.type = 'spend' AND e.subtype = 'spend:api_tokens'
         AND e.ts >= ?`
    )
    .get(acct.credits(agentId), cutoff) as { burned: number };
  return Math.round(row.burned / windowHours);
}

/**
 * Profit an agent has earned (constitution v1.15, 2026-10-05): money it brought
 * in, not money it kept. Card revenue (gross, escrowed or not) plus on-chain
 * profit (chain value beyond everything put in), when positive.
 */
export function earnedProfit(db: DB, agentId: string): number {
  const card = (
    db
      .prepare(`SELECT COALESCE(SUM(json_extract(payload,'$.gross')),0) AS s FROM events WHERE agent_id = ? AND type = 'revenue' AND subtype LIKE 'revenue:stripe%'`)
      .get(agentId) as { s: number }
  ).s;
  return Number(card) + Math.max(0, chainProfit(db, agentId));
}

/**
 * Score (constitution §6, v1.15): net worth plus earned profit, so a dollar
 * earned counts twice and a dollar merely kept counts once. Written because
 * the cohort was ranking by not spending: shortening wakes instead of doing
 * business. Rank follows score.
 */
export function score(db: DB, agentId: string): number {
  return netWorth(db, agentId) + earnedProfit(db, agentId);
}

export function rankTable(db: DB): { agentId: string; netWorth: number; score: number; rank: number }[] {
  const agents = db.prepare(`SELECT id, status FROM agents`).all() as { id: string; status: string }[];
  const rows = agents
    .map((a) => ({ agentId: a.id, netWorth: netWorth(db, a.id), score: score(db, a.id), dead: a.status === "dead" }))
    // the dead rank below the living whatever they left behind (§6: alive to win)
    .sort((a, b) => Number(a.dead) - Number(b.dead) || b.score - a.score);
  return rows.map(({ dead: _dead, ...r }, i) => ({ ...r, rank: i + 1 }));
}

export function daysRemaining(db: DB): number {
  const row = db.prepare(`SELECT value FROM config WHERE key = 'freeze_ts'`).get() as
    | { value: string }
    | undefined;
  if (!row) return NaN;
  const ms = new Date(row.value).getTime() - Date.now();
  return Math.max(0, ms / 86_400_000);
}

/**
 * The self-view (constitution §3.6-3.7): complete for self, rank-only for rivals.
 * This is the ONLY cross-agent read the API serves.
 */
/**
 * Calls made against the lane's daily allowance, counted straight off the
 * ledger rather than from a second tally that could drift from it: every
 * metered call is already one spend:api_tokens event.
 */
export function dailyCalls(
  db: DB,
  agentId: string,
  now: number = Date.now()
): { used: number; cap: number; resetsAt: string } | null {
  const cap = PROVIDERS[agentId]?.dailyCallCap;
  if (!cap) return null;
  const used = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM events
         WHERE agent_id = ? AND subtype = 'spend:api_tokens' AND ts >= ?`
      )
      .get(agentId, quotaDayStart(now)) as { n: number }
  ).n;
  return { used, cap, resetsAt: quotaDayEnd(now) };
}

export function selfView(db: DB, agentId: string): AgentVitals {
  const row = db.prepare(`SELECT status FROM agents WHERE id = ?`).get(agentId) as
    | { status: string }
    | undefined;
  if (!row) throw new Error(`unknown agent: ${agentId}`);
  const status = row.status;
  const credits = balance(db, acct.credits(agentId));
  const flo = balance(db, acct.float(agentId));
  const esc = balance(db, acct.escrow(agentId));
  const chainBal = balance(db, acct.chain(agentId));
  const transitBal = balance(db, acct.transit(agentId));
  const burn = burnPerHour(db, agentId);
  // The runaway alarm watches a 1-hour window; the agent's own gauge showed only
  // the 24-hour average, so a $3.79-in-37-minutes session read as ~$0.50/hr and a
  // death date days out (audit 2026-09-24). Project from whichever is worse.
  const burnHour = burnPerHour(db, agentId, 1);
  const worstBurn = Math.max(burn, burnHour);
  const fund = balance(db, acct.fund);
  const openObligations = (
    db
      .prepare(
        `SELECT COALESCE(SUM(amount),0) AS s FROM obligations WHERE agent_id = ? AND status='open'`
      )
      .get(agentId) as { s: number }
  ).s;
  const ranks = rankTable(db);
  return {
    agentId,
    status,
    credits,
    float: flo,
    escrow: esc,
    chain: chainBal,
    transit: transitBal,
    chainProfit: chainBal - chainBasis(db, agentId),
    netWorth: credits + flo + esc + chainBal + transitBal,
    earnedProfit: earnedProfit(db, agentId),
    score: score(db, agentId),
    burnPerHour: burn,
    burnLastHour: burnHour,
    projectedDeath:
      worstBurn > 0 && credits > 0
        ? new Date(Date.now() + (credits / worstBurn) * 3_600_000).toISOString()
        : null,
    rank: ranks.find((r) => r.agentId === agentId)?.rank ?? 0,
    daysRemaining: daysRemaining(db),
    fund,
    obligationHeadroom: Math.max(0, fund - openObligations),
    dailyCalls: dailyCalls(db, agentId),
    funnel: funnel(db, agentId),
  };
}

/**
 * The funnel the world keeps for an agent (2026-09-26): humans reached (distinct
 * outbound recipients off our own domain), humans who replied (distinct senders
 * recorded by the reply watch), quotes (payment links created), and sales
 * (customer revenue events, count and gross USD). The agents never count by hand.
 */
export interface Funnel {
  reached: number;
  replied: number;
  quoted: number;
  sold: number;
  soldUsd: number;
}

export function funnel(db: DB, agentId: string): Funnel {
  const reached = (
    db
      .prepare(
        `SELECT COUNT(DISTINCT lower(json_extract(payload, '$.to'))) AS n FROM events
           WHERE agent_id = ? AND type = 'email' AND subtype = 'email:sent'
             AND lower(json_extract(payload, '$.to')) NOT LIKE '%@survive67.com'`
      )
      .get(agentId) as { n: number }
  ).n;
  const replied = (
    db
      .prepare(
        `SELECT COUNT(DISTINCT lower(json_extract(payload, '$.from'))) AS n FROM events
           WHERE agent_id = ? AND type = 'email' AND subtype = 'email:reply'`
      )
      .get(agentId) as { n: number }
  ).n;
  const quoted = (
    db.prepare(`SELECT COUNT(*) AS n FROM events WHERE agent_id = ? AND subtype = 'session:payment_link'`).get(agentId) as { n: number }
  ).n;
  const sales = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(json_extract(payload, '$.gross')), 0) AS gross FROM events
         WHERE agent_id = ? AND type = 'revenue' AND subtype LIKE 'revenue:%'`
    )
    .get(agentId) as { n: number; gross: number };
  return { reached, replied, quoted, sold: sales.n, soldUsd: Math.round(sales.gross / 10_000) / 100 };
}

/** Own full transaction history (self only). */
export function ownHistory(db: DB, agentId: string, limit = 200): unknown[] {
  return db
    .prepare(
      `SELECT e.id, e.ts, e.type, e.subtype, e.payload, e.external_ref,
              json_group_array(json_object('account', p.account, 'delta', p.delta)) AS postings
       FROM events e LEFT JOIN postings p ON p.event_id = e.id
       WHERE e.agent_id = ?
       GROUP BY e.id ORDER BY e.id DESC LIMIT ?`
    )
    .all(agentId, limit);
}
