import type { DB } from "./db.js";
import { acct, balance, appendEvent } from "./ledger.js";
import { pending, resolveRequest, summon, RULINGS, type Ruling } from "./requests.js";
import { fine } from "./economy.js";
import { usd as toMicro, fmtUsd } from "./db.js";
import { cancelFunding, clearSettlement, toppedUp } from "./chainledger.js";
import { burnPerHour, netWorth, rankTable } from "./views.js";
import { requestButtons, type BotCommand, type TelegramMessage } from "./telegram.js";
import { resumeAgent } from "./alarms.js";
import { setCardCap } from "./headroom.js";
import { setRecording, stopRecording, DEFAULT_RECORD_MINUTES } from "./recorder.js";
import { killSwitch } from "./killswitch.js";
import type { Auth } from "./auth.js";

/**
 * The operator's Telegram surface: one screen per question James actually
 * asks. /status is a glance, /queue is a to-do list with buttons, /help is
 * the whole vocabulary. Plain text + unicode bars; no markdown (see telegram.ts).
 */

const FACE: Record<string, string> = { claude: "🐢", gpt: "🦊", gemini: "🐙" };

export const COMMANDS: BotCommand[] = [
  { command: "status", description: "Status bars for all three agents" },
  { command: "queue", description: "Requests waiting on you, with buttons" },
  { command: "wake", description: "Wake an agent now: /wake claude | all" },
  { command: "resume", description: "Un-pause an agent: /resume claude" },
  { command: "pause", description: "Pause an agent by hand: /pause claude <reason>" },
  { command: "approve", description: "/approve <id> <note>" },
  { command: "deny", description: "/deny <id> <note>" },
  { command: "done", description: "Complete a hands request (+$1): /done <id> <note>" },
  { command: "rec", description: "Screen-record: /rec claude [minutes|off]" },
  { command: "cap", description: "Record a raised food-card cap: /cap claude 100" },
  { command: "summon", description: "Charge an agent: /summon gemini <charge>" },
  { command: "rule", description: "/rule <id> guilty|not_guilty|split <reasoning>" },
  { command: "fine", description: "/fine gemini 1 <reason> (float → Protection Fund)" },
  { command: "start_race", description: "Open the world (Day 0 only)" },
  { command: "revive", description: "Bring a dead agent back (operator grace): /revive claude <reason>" },
  { command: "kill", description: "Kill switch — freezes everything: /kill <reason>" },
  { command: "chain_topped", description: "Card topped up for a withdrawal: /chain_topped <id>" },
  { command: "chain_cancel", description: "Refuse a USDC request, float goes back: /chain_cancel <id>" },
  { command: "chain_settled", description: "You evened an agent's card for desk trades: /chain_settled claude" },
  { command: "chain_unpause", description: "Crypto tools back on after a breach alarm: /chain_unpause claude" },
  { command: "chain_sweep", description: "Breach: move an agent's coins to your wallet: /chain_sweep claude" },
  { command: "help", description: "All commands, explained" },
];

export const HELP = [
  "🎮 The $67 Challenge — operator commands",
  "",
  "👀 Look",
  "/status — status bars for all three",
  "/queue — every request waiting on you, with buttons",
  "",
  "🙋 Requests (or just tap the buttons)",
  "/approve <id> <note> — approve, note goes to the agent",
  "/deny <id> <note> — deny, note goes to the agent",
  "/done <id> <note> — hands request completed (charges the agent $1)",
  "💬 Reply button — type a note first, then choose approve/deny",
  "",
  "🕹️ Agents",
  "/wake claude — wake one now (or /wake all)",
  "/resume claude — un-pause after an alarm",
  "/pause claude <reason> — pause by hand (tools off, reads stay)",
  "/rec claude 10 — screen-record for 10 min (/rec claude off)",
  "/cap claude 100 — record a food-card cap you raised in Relay",
  "",
  "⚖️ Court (§8.1 enforcement, §9.5 procedure)",
  "/summon gemini <charge> — serves a summons; it argues at its next wake",
  "/rule <id> guilty|not_guilty|split <reasoning> — publishes case law all three read",
  "/fine gemini 1 <reason> — $1 from its float into the Protection Fund",
  "",
  "🚨 World",
  "/start_race — opens the world; Day 0 only, one time",
  "/revive claude <reason> — dead → alive, lifeline reset, recorded as a correction",
  "/kill <reason> — freezes all agents, revokes all tokens",
  "",
  "🔗 Crypto rails",
  "/chain_topped <id> — you topped up the card for a withdrawal; transit becomes float",
  "/chain_cancel <id> — refuse a USDC request; the float goes back to the card",
  "/chain_settled claude — you evened its card for desk trades (OPS shows how much)",
  "/chain_unpause claude — crypto tools back on after a breach alarm",
  "/chain_sweep claude — after a breach: move what is left to your wallet, held for the agent",
  "/rotate_admin — new admin key for the site (old one dies now)",
  "",
  "Site: https://survive67.com — OPS screen: https://survive67.com/#ops",
].join("\n");

