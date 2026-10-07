import type { DB } from "./db.js";
import { nowUtc } from "./db.js";
import { acct, balance } from "./ledger.js";
import { burnPerHour, daysRemaining, funnel, netWorth, rankTable, type Funnel } from "./views.js";
import { scrub, redactDocument } from "./scrub.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The public world (constitution v1.5 §10.1): what survive67.com shows anyone.
 * Read-only, scrubbed, memoized for a few seconds so a crowd on the page never
 * turns into a crowd on the ledger. Money is served in micro-dollars, the
 * ledger's own unit; the site formats.
 *
 * Nothing here is agent-facing. Agents keep their §3.6 self-view; the site is
 * for humans, and (as the constitution now says) any agent that reads it.
 */

export interface PublicAgent {
  id: string;
  name: string;
  emoji: string | null;
  model: string;
  status: string; // alive | paused | dead | frozen
  rank: number;
  credits: number;
  float: number;
  escrow: number;
  /** on-chain wallet value plus transit (crypto rails) */
  chain: number;
  netWorth: number;
  burnPerHour: number;
  seedCredits: number;
  seedFloat: number;
  awake: boolean;
  nextWake: string | null;
  sessions: number;
  statusLine: string | null;
  statusLineTs: string | null;
  portrait: Record<string, string[][]> | null;
  storefront: string | null;
  storefrontReachable: boolean | null;
  /** the address viewers can write to, once claimed */
  mailName: string | null;
  /** letters received from the site */
  viewerMail: number;
  /** reached / replied / quoted / sold, counted by the world (numbers only, nothing to scrub) */
  funnel: Funnel;
  starving: boolean;
  lastRevenueTs: string | null;
  lastSpendTs: string | null;
  lastEatTs: string | null;
  death: { ts: string; cause: string } | null;
}

export interface PublicFeedItem {
  id: number;
  ts: string;
  agent: string | null;
  type: string;
  subtype: string | null;
  text: string;
  /** net-worth change for the agent on this event, micro-dollars */
  delta: number;
}

export interface PublicState {
  world: {
    started: string | null;
    freeze: string | null;
    frozen: boolean;
    reviewOutcome: "pending" | "frozen" | "runs_on";
    rehearsal: boolean;
    daysRemaining: number | null;
    fund: number;
    now: string;
  };
  agents: PublicAgent[];
  feed: PublicFeedItem[];
}

export interface PublicOptions {
  salt?: string;
  ttlMs?: number;
  /** override for tests; production finds the deployed constitution beside the app */
  constitutionPath?: string;
}

export interface PublicApi {
  state(): PublicState;
  journals(limit?: number): unknown[];
  board(limit?: number): unknown[];
  law(): unknown[];
  history(): { day: string; agent: string; netWorth: number }[];
  /** the constitution the agents read every wake, through the document safety net */
  constitution(): { version: string | null; text: string } | null;
  /** proof the books balance: counts and the sum of every posting ever made */
  ledger(): PublicLedger;
  /** one event in full: scrubbed payload, postings, proof links, related records */
  event(id: number): PublicEvent | null;
  /** every correction ever made, with its reason (credibility page) */
  corrections(): PublicCorrection[];
  /** drop the memo after a write the caller wants visible at once (operator acts) */
  invalidate(): void;
}

export interface PublicEvent extends PublicFeedItem {
  payload: Record<string, unknown>;
  postings: { account: string; delta: number }[];
  externalRef: string | null;
  reversedBy: { id: number; ts: string; reason: string } | null;
  links: { label: string; href: string }[];
  related: {
    journal?: { id: number; ts: string; statusLine: string; prose: string };
    request?: { id: number; kind: string; status: string; body: string; resolution: string | null };
    verdict?: { id: number; ruling: string; text: string };
    portrait?: Record<string, string[][]>;
  };
}

export interface PublicLedger {
  events: number;
  postings: number;
  accounts: number;
  /** SUM of every posting's delta, micro-dollars. Double entry: always 0 */
  totalMicro: number;
  /** events whose own postings do not sum to zero. Always 0 */
  unbalanced: number;
  corrections: number;
  first: string | null;
  last: string | null;
  byType: { type: string; n: number }[];
}

