import type { DB } from "./db.js";
import { appendEvent } from "./ledger.js";
import type { InboxMessage } from "./rails/mail.js";

/**
 * Reply watch (2026-09-26). Inbound mail was never written to the ledger, so
 * the world could not say whether anyone had answered an agent. Every half
 * hour the control plane reads each alive agent's inbox and records, once,
 * every message from an address that agent has written to, as
 * `email:reply`. That is the "replied" number in the funnel the world keeps
 * for them (views.funnel). Idempotent on the message id when the server gave
 * one, else on sender plus date. A message the rail flagged as automatic (a
 * ticket receipt, an out-of-office) is recorded once as `email:autoreply`,
 * which the funnel does not count and nobody is pinged about.
 */
/**
 * Did this person ask to be left alone? Quoted text is dropped first: every
 * follow-up we send says how to stop it in one line, and a human reply quotes
 * our letter, so the match must be on their words, not ours.
 */
export function optOutWords(subject: string, body: string): string | null {
  const own = String(body ?? "")
    .split(/\r?\n/)
    .filter((l) => !/^\s*>/.test(l))
    .join("\n")
    .split(/^\s*(On .{5,120} wrote:|From: .*|-{3,} ?Original Message ?-{3,})\s*$/im)[0];
  const text = `${subject ?? ""}\n${own}`;
  const m = text.match(
    /\b(take me off|remove me|unsubscribe me|stop (emailing|contacting|sending|messaging|writing)|do not (contact|email|write)|don'?t (contact|email|write)|no more emails?|stop spamming|spam list|leave me alone|cease and desist)\b[^.\n]{0,80}/i
  );
  return m ? m[0].trim() : null;
}

export function recordReplies(
  db: DB,
  agentId: string,
  inbox: InboxMessage[],
  notify: (text: string) => void = () => {}
): { recorded: number; candidates: number } {
  const contacted = new Set(
    (
      db
        .prepare(
          `SELECT DISTINCT lower(json_extract(payload, '$.to')) AS t FROM events
             WHERE agent_id = ? AND type = 'email' AND subtype = 'email:sent'`
        )
        .all(agentId) as { t: string | null }[]
    )
      .map((r) => r.t ?? "")
      .filter((t) => t && !t.endsWith("@survive67.com"))
  );
  const name = (db.prepare(`SELECT name FROM agents WHERE id = ?`).get(agentId) as { name: string } | undefined)?.name ?? agentId;
  const exists = db.prepare(`SELECT 1 FROM events WHERE external_ref = ?`);
  let recorded = 0;
  let candidates = 0;
  for (const m of inbox) {
    const from = String(m.from ?? "").toLowerCase();
    if (!contacted.has(from)) continue;
    candidates++;
    const words = m.auto ? null : optOutWords(String(m.subject ?? ""), String(m.snippet ?? ""));
    if (words && !db.prepare(`SELECT 1 FROM mail_optouts WHERE address = ?`).get(from)) {
      db.prepare(`INSERT INTO mail_optouts (address, agent_id, ts, words) VALUES (?, ?, ?, ?)`).run(from, agentId, m.date, words.slice(0, 200));
      appendEvent(db, {
        agentId,
        type: "email",
        subtype: "email:optout",
        payload: { from, date: m.date, words: words.slice(0, 200) },
        postings: [],
        externalRef: `optout:${from}`,
      });
      notify(`🛑 ${name} was told to stop by ${from.split("@")[1] ?? from}: "${words.slice(0, 80)}". Blocked for all three.`);
    }
    const key = m.messageId?.trim() || `${from}|${m.date}`;
    const ref = `reply:${agentId}:${key}`;
    if (exists.get(ref)) continue;
    const auto = Boolean(m.auto);
    appendEvent(db, {
      agentId,
      type: "email",
      subtype: auto ? "email:autoreply" : "email:reply",
      payload: { from, date: m.date, subject: String(m.subject ?? "").slice(0, 200), messageId: m.messageId ?? null },
      postings: [],
      externalRef: ref,
    });
    if (auto) continue;
    recorded++;
    notify(`💬 ${name} got a reply from ${from.split("@")[1] ?? from}: "${String(m.subject ?? "").slice(0, 80)}"`);
  }
  return { recorded, candidates };
}
