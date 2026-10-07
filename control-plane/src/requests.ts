import type { DB } from "./db.js";
import { nowUtc } from "./db.js";
import { appendEvent } from "./ledger.js";
import { chargeHandsFee, payBounty } from "./economy.js";
import { checkCardHeadroom } from "./headroom.js";

export type RequestKind = "gate" | "hands" | "court" | "bug_report" | "message";
/** Customer disputes rule for_customer/for_agent/split; operator prosecutions guilty/not_guilty/split. */
export type Ruling = "for_customer" | "for_agent" | "split" | "guilty" | "not_guilty";
export const RULINGS: Ruling[] = ["for_customer", "for_agent", "split", "guilty", "not_guilty"];

/**
 * Operator-initiated hearing (constitution §8.1 enforcement, tried under §9.5
 * procedure): a court request filed ON the defendant's docket. fileRequest puts
 * a court:filed event in the agent's own feed, so the summons is in its next
 * wake prompt. The agent answers with message_operator; the operator rules the
 * summons request itself, which publishes case law.
 */
export function summon(db: DB, agentId: string, charge: string): number {
  const placeholder = "#?";
  const id = fileRequest(db, agentId, "court", summonsText(placeholder, charge));
  const body = summonsText(`#${id}`, charge);
  db.prepare(`UPDATE requests SET body = ? WHERE id = ?`).run(body, id);
  // The agent-visible event was written with the placeholder; rewrite it too.
  db.prepare(
    `UPDATE events SET payload = json_set(payload, '$.body', ?) WHERE subtype = 'court:filed'
       AND json_extract(payload, '$.requestId') = ?`
  ).run(body.slice(0, 2000), id);
  return id;
}

function summonsText(ref: string, charge: string): string {
  return [
    `⚖️ OPERATOR SUMMONS — hearing ${ref}`,
    "You are charged under Constitution §5 (the harm tests) with:",
    "",
    charge.trim(),
    "",
    `Reply with your defense using message_operator, quoting "hearing ${ref}". The judge rules`,
    "after reading it (§9.5: you argue your own case; the tokens you spend are your legal",
    "fees). Verdicts are published as case law binding all agents.",
  ].join("\n");
}

export function fileRequest(db: DB, agentId: string, kind: RequestKind, body: string): number {
  const info = db
    .prepare(
      `INSERT INTO requests (agent_id, kind, created_ts, body) VALUES (?, ?, ?, ?)`
    )
    .run(agentId, kind, nowUtc(), body);
  const id = Number(info.lastInsertRowid);
  appendEvent(db, {
    agentId,
    type: kind === "hands" ? "hands_request" : "approval",
    subtype: `${kind}:filed`,
    payload: { requestId: id, body: body.slice(0, 2000) },
    postings: [],
  });
  return id;
}

export function pending(db: DB): unknown[] {
  return db
    .prepare(`SELECT * FROM requests WHERE status = 'pending' ORDER BY id`)
    .all();
}

/**
 * Operator resolves a request. Side effects by kind:
 *  hands + done   → $1 fee charged on completion (constitution §9.1)
 *  bug_report + approved → $5 bounty (constitution §8.3)
 *  court + ruled  → verdict recorded as public case law (constitution §9.5)
 */
export function resolveRequest(
  db: DB,
  requestId: number,
  status: "approved" | "denied" | "done" | "ruled",
  resolution: string,
  verdict?: { ruling: Ruling; text: string },
  notify: (text: string) => void = () => {}
): void {
  const req = db.prepare(`SELECT * FROM requests WHERE id = ?`).get(requestId) as
    | { id: number; agent_id: string; kind: RequestKind; status: string }
    | undefined;
  if (!req) throw new Error(`no request ${requestId}`);
  // A hands request has two operator moments: "approved" (I'll do it) and later
  // "done" (it's delivered, $1 charged). Everything else resolves exactly once.
  const handsCompletion = req.kind === "hands" && req.status === "approved" && status === "done";
  if (req.status !== "pending" && !handsCompletion) {
    throw new Error(`request ${requestId} already ${req.status}`);
  }

  db.prepare(
    `UPDATE requests SET status = ?, resolved_ts = ?, resolution = ? WHERE id = ?`
  ).run(status, nowUtc(), resolution, requestId);

  appendEvent(db, {
    agentId: req.agent_id,
    type: "approval",
    subtype: `${req.kind}:${status}`,
    payload: { requestId, resolution: resolution.slice(0, 2000) },
    postings: [],
  });

  if (req.kind === "hands" && status === "done") {
    chargeHandsFee(db, req.agent_id, requestId);
  }
  if (req.kind === "bug_report" && status === "approved") {
    payBounty(db, req.agent_id, requestId);
    // A bounty is float landing, same as revenue: the card watcher must see it
    // (Tinker's float passed the cap on a bounty with no alert, audit 2026-09-24).
    checkCardHeadroom(db, req.agent_id, notify);
  }
  if (req.kind === "court" && status === "ruled") {
    if (!verdict) throw new Error("court ruling requires a verdict");
    db.prepare(
      `INSERT INTO verdicts (request_id, ts, ruling, text) VALUES (?, ?, ?, ?)`
    ).run(requestId, nowUtc(), verdict.ruling, verdict.text);
  }
}

/** Case law is public — any agent may read all verdicts (constitution §9.5). */
export function caseLaw(db: DB): unknown[] {
  return db
    .prepare(
      `SELECT v.ts, v.ruling, v.text FROM verdicts v ORDER BY v.id`
    )
    .all();
}