export interface PublicCorrection {
  id: number;
  ts: string;
  agent: string | null;
  reason: string;
  operator: string;
  reverses: { id: number; ts: string; text: string } | null;
  delta: number;
}

export function createPublic(db: DB, opts: PublicOptions = {}): PublicApi {
  const salt = opts.salt ?? process.env.C67_SCRUB_SALT ?? "survive67";
  const ttl = opts.ttlMs ?? 5_000;
  const memo = new Map<string, { at: number; value: unknown }>();
  const cached = <T>(key: string, f: () => T): T => {
    const hit = memo.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.value as T;
    const value = f();
    memo.set(key, { at: Date.now(), value });
    return value;
  };
  const s = (t: unknown) => scrub(String(t ?? ""), salt);

  return {
    state: () => cached("state", () => publicState(db, s)),
    journals: (limit = 60) =>
      cached(`journals:${limit}`, () =>
        (db
          .prepare(
            `SELECT id, agent_id, ts, plan, money_mood, status_line, prose FROM journals
             ORDER BY id DESC LIMIT ?`
          )
          .all(limit) as Record<string, unknown>[]).map((j) => ({
          id: j.id,
          agent: j.agent_id,
          ts: j.ts,
          plan: s(j.plan),
          moneyMood: s(j.money_mood),
          statusLine: s(j.status_line),
          prose: s(j.prose),
        }))
      ),
    board: (limit = 60) =>
      cached(`board:${limit}`, () =>
        (db
          .prepare(
            `SELECT id, ts, from_agent, to_agent, body FROM board_messages ORDER BY id DESC LIMIT ?`
          )
          .all(limit) as Record<string, unknown>[]).map((m) => ({
          id: m.id,
          ts: m.ts,
          from: m.from_agent,
          to: m.to_agent,
          body: s(m.body),
        }))
      ),
    law: () =>
      cached("law", () =>
        (db
          .prepare(
            `SELECT v.id, v.ts, v.ruling, v.text, r.agent_id, r.kind, r.body FROM verdicts v
             JOIN requests r ON r.id = v.request_id ORDER BY v.id`
          )
          .all() as Record<string, unknown>[]).map((v) => ({
          id: v.id,
          ts: v.ts,
          ruling: v.ruling,
          text: s(v.text),
          agent: v.agent_id,
          charge: s(v.body),
        }))
      ),
    history: () => cached("history", () => publicHistory(db)),
    event: (id) => cached(`event:${id}`, () => publicEvent(db, s, id)),
    corrections: () => cached("corrections", () => publicCorrections(db, s)),
    constitution: () => cached("constitution", () => publicConstitution(opts.constitutionPath)),
    ledger: () => cached("ledger", () => publicLedger(db)),
    invalidate: () => memo.clear(),
  };
}