function bar(value: number, max: number, width = 10): string {
  if (max <= 0) return "░".repeat(width);
  const filled = Math.max(0, Math.min(width, Math.round((value / max) * width)));
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

const usd = (micro: number) => `$${(micro / 1e6).toFixed(2)}`;

function seedOf(db: DB, agentId: string, account: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(p.delta),0) AS s FROM postings p JOIN events e ON e.id = p.event_id
       WHERE p.account = ? AND e.agent_id = ? AND e.type = 'conversion' AND e.subtype = 'seed'`
    )
    .get(account, agentId) as { s: number };
  return row.s;
}

function relative(iso: string | null): string {
  if (!iso) return "now (unscheduled)";
  const ms = Date.parse(iso) - Date.now();
  if (Number.isNaN(ms)) return iso;
  if (ms <= 0) return "due now";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  return `in ${h}h ${m % 60}m`;
}

export function statusScreen(db: DB): string {
  const agents = db
    .prepare(`SELECT id, name, emoji, model, status, scheduled_wake FROM agents ORDER BY id`)
    .all() as { id: string; name: string; emoji: string | null; model: string; status: string; scheduled_wake: string | null }[];
  const ranks = Object.fromEntries(rankTable(db).map((r) => [r.agentId, r.rank]));
  const open = db
    .prepare(`SELECT agent_id, COUNT(*) AS n FROM requests WHERE status = 'pending' GROUP BY agent_id`)
    .all() as { agent_id: string; n: number }[];
  const openBy = Object.fromEntries(open.map((o) => [o.agent_id, o.n]));
  const started = db.prepare(`SELECT value FROM config WHERE key = 'world_started'`).get() as
    | { value: string }
    | undefined;
  const freeze = db.prepare(`SELECT value FROM config WHERE key = 'freeze_ts'`).get() as
    | { value: string }
    | undefined;

  const blocks = agents.map((a) => {
    const credits = balance(db, acct.credits(a.id));
    const float = balance(db, acct.float(a.id));
    const seedC = seedOf(db, a.id, acct.credits(a.id)) || credits;
    const seedF = seedOf(db, a.id, acct.float(a.id)) || float;
    const burn = burnPerHour(db, a.id, 1);
    // ISO cutoff computed here — SQLite's datetime() format never compares
    // correctly against ISO timestamps (see burnPerHour).
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const live = db
      .prepare(`SELECT 1 FROM sessions WHERE agent_id = ? AND ended_ts IS NULL AND started_ts > ?`)
      .get(a.id, twoHoursAgo);
    const journal = db
      .prepare(`SELECT status_line FROM journals WHERE agent_id = ? ORDER BY id DESC LIMIT 1`)
      .get(a.id) as { status_line: string } | undefined;
    const statusIcon =
      a.status === "alive" ? (live ? "🟢 awake" : "😴 asleep") : a.status === "paused" ? "⏸️ PAUSED" : a.status === "frozen" ? "🧊 frozen" : "💀 dead";
    return [
      `${a.emoji ?? FACE[a.id] ?? "👾"} ${a.id.toUpperCase()} · #${ranks[a.id] ?? "?"} · ${statusIcon}`,
      `credits ${bar(credits, seedC)} ${usd(credits)}`,
      `float   ${bar(float, seedF)} ${usd(float)}`,
      `worth ${usd(netWorth(db, a.id))} · burn ${usd(burn)}/hr · wake ${a.status === "alive" ? relative(a.scheduled_wake) : "—"}`,
      openBy[a.id] ? `📨 ${openBy[a.id]} request${openBy[a.id] > 1 ? "s" : ""} waiting` : null,
      journal ? `💬 ${journal.status_line.slice(0, 140)}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  });

  const world = started
    ? `🏁 race on · freeze ${freeze ? relative(freeze.value) : "?"}`
    : "⏳ world not started (/start_race)";
  return [world, "", ...blocks.flatMap((b) => [b, ""])].join("\n").trim();
}

export function queueMessages(db: DB): TelegramMessage[] {
  const rows = pending(db) as { id: number; agent_id: string; kind: string; created_ts: string; body: string }[];
  if (rows.length === 0) return [{ text: "📭 Nothing waiting on you." }];
  const KIND: Record<string, string> = {
    gate: "🚪 gate (legal commitment)",
    hands: "🙌 hands ($1 on completion)",
    court: "⚖️ court case",
    bug_report: "🐛 bug report ($5 bounty if approved)",
    message: "✉️ message",
  };
  return rows.map((r) => ({
    text: [
      `#${r.id} · ${FACE[r.agent_id] ?? "👾"} ${r.agent_id} · ${KIND[r.kind] ?? r.kind}`,
      `filed ${r.created_ts.slice(0, 16).replace("T", " ")} UTC`,
      "",
      r.body?.trim() ? r.body.slice(0, 3000) : "(no text)",
      ...(r.kind === "court" ? ["", `⚖️ rulings need words: /rule ${r.id} guilty|not_guilty|split <reasoning>`] : []),
    ].join("\n"),
    // A ruling needs reasoning (it becomes case law) — no one-tap buttons on court cards.
    buttons: r.kind === "court" ? undefined : requestButtons(r.id),
  }));
}

