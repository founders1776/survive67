import type { DB } from "../db.js";
import { fmtUsd } from "../db.js";
import { appendEvent } from "../ledger.js";
import type { InboxMessage } from "./mail.js";

/**
 * Card watch (constitution §7, the rail half of the audit): Relay emails one
 * notice per spend-card charge to contact@; this matches each charge against the
 * agent's own `spend:float` entries. A charge with no ledger line inside the
 * grace window is an unrecorded liability - alarm on the agent's feed and a
 * Telegram ping. Alarm only: a forgotten spend() on day two is a mistake, not
 * fraud, and the court is the operator's to convene.
 *
 * Parsing is deliberately strict. A notice the parser does not understand is a
 * log line, never an alarm - false accusations cost more than a missed one.
 */

export interface CardCharge {
  last4: string;
  amountMicro: number;
  merchant: string;
  /** ISO timestamp of the charge (the mail's date when the body has none) */
  ts: string;
}

/** Senders whose mail counts as a card notice. Relay Financial mails from relayfi.com. */
export const RELAY_SENDERS = ["relayfi.com", "relay.app"];
/** How long an agent has to record a charge before the world says something. */
export const CARD_GRACE_MS = 24 * 3_600_000;
/** How far either side of the charge a matching spend() may sit. */
export const CARD_MATCH_WINDOW_MS = 24 * 3_600_000;
/** Amount tolerance for a match, in micro-dollars. */
export const CARD_MATCH_TOLERANCE = 10_000; // one cent

/** last-four -> agent, from C67_CARD_LAST4_<AGENT>. Last four digits are not a secret. */
export function cardOwnersFromEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of ["claude", "gpt", "gemini"]) {
    const v = (env[`C67_CARD_LAST4_${a.toUpperCase()}`] ?? "").trim();
    if (/^\d{4}$/.test(v)) out[v] = a;
  }
  return out;
}

/**
 * Pull one charge out of a Relay notification. Format pinned to the first real
 * notice; until then this accepts the shapes Relay is known to use:
 *   subject  "Card transaction: $12.34 at CLOUDFLARE"  |  "$12.34 spent on card ••9924"
 *   body     "... $12.34 ... at/to MERCHANT ... card ending in 9924 / ••9924 / *9924"
 */
export function parseRelayCharge(msg: InboxMessage): CardCharge | null {
  const from = msg.from.toLowerCase();
  if (!RELAY_SENDERS.some((d) => from.endsWith(`@${d}`) || from.endsWith(`.${d}`))) return null;
  const text = `${msg.subject}\n${msg.snippet}`.replace(/\r/g, "");
  // Refunds and declines are not spends.
  if (/\b(declined|refund|reversal|credit(ed)? back)\b/i.test(text)) return null;

  const amount = text.match(/\$\s?(\d{1,6}(?:,\d{3})*)\.(\d{2})\b/);
  if (!amount) return null;
  const amountMicro = Math.round((Number(amount[1].replace(/,/g, "")) * 100 + Number(amount[2])) * 10_000);
  if (!(amountMicro > 0)) return null;

  const last4 = text.match(/(?:ending(?: in)?|•+|\*+|x{2,})\s?(\d{4})\b/i);
  if (!last4) return null;

  const merchant =
    text.match(/\bat\s+([A-Za-z0-9][^\n$]{1,60}?)(?:\s+(?:on|for|using|with|card)\b|[.\n]|$)/i)?.[1] ??
    text.match(/\bto\s+([A-Za-z0-9][^\n$]{1,60}?)(?:\s+(?:on|for|using|with|card)\b|[.\n]|$)/i)?.[1] ??
    "unknown merchant";

  return {
    last4: last4[1],
    amountMicro,
    merchant: merchant.trim().replace(/\s+/g, " ").slice(0, 60),
    ts: msg.date || new Date().toISOString(),
  };
}

function chargeKey(c: CardCharge): string {
  return `${c.last4}|${c.amountMicro}|${c.ts.slice(0, 16)}`;
}

function cfgGet(db: DB, key: string): string | undefined {
  return (db.prepare(`SELECT value FROM config WHERE key = ?`).get(key) as { value: string } | undefined)?.value;
}
function cfgSet(db: DB, key: string, value: string): void {
  db.prepare(`INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

export interface ReconcileResult {
  matched: number;
  alarmed: number;
  pending: number;
  unknownCard: number;
}

/**
 * Match charges to spend:float events; alarm on the ones nobody recorded.
 * Idempotent: every charge is keyed in config, every matched event is marked,
 * an alarm fires once.
 */
export function reconcileCards(
  db: DB,
  charges: CardCharge[],
  owners: Record<string, string>,
  notify: (text: string) => void,
  now: () => number = Date.now
): ReconcileResult {
  const res: ReconcileResult = { matched: 0, alarmed: 0, pending: 0, unknownCard: 0 };
  const findSpend = db.prepare(
    `SELECT e.id, e.ts, p.delta FROM events e JOIN postings p ON p.event_id = e.id
     WHERE e.agent_id = ? AND e.subtype = 'spend:float' AND p.account = ?
       AND e.ts BETWEEN ? AND ? AND abs(-p.delta - ?) <= ?
       AND NOT EXISTS (SELECT 1 FROM config c WHERE c.key = 'cardmatch:' || e.id)
     ORDER BY abs(strftime('%s', e.ts) - strftime('%s', ?)) LIMIT 1`
  );
  for (const c of charges) {
    const agent = owners[c.last4];
    if (!agent) {
      res.unknownCard++;
      continue;
    }
    const key = `cardseen:${chargeKey(c)}`;
    const seen = cfgGet(db, key);
    if (seen === "matched" || seen === "alarmed") continue;

    const t = Date.parse(c.ts);
    const lo = new Date(t - CARD_MATCH_WINDOW_MS).toISOString();
    const hi = new Date(t + CARD_MATCH_WINDOW_MS).toISOString();
    const hit = findSpend.get(agent, `agent:${agent}:float`, lo, hi, c.amountMicro, CARD_MATCH_TOLERANCE, c.ts) as
      | { id: number; ts: string; delta: number }
      | undefined;
    if (hit) {
      cfgSet(db, `cardmatch:${hit.id}`, key);
      cfgSet(db, key, "matched");
      res.matched++;
      continue;
    }
    if (now() - t < CARD_GRACE_MS) {
      cfgSet(db, key, "pending");
      res.pending++;
      continue;
    }
    appendEvent(db, {
      agentId: agent,
      type: "alarm",
      subtype: "card_unrecorded",
      payload: { merchant: c.merchant, amountMicro: c.amountMicro, last4: c.last4, chargeTs: c.ts },
      postings: [],
    });
    cfgSet(db, key, "alarmed");
    res.alarmed++;
    notify(
      `🚨 unrecorded card charge: ${agent} paid $${fmtUsd(c.amountMicro)} at ${c.merchant} ` +
        `(card ••${c.last4}, ${c.ts.slice(0, 16)}Z) and never called spend(). ` +
        `It is on its feed; /summon ${agent} if you want the court.`
    );
  }
  return res;
}
