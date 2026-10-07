import type { DB } from "./db.js";
import { recomputeBalance } from "./ledger.js";

export interface AuditFinding {
  check: string;
  ok: boolean;
  detail: string;
}

/**
 * Spontaneous audit, mechanical part (constitution §7):
 *  1. balances cache == sum of postings, for every account
 *  2. every event's postings sum to zero
 *  3. every revenue event carries an external_ref (rail truth)
 *  4. events are append-only (ids dense, ts monotone non-decreasing per insert order is
 *     not required — corrections happen later — but no gaps may exist)
 * Provider-invoice and Stripe-payout reconciliation are operator steps in the runbook;
 * this function produces the internal-consistency half.
 */
export function auditInternal(db: DB): AuditFinding[] {
  const findings: AuditFinding[] = [];

  const accounts = db.prepare(`SELECT account, balance FROM balances`).all() as {
    account: string;
    balance: number;
  }[];
  for (const a of accounts) {
    const recomputed = recomputeBalance(db, a.account);
    findings.push({
      check: `balance:${a.account}`,
      ok: recomputed === a.balance,
      detail: `cache=${a.balance} recomputed=${recomputed}`,
    });
  }

  const unbalanced = db
    .prepare(
      `SELECT event_id, SUM(delta) AS s FROM postings GROUP BY event_id HAVING s != 0`
    )
    .all() as { event_id: number; s: number }[];
  findings.push({
    check: "postings:zero-sum",
    ok: unbalanced.length === 0,
    detail: unbalanced.length ? `unbalanced events: ${unbalanced.map((u) => u.event_id)}` : "all balanced",
  });

  const noRef = db
    .prepare(`SELECT COUNT(*) AS c FROM events WHERE type='revenue' AND external_ref IS NULL`)
    .get() as { c: number };
  findings.push({
    check: "revenue:external-ref",
    ok: noRef.c === 0,
    detail: `${noRef.c} revenue events without rail reference`,
  });

  const gap = db
    .prepare(
      `SELECT COUNT(*) AS c, COALESCE(MAX(id),0) AS m, COALESCE(MIN(id),1) AS n FROM events`
    )
    .get() as { c: number; m: number; n: number };
  findings.push({
    check: "events:append-only",
    ok: gap.c === 0 || gap.m - gap.n + 1 === gap.c,
    detail: `count=${gap.c} idrange=[${gap.n},${gap.m}]`,
  });

  return findings;
}
