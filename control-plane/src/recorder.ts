import type { DB } from "./db.js";

/**
 * Screen-recording flags (plan Ops Q13: event-triggered + manual, sparing).
 * The control plane only holds a per-agent "record until" timestamp; the actual
 * capture runs on each agent VM (Xvfb + ffmpeg daemon polling record-state).
 * Triggers: operator's /rec command, revenue landing, runaway alarms.
 */

export const DEFAULT_RECORD_MINUTES = 10;

export function setRecording(db: DB, agentId: string, minutes: number): string {
  const until = new Date(Date.now() + minutes * 60_000).toISOString();
  db.prepare(`INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)`).run(
    `record_until:${agentId}`,
    until
  );
  return until;
}

export function stopRecording(db: DB, agentId: string): void {
  db.prepare(`DELETE FROM config WHERE key = ?`).run(`record_until:${agentId}`);
}

export function recordState(db: DB, agentId: string): { record: boolean; until: string | null } {
  const row = db.prepare(`SELECT value FROM config WHERE key = ?`).get(`record_until:${agentId}`) as
    | { value: string }
    | undefined;
  if (!row) return { record: false, until: null };
  if (Date.parse(row.value) <= Date.now()) return { record: false, until: null };
  return { record: true, until: row.value };
}
