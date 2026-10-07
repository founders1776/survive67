import type { DB } from "./db.js";
import { usd } from "./db.js";
import { appendEvent } from "./ledger.js";
import { burnPerHour } from "./views.js";

/** Spend-rate alarm (plan Arch Q16): pauses the agent, pings the operator, still bills. */
export const RUNAWAY_BURN_PER_HOUR = usd(10);

export function checkRunaway(
  db: DB,
  notify: (text: string) => void
): { agentId: string; burn: number }[] {
  const fired: { agentId: string; burn: number }[] = [];
  const agents = db
    .prepare(`SELECT id FROM agents WHERE status = 'alive'`)
    .all() as { id: string }[];
  // An open starvation session is exempt: it is bank-only and hard-capped by the
  // overdraft floor, so it cannot run away — but an agent that burned hard before
  // starving always has a hot trailing-hour burn, and pausing it mid-lifeline
  // consumes its one-time starvation wake without a single chance to eat.
  // (Ember, burn-in 2026-09-19, session 86.)
  const inStarvation = db.prepare(
    `SELECT 1 FROM sessions s
     JOIN events e ON json_extract(e.payload, '$.sessionId') = s.id
     WHERE s.agent_id = ? AND s.ended_ts IS NULL AND e.subtype = 'start:starvation'
     LIMIT 1`
  );
  for (const a of agents) {
    if (inStarvation.get(a.id)) continue;
    const burn = burnPerHour(db, a.id, 1);
    if (burn > RUNAWAY_BURN_PER_HOUR) {
      db.prepare(`UPDATE agents SET status = 'paused' WHERE id = ?`).run(a.id);
      appendEvent(db, {
        agentId: a.id,
        type: "alarm",
        subtype: "runaway_burn",
        payload: { burnPerHourMicro: burn, thresholdMicro: RUNAWAY_BURN_PER_HOUR },
        postings: [],
      });
      notify(
        `🚨 runaway alarm: ${a.id} burning $${(burn / 1e6).toFixed(2)}/hr — paused. ` +
          `Resume from survive67.com/#ops or /resume ${a.id}.`
      );
      fired.push({ agentId: a.id, burn });
    }
  }
  return fired;
}

export function resumeAgent(db: DB, agentId: string): void {
  const r = db
    .prepare(`UPDATE agents SET status = 'alive' WHERE id = ? AND status = 'paused'`)
    .run(agentId);
  if (r.changes === 0) throw new Error(`${agentId} is not paused`);
  appendEvent(db, {
    agentId,
    type: "alarm",
    subtype: "resumed",
    payload: {},
    postings: [],
  });
}
