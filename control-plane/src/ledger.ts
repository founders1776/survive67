import type { DB } from "./db.js";
import { nowUtc } from "./db.js";

export type EventType =
  | "spend" | "revenue" | "tax" | "escrow" | "conversion" | "approval"
  | "hands_request" | "session" | "alarm" | "a2a_message" | "journal"
  | "correction" | "penalty" | "bounty" | "email";

export interface Posting {
  account: string;
  delta: number; // micro-dollars
}

export interface EventInput {
  agentId?: string | null;
  type: EventType;
  subtype?: string;
  payload?: Record<string, unknown>;
  postings?: Posting[];
  correctionOf?: number;
  externalRef?: string;
  ts?: string; // override for tests only
}

export class LedgerError extends Error {}

/**
 * Append one event with balanced postings, atomically. Postings must sum to zero —
 * money never appears or vanishes, it moves between accounts (world:* accounts
 * represent the outside).
 */
export function appendEvent(db: DB, e: EventInput): number {
  const postings = e.postings ?? [];
  const sum = postings.reduce((a, p) => a + p.delta, 0);
  if (sum !== 0) {
    throw new LedgerError(`unbalanced postings (sum=${sum}) for event type=${e.type}`);
  }
  for (const p of postings) {
    if (!Number.isInteger(p.delta)) {
      throw new LedgerError(`non-integer posting delta on ${p.account}`);
    }
  }

  // Idempotency: an external ref (stripe payment id, tx hash) may enter the ledger once.
  if (e.externalRef) {
    const dup = db
      .prepare(`SELECT id FROM events WHERE external_ref = ?`)
      .get(e.externalRef) as { id: number } | undefined;
    if (dup) {
      throw new LedgerError(`duplicate external_ref ${e.externalRef} (event ${dup.id})`);
    }
  }

  const tx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO events (ts, agent_id, type, subtype, payload, correction_of, external_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        e.ts ?? nowUtc(),
        e.agentId ?? null,
        e.type,
        e.subtype ?? null,
        JSON.stringify(e.payload ?? {}),
        e.correctionOf ?? null,
        e.externalRef ?? null
      );
    const eventId = Number(info.lastInsertRowid);
    const insPosting = db.prepare(
      `INSERT INTO postings (event_id, account, delta) VALUES (?, ?, ?)`
    );
    const upsertBal = db.prepare(
      `INSERT INTO balances (account, balance) VALUES (?, ?)
       ON CONFLICT(account) DO UPDATE SET balance = balance + excluded.balance`
    );
    for (const p of postings) {
      insPosting.run(eventId, p.account, p.delta);
      upsertBal.run(p.account, p.delta);
    }
    return eventId;
  });
  return tx();
}

export function balance(db: DB, account: string): number {
  const row = db.prepare(`SELECT balance FROM balances WHERE account = ?`).get(account) as
    | { balance: number }
    | undefined;
  return row?.balance ?? 0;
}

/** Recompute a balance from raw postings — audit path, must equal balances cache. */
export function recomputeBalance(db: DB, account: string): number {
  const row = db
    .prepare(`SELECT COALESCE(SUM(delta),0) AS s FROM postings WHERE account = ?`)
    .get(account) as { s: number };
  return row.s;
}

/**
 * Append a correcting event: reverses the postings of a prior event (optionally scaled)
 * and records the linkage. History is never edited (constitution §8.4).
 */
export function correctEvent(
  db: DB,
  originalEventId: number,
  reason: string,
  operator: string
): number {
  const original = db
    .prepare(`SELECT id, type, agent_id FROM events WHERE id = ?`)
    .get(originalEventId) as { id: number; type: EventType; agent_id: string | null } | undefined;
  if (!original) throw new LedgerError(`no such event: ${originalEventId}`);
  if (original.type === "correction") {
    throw new LedgerError(`cannot correct a correction (event ${originalEventId})`);
  }
  const already = db
    .prepare(`SELECT id FROM events WHERE correction_of = ?`)
    .get(originalEventId) as { id: number } | undefined;
  if (already) {
    throw new LedgerError(
      `event ${originalEventId} already corrected by event ${already.id}`
    );
  }
  const originalPostings = db
    .prepare(`SELECT account, delta FROM postings WHERE event_id = ?`)
    .all(originalEventId) as Posting[];
  return appendEvent(db, {
    agentId: original.agent_id,
    type: "correction",
    subtype: `reverses:${original.type}`,
    payload: { reason, operator, reverses: originalEventId },
    postings: originalPostings.map((p) => ({ account: p.account, delta: -p.delta })),
    correctionOf: originalEventId,
  });
}

export const acct = {
  credits: (agentId: string) => `agent:${agentId}:credits`,
  float: (agentId: string) => `agent:${agentId}:float`,
  escrow: (agentId: string) => `agent:${agentId}:escrow`,
  /** on-chain wallet value at sell quote; the reconciler keeps it equal to the chain (plan Q18) */
  chain: (agentId: string) => `agent:${agentId}:chain`,
  /** money between the card and the chain, owed by the operator in one direction or the other */
  transit: (agentId: string) => `agent:${agentId}:transit`,
  /** counterparty for revaluation: market moves, trades, outflows */
  chainMark: "world:chain_mark",
  fund: "fund",
  stripe: "world:stripe",
  crypto: "world:crypto",
  provider: "world:provider",
  vendor: "world:vendor",
  operator: "world:operator",
};