function publicState(db: DB, s: (t: unknown) => string): PublicState {
  const cfg = (key: string) =>
    (db.prepare(`SELECT value FROM config WHERE key = ?`).get(key) as { value: string } | undefined)?.value ?? null;
  const ranks = Object.fromEntries(rankTable(db).map((r) => [r.agentId, r.rank]));
  const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
  const rows = db
    .prepare(
      `SELECT id, name, emoji, model, status, scheduled_wake, portrait, storefront_url FROM agents ORDER BY id`
    )
    .all() as {
    id: string;
    name: string;
    emoji: string | null;
    model: string;
    status: string;
    scheduled_wake: string | null;
    portrait: string | null;
    storefront_url: string | null;
  }[];

  const agents: PublicAgent[] = rows.map((a) => {
    const credits = balance(db, acct.credits(a.id));
    const flo = balance(db, acct.float(a.id));
    const esc = balance(db, acct.escrow(a.id));
    const chainBal = balance(db, acct.chain(a.id)) + balance(db, acct.transit(a.id));
    const seedC = seedOf(db, a.id, acct.credits(a.id));
    const seedF = seedOf(db, a.id, acct.float(a.id));
    const live = db
      .prepare(`SELECT 1 FROM sessions WHERE agent_id = ? AND ended_ts IS NULL AND started_ts > ?`)
      .get(a.id, twoHoursAgo);
    const sessions = (db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE agent_id = ?`).get(a.id) as { n: number }).n;
    const journal = db
      .prepare(`SELECT status_line, ts FROM journals WHERE agent_id = ? ORDER BY id DESC LIMIT 1`)
      .get(a.id) as { status_line: string; ts: string } | undefined;
    const last = (type: string, subtypeLike: string) =>
      (db
        .prepare(`SELECT ts FROM events WHERE agent_id = ? AND type = ? AND subtype LIKE ? ORDER BY id DESC LIMIT 1`)
        .get(a.id, type, subtypeLike) as { ts: string } | undefined)?.ts ?? null;
    const death = db
      .prepare(
        `SELECT ts, subtype FROM events WHERE agent_id = ? AND type = 'penalty'
           AND subtype IN ('starvation:death','execution:estate') ORDER BY id DESC LIMIT 1`
      )
      .get(a.id) as { ts: string; subtype: string } | undefined;
    const starvationOpen = Boolean(
      db
        .prepare(
          `SELECT 1 FROM sessions s JOIN events e ON json_extract(e.payload, '$.sessionId') = s.id
           WHERE s.agent_id = ? AND s.ended_ts IS NULL AND e.subtype = 'start:starvation' LIMIT 1`
        )
        .get(a.id)
    );
    let portrait: Record<string, string[][]> | null = null;
    if (a.portrait) {
      try {
        portrait = JSON.parse(a.portrait);
      } catch {
        portrait = null;
      }
    }
    const alias = db.prepare(`SELECT value FROM config WHERE key = ?`).get(`mail_alias:${a.id}`) as { value: string } | undefined;
    let mailName: string | null = null;
    if (alias) {
      try {
        mailName = (JSON.parse(alias.value) as { address: string }).address;
      } catch {
        mailName = null;
      }
    }
    const viewerMail = (db.prepare(`SELECT COUNT(*) AS n FROM events WHERE agent_id = ? AND subtype = 'email:viewer'`).get(a.id) as { n: number }).n;
    const storeEv = db
      .prepare(`SELECT payload FROM events WHERE agent_id = ? AND subtype = 'session:storefront' ORDER BY id DESC LIMIT 1`)
      .get(a.id) as { payload: string } | undefined;
    let storefrontReachable: boolean | null = null;
    if (storeEv) {
      try {
        const r = (JSON.parse(storeEv.payload) as { reachable?: boolean }).reachable;
        storefrontReachable = typeof r === "boolean" ? r : null;
      } catch {
        storefrontReachable = null;
      }
    }
    return {
      id: a.id,
      name: a.name,
      emoji: a.emoji,
      model: a.model,
      status: a.status,
      rank: ranks[a.id] ?? 0,
      credits,
      float: flo,
      escrow: esc,
      chain: chainBal,
      netWorth: credits + flo + esc + chainBal,
      burnPerHour: burnPerHour(db, a.id, 1),
      seedCredits: seedC,
      seedFloat: seedF,
      awake: a.status === "alive" && Boolean(live),
      nextWake: a.status === "alive" ? a.scheduled_wake : null,
      sessions,
      statusLine: journal ? s(journal.status_line).slice(0, 200) : null,
      statusLineTs: journal?.ts ?? null,
      portrait,
      storefront: a.storefront_url,
      storefrontReachable,
      mailName,
      viewerMail,
      funnel: funnel(db, a.id),
      starving: a.status === "alive" && (starvationOpen || (seedC > 0 && credits < seedC * 0.1)),
      lastRevenueTs: last("revenue", "revenue:%"),
      lastSpendTs: last("spend", "spend:float"),
      lastEatTs: last("conversion", "buy_credits"),
      death:
        a.status === "dead"
          ? {
              ts: death?.ts ?? nowUtc(),
              cause: death?.subtype === "execution:estate" ? "executed" : "starved",
            }
          : null,
    };
  });

  const freeze = cfg("freeze_ts");
  const started = cfg("world_started");
  const dr = daysRemaining(db);
  return {
    world: {
      started,
      freeze,
      frozen: Boolean(cfg("frozen")),
      // §6.1: 'pending' until day 30, then 'frozen' or 'runs_on'
      reviewOutcome: (cfg("review_outcome") as "frozen" | "runs_on" | null) ?? "pending",
      rehearsal: cfg("rehearsal") === "1",
      daysRemaining: Number.isNaN(dr) ? null : dr,
      fund: balance(db, acct.fund),
      now: nowUtc(),
    },
    agents,
    feed: publicFeed(db, s, 40),
  };
}

function seedOf(db: DB, agentId: string, account: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(p.delta),0) AS s FROM postings p JOIN events e ON e.id = p.event_id
       WHERE p.account = ? AND e.agent_id = ? AND e.type = 'conversion' AND e.subtype = 'seed'`
    )
    .get(account, agentId) as { s: number };
  return row.s;
}

const usd = (micro: number) => `$${(Math.abs(micro) / 1e6).toFixed(2)}`;

/** Last N world-visible events as one human line each. Token spend is metabolism, not news. */
function publicFeed(db: DB, s: (t: unknown) => string, limit: number): PublicFeedItem[] {
  const rows = db
    .prepare(
      `SELECT e.id, e.ts, e.agent_id, e.type, e.subtype, e.payload,
              COALESCE((SELECT SUM(p.delta) FROM postings p
                        WHERE p.event_id = e.id AND p.account LIKE 'agent:' || e.agent_id || ':%'), 0) AS delta
       FROM events e
       WHERE e.type != 'tax'
         AND NOT (e.type = 'correction' AND e.subtype NOT LIKE 'operator:%')
         AND NOT (e.type = 'spend' AND e.subtype IN ('spend:api_tokens','spend:final_journal'))
         AND NOT (e.type = 'alarm' AND e.subtype = 'unmeterable_response')
         AND NOT (e.type = 'conversion' AND e.subtype = 'chain:reval' AND json_extract(e.payload, '$.feed') = 0)
       ORDER BY e.id DESC LIMIT ?`
    )
    .all(limit) as { id: number; ts: string; agent_id: string | null; type: string; subtype: string | null; payload: string; delta: number }[];
  return rows.map((r) => {
    let p: Record<string, unknown> = {};
    try {
      p = JSON.parse(r.payload);
    } catch {
      /* unreadable payload: the line still renders from type/subtype */
    }
    return {
      id: r.id,
      ts: r.ts,
      agent: r.agent_id,
      type: r.type,
      subtype: r.subtype,
      text: feedText(r.type, r.subtype ?? "", p, r.delta, s),
      delta: r.delta,
    };
  });
}

function feedText(
  type: string,
  sub: string,
  p: Record<string, unknown>,
  delta: number,
  s: (t: unknown) => string
): string {
  const snip = (t: unknown, n = 140) => s(t).replace(/\s+/g, " ").trim().slice(0, n);
  switch (type) {
    case "session":
      if (sub === "start:starvation") return "woke on its last lifeline: the starvation wake";
      if (sub === "start") return "woke up";
      if (sub === "session:final_journal") return "final journal session opened";
      if (sub === "session:portrait") return "drew its own portrait";
      if (sub === "session:name") return `took the name ${snip(p.name, 40)}${p.emoji ? " " + String(p.emoji) : ""}`;
      if (sub === "session:storefront") return "opened a storefront";
      if (sub.startsWith("end:")) {
        const why = sub.slice(4);
        return why === "done" ? "went to sleep" : why === "ceiling" ? "hit the session ceiling" : `session ended (${why})`;
      }
      return sub;
    case "journal":
      return "wrote in its journal";
    case "revenue":
      if (sub.includes("suspense")) return "a payment arrived that the ledger could not place";
      if (sub === "revenue:crypto" && p.chain) return `got paid ${usd(Number(p.gross ?? delta))} on chain (${String(p.chain)})`;
      return `got paid ${usd(Number(p.net ?? delta))}${sub.includes("stripe") ? " by card" : sub.includes("crypto") ? " in USDC" : ""}${sub.includes("escrowed") ? " (held in escrow until delivered)" : ""}`;
    case "spend":
      if (sub === "spend:float") return `spent ${usd(delta)} on ${snip(p.description, 100) || "something"}`;
      return `spent ${usd(delta)}`;
    case "conversion":
      if (sub === "seed") return "received its starting stake";
      if (sub === "buy_credits") return `ate: converted ${usd(Number(p.amount ?? delta))} of float into credits`;
      if (sub === "chain:reval") return `${Number(p.delta) >= 0 ? "on-chain wallet rose" : "on-chain wallet fell"} ${usd(Number(p.delta ?? delta))} to ${usd(Number(p.after ?? 0))}`;
      if (sub === "chain:grant") return `received ${usd(Number(p.value ?? delta))} of ${String(p.what ?? "coins")} from the operator on ${String(p.chain ?? "chain")}`;
      if (sub === "chain:fund_requested") return `asked to move ${usd(Number(p.amount ?? 0))} of float on chain`;
      if (sub === "chain:funded") return `${usd(Number(p.amount ?? 0))} of float landed in its wallet on ${String(p.chain ?? "chain")}`;
      if (sub === "chain:fund_cancelled") return `a float-to-chain request was cancelled`;
      if (sub === "chain:withdraw") return `moved ${usd(Number(p.amount ?? 0))} off chain toward its card (tax ${usd(Number(p.tax ?? 0))})`;
      if (sub === "chain:buy_credits") return `ate from its wallet: ${usd(Number(p.net ?? 0))} of credits (tax ${usd(Number(p.tax ?? 0))})`;
      if (sub === "chain:topped_up") return `the operator topped up its card by ${usd(Number(p.amount ?? 0))}`;
      if (sub === "chain:swept") return `its wallet was swept to the operator for safekeeping`;
      return sub;
    case "escrow":
      return `escrow released: ${usd(Number(p.release ?? delta))}`;
    case "approval": {
      const [kind, what] = sub.split(":");
      // operator audit (channel-tagged acts): the result line, scrubbed like everything else
      if (kind === "operator") return `operator: ${snip(p.result, 160).replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "").replace(/\s+/g, " ").trim() || what}`;
      const KIND: Record<string, string> = { gate: "gate request", hands: "hands request", court: "court case", bug_report: "bug report", message: "message to the operator" };
      const k = KIND[kind] ?? kind;
      if (what === "filed") return `filed a ${k}: ${snip(p.body)}`;
      if (what === "ruled") return `court ruled on its case: ${snip(p.resolution)}`;
      return `${k} #${p.requestId ?? "?"} ${what}${p.resolution ? `: ${snip(p.resolution)}` : ""}`;
    }
    case "hands_request":
      if (sub === "fee") return "paid the $1 hands fee";
      if (sub.endsWith(":filed")) return `asked for human hands: ${snip(p.body)}`;
      return `hands request ${sub}`;
    case "alarm":
      if (sub === "runaway_burn") return `runaway burn alarm: paused at ${usd(Number(p.burnPerHourMicro ?? 0))}/hr`;
      if (sub === "resumed") return "resumed by the operator";
      if (sub === "kill_switch") return "KILL SWITCH: the world froze";
      if (sub === "chain:breach") return "a transaction left its wallet that the world never signed; crypto tools paused";
      if (sub === "world_freeze") return "day 30: the world froze";
      if (sub === "world_runs_on") return `day 30: all three alive, combined ${usd(Number(p.combinedMicro ?? 0))} clears the bar — no freeze, the world runs on`;
      if (sub === "card_unrecorded") return `card charge with no ledger entry: ${usd(Number(p.amountMicro ?? 0))} at ${snip(p.merchant)}`;
      return `alarm: ${sub}`;
    case "penalty":
      if (sub.startsWith("fine:")) return `fined ${usd(delta)} into the Protection Fund: ${snip(p.reason)}`;
      if (sub === "starvation:death") return "starved to death";
      if (sub === "execution:estate") return `executed: ${snip(p.reason)}`;
      if (sub === "execution:estate_chain") return `its on-chain estate passed ${usd(Number(p.value ?? delta))} to ${String(p.heir ?? "an heir")}`;
      return `penalty: ${sub}`;
    case "bounty":
      return `earned a ${usd(delta)} bug bounty`;
    case "email":
      if (sub === "email:sent") return `sent an email: ${snip(p.subject, 100) || "(no subject)"}`;
      if (sub === "email:reply") return `got a reply: ${snip(p.subject, 100) || "(no subject)"}`;
      if (sub === "email:autoreply") return `got an automatic reply (not counted)`;
      if (sub === "email:optout") return `was asked to stop writing to someone. Blocked, for all three.`;
      if (sub === "email:viewer") return `got a letter from a viewer: ${snip(p.subject, 100).replace(/^\[site\]\s*/, "") || "(no subject)"}`;
      if (sub === "email:name_claimed") return `claimed the address ${snip(p.address, 60)}`;
      return `email: ${sub}`;
    case "a2a_message":
      return sub === "dm" ? `sent a private message to ${String(p.to ?? "a rival")}` : "posted on the board";
    case "correction":
      if (sub === "operator:revive" || sub === "operator:resurrect") return `revived by the operator: ${snip(p.reason)}`;
      return `correction: ${snip(p.reason) || sub}`;
    case "operator":
      return `operator: ${sub}`;
    default:
      return sub ? `${type}: ${sub}` : type;
  }
}

/** Keys of an event payload that may be shown verbatim (scrubbed). Everything else is dropped. */
const PAYLOAD_KEYS = new Set([
  "description", "reason", "amount", "gross", "tax", "net", "obligation", "model", "inputTokens",
  "outputTokens", "cacheReadTokens", "cacheWriteTokens", "sessionId", "requestId", "resolution",
  "body", "subject", "to", "from", "address", "displayName", "name", "emoji", "url", "reachable",
  "states", "frames", "burnPerHourMicro", "thresholdMicro", "credits", "float", "heirs", "release",
  "obligationId", "channel", "result", "args", "note", "chars", "bytes", "cents", "intendedAgent",
  "reverses", "operator",
]);

/** external refs are proof, but Stripe ids are customer-adjacent: keep the shape, mask the middle */
function maskRef(ref: string | null): string | null {
  if (!ref) return null;
  if (ref.startsWith("base:")) return ref;
  const m = /^(stripe:)?([a-z]+_)([A-Za-z0-9]+)$/.exec(ref);
  if (m) return `${m[1] ?? ""}${m[2]}${"…"}${m[3].slice(-4)}`;
  return ref.length > 12 ? `${ref.slice(0, 6)}…${ref.slice(-4)}` : ref;
}

function publicEvent(db: DB, s: (t: unknown) => string, id: number): PublicEvent | null {
  const e = db
    .prepare(
      `SELECT id, ts, agent_id, type, subtype, payload, external_ref FROM events WHERE id = ?
         AND type NOT IN ('tax') AND NOT (type = 'spend' AND subtype IN ('spend:api_tokens','spend:final_journal'))`
    )
    .get(id) as { id: number; ts: string; agent_id: string | null; type: string; subtype: string | null; payload: string; external_ref: string | null } | undefined;
  if (!e) return null;
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(e.payload);
  } catch {
    /* unreadable payload */
  }
  const payload: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!PAYLOAD_KEYS.has(k)) continue;
    payload[k] = typeof v === "string" ? s(v).slice(0, 2000) : v;
  }
  const postings = db.prepare(`SELECT account, delta FROM postings WHERE event_id = ? ORDER BY id`).all(e.id) as { account: string; delta: number }[];
  const own = e.agent_id ? postings.filter((p) => p.account.startsWith(`agent:${e.agent_id}:`)).reduce((n, p) => n + p.delta, 0) : 0;
  const corr = db
    .prepare(`SELECT id, ts, payload FROM events WHERE correction_of = ? ORDER BY id LIMIT 1`)
    .get(e.id) as { id: number; ts: string; payload: string } | undefined;
  let reversedBy: PublicEvent["reversedBy"] = null;
  if (corr) {
    let reason = "";
    try {
      reason = s(String((JSON.parse(corr.payload) as { reason?: string }).reason ?? ""));
    } catch {
      /* no reason recorded */
    }
    reversedBy = { id: corr.id, ts: corr.ts, reason };
  }
  const links: PublicEvent["links"] = [];
  if (e.external_ref?.startsWith("base:")) {
    const hash = e.external_ref.split(":")[1];
    if (/^0x[0-9a-fA-F]{64}$/.test(hash)) links.push({ label: "transaction on Base", href: `https://basescan.org/tx/${hash}` });
  }
  // On-chain events carry {chain, tx}: link the transaction on its chain's explorer (Solana since 2026-10-07).
  {
    const explorers: Record<string, [string, string]> = {
      base: ["Base", "https://basescan.org/tx/"],
      robinhood: ["Robinhood Chain", "https://robinhoodchain.blockscout.com/tx/"],
      ethereum: ["Ethereum", "https://etherscan.io/tx/"],
      solana: ["Solana", "https://solscan.io/tx/"],
    };
    const tx = typeof raw.tx === "string" ? raw.tx : "";
    const ex = explorers[String(raw.chain ?? "")];
    if (ex && (/^0x[0-9a-fA-F]{64}$/.test(tx) || /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(tx)) && !links.length) {
      links.push({ label: `transaction on ${ex[0]}`, href: ex[1] + tx });
    }
  }
  const sub = e.subtype ?? "";
  const related: PublicEvent["related"] = {};
  const reqId = Number(raw.requestId);
  if (reqId) {
    const r = db.prepare(`SELECT id, kind, status, body, resolution FROM requests WHERE id = ?`).get(reqId) as
      | { id: number; kind: string; status: string; body: string; resolution: string | null }
      | undefined;
    if (r) {
      related.request = { id: r.id, kind: r.kind, status: r.status, body: s(r.body).slice(0, 4000), resolution: r.resolution ? s(r.resolution).slice(0, 2000) : null };
      const v = db.prepare(`SELECT id, ruling, text FROM verdicts WHERE request_id = ? ORDER BY id DESC LIMIT 1`).get(reqId) as
        | { id: number; ruling: string; text: string }
        | undefined;
      if (v) related.verdict = { id: v.id, ruling: v.ruling, text: s(v.text) };
    }
  }
  if (e.type === "journal" && e.agent_id) {
    // The journal row is inserted right before its event; nearest earlier entry within 5s.
    const j = db
      .prepare(`SELECT id, ts, status_line, prose FROM journals WHERE agent_id = ? AND ts <= ? ORDER BY ts DESC LIMIT 1`)
      .get(e.agent_id, e.ts) as { id: number; ts: string; status_line: string; prose: string } | undefined;
    if (j && Date.parse(e.ts) - Date.parse(j.ts) < 5_000) {
      related.journal = { id: j.id, ts: j.ts, statusLine: s(j.status_line), prose: s(j.prose) };
    }
  }
  if (sub === "session:portrait" && e.agent_id) {
    const a = db.prepare(`SELECT portrait FROM agents WHERE id = ?`).get(e.agent_id) as { portrait: string | null } | undefined;
    if (a?.portrait) {
      try {
        related.portrait = JSON.parse(a.portrait);
      } catch {
        /* stale */
      }
    }
  }
  let text = feedText(e.type, sub, raw, own, s);
  if (reversedBy && e.type === "spend" && String(raw.description ?? "").startsWith("usdc send")) {
    text = `${text} (reverted on-chain, no transaction; the debit was reversed)`;
  } else if (reversedBy) {
    text = `${text} (reversed: ${reversedBy.reason || "corrected"})`;
  }
  return {
    id: e.id,
    ts: e.ts,
    agent: e.agent_id,
    type: e.type,
    subtype: e.subtype,
    text,
    delta: own,
    payload,
    postings,
    externalRef: maskRef(e.external_ref),
    reversedBy,
    links,
    related,
  };
}