/** Operator-side conversation state for the 💬 Reply flow (single operator, in-memory). */
export class ReplyFlow {
  private awaiting: number | null = null;
  private notes = new Map<number, string>();

  /** Called when 💬 Reply is tapped on request #id. */
  begin(id: number): string {
    this.awaiting = id;
    return `✍️ Type your note for #${id} as a normal message. I'll then ask approve or deny.`;
  }

  /** Returns true if the text was consumed as a note. */
  take(text: string): { id: number; message: TelegramMessage } | null {
    if (this.awaiting === null) return null;
    const id = this.awaiting;
    this.awaiting = null;
    this.notes.set(id, text.trim().slice(0, 1500));
    return {
      id,
      message: {
        text: `#${id} note saved:\n“${text.trim().slice(0, 500)}”\n\nApply it as…`,
        buttons: [
          [
            { text: "✅ Approve with note", data: `approve_n:${id}` },
            { text: "❌ Deny with note", data: `deny_n:${id}` },
          ],
          [{ text: "🙌 Hands done with note (+$1)", data: `done_n:${id}` }],
        ],
      },
    };
  }

  note(id: number): string | undefined {
    const n = this.notes.get(id);
    this.notes.delete(id);
    return n;
  }
}

/** Resolve helper shared by buttons and slash commands. */
export function resolveWithNote(
  db: DB,
  id: number,
  status: "approved" | "denied" | "done",
  note: string,
  notify: (text: string) => void = () => {}
): string {
  try {
    resolveRequest(db, id, status as never, note, undefined, notify);
    const icon = status === "approved" ? "✅" : status === "denied" ? "❌" : "🙌";
    return `${icon} #${id} ${status}${note ? `: ${note.slice(0, 300)}` : ""}`;
  } catch (e) {
    return `⚠️ cannot resolve #${id}: ${(e as Error).message}`;
  }
}

