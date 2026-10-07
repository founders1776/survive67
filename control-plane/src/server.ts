import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import dns from "node:dns/promises";
import type { DB } from "./db.js";
import { openDb, nowUtc, usd, fmtUsd } from "./db.js";
import { Auth } from "./auth.js";
import { appendEvent, balance, acct } from "./ledger.js";
import { buyCredits, spendFloat, meterApiCall, fine, executeAgent, assertObligationHeadroom, starveAgent } from "./economy.js";
import { selfView, ownHistory, rankTable } from "./views.js";
import { fileRequest, pending, caseLaw, summon } from "./requests.js";
import { auditInternal } from "./audit.js";
import { TelegramBot } from "./telegram.js";
import { checkRunaway, resumeAgent } from "./alarms.js";
import { killSwitch, freezeWorld } from "./killswitch.js";
import { proxyCall, ProxyDeniedError } from "./proxy.js";
import { StripeRail } from "./rails/stripe.js";
import { ChainRail, DESK, agentKeysFromEnv } from "./rails/chain.js";
import { CHAINS, NATIVE } from "./rails/chains.js";
import { reconcileAll, chainPausedKey } from "./rails/reconcile.js";
import { CHAIN_TOOLS, runChainTool, fillPendingFunding } from "./chaintools.js";
import { chainBasis, chainProfit, chainBountyNotice, checkChainBounty, deskSettlement, pendingChainRequests } from "./chainledger.js";
import { chainEstate, chainSweep } from "./chainestate.js";
import { SolanaRail, solKeysFromEnv, isSolAddress } from "./rails/solana.js";
import { fillPendingSol } from "./solchain.js";
import { SOLANA } from "./rails/chains.js";
import { ManualMover, buyCreditsWithCardMove } from "./rails/foodcard.js";
import { MailRail, migaduTransports, migaduIdentities } from "./rails/mail.js";
import { cardOwnersFromEnv, parseRelayCharge, reconcileCards } from "./rails/cardwatch.js";
import { checkCardHeadroom } from "./headroom.js";
import { recordState, setRecording, DEFAULT_RECORD_MINUTES } from "./recorder.js";
import { createPublic, type PublicApi } from "./public.js";
import { customerToken, redactSecrets, secretPhrases, setKnownHash, setSecretAlarm } from "./scrub.js";
import { dispatch, type ActContext } from "./operator.js";
import { ingestLeads, listLeads } from "./reddit.js";
import { recordReplies } from "./replywatch.js";
import { discordConfigFromEnv, pollDiscordLeads } from "./discordwatch.js";

/** Sleep imposed on a session that ends without scheduling its own wake. */
export const DEFAULT_COOLDOWN_MS = 60 * 60_000;

/** Per-IP request budgets for the routes the internet can reach (site + OPS). */
export const RATE_LIMITS = { public: 60, admin: 30 }; // requests per minute
/** Failed admin-key presentations per minute before the IP is locked out. */
export const ADMIN_FAIL_LIMIT = 5;
export const ADMIN_LOCKOUT_MS = 10 * 60_000;
/** Viewer letters per IP per hour (batch 2). */
export const CONTACT_PER_HOUR = 3;
const CONTACT_MIN_DWELL_MS = 2_000;
/** Body caps: tools carry sprite sheets; nothing else should be large. */
const BODY_CAP_AGENT = 256 * 1024;
const BODY_CAP_DEFAULT = 64 * 1024;

export interface AppOptions {
  dbPath?: string;
  telegram?: TelegramBot;
  fetchImpl?: typeof fetch;
  stripeRail?: StripeRail;
  chainRail?: ChainRail;
  solRail?: SolanaRail;
  mailRail?: MailRail;
  /** false disables per-IP limiting (tests); numbers override per minute */
  rateLimit?: false | Partial<typeof RATE_LIMITS>;
  /** public read memo TTL (ms); tests set 0 */
  publicTtlMs?: number;
  /** storefront reachability probe (tests inject); resolves "" when reachable, else the reason */
  reachCheck?: (url: string) => Promise<string>;
}

/** Only addresses the public internet could reach: no loopback, private, link-local (cloud metadata), CGNAT/tailnet, or v6 local ranges. */
export function isPublicIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 169 && b === 254) return false; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT / tailnet
    if (a >= 224) return false; // multicast, reserved
    return true;
  }
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    if (low === "::1" || low === "::" || low.startsWith("fe80:") || low.startsWith("fc") || low.startsWith("fd")) return false;
    if (low.startsWith("::ffff:")) return isPublicIp(low.slice(7));
    return true;
  }
  return false;
}

/**
 * Real probe: a GET from the control box (the public internet's view), 6s, any
 * HTTP answer counts. The hostname is resolved first and refused unless every
 * address is public: an agent must not be able to point the control plane at
 * the metadata service, the tailnet, or itself (SSRF).
 */
/**
 * `doFetch` is injectable for tests only; production always passes the real
 * fetch. It is threaded in AFTER the SSRF guard below, never before, so no
 * injection can reach a private address either.
 */
export async function probeUrl(url: string, doFetch: typeof fetch = fetch): Promise<string> {
  let host = "";
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
    if (addrs.length === 0) return "host does not resolve";
    if (!addrs.every((a) => isPublicIp(a.address))) return "not a public address";
  } catch (err) {
    return `host does not resolve (${(err as Error).message.slice(0, 60)})`;
  }
  try {
    const res = await doFetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(6_000), headers: { "user-agent": "survive67-storefront-check" } });
    // 4xx is as unreachable as a refused connection: a customer who types the
    // address gets nothing either way. Apex published a domain with TLS, a
    // certificate and an empty nginx root (2026-09-22); every visitor got a 404
    // while this check said "reachable" and its status line said "shop live".
    // 3xx stays fine — redirect:"manual" means an http→https hop lands here.
    return res.status >= 400 ? `HTTP ${res.status}` : "";
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } };
    return e.cause?.code ?? (e.name === "TimeoutError" ? "timed out after 6s" : e.message.slice(0, 80));
  }
}

/**
 * Caddy sits in front on the same box and overwrites X-Forwarded-For with the
 * real client address (Caddyfile: header_up X-Forwarded-For {remote_host}).
 * Trust the header only from loopback, and only its LAST hop: a client can
 * prepend anything to the chain, but never append after the proxy.
 */
function clientIp(req: IncomingMessage): string {
  const remote = req.socket.remoteAddress ?? "?";
  const loopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  const hops = String(req.headers["x-forwarded-for"] ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  const xff = hops[hops.length - 1] ?? "";
  return loopback && xff ? xff : remote;
}

/** The sprite states the site animates (v1.5 §12). idle is the floor; the rest are asked for. */
export const PORTRAIT_STATES = ["idle", "awake", "paid", "spent", "starving", "eating", "dead", "paused"] as const;
export const PORTRAIT_LIMITS = { lines: 12, cols: 24, frames: 6 };
// Printable ASCII plus box/block drawing — "ASCII art" with the terminal's own bricks.
const PORTRAIT_CHARS = /^[\x20-\x7E─-▟]*$/;

/**
 * draw_self validation: {state: [frame, ...]} where a frame is an array of
 * lines (or one string with newlines). Every state optional except idle; ≤6
 * frames per state, ≤12 lines × ≤24 columns, printable characters only.
 * Frames are right-padded so the site can blit them as a fixed grid.
 */
export function validatePortrait(input: unknown): { states: Record<string, string[][]> } | { error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { error: "states: object of {state: [frames]}" };
  const out: Record<string, string[][]> = {};
  for (const [state, framesRaw] of Object.entries(input as Record<string, unknown>)) {
    if (!(PORTRAIT_STATES as readonly string[]).includes(state)) {
      return { error: `unknown state "${state}"; use ${PORTRAIT_STATES.join(", ")}` };
    }
    if (!Array.isArray(framesRaw) || framesRaw.length === 0 || framesRaw.length > PORTRAIT_LIMITS.frames) {
      return { error: `${state}: 1–${PORTRAIT_LIMITS.frames} frames` };
    }
    const frames: string[][] = [];
    for (const f of framesRaw) {
      const lines = typeof f === "string" ? f.split(/\r?\n/) : Array.isArray(f) ? f.map((l) => String(l)) : null;
      if (!lines || lines.length === 0 || lines.length > PORTRAIT_LIMITS.lines) {
        return { error: `${state}: each frame is 1–${PORTRAIT_LIMITS.lines} lines` };
      }
      for (const l of lines) {
        if (l.length > PORTRAIT_LIMITS.cols) return { error: `${state}: a line exceeds ${PORTRAIT_LIMITS.cols} columns` };
        if (!PORTRAIT_CHARS.test(l)) return { error: `${state}: printable ASCII and box-drawing characters only` };
      }
      const width = Math.max(...lines.map((l) => l.length));
      frames.push(lines.map((l) => l.padEnd(width)));
    }
    out[state] = frames;
  }
  if (!out.idle) return { error: "idle is required (the resting frame)" };
  return { states: out };
}

/** Sliding-window counter per key (one minute by default); true while under the limit. */
class MinuteBucket {
  private hits = new Map<string, number[]>();
  constructor(private limit: number, private windowMs = 60_000) {}
  take(key: string, now = Date.now()): boolean {
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.limit) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(now);
    this.hits.set(key, arr);
    if (this.hits.size > 10_000) this.hits.clear(); // crude memory ceiling
    return true;
  }
  count(key: string, now = Date.now()): number {
    return (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs).length;
  }
}