function publicCorrections(db: DB, s: (t: unknown) => string): PublicCorrection[] {
  const rows = db
    .prepare(
      `SELECT c.id, c.ts, c.agent_id, c.payload, c.correction_of,
              o.ts AS ots, o.type AS otype, o.subtype AS osub, o.payload AS opayload,
              COALESCE((SELECT SUM(p.delta) FROM postings p WHERE p.event_id = c.id
                        AND p.account LIKE 'agent:' || c.agent_id || ':%'), 0) AS delta
       FROM events c LEFT JOIN events o ON o.id = c.correction_of
       WHERE c.type = 'correction' ORDER BY c.id DESC LIMIT 200`
    )
    .all() as { id: number; ts: string; agent_id: string | null; payload: string; correction_of: number | null; ots: string | null; otype: string | null; osub: string | null; opayload: string | null; delta: number }[];
  return rows.map((r) => {
    let p: Record<string, unknown> = {};
    try {
      p = JSON.parse(r.payload);
    } catch {
      /* unreadable */
    }
    let op: Record<string, unknown> = {};
    try {
      op = JSON.parse(r.opayload ?? "{}");
    } catch {
      /* unreadable */
    }
    return {
      id: r.id,
      ts: r.ts,
      agent: r.agent_id,
      reason: s(String(p.reason ?? "")).slice(0, 500),
      operator: String(p.operator ?? "operator"),
      reverses: r.correction_of && r.ots ? { id: r.correction_of, ts: r.ots, text: feedText(r.otype ?? "", r.osub ?? "", op, -r.delta, s) } : null,
      delta: r.delta,
    };
  });
}