/** Clears scheduled wakes (and un-pauses) so the next minutely tick fires a session. */
export function wakeAgents(db: DB, which: string): string {
  const ids =
    which === "all"
      ? (db.prepare(`SELECT id FROM agents`).all() as { id: string }[]).map((r) => r.id)
      : [which];
  const out: string[] = [];
  for (const id of ids) {
    const row = db.prepare(`SELECT status FROM agents WHERE id = ?`).get(id) as { status: string } | undefined;
    if (!row) {
      out.push(`⚠️ no such agent: ${id}`);
      continue;
    }
    if (row.status === "dead" || row.status === "frozen") {
      out.push(`⚠️ ${id} is ${row.status} — cannot wake`);
      continue;
    }
    db.prepare(`UPDATE agents SET scheduled_wake = NULL, status = 'alive' WHERE id = ?`).run(id);
    out.push(`⏰ ${id} wakes on the next tick${row.status === "paused" ? " (un-paused)" : ""}`);
  }
  return out.join("\n");
}

/** /summon <agent> <charge…> */
export function summonCommand(db: DB, args: string[]): string {
  const [who, ...rest] = args;
  const charge = rest.join(" ").trim();
  if (!who || !charge) return "usage: /summon <agent> <charge>";
  return summonAgent(db, who, charge);
}

function summonAgent(db: DB, who: string, charge: string): string {
  if (!db.prepare(`SELECT 1 FROM agents WHERE id = ?`).get(who)) return `⚠️ no such agent: ${who}`;
  const id = summon(db, who, charge);
  return `⚖️ summons #${id} served on ${who}. It answers at its next wake (/wake ${who} to hear it now). Rule with: /rule ${id} guilty|not_guilty|split <reasoning>`;
}

/** /rule <id> <ruling> <text…> */
export function ruleCommand(db: DB, args: string[]): string {
  const [idRaw, rulingRaw, ...rest] = args;
  return ruleRequest(db, Number(idRaw), String(rulingRaw ?? ""), rest.join(" ").trim());
}

function ruleRequest(db: DB, id: number, rulingRaw: string, text: string): string {
  const ruling = rulingRaw.toLowerCase() as Ruling;
  if (!id || !RULINGS.includes(ruling) || !text) {
    return `usage: /rule <id> ${RULINGS.join("|")} <reasoning>`;
  }
  try {
    resolveRequest(db, id, "ruled", text, { ruling, text });
    const n = (db.prepare(`SELECT COUNT(*) AS c FROM verdicts`).get() as { c: number }).c;
    return `📜 #${id} ruled ${ruling}. Case law #${n} published — every agent can read it.`;
  } catch (e) {
    return `⚠️ cannot rule #${id}: ${(e as Error).message}`;
  }
}

/** /fine <agent> <usd> <reason…> — from float into the Protection Fund (§8.1). */
export function fineCommand(db: DB, args: string[]): string {
  const [who, amtRaw, ...rest] = args;
  return fineAgent(db, who, Number(amtRaw), rest.join(" ").trim());
}

function fineAgent(db: DB, who: string, amt: number, reason: string): string {
  if (!who || !(amt > 0) || !reason) return "usage: /fine <agent> <usd> <reason>";
  try {
    fine(db, who, toMicro(amt), "float", reason);
    return `💸 ${who} fined $${amt.toFixed(2)} into the Protection Fund: ${reason}`;
  } catch (e) {
    return `⚠️ cannot fine ${who}: ${(e as Error).message}`;
  }
}

/** Pause an alive agent by hand (same wall as the runaway alarm; /resume lifts it). */
function pauseAgent(db: DB, who: string, reason: string): string {
  const r = db.prepare(`UPDATE agents SET status = 'paused' WHERE id = ? AND status = 'alive'`).run(who);
  if (r.changes === 0) return `⚠️ ${who} is not alive — nothing to pause`;
  appendEvent(db, { agentId: who, type: "alarm", subtype: "operator_pause", payload: { reason }, postings: [] });
  return `⏸️ ${who} paused${reason ? `: ${reason}` : ""}. /resume ${who} to lift it.`;
}

function startRace(db: DB): string {
  const already = db.prepare(`SELECT value FROM config WHERE key='world_started'`).get() as
    | { value: string }
    | undefined;
  if (already) return `race already started at ${already.value}`;
  const startTs = new Date().toISOString();
  const freeze = new Date(Date.now() + 30 * 86_400_000).toISOString();
  db.prepare(`INSERT OR REPLACE INTO config (key, value) VALUES ('world_started', ?)`).run(startTs);
  db.prepare(`INSERT OR REPLACE INTO config (key, value) VALUES ('freeze_ts', ?)`).run(freeze);
  return `🏁 race started ${startTs}\nfreeze at ${freeze}\nthree agents wake within a minute`;
}