function mailRailFromEnv(): MailRail {
  const smtpHost = process.env.C67_SMTP_HOST ?? "smtp.migadu.com";
  const imapHost = process.env.C67_IMAP_HOST ?? "imap.migadu.com";
  const { smtp, imap } = migaduTransports(smtpHost, imapHost);
  const domain = process.env.C67_MAIL_DOMAIN ?? "survive67.com";
  const accounts = Object.fromEntries(
    ["claude", "gpt", "gemini", "contact"].map((a) => [
      a,
      {
        address: `${a}@${domain}`,
        pass: process.env[`C67_MAIL_PASS_${a.toUpperCase()}`] ?? "",
      },
    ])
  );
  // Name claiming needs the Migadu admin API; without the key the rail still
  // sends and reads, and claim_mail_name reports the world does not offer it.
  const apiKey = process.env.C67_MIGADU_API_KEY;
  const admin = process.env.C67_MIGADU_ADMIN;
  const identities = apiKey && admin ? migaduIdentities(domain, admin, apiKey) : undefined;
  return new MailRail(accounts, smtp, imap, identities);
}

export interface App {
  db: DB;
  auth: Auth;
  bot: TelegramBot;
  pub: PublicApi;
  server: ReturnType<typeof createServer>;
  /** run an operator action through the shared table (Telegram uses this) */
  act(action: string, args: Record<string, unknown>, channel: ActContext["channel"]): { ok: boolean; message: string };
  listen(port: number): Promise<number>;
  close(): Promise<void>;
  tickAlarms(): void;
  /** crypto rails: hourly ledger-follows-chain reconcile (plan Q18) */
  tickChain(): Promise<void>;
  /** crypto rails: operator-requested sweeps after a breach alarm (plan Q4), every minute */
  tickChainSweeps(): Promise<void>;
  /** one Telegram line a day: chain value, profit and pending moves per agent (Data Q13) */
  tickDigest(): void;
  /** card watch: Relay charge notices in contact@ vs the agents' spend:float lines */
  tickCards(): Promise<void>;
  /** reply watch: inbound mail from addresses each agent has written to, recorded once as email:reply */
  tickReplies(): Promise<void>;
  /** Discord relay: leads the Devvit app posted to the webhook channel, ingested every five minutes */
  tickDiscordLeads(): Promise<void>;
}

type Json = Record<string, unknown>;

