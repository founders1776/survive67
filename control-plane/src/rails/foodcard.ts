import type { DB } from "../db.js";
import { fmtUsd } from "../db.js";
import { buyCredits } from "../economy.js";

/**
 * Food-card rail (plan Ops Q12, revised 2026-09-17): buy_credits is ledger-instant
 * and FULLY autonomous. Food cards carry a standing cap (default $50/month = the
 * pre-revenue float ceiling), so no per-allocation operator action exists.
 *
 * The operator's only job is scaling: when an agent's earned float outgrows its
 * card cap, the headroom watcher pings Telegram and the operator raises the cap
 * in the banking app + /cap command. That fires only on success, never on a
 * decision — the constitution's "instantly, whenever you choose" stays true.
 */

export interface CardMover {
  /** informational hook after an allocation; never gates anything */
  move(agentId: string, micro: number): Promise<{ ok: boolean; detail: string }>;
}

/** Notification-only: books stay legible; no action attached. */
export class ManualMover implements CardMover {
  constructor(private notify: (text: string) => void) {}
  async move(agentId: string, micro: number) {
    this.notify(`🍽️ ${agentId} allocated $${fmtUsd(micro)} of float to credits. (info only)`);
    return { ok: true, detail: "informational; ledger is source of truth" };
  }
}

export async function buyCreditsWithCardMove(
  db: DB,
  agentId: string,
  micro: number,
  mover: CardMover
): Promise<{ eventId: number; moverDetail: string }> {
  const eventId = buyCredits(db, agentId, micro); // validates float, writes ledger
  const moved = await mover.move(agentId, micro);
  return { eventId, moverDetail: moved.detail };
}