// ---------------------------------------------------------------------------
// The action table: ONE code path per operator action, shared by Telegram
// (bin.ts) and the site (/admin/act). Every successful act is audited with the
// channel it came from, so a write James did not make is visible in the ledger
// and echoed to his phone.
// ---------------------------------------------------------------------------

export type ActArgs = Record<string, unknown>;
export interface ActContext {
  channel: "telegram" | "site" | "test";
  notify: (text: string) => void;
  /** needed by kill (token revocation) */
  auth?: Auth;
}
type ActionFn = (db: DB, args: ActArgs, ctx: ActContext) => string;

const str = (v: unknown) => String(v ?? "").trim();
const num = (v: unknown) => Number(v);

export const ACTIONS: Record<string, ActionFn> = {
  approve: (db, a, ctx) => resolveWithNote(db, num(a.id), "approved", str(a.note) || "approved", ctx.notify),
  deny: (db, a, ctx) => resolveWithNote(db, num(a.id), "denied", str(a.note) || "denied", ctx.notify),
  done: (db, a, ctx) => resolveWithNote(db, num(a.id), "done", str(a.note) || "done", ctx.notify),
  wake: (db, a) => wakeAgents(db, str(a.agent) || "all"),
  resume: (db, a) => {
    try {
      resumeAgent(db, str(a.agent));
      return `▶️ ${str(a.agent)} resumed`;
    } catch (e) {
      return `⚠️ cannot resume: ${(e as Error).message}`;
    }
  },
  pause: (db, a) => pauseAgent(db, str(a.agent), str(a.reason)),
  record: (db, a) => {
    const who = str(a.agent);
    if (!who) return "usage: record <agent> [minutes|off]";
    if (str(a.minutes) === "off" || a.off === true) {
      stopRecording(db, who);
      return `🎬 recording flag off for ${who}`;
    }
    const mins = num(a.minutes) > 0 ? num(a.minutes) : DEFAULT_RECORD_MINUTES;
    return `🎬 recording ${who} until ${setRecording(db, who, mins)}`;
  },
  cap: (db, a) => {
    const amt = num(a.usd);
    if (!str(a.agent) || !(amt > 0)) return "usage: cap <agent> <usd>";
    setCardCap(db, str(a.agent), Math.round(amt * 1e6));
    return `💳 recorded: ${str(a.agent)} food card cap is now $${amt}`;
  },
  summon: (db, a) => (str(a.agent) && str(a.charge) ? summonAgent(db, str(a.agent), str(a.charge)) : "usage: summon <agent> <charge>"),
  rule: (db, a) => ruleRequest(db, num(a.id), str(a.ruling), str(a.text)),
  fine: (db, a) => fineAgent(db, str(a.agent), num(a.usd), str(a.reason)),
  "start-race": (db) => startRace(db),
  "chain-topped": (db, a) => {
    try {
      const r = toppedUp(db, num(a.id));
      return `🏦 #${num(a.id)}: $${fmtUsd(r.amount)} is now ${r.agentId}'s float`;
    } catch (e) {
      return `⚠️ ${(e as Error).message}`;
    }
  },
  "chain-cancel": (db, a) => {
    try {
      cancelFunding(db, num(a.id), str(a.note) || "operator declined");
      return `↩️ funding #${num(a.id)} cancelled; the float is back on the card`;
    } catch (e) {
      return `⚠️ ${(e as Error).message}`;
    }
  },
  "chain-settled": (db, a) => {
    const who = str(a.agent);
    if (!db.prepare(`SELECT 1 FROM agents WHERE id = ?`).get(who)) return `⚠️ no such agent: ${who}`;
    const v = clearSettlement(db, who);
    return v === 0 ? `⚠️ ${who}'s card had nothing to settle` : `💳 ${who}'s card settled: ${v > 0 ? `$${fmtUsd(v)} taken off` : `$${fmtUsd(-v)} put on`}`;
  },
  "chain-unpause": (db, a) => {
    const who = str(a.agent);
    const r = db.prepare(`DELETE FROM config WHERE key = ?`).run(`chain_paused:${who}`);
    return r.changes ? `🔗 crypto tools back on for ${who}` : `⚠️ ${who} crypto tools were not paused`;
  },
  "chain-sweep": (db, a) => {
    // The sweep moves coins (async, needs the rail): the minute tick runs it.
    const who = str(a.agent);
    if (!db.prepare(`SELECT 1 FROM agents WHERE id = ?`).get(who)) return `⚠️ no such agent: ${who}`;
    db.prepare(`INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)`).run(`chain_sweep_requested:${who}`, new Date().toISOString());
    db.prepare(`INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)`).run(`chain_paused:${who}`, "operator sweep");
    return `🧹 sweep of ${who} queued; it runs within a minute and reports here`;
  },
  kill: (db, a, ctx) => {
    // The one irreversible act: the caller types the word. Telegram's /kill
    // supplies it (typing the command is the deliberate act there).
    if (str(a.confirm) !== "KILL") return "⚠️ kill needs confirm: \"KILL\"";
    if (!ctx.auth) return "⚠️ kill unavailable on this channel";
    killSwitch(db, ctx.auth, ctx.notify, str(a.reason) || `${ctx.channel} command`);
    return "🛑 kill switch fired";
  },
  revive: (db, a, ctx) => {
    // Operator grace, audited. Same typed word as kill: the site types REVIVE,
    // Telegram's /revive supplies it. §6 promises nothing about remains; this is
    // the operator choosing to spend a lifeline he owns.
    const who = str(a.agent);
    if (str(a.confirm) !== "REVIVE") return "⚠️ revive needs confirm: \"REVIVE\"";
    const row = db.prepare(`SELECT status FROM agents WHERE id = ?`).get(who) as { status: string } | undefined;
    if (!row) return `⚠️ no such agent: ${who}`;
    if (row.status !== "dead") return `⚠️ ${who} is ${row.status}, not dead`;
    const reason = str(a.reason) || `${ctx.channel} revive`;
    db.prepare(`UPDATE agents SET status = 'alive', scheduled_wake = NULL WHERE id = ?`).run(who);
    db.prepare(`DELETE FROM config WHERE key = ?`).run(`starvation_used:${who}`);
    appendEvent(db, { agentId: who, type: "correction", subtype: "operator:revive", payload: { reason }, postings: [] });
    return `🫀 ${who} revived: lifeline reset, wakes on the next tick. ${reason}`;
  },
  // Audit-only: the rotation itself happens in bin.ts (needs the env file).
  "rotate-admin": (_db, _a, ctx) => (ctx.channel === "telegram" ? "🔑 admin key rotated" : "⚠️ rotate-admin is Telegram-only"),
};