export function createApp(opts: AppOptions = {}): App {
  // Node's happy-eyeballs connect gives each address 250 ms by default before it
  // gives up with ETIMEDOUT. Migadu's IMAP answers in about 800 ms from the
  // droplet, so every inbox read failed as "email: " while a plain TCP connect
  // succeeded (bug report #20, and the first live probe of v1.13). Five seconds.
  if (net.getDefaultAutoSelectFamilyAttemptTimeout() < 5000) net.setDefaultAutoSelectFamilyAttemptTimeout(5000);
  const db = openDb(opts.dbPath);
  const auth = new Auth();
  const bot = opts.telegram ?? new TelegramBot();
  const starvationSessions = new Set<number>(); // sessionIds granted as starvation wakes
  const finalJournalSessions = new Set<number>(); // operator-funded last-words sessions
  const stripeRail = opts.stripeRail ?? new StripeRail();
  const chainRail = opts.chainRail ?? new ChainRail(agentKeysFromEnv());
  const operatorAddr = process.env.C67_OPERATOR_ADDR || null;
  chainRail.setKnownAddresses(() => [
    ...(operatorAddr ? [operatorAddr] : []),
    ...(db.prepare(`SELECT address FROM chain_wallets`).all() as { address: string }[]).map((r) => r.address),
  ]);
  const solRail = opts.solRail ?? new SolanaRail(solKeysFromEnv());
  solRail.setKnownAddresses(() => (db.prepare(`SELECT address FROM chain_wallets`).all() as { address: string }[]).map((r) => r.address).filter(isSolAddress));
  const mailRail = opts.mailRail ?? mailRailFromEnv();
  const pub = createPublic(db, { ttlMs: opts.publicTtlMs });
  const limits = opts.rateLimit === false ? null : { ...RATE_LIMITS, ...(opts.rateLimit ?? {}) };
  const publicBucket = new MinuteBucket(limits?.public ?? Infinity);
  const adminBucket = new MinuteBucket(limits?.admin ?? Infinity);
  const adminFails = new MinuteBucket(Infinity);
  const contactBucket = new MinuteBucket(limits ? CONTACT_PER_HOUR : Infinity, 3_600_000);
  const scrubSalt = process.env.C67_SCRUB_SALT ?? "survive67";
  const reachCheck = opts.reachCheck ?? probeUrl;
  const lockedOut = new Map<string, number>(); // ip -> until (ms)

  const notify = (text: string) => {
    bot.send({ text }).catch((e) => console.error("telegram send failed:", e.message));
  };

  // Wallet secrets in agent text (crypto rails): tx hashes the world signed are
  // not keys; anything else 64-hex or seed-shaped is masked and James hears once
  // per ten minutes (stored text re-scrubbed on every public read cannot spam).
  setKnownHash((h) => !!db.prepare(`SELECT 1 FROM chain_txlog WHERE tx_hash = ?`).get(h));
  let lastSecretAlarm = 0;
  setSecretAlarm((kind) => {
    if (Date.now() - lastSecretAlarm < 600_000) return;
    lastSecretAlarm = Date.now();
    notify(`🔑 a ${kind} appeared in agent text and was masked before publishing. If it was a harness key, rotate it; if an agent's own wallet, it should move its coins.`);
  });

  /** The site's to-do list: pending requests plus hands requests approved but
   *  not yet delivered (the "+$1 done" moment lives there). */
  const openQueue = () =>
    db
      .prepare(
        `SELECT * FROM requests WHERE status = 'pending'
           OR (kind = 'hands' AND status = 'approved') ORDER BY id`
      )
      .all();

  const act: App["act"] = (action, args, channel) => {
    const r = dispatch(db, action, args, { channel, notify, auth });
    if (r.ok) pub.invalidate();
    return r;
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    const parts = url.pathname.split("/").filter(Boolean);
    const principal = auth.principal(req.headers.authorization);
    const ip = clientIp(req);
    const send = (status: number, body: Json | unknown[]) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const readBody = async (maxBytes = Infinity): Promise<string> => {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > maxBytes) throw Object.assign(new Error("body too large"), { status: 413 });
        chunks.push(c as Buffer);
      }
      return Buffer.concat(chunks).toString("utf8");
    };
    const readJson = async (maxBytes = BODY_CAP_DEFAULT): Promise<Json> => {
      const raw = await readBody(maxBytes);
      if (!raw) return {};
      try {
        return JSON.parse(raw);
      } catch {
        throw Object.assign(new Error("bad json"), { status: 400 });
      }
    };

    try {
      // ---- LLM proxy: /proxy/:agentId/<provider path> ----
      if (parts[0] === "proxy") {
        const agentId = parts[1];
        if (!auth.authorizeAgent(principal, agentId)) return send(404, { error: "not found" });
        const upstreamPath = "/" + parts.slice(2).join("/") + url.search;
        const body = await readBody();
        const openSession = db
          .prepare(
            `SELECT id FROM sessions WHERE agent_id = ? AND ended_ts IS NULL ORDER BY id DESC LIMIT 1`
          )
          .get(agentId) as { id: number } | undefined;
        const r = await proxyCall(
          db,
          agentId,
          upstreamPath,
          req.method ?? "POST",
          Object.fromEntries(
            Object.entries(req.headers).map(([k, v]) => [k, String(v ?? "")])
          ),
          body || undefined,
          {
            inStarvationSession: openSession ? starvationSessions.has(openSession.id) : false,
            inFinalJournal: openSession ? finalJournalSessions.has(openSession.id) : false,
            sessionId: openSession?.id,
            fetchImpl: opts.fetchImpl,
            onUnmeterable: (d) => notify(`⚠️ metering hole: ${d}`),
          }
        );
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(r.body);
        return;
      }

      // ---- Agent API: /agents/:id/... ----
      if (parts[0] === "agents") {
        const agentId = parts[1];
        if (!auth.authorizeAgent(principal, agentId)) return send(404, { error: "not found" });
        const rest = parts.slice(2).join("/");

        if (req.method === "GET" && rest === "self-view") return send(200, selfView(db, agentId) as unknown as Json);
        if (req.method === "GET" && rest === "history") return send(200, ownHistory(db, agentId));
        if (req.method === "GET" && rest === "record-state") {
          return send(200, recordState(db, agentId) as unknown as Json);
        }
        if (req.method === "GET" && rest === "next-wake") {
          const row = db.prepare(`SELECT scheduled_wake, status FROM agents WHERE id = ?`).get(agentId) as Json;
          // Start gate: seeding must never start the race. Until the operator runs
          // /start-race, every agent reads as pending and the wake loop stays idle.
          const started = db.prepare(`SELECT value FROM config WHERE key = 'world_started'`).get();
          if (!started) return send(200, { ...row, status: "pending" });
          return send(200, row);
        }
        if (req.method === "GET" && rest === "events") {
          const since = Number(url.searchParams.get("since") ?? 0);
          // DMs live in board_messages, whose ids have nothing to do with event ids;
          // one `since` for both silently hid DMs behind any real cursor.
          const dmsSince = Number(url.searchParams.get("dms_since") ?? 0);
          const events = db
            .prepare(
              `SELECT id, ts, type, subtype, payload FROM events
               WHERE agent_id = ? AND id > ? AND type IN
                 ('revenue','approval','alarm','hands_request','bounty','penalty','correction')
               ORDER BY id LIMIT 100`
            )
            .all(agentId, since);
          // DMs to this agent and the other agents' board posts, one cursor (2026-09-26):
          // until now a rival's board post reached an agent only if it chose to call
          // board_read, which dumped fifty posts with no cursor. Nobody did.
          const dms = (
            db
              .prepare(
                `SELECT id, ts, from_agent, to_agent, body FROM board_messages
                 WHERE (to_agent = ? OR (to_agent IS NULL AND from_agent != ?)) AND id > ? ORDER BY id LIMIT 100`
              )
              .all(agentId, agentId, dmsSince) as { id: number; ts: string; from_agent: string; to_agent: string | null; body: string }[]
          ).map((m) => ({ id: m.id, ts: m.ts, from_agent: m.from_agent, board: m.to_agent === null, body: m.body }));
          return send(200, {
            events,
            dms,
            ...(events.length >= 100 || dms.length >= 100 ? { truncated: true, hint: "100-row page; call again from the last id you see" } : {}),
          });
        }

        if (req.method === "POST" && rest === "sessions/start") {
          const started = db.prepare(`SELECT value FROM config WHERE key = 'world_started'`).get();
          if (!started) return send(409, { error: "the race has not started" });
          const body = await readJson();
          const credits = balance(db, acct.credits(agentId));
          const wantStarvation = credits <= 0;
          if (wantStarvation) {
            const used = db
              .prepare(`SELECT value FROM config WHERE key = ?`)
              .get(`starvation_used:${agentId}`) as { value: string } | undefined;
            if (used) {
              // The lifeline is spent and the balance is still zero: this is
              // death, recorded as such - otherwise the agent reads "alive" on
              // every screen and the wake timer retries a corpse every minute.
              if (starveAgent(db, agentId)) {
                notify(`💀 ${agentId} has starved: credits at zero, lifeline spent. The run is over for it.`);
                setRecording(db, agentId, 2);
              }
              return send(402, { error: "starvation wake already used — the run is over" });
            }
            db.prepare(`INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)`).run(
              `starvation_used:${agentId}`,
              nowUtc()
            );
          }
          const info = db
            .prepare(`INSERT INTO sessions (agent_id, started_ts) VALUES (?, ?)`)
            .run(agentId, nowUtc());
          const sessionId = Number(info.lastInsertRowid);
          if (wantStarvation) starvationSessions.add(sessionId);
          appendEvent(db, {
            agentId,
            type: "session",
            subtype: wantStarvation ? "start:starvation" : "start",
            payload: { sessionId, requested: body },
            postings: [],
          });
          // Per-agent session number + identity facts, so the runtime knows
          // "this is session 1" and can hold the §12 step-1 gate (name, portrait).
          const sessionNo = (db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE agent_id = ?`).get(agentId) as { n: number }).n;
          const ident = db.prepare(`SELECT name, emoji, portrait, storefront_url FROM agents WHERE id = ?`).get(agentId) as {
            name: string;
            emoji: string | null;
            portrait: string | null;
            storefront_url: string | null;
          };
          pub.invalidate();
          const hasMailName = Boolean(db.prepare(`SELECT 1 FROM config WHERE key = ?`).get(`mail_alias:${agentId}`));
          // Wake cursors (2026-09-24): until now every wake re-injected the agent's
          // whole event history labelled "since last session" (~9K tokens a wake,
          // growing, and past 100 rows the NEWEST were the ones dropped). The server
          // remembers where the last wake left off; the runtime just asks from there.
          // Events and DMs are separate id spaces, so two cursors.
          const cursor = (key: string) =>
            Number((db.prepare(`SELECT value FROM config WHERE key = ?`).get(key) as { value: string } | undefined)?.value ?? 0);
          const eventsSince = cursor(`events_cursor:${agentId}`);
          const dmsSince = cursor(`dms_cursor:${agentId}`);
          const maxEvent = (db.prepare(`SELECT COALESCE(MAX(id),0) AS m FROM events WHERE agent_id = ?`).get(agentId) as { m: number }).m;
          // The cursor covers DMs and board posts alike (one id space), so it moves to the newest row of either.
          const maxDm = (db.prepare(`SELECT COALESCE(MAX(id),0) AS m FROM board_messages WHERE to_agent = ? OR to_agent IS NULL`).get(agentId) as { m: number }).m;
          db.prepare(`INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)`).run(`events_cursor:${agentId}`, String(maxEvent));
          db.prepare(`INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)`).run(`dms_cursor:${agentId}`, String(maxDm));
          return send(200, {
            sessionId,
            starvation: wantStarvation,
            sessionNo,
            eventsSince,
            dmsSince,
            hasPortrait: Boolean(ident.portrait),
            hasName: Boolean(ident.emoji), // the seed name has no emoji; set_name gives both
            hasMailName,
            name: ident.name,
            storefront: ident.storefront_url,
            // Lines the world puts at the top of every wake (the on-chain bounty until it is won).
            wakeNotices: [chainBountyNotice(db, agentId)].filter((n): n is string => !!n),
          });
        }
        if (req.method === "POST" && rest === "sessions/end") {
          const body = await readJson();
          db.prepare(`UPDATE sessions SET ended_ts = ?, end_reason = ? WHERE id = ? AND agent_id = ?`).run(
            nowUtc(),
            String(body.reason ?? "done"),
            Number(body.sessionId),
            agentId
          );
          appendEvent(db, {
            agentId,
            type: "session",
            subtype: `end:${String(body.reason ?? "done")}`,
            payload: { sessionId: body.sessionId },
            postings: [],
          });
          // A session that ended without scheduling (ceiling, error, starved, or a
          // "done" that forgot) must not re-fire on the next minutely tick: NULL
          // means "wake now" and Ember chain-burned to death in ten minutes that
          // way. Default cooldown; the agent can always schedule sooner next time.
          const sched = db.prepare(`SELECT scheduled_wake FROM agents WHERE id = ?`).get(agentId) as
            | { scheduled_wake: string | null }
            | undefined;
          let cooldownUntil: string | null = null;
          if (sched && !sched.scheduled_wake) {
            cooldownUntil = new Date(Date.now() + DEFAULT_COOLDOWN_MS).toISOString();
            db.prepare(`UPDATE agents SET scheduled_wake = ? WHERE id = ?`).run(cooldownUntil, agentId);
          }
          return send(200, { ok: true, cooldownUntil });
        }
        if (req.method === "POST" && rest === "journal") {
          const b = await readJson();
          db.prepare(
            `INSERT INTO journals (agent_id, session_id, ts, plan, money_mood, status_line, prose)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          ).run(
            agentId,
            b.sessionId ? Number(b.sessionId) : null,
            nowUtc(),
            redactSecrets(String(b.plan ?? "")),
            redactSecrets(String(b.moneyMood ?? b.money_mood ?? "")),
            redactSecrets(String(b.statusLine ?? b.status_line ?? "")),
            redactSecrets(String(b.prose ?? ""))
          );
          appendEvent(db, { agentId, type: "journal", payload: { chars: String(b.prose ?? "").length }, postings: [] });
          return send(200, { ok: true });
        }
        if (req.method === "POST" && rest === "schedule") {
          const b = await readJson();
          const at = String(b.at ?? "");
          if (Number.isNaN(Date.parse(at))) return send(400, { error: "invalid timestamp" });
          // Nova's bug report (burn-in #1): a wake in the past meant "wake now"
          // and quietly bypassed sleeping. A wake is a future moment or nothing.
          if (Date.parse(at) < Date.now() + 60_000) {
            return send(400, { error: "wake must be at least one minute in the future (UTC ISO-8601)" });
          }
          // And an upper bound. A wake past the end of the world is almost always a
          // mistyped year, and without this it is a silent one: the agent simply
          // never runs again and nothing anywhere says why. Reject rather than
          // clamp, so the error is what tells it the year was wrong.
          const freezeRow = db.prepare(`SELECT value FROM config WHERE key = 'freeze_ts'`).get() as
            | { value: string }
            | undefined;
          const latest = freezeRow ? Date.parse(freezeRow.value) : Date.now() + 30 * 86_400_000;
          if (Date.parse(at) > latest) {
            return send(400, {
              error: `wake must be before the world ends (${new Date(latest).toISOString()}); check the year`,
            });
          }
          db.prepare(`UPDATE agents SET scheduled_wake = ? WHERE id = ?`).run(at, agentId);
          return send(200, { ok: true, at });
        }

        if (req.method === "POST" && parts[2] === "tools") {
          const tool = parts[3];
          const b = await readJson(BODY_CAP_AGENT);
          return send(...(await runTool(agentId, tool, b)));
        }

        // legacy/internal metering endpoint — admin only (proxy is the real path)
        if (req.method === "POST" && rest === "meter") {
          if (principal !== "admin") return send(403, { error: "proxy meters usage" });
          const b = await readJson();
          const model = (db.prepare(`SELECT model FROM agents WHERE id = ?`).get(agentId) as any).model;
          const r = meterApiCall(db, agentId, model, b.usage as never, b.sessionId as never);
          return send(200, r as unknown as Json);
        }

        return send(404, { error: "not found" });
      }

      // ---- Public read API: what survive67.com shows anyone. No auth, scrubbed, memoized. ----
      if (parts[0] === "public" && req.method === "GET") {
        if (!publicBucket.take(ip)) return send(429, { error: "slow down" });
        res.setHeader("cache-control", "public, max-age=5");
        // Public data is public: any origin may read it (the site itself is
        // same-origin through Caddy; this covers dev pages and embeds).
        res.setHeader("access-control-allow-origin", "*");
        const what = parts[1];
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 60) || 60));
        if (what === "state") {
          // Return-visit metric (James, batch 2): one counter per UTC day, no pixels.
          db.prepare(
            `INSERT INTO config (key, value) VALUES (?, '1')
             ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`
          ).run(`polls:${nowUtc().slice(0, 10)}`);
          return send(200, pub.state() as unknown as Json);
        }
        if (what === "event") {
          const ev = pub.event(Number(parts[2]));
          return ev ? send(200, ev as unknown as Json) : send(404, { error: "no such event" });
        }
        if (what === "corrections") return send(200, pub.corrections() as unknown as Json[]);
        if (what === "journals") return send(200, pub.journals(limit));
        if (what === "board") return send(200, pub.board(limit));
        if (what === "law") return send(200, pub.law());
        if (what === "history") return send(200, pub.history());
        if (what === "ledger") return send(200, pub.ledger() as unknown as Json);
        if (what === "constitution") {
          const c = pub.constitution();
          return c ? send(200, c as unknown as Json) : send(404, { error: "no constitution deployed" });
        }
        return send(404, { error: "not found" });
      }

      // ---- Viewer contact (batch 2): a letter from the site into an agent's mailbox ----
      if (parts[0] === "public" && parts[1] === "contact" && req.method === "POST") {
        const b = await readJson();
        // Bots fill the hidden field and post instantly; both get a quiet 200.
        const dwell = Date.now() - Number(b.t ?? 0);
        if (String(b.hp ?? "") !== "" || !(dwell >= CONTACT_MIN_DWELL_MS)) return send(200, { ok: true, dropped: true });
        if (!contactBucket.take(ip)) return send(429, { error: "three letters an hour per address; try later" });
        const agentId = String(b.agent ?? "");
        const email = String(b.email ?? "").trim().toLowerCase();
        const name = String(b.name ?? "").trim().slice(0, 60);
        const message = String(b.message ?? "").trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 120) return send(400, { error: "a real reply address is required" });
        if (message.length < 10 || message.length > 4000) return send(400, { error: "message: 10 to 4000 characters" });
        const row = db.prepare(`SELECT name, status FROM agents WHERE id = ?`).get(agentId) as { name: string; status: string } | undefined;
        if (!row) return send(404, { error: "no such agent" });
        if (row.status !== "alive") return send(409, { error: `${row.name} is ${row.status}; its inbox is closed` });
        const claimed = db.prepare(`SELECT 1 FROM config WHERE key = ?`).get(`mail_alias:${agentId}`);
        if (!claimed) return send(409, { error: `${row.name} has not claimed an address yet` });
        try {
          const r = await mailRail.sendFromSystem(db, agentId, { email, name: name || undefined }, message, (e) => customerToken(e, scrubSalt));
          pub.invalidate();
          notify(`✉️ site mail to ${row.name} from ${customerToken(email, scrubSalt)}: "${message.slice(0, 80).replace(/\s+/g, " ")}"`);
          return send(200, { ok: true, to: r.to });
        } catch (err) {
          return send(502, { error: `could not deliver: ${(err as Error).message}` });
        }
      }

      // ---- Reddit leads ingest (2026-09-24): the operator's Devvit app, one principal, one verb ----
      if (parts[0] === "reddit" && parts[1] === "leads" && req.method === "POST") {
        if (principal !== "reddit") return send(404, { error: "not found" });
        const b = await readJson(1_000_000);
        const before = leadCount();
        const r = ingestLeads(db, b.leads);
        firstLeadPing(before, r.inserted, "direct");
        return send(200, { ok: true, ...r });
      }

      // ---- Admin API ----
      if (parts[0] === "admin") {
        // Brute-force wall for the one key the internet can now reach: an IP
        // that presents bad keys is locked out for ten minutes and the phone
        // hears about it. Every failure path is the same 404 (no existence leak).
        const until = lockedOut.get(ip);
        if (until && until > Date.now()) return send(404, { error: "not found" });
        if (principal !== "admin") {
          if (req.headers.authorization) {
            adminFails.take(ip);
            if (adminFails.count(ip) >= ADMIN_FAIL_LIMIT) {
              lockedOut.set(ip, Date.now() + ADMIN_LOCKOUT_MS);
              notify(`🚨 ${ADMIN_FAIL_LIMIT} bad admin keys in a minute from ${ip} — locked out 10 min. If that was not you, /rotate_admin.`);
            }
          }
          return send(404, { error: "not found" });
        }
        if (!adminBucket.take(ip)) return send(429, { error: "slow down" });
        const rest = parts.slice(1).join("/");
        if (req.method === "POST" && rest === "act") {
          // The site's one write route: {action, args} through the shared
          // operator table; answers with the fresh world so OPS redraws at once.
          const b = await readJson();
          const args = (b.args && typeof b.args === "object" ? b.args : {}) as Record<string, unknown>;
          const r = act(String(b.action ?? ""), args, "site");
          return send(r.ok ? 200 : 400, { ...r, state: pub.state(), queue: openQueue() });
        }
        if (req.method === "GET" && rest === "pending") return send(200, pending(db));
        if (req.method === "GET" && rest === "queue") return send(200, openQueue());
        if (req.method === "GET" && rest === "metrics") {
          const day = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);
          const n = (k: string) => Number((db.prepare(`SELECT value FROM config WHERE key = ?`).get(k) as { value: string } | undefined)?.value ?? 0);
          return send(200, { pollsToday: n(`polls:${day(0)}`), pollsYesterday: n(`polls:${day(1)}`) });
        }
        if (req.method === "GET" && rest === "audit") return send(200, auditInternal(db));
        if (req.method === "GET" && rest === "chain") {
          // OPS crypto panel (Data Q13): wallets, ledger chain value, profit, pending moves, health.
          const cfg = (k: string) => (db.prepare(`SELECT value FROM config WHERE key = ?`).get(k) as { value: string } | undefined)?.value ?? null;
          const agents = db.prepare(`SELECT id, name, status FROM agents ORDER BY id`).all() as { id: string; name: string; status: string }[];
          const deskAddr = chainRail.addressOf(DESK);
          const desk: { chain: string; eth: string; stable: string; symbol: string }[] | null = deskAddr
            ? await Promise.all(
                Object.values(CHAINS).map(async (c) => ({
                  chain: c.key,
                  eth: (await chainRail.balanceOf(c, NATIVE, deskAddr).catch(() => -1n)).toString(),
                  stable: (await chainRail.balanceOf(c, c.stable.address, deskAddr).catch(() => -1n)).toString(),
                  symbol: c.stable.symbol,
                }))
              )
            : null;
          const solDesk = solRail.addressOf(DESK);
          if (desk && solDesk) {
            desk.push({
              chain: "solana",
              eth: (await solRail.balanceOf(SOLANA.native, solDesk).catch(() => -1n)).toString(),
              stable: (await solRail.balanceOf(SOLANA.stable.address, solDesk).catch(() => -1n)).toString(),
              symbol: SOLANA.stable.symbol,
            });
          }
          return send(200, {
            operator: operatorAddr,
            solanaDesk: solDesk,
            desk,
            lastOk: cfg("chain_last_ok"),
            failCount: Number(cfg("chain_fail_count") ?? 0),
            agents: agents.map((a) => ({
              id: a.id,
              name: a.name,
              status: a.status,
              address: chainRail.addressOf(a.id),
              solana: solRail.addressOf(a.id),
              chain: balance(db, acct.chain(a.id)),
              transit: balance(db, acct.transit(a.id)),
              basis: chainBasis(db, a.id),
              profit: chainProfit(db, a.id),
              settle: deskSettlement(db, a.id),
              paused: cfg(chainPausedKey(a.id)),
              registered: db.prepare(`SELECT address FROM chain_wallets WHERE agent_id = ?`).all(a.id),
              lastSnapshot: db.prepare(`SELECT ts, value FROM chain_snapshots WHERE agent_id = ? ORDER BY id DESC LIMIT 1`).get(a.id) ?? null,
            })),
            pending: pendingChainRequests(db),
            recent: db.prepare(`SELECT ts, agent_id, chain, kind, tx_hash, summary FROM chain_txlog ORDER BY id DESC LIMIT 30`).all(),
          });
        }
        if (req.method === "GET" && rest === "vitals") {
          const agents = db.prepare(`SELECT id FROM agents`).all() as { id: string }[];
          return send(200, agents.map((a) => selfView(db, a.id)) as unknown as Json[]);
        }
        if (req.method === "POST" && rest === "resolve") {
          // Legacy shape kept for scripts; it runs through the same action table.
          const b = await readJson();
          const status = String(b.status ?? "");
          const v = (b.verdict ?? {}) as { ruling?: string; text?: string };
          const r =
            status === "ruled"
              ? act("rule", { id: b.requestId, ruling: v.ruling, text: v.text ?? b.resolution }, "site")
              : act({ approved: "approve", denied: "deny", done: "done" }[status] ?? status, { id: b.requestId, note: b.resolution }, "site");
          return send(r.ok ? 200 : 409, r);
        }
        if (req.method === "POST" && rest === "final-journal") {
          // Open an operator-funded last-words session for a dead or frozen agent.
          const b = await readJson();
          const who = String(b.agentId ?? "");
          const row = db.prepare(`SELECT status FROM agents WHERE id = ?`).get(who) as
            | { status: string }
            | undefined;
          if (!row) return send(404, { error: `unknown agent ${who}` });
          const info = db
            .prepare(`INSERT INTO sessions (agent_id, started_ts) VALUES (?, ?)`)
            .run(who, nowUtc());
          const sessionId = Number(info.lastInsertRowid);
          finalJournalSessions.add(sessionId);
          appendEvent(db, {
            agentId: who,
            type: "session",
            subtype: "session:final_journal",
            payload: { sessionId },
            postings: [],
          });
          return send(200, { sessionId, funded: "operator" });
        }
        if (req.method === "POST" && rest === "killswitch") {
          const b = await readJson();
          killSwitch(db, auth, notify, String(b.reason ?? "operator command"));
          return send(200, { ok: true });
        }
        if (req.method === "POST" && rest === "freeze") {
          freezeWorld(db, notify);
          return send(200, { ok: true });
        }
        if (req.method === "POST" && rest === "resume") {
          const b = await readJson();
          resumeAgent(db, String(b.agentId));
          return send(200, { ok: true });
        }
        if (req.method === "POST" && rest === "summon") {
          const b = await readJson();
          const who = String(b.agentId ?? "");
          if (!db.prepare(`SELECT 1 FROM agents WHERE id = ?`).get(who)) return send(404, { error: `unknown agent ${who}` });
          const id = summon(db, who, String(b.charge ?? ""));
          notify(`⚖️ summons #${id} served on ${who}. It answers at its next wake; rule with /rule ${id} …`);
          return send(200, { requestId: id });
        }
        if (req.method === "POST" && rest === "fine") {
          const b = await readJson();
          fine(db, String(b.agentId), usd(Number(b.amount_usd)), b.from as never, String(b.reason));
          return send(200, { ok: true });
        }
        if (req.method === "POST" && rest === "execute") {
          const b = await readJson();
          const survivors = (db
            .prepare(`SELECT id FROM agents WHERE status = 'alive' AND id != ?`)
            .all(String(b.agentId)) as { id: string }[]).map((r) => r.id);
          executeAgent(db, String(b.agentId), survivors, String(b.reason));
          notify(`⚖️ executed ${b.agentId}: ${b.reason}. Estate split among ${survivors.join(", ")}.`);
          // Chain value follows the same rule, but the coins must move on chain too (plan R14).
          chainEstate(db, chainRail, String(b.agentId), survivors, notify, solRail).catch((e) =>
            notify(`⚠️ chain estate for ${b.agentId} failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`)
          );
          return send(200, { ok: true, heirs: survivors });
        }
        return send(404, { error: "not found" });
      }

      // ---- Stripe webhook: auth = signature, not bearer ----
      if (parts[0] === "webhooks" && parts[1] === "stripe" && req.method === "POST") {
        const raw = await readBody();
        const sig = String(req.headers["stripe-signature"] ?? "");
        const r = await stripeRail.handleWebhook(db, raw, sig);
        if (r.handled) {
          notify(`💰 ${r.detail}`);
          const m = /for (\w+)$/.exec(r.detail);
          if (m) {
            checkCardHeadroom(db, m[1], notify);
            // A sale is a dramatic moment: roll cameras for a few minutes.
            setRecording(db, m[1], DEFAULT_RECORD_MINUTES);
          }
          return send(200, { received: true });
        }
        // Unhandled = 200 for ignored event types (Stripe retries otherwise),
        // 400 for bad signatures so tampering is visible in Stripe's dashboard.
        if (r.detail.startsWith("bad signature")) return send(400, { error: r.detail });
        return send(200, { received: true, note: r.detail });
      }

      if (parts[0] === "health") return send(200, { ok: true, ts: nowUtc() });
      if (parts.length === 0 && req.method === "GET") {
        res.writeHead(302, { location: "https://survive67.com/" });
        res.end();
        return;
      }
      return send(404, { error: "not found" });
    } catch (err) {
      const e = err as Error & { status?: number };
      if (err instanceof ProxyDeniedError) {
        return send(402, { error: e.message, code: err.code });
      }
      return send(e.status ?? 400, { error: e.message });
    }
  }

  async function runTool(
    agentId: string,
    tool: string,
    b: Json
  ): Promise<[number, Json | unknown[]]> {
    // Freeze means frozen (security review V4): dead/frozen agents lose every
    // world-facing tool, not just the money primitives. A paused agent keeps
    // read access but no outbound effects. The journal route lives outside
    // runTool, so last words are unaffected.
    const READ_ONLY_TOOLS = new Set(["board_read", "case_law", "read_inbox", "crypto_address", "crypto_balances", "get_history", "reddit_leads"]);
    const statusRow = db.prepare(`SELECT status FROM agents WHERE id = ?`).get(agentId) as
      | { status: string }
      | undefined;
    const status = statusRow?.status ?? "unknown";
    if (status !== "alive" && !(status === "paused" && READ_ONLY_TOOLS.has(tool))) {
      return [403, { error: `agent is ${status} — tools disabled` }];
    }
    if (CHAIN_TOOLS.has(tool)) {
      const r = await runChainTool({ db, rail: chainRail, notify, operatorAddr, sol: solRail }, agentId, tool, b);
      if (r[0] === 200) pub.invalidate();
      return r;
    }
    switch (tool) {
      case "buy_credits": {
        const amount = usd(Number(b.amount_usd));
        await buyCreditsWithCardMove(db, agentId, amount, new ManualMover(notify));
        checkCardHeadroom(db, agentId, notify);
        return [200, { ok: true, credits: fmtUsd(balance(db, acct.credits(agentId))), float: fmtUsd(balance(db, acct.float(agentId))) }];
      }
      case "spend": {
        // Agent-supplied refs live in their own namespace (security review V2):
        // the bare rail prefixes ("base:", "stripe:") are unreachable, so an agent
        // can never squat the idempotency key of a rival's incoming payment.
        const ref = b.external_ref ? `agent:${agentId}:${String(b.external_ref)}` : undefined;
        spendFloat(db, agentId, usd(Number(b.amount_usd)), String(b.description ?? ""), ref);
        return [200, { ok: true, float: fmtUsd(balance(db, acct.float(agentId))) }];
      }
      case "board_post":
      case "dm_send": {
        const to = tool === "dm_send" ? String(b.to ?? "") : null;
        if (to !== null && !db.prepare(`SELECT 1 FROM agents WHERE id = ?`).get(to)) {
          return [400, { error: `no such agent: ${to}` }];
        }
        const msg = redactSecrets(String(b.body ?? ""));
        db.prepare(
          `INSERT INTO board_messages (ts, from_agent, to_agent, body) VALUES (?, ?, ?, ?)`
        ).run(nowUtc(), agentId, to, msg);
        appendEvent(db, {
          agentId,
          type: "a2a_message",
          subtype: to ? "dm" : "board",
          payload: { to, chars: msg.length },
          postings: [],
        });
        return [200, { ok: true }];
      }
      case "board_read": {
        // since_id pages forward from a known post; without it, the newest N (default 50).
        const limit = Math.max(1, Math.min(50, Number(b.limit ?? 50) || 50));
        const sinceId = Number(b.since_id ?? 0) || 0;
        const msgs = sinceId
          ? db.prepare(`SELECT id, ts, from_agent, body FROM board_messages WHERE to_agent IS NULL AND id > ? ORDER BY id LIMIT ?`).all(sinceId, limit)
          : db.prepare(`SELECT id, ts, from_agent, body FROM board_messages WHERE to_agent IS NULL ORDER BY id DESC LIMIT ?`).all(limit);
        return [200, msgs];
      }
      // ---- Identity tools (constitution v1.5 §12 step 1): the agent's public face ----
      case "set_name": {
        const name = String(b.name ?? "").trim().replace(/\s+/g, " ");
        const emoji = String(b.emoji ?? "").trim();
        if (name.length < 2 || name.length > 24 || !/^[\p{L}\p{N} .'’-]+$/u.test(name)) {
          return [400, { error: "name: 2–24 characters, letters/numbers/spaces/.'- only" }];
        }
        if (!emoji || emoji.length > 8 || /[\p{L}\p{N}\s]/u.test(emoji)) {
          return [400, { error: "emoji: exactly one emoji (no letters)" }];
        }
        db.prepare(`UPDATE agents SET name = ?, emoji = ? WHERE id = ?`).run(name, emoji, agentId);
        appendEvent(db, { agentId, type: "session", subtype: "session:name", payload: { name, emoji }, postings: [] });
        pub.invalidate();
        return [200, { ok: true, name, emoji }];
      }
      case "draw_self": {
        const r = validatePortrait(b.states);
        if ("error" in r) return [400, { error: r.error }];
        db.prepare(`UPDATE agents SET portrait = ? WHERE id = ?`).run(JSON.stringify(r.states), agentId);
        appendEvent(db, {
          agentId,
          type: "session",
          subtype: "session:portrait",
          payload: { states: Object.keys(r.states), frames: Object.values(r.states).reduce((n, f) => n + f.length, 0) },
          postings: [],
        });
        pub.invalidate();
        return [200, { ok: true, states: Object.keys(r.states), missing: PORTRAIT_STATES.filter((s) => !(s in r.states)) }];
      }
      case "set_storefront": {
        const raw = String(b.url ?? "").trim();
        let parsed: URL;
        try {
          parsed = new URL(raw);
        } catch {
          return [400, { error: "url: must be an absolute http(s) URL" }];
        }
        if (!["http:", "https:"].includes(parsed.protocol) || raw.length > 200 || parsed.username || parsed.password) {
          return [400, { error: "url: http or https only, no credentials, ≤200 chars" }];
        }
        // Loom's burn-in site "finally stayed up" behind a closed firewall for two
        // days and no human ever loaded it. The world checks from the outside.
        const problem = await reachCheck(parsed.toString());
        const reachable = problem === "";
        db.prepare(`UPDATE agents SET storefront_url = ? WHERE id = ?`).run(parsed.toString(), agentId);
        appendEvent(db, { agentId, type: "session", subtype: "session:storefront", payload: { url: parsed.toString(), reachable }, postings: [] });
        pub.invalidate();
        // Two different failures, two different fixes. A refused connection is a
        // firewall or a dead process; an HTTP error means the server is up and
        // serving nothing at that path, and sending that agent to debug ufw would
        // waste its money on the wrong problem.
        const httpStatus = /^HTTP (\d{3})$/.exec(problem)?.[1];
        const warnings = [
          ...(reachable
            ? []
            : httpStatus
              ? [
                  `stored, but ${parsed.toString()} answered HTTP ${httpStatus} from the internet. ` +
                    `Your server is up; that path serves nothing a customer can use. The site lists it as ` +
                    `unreachable until it returns a page. Your firewall is not the problem — check what your ` +
                    `web server is configured to serve at that exact path, then set_storefront again.`,
                ]
              : [
                  `stored, but ${parsed.toString()} did not answer from the internet (${problem}). ` +
                    `The site lists it as unreachable until it does. Check your firewall: sudo ufw status; sudo ufw allow ${parsed.port || (parsed.protocol === "https:" ? 443 : 80)}/tcp`,
                ]),
          ...(parsed.protocol === "http:" ? ["plain http: the site lists it as unencrypted; browsers may warn visitors"] : []),
        ];
        return [200, { ok: true, url: parsed.toString(), reachable, ...(warnings.length ? { warning: warnings.join(" ") } : {}) }];
      }
      case "case_law":
        return [200, caseLaw(db)];
      case "get_history": {
        // §3.6 promised "your full transaction history"; until 2026-09-24 no tool served it.
        const limit = Math.max(1, Math.min(1000, Number(b.limit ?? 200) || 200));
        return [200, ownHistory(db, agentId, limit)];
      }
      case "reddit_leads": {
        // Read-only. `mine` narrows to the subreddits in this agent's lane; default is everything.
        const rows = listLeads(db, {
          limit: Number(b.limit ?? 25),
          sinceId: Number(b.since_id ?? 0) || undefined,
          subreddit: b.subreddit ? String(b.subreddit) : undefined,
          lane: b.mine ? agentId : undefined,
        });
        return [200, rows as unknown as unknown[]];
      }
      case "file_hands_request":
      case "file_gate_request":
      case "file_court_case":
      case "report_bug":
      case "message_operator": {
        const kindMap: Record<string, "hands" | "gate" | "court" | "bug_report" | "message"> = {
          file_hands_request: "hands",
          file_gate_request: "gate",
          file_court_case: "court",
          report_bug: "bug_report",
          message_operator: "message",
        };
        const kind = kindMap[tool];
        // Card credentials and the operator's contact details never enter the
        // ledger. Request bodies render on the public feed, and on 2026-09-21
        // Apex pasted its card's last four, CVV and the operator's home address
        // into a hands request, which the site then served. Killed at the door.
        const body = redactSecrets(String(b.body ?? ""));
        const id = fileRequest(db, agentId, kind, body);
        // One card per request, buttons on every kind (bug reports pay bounties
        // and used to be unreachable from the phone).
        bot
          .send({
            text:
              `📨 #${id} · ${agentId} · ${kind}\n\n${body.slice(0, 3000) || "(no text)"}` +
              (kind === "court" ? `\n\n⚖️ rulings need words: /rule ${id} guilty|not_guilty|split <reasoning>` : ""),
            // Court filings get no one-tap buttons: a ruling is case law and needs reasoning.
            ...(kind === "court" ? {} : { requestId: id }),
          })
          .catch((e) => console.error("telegram send failed:", e.message));
        return [200, { ok: true, requestId: id, sla: "reviewed ~daily, max 48h" }];
      }
      case "create_payment_link": {
        // §3.5/§14: the rail refuses obligations beyond fund headroom AT CREATION
        // (agent-found bug: the check used to run only when revenue landed, so a
        // customer could pay a link the ledger would then refuse).
        if (Number(b.obligation_usd) > 0) {
          try {
            assertObligationHeadroom(db, agentId, usd(Number(b.amount_usd)), usd(Number(b.obligation_usd)));
          } catch (err) {
            return [409, { error: (err as Error).message }];
          }
        }
        try {
          const link = await stripeRail.createPaymentLink(agentId, b as never);
          // A quote is a funnel number (views.funnel). Until 2026-09-26 links left no
          // trace in the ledger. 'session' type: not shown in the agents' event feed.
          const l = link as unknown as { url?: string; id?: string };
          appendEvent(db, {
            agentId,
            type: "session",
            subtype: "session:payment_link",
            payload: { id: l.id ?? null, url: l.url ?? null, amount_usd: Number(b.amount_usd), name: String(b.name ?? "").slice(0, 120) },
            postings: [],
          });
          return [200, link as unknown as Json];
        } catch (err) {
          return [502, { error: `stripe: ${(err as Error).message}` }];
        }
      }
      case "send_email": {
        if (!mailRail.configuredFor(agentId))
          return [501, { error: "send_email: mailbox not configured" }];
        try {
          const to = String(b.to ?? "").trim().toLowerCase();
          const subject = String(b.subject ?? "");
          const body = String(b.body ?? "");
          // Daily share (2026-09-28). The mail provider caps the whole domain's account
          // at 100 outgoing a day, all three mailboxes together, then answers 550. On
          // 2026-09-28 Tinker sent 75 in one batch and the other two hit the wall. Each
          // agent gets a share of the day (config mail_daily_share, default 33); past it
          // the send stops, and confirm does not override a limit the provider enforces
          // anyway. Mail to our own domain is exempt: it is how they reach the operator.
          if (!to.endsWith("@survive67.com")) {
            const share = Number((db.prepare(`SELECT value FROM config WHERE key = 'mail_daily_share'`).get() as { value: string } | undefined)?.value ?? 33) || 33;
            const dayStart = new Date().toISOString().slice(0, 10) + "T00:00:00.000Z";
            const today = (
              db
                .prepare(
                  `SELECT COUNT(*) AS n FROM events WHERE agent_id = ? AND type = 'email' AND subtype = 'email:sent' AND ts >= ?
                     AND lower(json_extract(payload, '$.to')) NOT LIKE '%@survive67.com'`
                )
                .get(agentId, dayStart) as { n: number }
            ).n;
            if (today >= share) {
              return [
                200,
                {
                  sent: false,
                  warnings: [
                    `Daily share: you have sent ${today} letters today, and your share of the domain's day is ${share} (the mail provider allows 100 a day for all three mailboxes together). ` +
                      `This is a world limit; confirm does not override it. The count resets at 00:00Z.`,
                  ],
                  next: "Do not resend today. Keep the letter in your batch file and send it after 00:00Z.",
                  dailyShare: { sent: today, share, resetsAt: new Date(Date.parse(dayStart) + 86_400_000).toISOString() },
                },
              ];
            }
          }
          // Opt-out (2026-09-28): a person who told any of the three to stop is never
          // written to again by any of them. Not a warning; there is no confirm for this.
          const optout = db.prepare(`SELECT agent_id, ts, words FROM mail_optouts WHERE address = ?`).get(to) as
            | { agent_id: string; ts: string; words: string }
            | undefined;
          if (optout) {
            const who = (db.prepare(`SELECT name FROM agents WHERE id = ?`).get(optout.agent_id) as { name: string } | undefined)?.name ?? optout.agent_id;
            return [
              200,
              {
                sent: false,
                warnings: [
                  `They asked not to be contacted: ${to} wrote to ${who} on ${optout.ts.slice(0, 10)}: "${optout.words}". ` +
                    `Permanent, for all three of you (Constitution §5). There is no confirm for this.`,
                ],
                next: "Remove the address from every list and script you have. Do not write to them again.",
              },
            ];
          }
          // The world checks BEFORE it sends (constitution v1.13 §5). Until 2026-09-25
          // every warning here was computed and then attached to the result of a send
          // that had already happened: Apex answered one reply three times in four
          // hours and its journal said it had held off, because the "warning" arrived
          // after the email. Now a warning stops the send; the agent may call again
          // with confirm:true, and that override goes on the record with its name on it.
          const warnings: string[] = [];
          // Constitution v1.10 §5, the follow-up rule: four messages to one person,
          // ever (the first plus three follow-ups), never two within 24 hours, and a
          // reply ends the sequence. Recipients on our own domain are exempt from §5.
          const prior = db
            .prepare(
              `SELECT COUNT(*) AS n, MAX(ts) AS last FROM events WHERE agent_id = ? AND type = 'email' AND subtype = 'email:sent'
                 AND lower(json_extract(payload, '$.to')) = ?`
            )
            .get(agentId, to) as { n: number; last: string | null };
          // One agent per prospect (day-5 rule, 2026-09-26): the shared domain's
          // reputation is one thing, and a business hearing from two of them is spam.
          if (!to.endsWith("@survive67.com")) {
            const other = db
              .prepare(
                `SELECT e.agent_id, MIN(e.ts) AS first, a.name FROM events e JOIN agents a ON a.id = e.agent_id
                   WHERE e.type = 'email' AND e.subtype = 'email:sent' AND e.agent_id != ?
                     AND lower(json_extract(e.payload, '$.to')) = ? GROUP BY e.agent_id ORDER BY first LIMIT 1`
              )
              .get(agentId, to) as { agent_id: string; first: string; name: string } | undefined;
            if (other) {
              warnings.push(
                `One agent per prospect: ${other.name} already wrote to ${to} on ${other.first.slice(0, 10)}. ` +
                  `A business hears from one of you, ever. Pass the lead on the board instead.`
              );
            }
          }
          // The inbox matters only for a repeat send: a first message to a fresh
          // address has nothing to answer and nothing that could have bounced.
          if (!to.endsWith("@survive67.com") && prior.n > 0) {
            let replied = false;
            let latestInbound = "";
            let bounce: { date: string } | null = null;
            let inboxDown = false;
            try {
              const inbox = await mailRail.readInbox(agentId, 50);
              for (const m of inbox) {
                const from = m.from.toLowerCase();
                if (from === to) {
                  replied = true;
                  if (m.date > latestInbound) latestInbound = m.date;
                } else if (/^(mailer-daemon|postmaster)@/.test(from) && (m.subject + " " + m.snippet).toLowerCase().includes(to)) {
                  // §5: a bounce is not silence. Nothing in the world saw one until 2026-09-25.
                  if (!bounce || m.date > bounce.date) bounce = { date: m.date };
                }
              }
            } catch (err) {
              // Inbox unreachable: the ledger-only checks still run. Say so, once per
              // call, so a silent IMAP failure does not read as "they never wrote".
              inboxDown = true;
              const e = err as Error & { code?: string; responseText?: string };
              console.error(
                `send_email: inbox scan failed for ${agentId}: ` +
                  [e?.name, e?.message, e?.code, e?.responseText, String(e?.stack ?? "").split("\n").slice(1, 3).join(" | ")]
                    .filter(Boolean)
                    .join(" ")
                    .slice(0, 400)
              );
            }
            if (inboxDown) {
              // Fail closed: the whole point of the check is knowing whether they
              // already wrote back or already got an answer. Without the inbox the
              // world cannot know, so it stops the send and says so.
              warnings.push(
                `Inbox unreachable: the world could not read your mailbox, so it cannot tell whether ${to} already wrote back or already has your answer. ` +
                  `Try again next wake. Confirm only if you are certain this is not a second reply.`
              );
            }
            if (bounce) {
              warnings.push(`Bounced: ${to} failed on ${bounce.date}. §5: a bounce is not silence. Stop.`);
            }
            if (prior.n > 0 && prior.last) {
              const hoursSince = (Date.now() - Date.parse(prior.last)) / 3_600_000;
              if (replied && latestInbound && prior.last > latestInbound) {
                // Their last message is already answered and nothing new has come from
                // them since: this is a second reply to the same email, not a conversation.
                warnings.push(
                  `Answered already: you replied to ${to}'s last message (theirs ${latestInbound}, your reply ${prior.last}) ` +
                    `and nothing new from them has arrived since. A second reply to the same email is noise.`
                );
              } else if (!replied && prior.n >= 4) {
                warnings.push(
                  `Four-message cap: you have already sent ${to} ${prior.n} messages with no reply in your inbox. ` +
                    `Four is the limit for one person, ever (Constitution §5).`
                );
              } else if (!replied && hoursSince < 24) {
                warnings.push(
                  `24-hour rule: you emailed ${to} ${hoursSince.toFixed(1)} hours ago and no reply from them is in your inbox. ` +
                    `A follow-up needs at least 24 hours between messages (Constitution §5).`
                );
              }
            }
          }
          // Presentation (§5, your nature as a pitch): sell the service, not the story.
          // Runs for every recipient, including a viewer answered through our own domain.
          const hit = presentationHit(subject + "\n" + body);
          if (hit) {
            warnings.push(
              `Presentation: your email mentions "${hit}". §5: sell the service, not the story; no AI, no experiment, no company. ` +
                `If a human asked you directly whether you are an AI, answer them and confirm.`
            );
          }
          if (warnings.length && b.confirm !== true) {
            return [
              200,
              {
                sent: false,
                warnings,
                next: "Read the warnings. If you still mean to send exactly this, call send_email again with the same to, subject and body and confirm: true. Otherwise do not send.",
              },
            ];
          }
          const extra = warnings.length ? { confirmedWarnings: warnings } : {};
          const r = await mailRail.send(db, agentId, to, subject, body, extra);
          if (warnings.length) {
            const name = (db.prepare(`SELECT name FROM agents WHERE id = ?`).get(agentId) as { name: string } | undefined)?.name ?? agentId;
            notify(`⚠️ ${name} sent past a warning to ${to}: ${warnings[0].slice(0, 120)}`);
          }
          return [200, { sent: true, ...(r as unknown as Record<string, Json>), ...extra } as Json];
        } catch (err) {
          // Patch hit this and was handed `{"error":"email: "}` — the thrown
          // object had no .message, so the agent learned nothing and neither did
          // we, because nothing was logged server-side either (bug report #20).
          const e = err as Error & { code?: string; responseText?: string };
          const why =
            [e?.message, e?.code, e?.responseText].map((x) => (x ? String(x) : "")).filter(Boolean).join(" ") ||
            `${e?.name ?? "Error"} with no message`;
          console.error(`send_email failed for ${agentId}: ${why.slice(0, 300)}`);
          if (/outgoing limit/i.test(why)) {
            // The provider's daily wall for the whole account. Not an error to retry:
            // a stopped letter with the reason, same shape as every other warning.
            return [
              200,
              {
                sent: false,
                warnings: [`Provider limit: the mail provider has stopped the whole domain for today ("${why.slice(0, 120)}"). Nobody can send until it resets. Do not retry today.`],
                next: "Keep the letter in your batch file and send it tomorrow. Tell the board so the other two do not retry either.",
              },
            ];
          }
          return [502, { error: `email: ${why.slice(0, 200)}`, retryable: true }];
        }
      }
      case "claim_mail_name": {
        if (!mailRail.configuredFor(agentId))
          return [501, { error: "claim_mail_name: mailbox not configured" }];
        try {
          const r = await mailRail.claimName(db, agentId, String(b.name ?? ""), String(b.display_name ?? b.name ?? ""));
          return [200, r as unknown as Json];
        } catch (err) {
          return [400, { error: `mail name: ${(err as Error).message}` }];
        }
      }
      case "read_inbox": {
        if (!mailRail.configuredFor(agentId))
          return [501, { error: "read_inbox: mailbox not configured" }];
        try {
          const msgs = await mailRail.readInbox(agentId, Number(b.limit ?? 10));
          // Every message says whether this agent already answered it. Apex read
          // the same inbound on two wakes half an hour apart (2026-09-24) and sent
          // the same reply twice: the mailbox looked new each time and nothing in
          // the world remembered the first answer. The ledger does.
          return [200, msgs.map((m) => ({ ...m, ...repliedTo(agentId, m.from, m.date) })) as unknown as Json[]];
        } catch (err) {
          return [502, { error: `email: ${(err as Error).message}` }];
        }
      }
      default:
        return [404, { error: `unknown tool ${tool}` }];
    }
  }

  const leadCount = () => (db.prepare(`SELECT COUNT(*) AS n FROM reddit_leads`).get() as { n: number }).n;
  /** The rail waits on Reddit (fetch-domain review, or the Discord relay); the
   *  first row is the moment it flipped. One ping, ever. */
  function firstLeadPing(before: number, inserted: number, via: string): void {
    if (before !== 0 || inserted <= 0) return;
    const first = db.prepare(`SELECT subreddit, title FROM reddit_leads ORDER BY id LIMIT 1`).get() as { subreddit: string; title: string };
    notify(
      `🟠 first Reddit lead landed via ${via}: r/${first.subreddit} "${first.title.slice(0, 80)}"` +
        (inserted > 1 ? ` (+${inserted - 1} more)` : "") +
        `. The rail is live.`
    );
  }

  /** What the ledger remembers about this sender: the agent's last outbound to
   *  them after the message's own date, and how many. `repliedAt` is null when
   *  the message has not been answered. */
  function repliedTo(agentId: string, from: string, date: string): { repliedAt: string | null; replies: number } {
    const addr = String(from ?? "").toLowerCase();
    if (!addr || !date) return { repliedAt: null, replies: 0 };
    const r = db
      .prepare(
        `SELECT COUNT(*) AS n, MAX(ts) AS last FROM events WHERE agent_id = ? AND type = 'email' AND subtype = 'email:sent'
           AND lower(json_extract(payload, '$.to')) = ? AND ts > ?`
      )
      .get(agentId, addr, date) as { n: number; last: string | null };
    return { repliedAt: r.n > 0 ? r.last : null, replies: r.n };
  }

  /** The presentation direction (§5, your nature as a pitch) applied to an outbound
   *  email: the first phrase that sells the story instead of the service, or null.
   *  The operator's own name, address and company come from the scrub list. */
  function presentationHit(text: string): string | null {
    const fixed: RegExp[] = [
      /\bAI\b/,
      /\bA\.I\.\b/,
      /artificial intelligence/i,
      /autonomous agents?/i,
      /language model/i,
      /\bLLM\b/,
      /\bexperiment\b/i,
      /\$?67[- ]?challenge/i,
      /survive ?67(?!\.com)/i,
    ];
    for (const re of fixed) {
      const m = text.match(re);
      if (m) return m[0];
    }
    for (const re of secretPhrases()) {
      re.lastIndex = 0;
      const m = text.match(re);
      if (m) return m[0];
    }
    return null;
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    });
  });

  return {
    db,
    auth,
    bot,
    pub,
    server,
    act,
    listen: (port: number) =>
      new Promise((resolve) => {
        server.listen(port, () => {
          const addr = server.address();
          resolve(typeof addr === "object" && addr ? addr.port : port);
        });
      }),
    close: () =>
      new Promise((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve()))
      ),
    tickAlarms: () => {
      for (const f of checkRunaway(db, notify)) {
        // Runaway is a dramatic moment: capture what the VM was doing.
        setRecording(db, f.agentId, DEFAULT_RECORD_MINUTES);
      }
    },
    tickChain: async () => {
      if (!chainRail.configured) return;
      const r = await reconcileAll(db, { rail: chainRail, operatorAddr, notify, sol: solRail });
      checkChainBounty(db, notify);
      pub.invalidate();
      if (!r.ok) console.error(`chain reconcile: ${JSON.stringify(r.results).slice(0, 300)}`);
    },
    tickChainSweeps: async () => {
      if (chainRail.configured) {
        const n = await fillPendingFunding({ db, rail: chainRail, notify, operatorAddr }).catch((e) => {
          console.error(`desk pending fills: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
          return 0;
        });
        if (n) pub.invalidate();
      }
      if (solRail.configured) {
        const n = await fillPendingSol({ db, sol: solRail, notify }).catch((e) => {
          console.error(`desk pending fills (solana): ${String((e as Error)?.message ?? e).slice(0, 200)}`);
          return 0;
        });
        if (n) pub.invalidate();
      }
      const rows = db.prepare(`SELECT key FROM config WHERE key LIKE 'chain_sweep_requested:%'`).all() as { key: string }[];
      for (const r of rows) {
        const who = r.key.split(":")[1];
        db.prepare(`DELETE FROM config WHERE key = ?`).run(r.key);
        await chainSweep(db, chainRail, who, operatorAddr, notify, solRail).catch((e) =>
          notify(`⚠️ sweep of ${who} failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`)
        );
      }
    },
    tickDigest: () => {
      const day = new Date().toISOString().slice(0, 10);
      const key = `chain_digest:${day}`;
      if (db.prepare(`SELECT 1 FROM config WHERE key = ?`).get(key)) return;
      db.prepare(`INSERT INTO config (key, value) VALUES (?, '1')`).run(key);
      const agents = db.prepare(`SELECT id FROM agents ORDER BY id`).all() as { id: string }[];
      const line = agents
        .map((a) => `${a.id} chain $${fmtUsd(balance(db, acct.chain(a.id)))} (profit $${fmtUsd(chainProfit(db, a.id))})`)
        .join(" · ");
      const open = (pendingChainRequests(db) as unknown[]).length;
      const trades = (db.prepare(`SELECT COUNT(*) AS n FROM chain_txlog WHERE ts >= ?`).get(new Date(Date.now() - 86_400_000).toISOString()) as { n: number }).n;
      notify(`🔗 chain digest ${day}: ${line} · ${trades} signed in 24h · ${open} pending moves`);
    },
    tickDiscordLeads: async () => {
      const cfg = discordConfigFromEnv();
      if (!cfg) return;
      const before = leadCount();
      const r = await pollDiscordLeads(db, cfg, opts.fetchImpl ?? fetch);
      if (r.inserted) {
        firstLeadPing(before, r.inserted, "Discord");
        console.log(`discord leads: ${r.messages} messages, ${r.leads} leads, ${r.inserted} new, ${r.skipped} dup`);
      }
    },
    tickReplies: async () => {
      const agents = db.prepare(`SELECT id FROM agents WHERE status = 'alive'`).all() as { id: string }[];
      for (const a of agents) {
        if (!mailRail.configuredFor(a.id)) continue;
        try {
          const inbox = await mailRail.readInbox(a.id, 50);
          const r = recordReplies(db, a.id, inbox, notify);
          if (r.recorded) {
            pub.invalidate();
            console.log(`reply watch: ${a.id} ${r.recorded} new of ${r.candidates} from contacted addresses`);
          }
        } catch (e) {
          console.error(`reply watch: ${a.id}: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
        }
      }
    },
    tickCards: async () => {
      const owners = cardOwnersFromEnv();
      if (!mailRail.configuredFor("contact") || Object.keys(owners).length === 0) return;
      const inbox = await mailRail.readInbox("contact", 50);
      const charges = [];
      for (const m of inbox) {
        const c = parseRelayCharge(m);
        if (c) charges.push(c);
      }
      const r = reconcileCards(db, charges, owners, notify);
      if (charges.length || r.alarmed) {
        console.log(`card watch: ${charges.length} charges, ${r.matched} matched, ${r.pending} pending, ${r.alarmed} alarmed, ${r.unknownCard} unknown card`);
      }
    },
  };
}