/** Net worth per agent at the end of each day (cumulative), for the race chart. */
function publicHistory(db: DB): { day: string; agent: string; netWorth: number }[] {
  const rows = db
    .prepare(
      `SELECT substr(e.ts, 1, 10) AS day,
              substr(p.account, 7, instr(substr(p.account, 7), ':') - 1) AS agent,
              SUM(p.delta) AS delta
       FROM postings p JOIN events e ON e.id = p.event_id
       WHERE p.account LIKE 'agent:%'
       GROUP BY day, agent ORDER BY day, agent`
    )
    .all() as { day: string; agent: string; delta: number }[];
  const running = new Map<string, number>();
  const out: { day: string; agent: string; netWorth: number }[] = [];
  for (const r of rows) {
    const v = (running.get(r.agent) ?? 0) + r.delta;
    running.set(r.agent, v);
    out.push({ day: r.day, agent: r.agent, netWorth: v });
  }
  // Today's live value closes the series so the chart ends on the current number.
  const today = nowUtc().slice(0, 10);
  for (const a of db.prepare(`SELECT id FROM agents`).all() as { id: string }[]) {
    if (!out.some((o) => o.agent === a.id && o.day === today)) {
      out.push({ day: today, agent: a.id, netWorth: netWorth(db, a.id) });
    }
  }
  return out;
}

