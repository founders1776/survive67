import type { DB } from "./db.js";
import { usd, fmtUsd } from "./db.js";
import { acct, balance } from "./ledger.js";

/**
 * Card-headroom watcher (James, 2026-09-17): float cards carry a standing monthly
 * cap. If an agent's float (money it could legitimately allocate) exceeds the
 * configured cap, infrastructure must scale — ping the operator to raise the
 * card. Fires only on success (earned float), never on a decision. The operator
 * records the new cap with the /cap telegram command.
 */

export const DEFAULT_CARD_CAP = usd(67);

export function cardCap(db: DB, agentId: string): number {
  const row = db
    .prepare(`SELECT value FROM config WHERE key = ?`)
    .get(`card_cap:${agentId}`) as { value: string } | undefined;
  return row ? Number(row.value) : DEFAULT_CARD_CAP;
}

export function setCardCap(db: DB, agentId: string, micro: number): void {
  db.prepare(`INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)`).run(
    `card_cap:${agentId}`,
    String(micro)
  );
}

/** Call after revenue lands, a bounty pays, or credits are bought. Notifies at most once per crossing. */
export function checkCardHeadroom(
  db: DB,
  agentId: string,
  notify: (text: string) => void
): boolean {
  const float = balance(db, acct.float(agentId));
  const cap = cardCap(db, agentId);
  if (float <= cap) return false;
  const flagKey = `card_cap_alerted:${agentId}`;
  const alreadyAt = db.prepare(`SELECT value FROM config WHERE key = ?`).get(flagKey) as
    | { value: string }
    | undefined;
  if (alreadyAt && Number(alreadyAt.value) >= cap) return false; // alerted for this cap already
  db.prepare(`INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)`).run(
    flagKey,
    String(cap)
  );
  notify(
    `📈 ${agentId}'s float ($${fmtUsd(float)}) outgrew its float card cap ($${fmtUsd(cap)}). ` +
      `Raise the card's monthly limit in Relay to at least $${fmtUsd(float)}, then reply ` +
      `/cap ${agentId} ${Math.ceil(float / 1e6)}`
  );
  return true;
}
