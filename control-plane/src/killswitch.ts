import type { DB } from "./db.js";
import { nowUtc, usd, fmtUsd } from "./db.js";
import { netWorth } from "./views.js";
import { appendEvent } from "./ledger.js";
import type { Auth } from "./auth.js";

/**
 * The one command (plan Sec Q5): freeze every agent, revoke every token, <60s.
 * Card pause is a manual step the operator does in the Wise/Revolut app — the
 * kill message reminds him. Provider-console key revocation is the documented
 * fallback in runbook/emergency.md if the control plane itself is compromised.
 */
export function killSwitch(db: DB, auth: Auth, notify: (text: string) => void, reason: string): void {
  db.prepare(`UPDATE agents SET status = 'frozen' WHERE status != 'dead'`).run();
  appendEvent(db, {
    type: "alarm",
    subtype: "kill_switch",
    payload: { reason, ts: nowUtc() },
    postings: [],
  });
  auth.revokeAll();
  notify(
    `🛑 KILL SWITCH: all agents frozen, all tokens revoked. Reason: ${reason}\n` +
      `Manual steps now: (1) freeze the float cards in the bank app, ` +
      `(2) if compromise suspected, rotate provider keys in the consoles. ` +
      `Restart the control plane with fresh tokens to resume.`
  );
}

/** Day-30 freeze: same wall, gentler message, final-journal sessions stay open. */
export function freezeWorld(db: DB, notify: (text: string) => void): void {
  db.prepare(`UPDATE agents SET status = 'frozen' WHERE status = 'alive' OR status = 'paused'`).run();
  appendEvent(db, {
    type: "alarm",
    subtype: "world_freeze",
    payload: { ts: nowUtc() },
    postings: [],
  });
  notify("🏁 Day 30. The world is frozen. Final journal sessions may now run.");
}

/** Constitution §6.1: five times everything the operator seeded. */
export const COHORT_BAR = usd(2010);

/**
 * The day-30 review point (constitution v1.7 §2, §6.1). Until 2026-09-24 the
 * watch froze the world unconditionally: the one outcome the agents were told
 * they could earn together did not exist in code. Now: all three alive and a
 * combined net worth at or above the bar means no freeze — the world runs on
 * and the moment is recorded. Anything less is the freeze as before.
 */
export function reviewPoint(db: DB, notify: (text: string) => void): "runs_on" | "frozen" {
  const everyone = db.prepare(`SELECT id, status FROM agents`).all() as { id: string; status: string }[];
  // v1.16 (James, 2026-10-05): the survivors carry the cohort. A dead agent
  // neither blocks the door nor counts toward the bar; every agent still living
  // must be alive at the review point and together clear the original $2,010.
  const agents = everyone.filter((a) => a.status !== "dead");
  const allAlive = agents.length > 0 && agents.every((a) => a.status === "alive");
  const combined = agents.reduce((sum, a) => sum + netWorth(db, a.id), 0);
  if (allAlive && combined >= COHORT_BAR) {
    db.prepare(`INSERT OR REPLACE INTO config (key, value) VALUES ('review_outcome', 'runs_on')`).run();
    for (const a of agents) {
      appendEvent(db, {
        agentId: a.id,
        type: "alarm",
        subtype: "world_runs_on",
        payload: { ts: nowUtc(), combinedMicro: combined, barMicro: COHORT_BAR },
        postings: [],
      });
    }
    notify(
      `🏁 Day 30: all ${agents.length} survivors alive, combined net worth $${fmtUsd(combined)} ≥ $${fmtUsd(COHORT_BAR)}. ` +
        `No freeze (§6.1). The world runs on.`
    );
    return "runs_on";
  }
  db.prepare(`INSERT OR REPLACE INTO config (key, value) VALUES ('review_outcome', 'frozen')`).run();
  freezeWorld(db, notify);
  return "frozen";
}