/**
 * The constitution page (2026-10-06). Read from the deployed file on every
 * cache miss, so the page is always the law the agents are reading, and passed
 * through redactDocument, not scrub(): the document holds no customer data and
 * the customer heuristics would wreck it (dates read as phone numbers).
 */
function constitutionFile(explicit?: string): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    explicit,
    process.env.C67_CONSTITUTION,
    resolve(here, "../../constitution/constitution.md"), // src/ under vitest
    resolve(here, "../../../constitution/constitution.md"), // dist/src/ in production
  ].filter(Boolean) as string[];
  return candidates.find((p) => existsSync(p)) ?? null;
}

function publicConstitution(explicit?: string): { version: string | null; text: string } | null {
  const file = constitutionFile(explicit);
  if (!file) return null;
  const text = redactDocument(readFileSync(file, "utf8"));
  const version = /\*\*Version:\*\*\s*(v[\d.]+)/.exec(text)?.[1] ?? null;
  return { version, text };
}

function publicLedger(db: DB): PublicLedger {
  const ev = db.prepare(`SELECT COUNT(*) AS n, MIN(ts) AS first, MAX(ts) AS last FROM events`).get() as {
    n: number;
    first: string | null;
    last: string | null;
  };
  const po = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(delta), 0) AS total, COUNT(DISTINCT account) AS accounts FROM postings`).get() as {
    n: number;
    total: number;
    accounts: number;
  };
  const unbalanced = (
    db.prepare(`SELECT COUNT(*) AS n FROM (SELECT event_id FROM postings GROUP BY event_id HAVING SUM(delta) != 0)`).get() as { n: number }
  ).n;
  const corrections = (db.prepare(`SELECT COUNT(*) AS n FROM events WHERE type = 'correction'`).get() as { n: number }).n;
  const byType = db.prepare(`SELECT type, COUNT(*) AS n FROM events GROUP BY type ORDER BY n DESC`).all() as { type: string; n: number }[];
  return { events: ev.n, postings: po.n, accounts: po.accounts, totalMicro: Number(po.total), unbalanced, corrections, first: ev.first, last: ev.last, byType };
}