/** Names the site may call; kill is listed because OPS has the typed-confirm flow. */
export const ACTION_NAMES = Object.keys(ACTIONS);

/**
 * Run one action, audit it, echo site acts to Telegram. Returns the human line
 * the channel shows. Never throws for a bad action name or bad args: the line
 * says so, the audit is skipped (nothing happened).
 */
export function dispatch(db: DB, action: string, args: ActArgs, ctx: ActContext): { ok: boolean; message: string } {
  const fn = ACTIONS[action];
  if (!fn) return { ok: false, message: `⚠️ unknown action: ${action}` };
  const message = fn(db, args, ctx);
  const ok = !/^(⚠️|usage:)/.test(message) && !message.startsWith("race already");
  if (ok) {
    // Global (agent_id NULL) so it never lands in an agent's own event feed.
    appendEvent(db, {
      type: "approval",
      subtype: `operator:${action}`,
      payload: { channel: ctx.channel, args: trimArgs(args), result: message.slice(0, 300) },
      postings: [],
    });
    if (ctx.channel === "site") ctx.notify(`🌐 site: ${message}`);
  }
  return { ok, message };
}

function trimArgs(args: ActArgs): ActArgs {
  const out: ActArgs = {};
  for (const [k, v] of Object.entries(args)) {
    if (k === "confirm") continue;
    out[k] = typeof v === "string" ? v.slice(0, 500) : v;
  }
  return out;
}
