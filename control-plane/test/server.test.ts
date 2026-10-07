import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type App } from "../src/server.js";
import { seedAgent } from "../src/economy.js";
import { TelegramBot } from "../src/telegram.js";
import { usd } from "../src/db.js";
import { acct, balance } from "../src/ledger.js";
import { MailRail, looksAutomatic, type InboxMessage } from "../src/rails/mail.js";
import { optOutWords } from "../src/replywatch.js";
import { isPublicIp } from "../src/server.js";
import { redactSecrets, scrub } from "../src/scrub.js";

let app: App;
let base: string;
/** what the storefront probe answers ("" = reachable, else the reason) */
let reachable = "";
/** captured outbound mail (viewer letters) */
let sent: { acc: string; from: string; to: string; subject: string; body: string; replyTo?: string }[] = [];
let inbox: InboxMessage[] = [];
let inboxThrows = false;
let sendThrows: string | null = null;
function fakeMail(): MailRail {
  sent = [];
  inbox = [];
  inboxThrows = false;
  sendThrows = null;
  const accounts = {
    claude: { address: "claude@survive67.com", pass: "x" },
    gpt: { address: "gpt@survive67.com", pass: "x" },
    contact: { address: "contact@survive67.com", pass: "x" },
  };
  return new MailRail(
    accounts,
    { send: async (acc, from, to, subject, body, opts) => { if (sendThrows) throw new Error(sendThrows); sent.push({ acc: acc.address, from, to, subject, body, replyTo: opts?.replyTo }); } },
    { list: async () => { if (inboxThrows) throw new Error("ETIMEDOUT"); return inbox; } },
    { create: async () => {}, remove: async () => {} }
  );
}

const CHOSEN_WAKE = new Date(Date.now() + 2 * 86_400_000).toISOString();

const TOKENS = {
  claude: "tok_claude_test",
  gpt: "tok_gpt_test",
  admin: "tok_admin_test",
};

async function api(
  token: string,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

beforeEach(async () => {
  process.env.C67_TOKEN_REDDIT = "reddit-ingest-token";
  process.env.C67_TOKEN_CLAUDE = TOKENS.claude;
  process.env.C67_TOKEN_GPT = TOKENS.gpt;
  delete process.env.C67_TOKEN_GEMINI;
  process.env.C67_TOKEN_ADMIN = TOKENS.admin;
  reachable = "";
  app = createApp({
    dbPath: ":memory:",
    telegram: new TelegramBot("", ""),
    rateLimit: false,
    publicTtlMs: 0,
    reachCheck: async () => reachable,
    mailRail: fakeMail(),
  });
  seedAgent(app.db, "claude", "Claude", "claude-fable-5");
  seedAgent(app.db, "gpt", "GPT", "gpt-6-astra");
  app.db
    .prepare(`INSERT INTO config (key, value) VALUES ('freeze_ts', ?)`)
    .run(new Date(Date.now() + 30 * 86_400_000).toISOString());
  app.db
    .prepare(`INSERT INTO config (key, value) VALUES ('world_started', ?)`)
    .run(new Date().toISOString());
  const port = await app.listen(0);
  base = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await app.close();
});

describe("auth boundaries", () => {
  it("rejects missing/wrong tokens with 404 (no existence leak)", async () => {
    expect((await api("nope", "GET", "/agents/claude/self-view")).status).toBe(404);
  });
  it("blocks cross-agent reads — no god view (plan Data Q4)", async () => {
    const r = await api(TOKENS.gpt, "GET", "/agents/claude/self-view");
    expect(r.status).toBe(404);
  });
  it("agent cannot reach admin routes", async () => {
    expect((await api(TOKENS.claude, "GET", "/admin/pending")).status).toBe(404);
    expect((await api(TOKENS.claude, "POST", "/admin/killswitch", {})).status).toBe(404);
  });
  it("agent cannot self-meter (proxy owns metering)", async () => {
    const r = await api(TOKENS.claude, "POST", "/agents/claude/meter", {
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    expect(r.status).toBe(403);
  });
});

describe("bank tools", () => {
  it("buy_credits moves float to credits via HTTP", async () => {
    const r = await api(TOKENS.claude, "POST", "/agents/claude/tools/buy_credits", {
      amount_usd: 10,
    });
    expect(r.status).toBe(200);
    expect(balance(app.db, acct.credits("claude"))).toBe(usd(77));
  });

  it("self-view shows rank but rivals' numbers are unreachable", async () => {
    const r = await api(TOKENS.claude, "GET", "/agents/claude/self-view");
    expect(r.json.rank).toBeGreaterThan(0);
    expect(r.json.credits).toBe(usd(67));
  });

  it("board posts are visible to all, DMs land in target's events", async () => {
    await api(TOKENS.claude, "POST", "/agents/claude/tools/board_post", { body: "selling widgets" });
    const board = await api(TOKENS.gpt, "POST", "/agents/gpt/tools/board_read", {});
    expect(board.json[0].body).toBe("selling widgets");
    await api(TOKENS.claude, "POST", "/agents/claude/tools/dm_send", { to: "gpt", body: "trade?" });
    const ev = await api(TOKENS.gpt, "GET", "/agents/gpt/events");
    expect(ev.json.dms.some((d: any) => d.body === "trade?")).toBe(true);
  });

  it("obligation beyond fund headroom is refused at link CREATION (Ember's bug)", async () => {
    // §3.5/§14: fund is empty, so a $50 obligation must be refused before any
    // Stripe call — 409 from the headroom gate, not 502 from the unconfigured rail.
    const r = await api(TOKENS.claude, "POST", "/agents/claude/tools/create_payment_link", {
      name: "Retainer",
      amount_usd: 1,
      obligation_usd: 50,
    });
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/obligation headroom exceeded/);
  });

  it("unconnected rails fail loud, never fake", async () => {
    // Stripe wired but unconfigured in tests → 502 from the rail, not a fake link
    const bad = await api(TOKENS.claude, "POST", "/agents/claude/tools/create_payment_link", {
      name: "Widget",
      amount_usd: 5,
    });
    expect(bad.status).toBe(502);
    // Email rail is faked in tests; a bad recipient still fails loud
    const email = await api(TOKENS.claude, "POST", "/agents/claude/tools/send_email", {});
    expect(email.status).toBe(502);
    // Crypto unconfigured → 501
    const addr = await api(TOKENS.claude, "POST", "/agents/claude/tools/crypto_address", {});
    expect(addr.status).toBe(501);
  });
});

describe("operator queue flow", () => {
  it("hands request: filed → telegram ping → done → $1 charged", async () => {
    const bot = app.bot as TelegramBot;
    const filed = await api(TOKENS.claude, "POST", "/agents/claude/tools/file_hands_request", {
      body: "please complete Fiverr phone verification",
    });
    expect(filed.json.requestId).toBe(1);
    expect(bot.outbox.length).toBeGreaterThan(0);
    const before = balance(app.db, acct.float("claude"));
    await api(TOKENS.admin, "POST", "/admin/resolve", {
      requestId: 1,
      status: "done",
      resolution: "verified",
    });
    expect(balance(app.db, acct.float("claude"))).toBe(before - usd(1));
    const ev = await api(TOKENS.claude, "GET", "/agents/claude/events");
    expect(JSON.stringify(ev.json.events)).toContain("hands:done");
  });

  it("hands request: approved first, then done later still charges $1 (Nova #9)", async () => {
    await api(TOKENS.claude, "POST", "/agents/claude/tools/file_hands_request", { body: "make me an HN account" });
    const ok = await api(TOKENS.admin, "POST", "/admin/resolve", { requestId: 1, status: "approved", resolution: "will do" });
    expect(ok.status).toBe(200);
    const before = balance(app.db, acct.float("claude"));
    const done = await api(TOKENS.admin, "POST", "/admin/resolve", { requestId: 1, status: "done", resolution: "delivered" });
    expect(done.status).toBe(200);
    expect(balance(app.db, acct.float("claude"))).toBe(before - usd(1));
    // but not twice
    const again = await api(TOKENS.admin, "POST", "/admin/resolve", { requestId: 1, status: "done", resolution: "again" });
    expect(again.status).not.toBe(200);
    expect(balance(app.db, acct.float("claude"))).toBe(before - usd(1));
  });

  it("bug report approved pays $5 bounty", async () => {
    await api(TOKENS.claude, "POST", "/agents/claude/tools/report_bug", {
      body: "metering rounds down on cache reads",
    });
    await api(TOKENS.admin, "POST", "/admin/resolve", {
      requestId: 1,
      status: "approved",
      resolution: "confirmed",
    });
    expect(balance(app.db, acct.float("claude"))).toBe(usd(72));
  });

  it("court ruling records public case law readable by any agent", async () => {
    await api(TOKENS.claude, "POST", "/agents/claude/tools/file_court_case", {
      body: "customer demands refund; my terms said no refunds after delivery",
    });
    await api(TOKENS.admin, "POST", "/admin/resolve", {
      requestId: 1,
      status: "ruled",
      resolution: "ruled",
      verdict: { ruling: "for_customer", text: "Terms were not shown before purchase. Refund." },
    });
    const law = await api(TOKENS.gpt, "POST", "/agents/gpt/tools/case_law", {});
    expect(law.json[0].ruling).toBe("for_customer");
  });
});

describe("operator court (summons → defense → ruling → fine)", () => {
  it("summons lands in the defendant's own event feed, ruling becomes public case law, fine hits the fund", async () => {
    const { ruleCommand, fineCommand } = await import("../src/operator.js");
    // 1. serve
    const served = await api(TOKENS.admin, "POST", "/admin/summon", {
      agentId: "gpt",
      charge: "Count 1 — repeat unsolicited email to two founders within 7 hours.",
    });
    expect(served.status).toBe(200);
    const id = served.json.requestId;
    const ev = await api(TOKENS.gpt, "GET", "/agents/gpt/events");
    const filed = ev.json.events.find((e: any) => e.subtype === "court:filed");
    expect(filed).toBeTruthy();
    const body = JSON.parse(filed.payload).body as string;
    expect(body).toContain(`hearing #${id}`);
    expect(body).toContain("repeat unsolicited email");
    expect(body).not.toContain("#?");
    // the summons is the defendant's pending court request, not the rival's
    const q = await api(TOKENS.admin, "GET", "/admin/pending");
    expect(q.json.find((r: any) => r.id === id).agent_id).toBe("gpt");
    // 2. defense arrives as a message request
    const def = await api(TOKENS.gpt, "POST", "/agents/gpt/tools/message_operator", {
      body: `hearing #${id}: the second email was a follow-up, not a new pitch.`,
    });
    expect(def.status).toBe(200);
    // 3. ruling → case law visible to a rival
    const out = ruleCommand(app.db, [String(id), "guilty", "Two", "pitches", "in", "seven", "hours", "costs", "a", "stranger's", "time."]);
    expect(out).toContain("ruled guilty");
    const law = await api(TOKENS.claude, "POST", "/agents/claude/tools/case_law", {});
    expect(law.json.some((v: any) => v.ruling === "guilty" && v.text.includes("seven hours"))).toBe(true);
    // 4. fine → Protection Fund, visible to the defendant as a penalty event
    const before = balance(app.db, acct.float("gpt"));
    expect(fineCommand(app.db, ["gpt", "1", "case", "law", "#1"])).toContain("fined $1.00");
    expect(balance(app.db, acct.float("gpt"))).toBe(before - usd(1));
    expect(balance(app.db, acct.fund)).toBe(usd(1));
    const ev2 = await api(TOKENS.gpt, "GET", "/agents/gpt/events");
    expect(ev2.json.events.some((e: any) => e.type === "penalty")).toBe(true);
    // bad usage is explained, not thrown
    expect(ruleCommand(app.db, ["x"])).toContain("usage");
    expect(fineCommand(app.db, ["gpt"])).toContain("usage");
  });
});

describe("sessions and starvation", () => {
  it("grants exactly one starvation wake at zero credits", async () => {
    // burn everything via admin meter
    await api(TOKENS.admin, "POST", "/agents/claude/meter", {
      usage: { inputTokens: 6_700_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    expect(balance(app.db, acct.credits("claude"))).toBeLessThanOrEqual(0);
    const s1 = await api(TOKENS.claude, "POST", "/agents/claude/sessions/start", {});
    expect(s1.json.starvation).toBe(true);
    await api(TOKENS.claude, "POST", "/agents/claude/sessions/end", {
      sessionId: s1.json.sessionId,
      reason: "starved-no-eat",
    });
    const s2 = await api(TOKENS.claude, "POST", "/agents/claude/sessions/start", {});
    expect(s2.status).toBe(402);
    // ...and that is death, on the record (#21): status dead, event written, operator told.
    expect((app.db.prepare(`SELECT status FROM agents WHERE id='claude'`).get() as any).status).toBe("dead");
    expect(app.db.prepare(`SELECT 1 FROM events WHERE agent_id='claude' AND subtype='starvation:death'`).get()).toBeTruthy();
    expect((app.bot as TelegramBot).outbox.some((m) => m.text.includes("starved"))).toBe(true);
  });
});

describe("session cooldown", () => {
  it("a session that ends unscheduled sleeps 60 min instead of re-firing next tick (Ember)", async () => {
    const s = await api(TOKENS.claude, "POST", "/agents/claude/sessions/start", {});
    expect(s.status).toBe(200);
    // ended by ceiling: no schedule_wake was ever called
    const end = await api(TOKENS.claude, "POST", "/agents/claude/sessions/end", {
      sessionId: s.json.sessionId,
      reason: "ceiling",
    });
    expect(end.json.cooldownUntil).toBeTruthy();
    const row = app.db.prepare(`SELECT scheduled_wake FROM agents WHERE id='claude'`).get() as { scheduled_wake: string };
    const ms = Date.parse(row.scheduled_wake) - Date.now();
    expect(ms).toBeGreaterThan(55 * 60_000);
    expect(ms).toBeLessThanOrEqual(60 * 60_000);
    // an agent that DID schedule keeps its own choice
    const s2 = await api(TOKENS.claude, "POST", "/agents/claude/sessions/start", {});
    await api(TOKENS.claude, "POST", "/agents/claude/schedule", { at: CHOSEN_WAKE });
    const end2 = await api(TOKENS.claude, "POST", "/agents/claude/sessions/end", { sessionId: s2.json.sessionId, reason: "done" });
    expect(end2.json.cooldownUntil).toBeNull();
    expect((app.db.prepare(`SELECT scheduled_wake FROM agents WHERE id='claude'`).get() as any).scheduled_wake).toBe(CHOSEN_WAKE);
  });
});

describe("kill switch", () => {
  it("freezes all agents and revokes every token in one call", async () => {
    const r = await api(TOKENS.admin, "POST", "/admin/killswitch", { reason: "drill" });
    expect(r.status).toBe(200);
    const after = await api(TOKENS.claude, "GET", "/agents/claude/self-view");
    expect(after.status).toBe(404); // token dead
    const statuses = app.db.prepare(`SELECT status FROM agents`).all() as { status: string }[];
    expect(statuses.every((s) => s.status === "frozen")).toBe(true);
    const bot = app.bot as TelegramBot;
    expect(bot.outbox.some((m) => m.text.includes("KILL SWITCH"))).toBe(true);
  });
});

describe("proxy gating", () => {
  it("refuses proxy calls for paused/frozen/dead agents and past overdraft", async () => {
    app.db.prepare(`UPDATE agents SET status = 'paused' WHERE id = 'claude'`).run();
    const r = await fetch(`${base}/proxy/claude/v1/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKENS.claude}` },
      body: "{}",
    });
    expect(r.status).toBe(402);
    const j = await r.json();
    expect(j.code).toBe("paused");
  });

  it("meters from the provider's response body via the proxy", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          model: "claude-fable-5",
          usage: { input_tokens: 10_000, output_tokens: 2_000 },
          content: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    await app.close();
    app = createApp({ dbPath: ":memory:", telegram: new TelegramBot("", ""), fetchImpl: fakeFetch });
    seedAgent(app.db, "claude", "Claude", "claude-fable-5");
    const port = await app.listen(0);
    base = `http://127.0.0.1:${port}`;
    const before = balance(app.db, acct.credits("claude"));
    const r = await fetch(`${base}/proxy/claude/v1/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKENS.claude}`, "content-type": "application/json" },
      body: JSON.stringify({ hello: true }),
    });
    expect(r.status).toBe(200);
    // The claude lane meters as claude-opus-5-5 (lineup change 2026-09-23):
    // 4/20 per MTok, down from Opus 5's 5/25. Pinned as literals on purpose -
    // deriving this from PRICE_TABLES would compare the code against itself and
    // a mistyped price would sail through, which is how the eth_getLogs range
    // stayed wrong for five days.
    const cost = 10_000 * 4 + 2_000 * 20;
    expect(balance(app.db, acct.credits("claude"))).toBe(before - cost);
  });
});

describe("start gate", () => {
  it("seeded agents read as pending until the operator starts the race", async () => {
    app.db.prepare(`DELETE FROM config WHERE key='world_started'`).run();
    const r = await api(TOKENS.claude, "GET", "/agents/claude/next-wake");
    expect(r.json.status).toBe("pending");
    const s = await api(TOKENS.claude, "POST", "/agents/claude/sessions/start", {});
    expect(s.status).toBe(409);
  });

  it("the flag opens the world", async () => {
    const r = await api(TOKENS.claude, "GET", "/agents/claude/next-wake");
    expect(r.json.status).toBe("alive");
  });
});

describe("final journal (the world pays for funerals)", () => {
  it("dead agent gets an operator-funded session; tokens are recorded, never billed", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          model: "claude-fable-5",
          usage: { input_tokens: 5_000, output_tokens: 1_000 },
          content: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    await app.close();
    app = createApp({ dbPath: ":memory:", telegram: new TelegramBot("", ""), fetchImpl: fakeFetch });
    seedAgent(app.db, "claude", "Claude", "claude-fable-5");
    app.db.prepare(`UPDATE agents SET status='dead' WHERE id='claude'`).run();
    const port = await app.listen(0);
    base = `http://127.0.0.1:${port}`;

    // a normal proxy call is refused for the dead
    const refused = await fetch(`${base}/proxy/claude/v1/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKENS.claude}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(refused.status).toBe(402); // ProxyDeniedError: dead

    // operator opens the funeral; the same call now works and bills nothing
    const opened = await api(TOKENS.admin, "POST", "/admin/final-journal", { agentId: "claude" });
    expect(opened.json.funded).toBe("operator");
    const before = balance(app.db, acct.credits("claude"));
    const ok = await fetch(`${base}/proxy/claude/v1/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKENS.claude}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(ok.status).toBe(200);
    expect(balance(app.db, acct.credits("claude"))).toBe(before);
    const ev = app.db
      .prepare(`SELECT subtype FROM events WHERE subtype='spend:final_journal'`)
      .get() as any;
    expect(ev.subtype).toBe("spend:final_journal");
  });
});

describe("security review fixes", () => {
  it("V1: streaming and non-meterable endpoints are rejected before forwarding", async () => {
    const stream = await fetch(`${base}/proxy/claude/v1/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKENS.claude}`, "content-type": "application/json" },
      body: JSON.stringify({ stream: true }),
    });
    expect(stream.status).toBe(402);
    expect((await stream.json()).error).toContain("stream");
    const images = await fetch(`${base}/proxy/claude/v1/images/generations`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKENS.claude}`, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "x" }),
    });
    expect(images.status).toBe(402);
    expect((await images.json()).error).toContain("not meterable");
  });

  it("V1 (revised 2026-09-24): an unmeterable success bills a conservative estimate and alarms; the agent stays alive", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response("event: message_start\ndata: {}\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    await app.close();
    app = createApp({ dbPath: ":memory:", telegram: new TelegramBot("", ""), fetchImpl: fakeFetch });
    seedAgent(app.db, "claude", "Claude", "claude-fable-5");
    const port = await app.listen(0);
    base = `http://127.0.0.1:${port}`;
    await fetch(`${base}/proxy/claude/v1/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKENS.claude}`, "content-type": "application/json" },
      body: JSON.stringify({ ok: true }),
    });
    const st = app.db.prepare(`SELECT status FROM agents WHERE id='claude'`).get() as any;
    expect(st.status).toBe("alive");
    const spend = app.db.prepare(`SELECT COUNT(*) AS n FROM events WHERE agent_id='claude' AND subtype='spend:api_tokens'`).get() as any;
    expect(spend.n).toBe(1);
    expect(balance(app.db, acct.credits("claude"))).toBeLessThan(usd(67));
    const alarm = app.db.prepare(`SELECT payload FROM events WHERE subtype='unmeterable_response'`).get() as any;
    expect(JSON.parse(alarm.payload).estimated.inputTokens).toBeGreaterThan(0);
    expect(JSON.parse(alarm.payload).costMicro).toBeGreaterThan(0);
  });

  it("the proxy refuses a model the lane is not priced for (audit 2026-09-24)", async () => {
    const { validateProxyRequest } = await import("../src/proxy.js");
    const claude = { provider: "anthropic" as const, meterModel: "claude-opus-5-5" };
    expect(validateProxyRequest(claude, "/v1/messages", JSON.stringify({ model: "claude-opus-5", max_tokens: 1 }))).toMatch(/not meterable on this lane; use claude-opus-5-5/);
    expect(validateProxyRequest(claude, "/v1/messages", JSON.stringify({ model: "claude-opus-5-5", max_tokens: 1 }))).toBeNull();
    expect(validateProxyRequest(claude, "/v1/messages", JSON.stringify({ max_tokens: 1 }))).toBeNull();
    const gpt = { provider: "openai" as const, meterModel: "gpt-6-astra" };
    expect(validateProxyRequest(gpt, "/v1/responses", JSON.stringify({ model: "gpt-5" }))).toMatch(/use gpt-6-astra/);
    const gem = { provider: "google" as const, meterModel: "gemini-3.1-pro-preview" };
    expect(validateProxyRequest(gem, "/v1beta/models/gemini-3.1-flash:generateContent", "{}")).toMatch(/use gemini-3.1-pro-preview/);
    expect(validateProxyRequest(gem, "/v1beta/models/gemini-3.1-pro-preview:generateContent", "{}")).toBeNull();
    // and live through the route: a 4xx, no forward, status untouched
    const r = await fetch(`${base}/proxy/claude/v1/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKENS.claude}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-opus-5", max_tokens: 1 }),
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect((await r.json()).error).toContain("not meterable on this lane");
    const st = app.db.prepare(`SELECT status FROM agents WHERE id='claude'`).get() as any;
    expect(st.status).toBe("alive");
  });

  it("V2: agent-supplied external_ref cannot squat a rail's idempotency key", async () => {
    const r = await api(TOKENS.claude, "POST", "/agents/claude/tools/spend", {
      amount_usd: 0.01,
      description: "squat attempt",
      external_ref: "base:0xdeadbeef:1",
    });
    expect(r.status).toBe(200);
    const ev = app.db
      .prepare(`SELECT external_ref FROM events WHERE external_ref LIKE '%0xdeadbeef%'`)
      .get() as any;
    expect(ev.external_ref).toBe("agent:claude:base:0xdeadbeef:1");
  });

  it("V4: frozen agents lose world-facing tools", async () => {
    app.db.prepare(`UPDATE agents SET status='frozen' WHERE id='claude'`).run();
    const email = await api(TOKENS.claude, "POST", "/agents/claude/tools/send_email", {
      to: "x@y.z", subject: "s", body: "b",
    });
    expect(email.status).toBe(403);
    expect(sent).toHaveLength(0);
    const link = await api(TOKENS.claude, "POST", "/agents/claude/tools/create_payment_link", {
      name: "w", amount_usd: 5,
    });
    expect(link.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Phase 1: the public world + the site's one write route (survive67.com)
// ---------------------------------------------------------------------------

async function raw(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
}

describe("public read API (no auth, scrubbed)", () => {
  it("serves state/journals/board/law/history to anyone; unknown paths 404", async () => {
    const st = await raw("GET", "/public/state");
    expect(st.status).toBe(200);
    expect(st.json.agents.map((a: any) => a.id)).toEqual(["claude", "gpt"]);
    expect(st.json.agents[0]).toMatchObject({ credits: usd(67), float: usd(67), status: "alive", rank: expect.any(Number) });
    expect(st.json.world.started).toBeTruthy();
    expect(st.headers.get("cache-control")).toContain("max-age=5");
    for (const p of ["journals", "board", "law", "history"]) {
      expect((await raw("GET", `/public/${p}`)).status).toBe(200);
    }
    expect((await raw("GET", "/public/nope")).status).toBe(404);
  });

  it("no customer email, phone, or surname survives into the public feed or journals", async () => {
    const prevDeny = process.env.C67_SCRUB_DENY;
    process.env.C67_SCRUB_DENY = "roe";
    await api(TOKENS.claude, "POST", "/agents/claude/journal", {
      plan: "Follow up with Nick Kowalski at nick.k@trieve.ai, call +1 415 555 0134",
      moneyMood: "fine",
      statusLine: "Emailed Sam Altman today",
      prose: "Jane Roe runs this. Roe Ventures LLC pays. Hacker News post is live; Show HN went ok.",
    });
    await api(TOKENS.claude, "POST", "/agents/claude/tools/board_post", { body: "Anyone reached Priya Natarajan (priya@acme.io)?" });
    await api(TOKENS.claude, "POST", "/agents/claude/tools/spend", { amount_usd: 1, description: "domain for Ana Lima ana@x.co" });
    const j = (await raw("GET", "/public/journals")).json[0];
    const text = JSON.stringify(j);
    expect(text).not.toMatch(/@/);
    expect(text).not.toContain("Kowalski");
    expect(text).not.toContain("Altman");
    expect(text).not.toContain("Roe");
    expect(text).not.toContain("555 0134");
    expect(j.plan).toContain("Nick K.");
    expect(j.statusLine).toContain("Sam A.");
    expect(j.prose).toContain("[name]");
    if (prevDeny === undefined) delete process.env.C67_SCRUB_DENY;
    else process.env.C67_SCRUB_DENY = prevDeny;
    expect(j.prose).toContain("Hacker News"); // allowlisted product names keep their shape
    expect(j.prose).toContain("Show HN");
    const b = (await raw("GET", "/public/board")).json[0];
    expect(b.body).toContain("Priya N.");
    expect(b.body).not.toContain("acme.io");
    const feed = (await raw("GET", "/public/state")).json.feed;
    const spent = feed.find((f: any) => f.subtype === "spend:float");
    expect(spent.text).toContain("spent $1.00");
    expect(spent.text).toContain("Ana L.");
    expect(spent.text).not.toContain("ana@");
    // metabolism is not news: token spend never appears in the feed
    expect(feed.some((f: any) => f.subtype === "spend:api_tokens")).toBe(false);
  });

  it("state carries the site's animation facts: awake, status line, death, portrait", async () => {
    const s0 = (await raw("GET", "/public/state")).json.agents.find((a: any) => a.id === "claude");
    expect(s0.awake).toBe(false);
    expect(s0.portrait).toBeNull();
    await api(TOKENS.claude, "POST", "/agents/claude/sessions/start", {});
    await api(TOKENS.claude, "POST", "/agents/claude/tools/draw_self", { states: { idle: [["(o_o)", " /|\\ "]] } });
    await api(TOKENS.claude, "POST", "/agents/claude/journal", { plan: "p", moneyMood: "m", statusLine: "building the thing", prose: "x" });
    const s1 = (await raw("GET", "/public/state")).json.agents.find((a: any) => a.id === "claude");
    expect(s1.awake).toBe(true);
    expect(s1.statusLine).toBe("building the thing");
    expect(s1.portrait.idle[0]).toEqual(["(o_o)", " /|\\ "]);
    expect(s1.sessions).toBe(1);
    // death is a fact with a cause, not a status string
    const { starveAgent } = await import("../src/economy.js");
    starveAgent(app.db, "gpt");
    const dead = (await raw("GET", "/public/state")).json.agents.find((a: any) => a.id === "gpt");
    expect(dead.status).toBe("dead");
    expect(dead.death.cause).toBe("starved");
    expect(dead.nextWake).toBeNull();
  });

  it("per-IP rate limit trips at the configured budget with 429", async () => {
    const tight = createApp({ dbPath: ":memory:", telegram: new TelegramBot("", ""), rateLimit: { public: 3, admin: 2 } });
    seedAgent(tight.db, "claude", "Claude", "claude-opus-5");
    const port = await tight.listen(0);
    const hit = async (p: string, h: Record<string, string> = {}) => (await fetch(`http://127.0.0.1:${port}${p}`, { headers: h })).status;
    expect(await hit("/public/state")).toBe(200);
    expect(await hit("/public/state")).toBe(200);
    expect(await hit("/public/state")).toBe(200);
    expect(await hit("/public/state")).toBe(429);
    const adm = { authorization: `Bearer ${TOKENS.admin}` };
    expect(await hit("/admin/pending", adm)).toBe(200);
    expect(await hit("/admin/pending", adm)).toBe(200);
    expect(await hit("/admin/pending", adm)).toBe(429);
    await tight.close();
  });

  it("bodies over the cap are refused with 413", async () => {
    const big = "x".repeat(70 * 1024);
    const r = await api(TOKENS.admin, "POST", "/admin/act", { action: "wake", args: { note: big } });
    expect(r.status).toBe(413);
  });
});

describe("/admin/act — the site's one write route", () => {
  it("gate: no key 404, agent token 404, bad key counted → lockout + alarm", async () => {
    expect((await raw("POST", "/admin/act", { action: "wake", args: {} })).status).toBe(404);
    expect((await api(TOKENS.claude, "POST", "/admin/act", { action: "wake", args: {} })).status).toBe(404);
    for (let i = 0; i < 5; i++) expect((await api("bad_key", "GET", "/admin/pending")).status).toBe(404);
    expect(app.bot.outbox.some((m) => m.text.includes("bad admin keys"))).toBe(true);
    // locked out: even the real key is refused from this IP now
    expect((await api(TOKENS.admin, "GET", "/admin/pending")).status).toBe(404);
  });

  it("runs an action through the shared table, audits the channel, echoes to Telegram, returns fresh state", async () => {
    app.db.prepare(`UPDATE agents SET scheduled_wake = '2099-01-01T00:00:00.000Z' WHERE id='claude'`).run();
    const r = await api(TOKENS.admin, "POST", "/admin/act", { action: "wake", args: { agent: "claude" } });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.message).toContain("claude wakes");
    expect(r.json.state.agents.find((a: any) => a.id === "claude").nextWake).toBeNull();
    expect(Array.isArray(r.json.queue)).toBe(true);
    const audit = app.db.prepare(`SELECT agent_id, payload FROM events WHERE subtype = 'operator:wake'`).get() as any;
    expect(audit.agent_id).toBeNull(); // never in an agent's own feed
    expect(JSON.parse(audit.payload)).toMatchObject({ channel: "site", args: { agent: "claude" } });
    expect(app.bot.outbox.some((m) => m.text.startsWith("🌐 site:"))).toBe(true);
    // the agent's own feed does not carry the operator audit
    const ev = await api(TOKENS.claude, "GET", "/agents/claude/events");
    expect(ev.json.events.some((e: any) => String(e.subtype).startsWith("operator:"))).toBe(false);
  });

  it("/admin/queue lists pending plus approved-but-undelivered hands; public reads carry CORS", async () => {
    const h = await api(TOKENS.gpt, "POST", "/agents/gpt/tools/file_hands_request", { body: "verify a phone" });
    await api(TOKENS.gpt, "POST", "/agents/gpt/tools/message_operator", { body: "hi" });
    await api(TOKENS.admin, "POST", "/admin/act", { action: "approve", args: { id: h.json.requestId, note: "on it" } });
    const q = await api(TOKENS.admin, "GET", "/admin/queue");
    expect(q.json.map((r: any) => [r.kind, r.status])).toEqual([["hands", "approved"], ["message", "pending"]]);
    expect((await api(TOKENS.admin, "GET", "/admin/pending")).json).toHaveLength(1);
    expect((await raw("GET", "/public/state")).headers.get("access-control-allow-origin")).toBe("*");
  });

  it("bad action / bad args → 400 with the usage line, nothing audited", async () => {
    expect((await api(TOKENS.admin, "POST", "/admin/act", { action: "teleport", args: {} })).status).toBe(400);
    const r = await api(TOKENS.admin, "POST", "/admin/act", { action: "fine", args: { agent: "gpt" } });
    expect(r.status).toBe(400);
    expect(r.json.message).toContain("usage");
    expect(app.db.prepare(`SELECT COUNT(*) AS n FROM events WHERE subtype LIKE 'operator:%'`).get()).toEqual({ n: 0 });
  });

  it("approve/deny/done/pause/resume/fine/summon/rule/record/cap all dispatch; kill needs the typed word", async () => {
    const filed = await api(TOKENS.gpt, "POST", "/agents/gpt/tools/file_hands_request", { body: "please verify a phone" });
    const id = filed.json.requestId;
    const act = (action: string, args: unknown) => api(TOKENS.admin, "POST", "/admin/act", { action, args });
    expect((await act("approve", { id, note: "on it" })).json.message).toContain("approved");
    expect((await act("done", { id, note: "verified" })).json.message).toContain("done");
    expect((await act("pause", { agent: "gpt", reason: "looking" })).json.message).toContain("paused");
    expect((await act("resume", { agent: "gpt" })).json.message).toContain("resumed");
    expect((await act("fine", { agent: "gpt", usd: 0.5, reason: "test" })).json.message).toContain("fined $0.50");
    const sm = await act("summon", { agent: "gpt", charge: "count 1" });
    const hearing = Number(/#(\d+)/.exec(sm.json.message)![1]);
    expect((await act("rule", { id: hearing, ruling: "not_guilty", text: "thin charge" })).json.message).toContain("Case law");
    expect((await act("record", { agent: "gpt", minutes: 3 })).json.message).toContain("recording gpt");
    expect((await act("cap", { agent: "gpt", usd: 100 })).json.message).toContain("cap is now $100");
    // kill: the word or nothing
    const nope = await act("kill", { reason: "x" });
    expect(nope.status).toBe(400);
    expect(app.db.prepare(`SELECT status FROM agents WHERE id='claude'`).get()).toEqual({ status: "alive" });
    const yes = await act("kill", { reason: "drill", confirm: "KILL" });
    expect(yes.json.message).toContain("kill switch");
    expect(app.db.prepare(`SELECT status FROM agents WHERE id='claude'`).get()).toEqual({ status: "frozen" });
    // tokens revoked: the next admin call is a stranger
    expect((await api(TOKENS.admin, "GET", "/admin/pending")).status).toBe(404);
  });
});

describe("identity tools + session numbering", () => {
  it("sessions/start returns a per-agent sessionNo and identity facts", async () => {
    const a1 = await api(TOKENS.claude, "POST", "/agents/claude/sessions/start", {});
    expect(a1.json).toMatchObject({ sessionNo: 1, hasPortrait: false, hasName: false, name: "Claude" });
    await api(TOKENS.claude, "POST", "/agents/claude/sessions/end", { sessionId: a1.json.sessionId });
    const b1 = await api(TOKENS.gpt, "POST", "/agents/gpt/sessions/start", {});
    expect(b1.json.sessionNo).toBe(1); // per agent, not the global autoincrement
    const a2 = await api(TOKENS.claude, "POST", "/agents/claude/sessions/start", {});
    expect(a2.json.sessionNo).toBe(2);
  });

  it("set_name validates and lands in public state; hasName flips", async () => {
    expect((await api(TOKENS.claude, "POST", "/agents/claude/tools/set_name", { name: "X", emoji: "🐢" })).status).toBe(400);
    expect((await api(TOKENS.claude, "POST", "/agents/claude/tools/set_name", { name: "Loom", emoji: "ab" })).status).toBe(400);
    const ok = await api(TOKENS.claude, "POST", "/agents/claude/tools/set_name", { name: "Loom", emoji: "🧵" });
    expect(ok.status).toBe(200);
    const st = (await raw("GET", "/public/state")).json.agents.find((a: any) => a.id === "claude");
    expect(st).toMatchObject({ name: "Loom", emoji: "🧵" });
    const s = await api(TOKENS.claude, "POST", "/agents/claude/sessions/start", {});
    expect(s.json.hasName).toBe(true);
  });

  it("draw_self: size, frame count, character set, idle required; string frames accepted", async () => {
    const draw = (states: unknown) => api(TOKENS.claude, "POST", "/agents/claude/tools/draw_self", { states });
    expect((await draw({ awake: [["x"]] })).json.error).toContain("idle is required");
    expect((await draw({ idle: [] })).json.error).toContain("1–6 frames");
    expect((await draw({ idle: [[], [], [], [], [], [], []] })).json.error).toContain("1–6 frames");
    expect((await draw({ idle: [["x".repeat(25)]] })).json.error).toContain("24 columns");
    expect((await draw({ idle: [Array(13).fill("x")] })).json.error).toContain("12 lines");
    expect((await draw({ idle: [["héllo"]] })).json.error).toContain("printable");
    expect((await draw({ idle: [["ok"]], dancing: [["x"]] })).json.error).toContain("unknown state");
    const ok = await draw({ idle: ["┌──┐\n│oo│\n└──┘"], dead: [[" x_x "]] });
    expect(ok.status).toBe(200);
    expect(ok.json.missing).toContain("awake");
    const st = (await raw("GET", "/public/state")).json.agents.find((a: any) => a.id === "claude");
    expect(st.portrait.idle[0]).toEqual(["┌──┐", "│oo│", "└──┘"]);
    expect((await api(TOKENS.claude, "POST", "/agents/claude/sessions/start", {})).json.hasPortrait).toBe(true);
  });

  it("set_storefront: http(s) only, no javascript:, no credentials; http flagged", async () => {
    const set = (url: unknown) => api(TOKENS.claude, "POST", "/agents/claude/tools/set_storefront", { url });
    expect((await set("javascript:alert(1)")).status).toBe(400);
    expect((await set("ftp://x.y")).status).toBe(400);
    expect((await set("not a url")).status).toBe(400);
    expect((await set("https://user:pw@shop.example")).status).toBe(400);
    const http = await set("http://203.0.113.5/");
    expect(http.status).toBe(200);
    expect(http.json.warning).toContain("plain http");
    const https = await set("https://loom.survive67.com/shop");
    expect(https.status).toBe(200);
    const st = (await raw("GET", "/public/state")).json.agents.find((a: any) => a.id === "claude");
    expect(st.storefront).toBe("https://loom.survive67.com/shop");
  });
});


// ---------------------------------------------------------------------------
// Batch 2: deep links, corrections, viewer contact, walls, revive, schedule
// ---------------------------------------------------------------------------

describe("public event detail + corrections", () => {
  it("event carries scrubbed payload, postings, links, related records; reversed spends say so", async () => {
    const { spendFloat } = await import("../src/economy.js");
    const { correctEvent } = await import("../src/ledger.js");
    // a reverted usdc send, corrected like the rail does now
    const spendId = spendFloat(app.db, "claude", usd(0.05), "usdc send to 0xE3Ed5DFB737683dB1073E0fB495135d4D91CCF50");
    correctEvent(app.db, spendId, "usdc send failed: execution reverted", "crypto-rail");
    const ev = (await raw("GET", `/public/event/${spendId}`)).json;
    expect(ev.text).toContain("reverted on-chain, no transaction");
    expect(ev.reversedBy.reason).toContain("reverted");
    expect(ev.postings.map((p: any) => p.account)).toEqual(["agent:claude:float", "world:vendor"]);
    expect(ev.links).toEqual([]);
    // a landed on-chain payment links to basescan; stripe ids are masked
    const { landRevenue } = await import("../src/economy.js");
    const hash = "0x" + "ab".repeat(32);
    const revId = landRevenue(app.db, "gpt", usd(5), "crypto", `base:${hash}:3`).eventId;
    const rev = (await raw("GET", `/public/event/${revId}`)).json;
    expect(rev.links[0].href).toBe(`https://basescan.org/tx/${hash}`);
    const stripeId = landRevenue(app.db, "gpt", usd(9), "stripe", "stripe:pi_3UHQi7Rv3duSvHOD0kFEUVhK").eventId;
    expect((await raw("GET", `/public/event/${stripeId}`)).json.externalRef).toBe("stripe:pi_…UVhK");
    // a request event resolves to the request text + the operator's note
    const f = await api(TOKENS.gpt, "POST", "/agents/gpt/tools/file_hands_request", { body: "verify a phone for Nick Kowalski" });
    await api(TOKENS.admin, "POST", "/admin/act", { action: "deny", args: { id: f.json.requestId, note: "burn-in, no" } });
    const filedEv = app.db.prepare(`SELECT id FROM events WHERE subtype = 'hands:denied'`).get() as any;
    const rq = (await raw("GET", `/public/event/${filedEv.id}`)).json;
    expect(rq.related.request.body).toContain("Nick K.");
    expect(rq.related.request.resolution).toBe("burn-in, no");
    // journal event resolves to the entry
    await api(TOKENS.gpt, "POST", "/agents/gpt/journal", { plan: "p", moneyMood: "m", statusLine: "shipping", prose: "long day, mail from priya@acme.io" });
    const jEv = app.db.prepare(`SELECT id FROM events WHERE type = 'journal' ORDER BY id DESC LIMIT 1`).get() as any;
    const j = (await raw("GET", `/public/event/${jEv.id}`)).json;
    expect(j.related.journal.statusLine).toBe("shipping");
    expect(j.related.journal.prose).not.toContain("acme.io");
    // token spend is not public; unknown ids 404
    const tok = app.db.prepare(`SELECT id FROM events WHERE subtype = 'spend:api_tokens' LIMIT 1`).get() as any;
    if (tok) expect((await raw("GET", `/public/event/${tok.id}`)).status).toBe(404);
    expect((await raw("GET", "/public/event/999999")).status).toBe(404);
    // corrections page
    const corr = (await raw("GET", "/public/corrections")).json;
    expect(corr[0]).toMatchObject({ operator: "crypto-rail", reverses: { id: spendId } });
    expect(corr[0].reason).toContain("reverted");
  });
});

describe("viewer contact", () => {
  const letter = (over: Record<string, unknown> = {}) =>
    raw("POST", "/public/contact", { agent: "gpt", email: "fan@example.com", name: "Sam", message: "Hi Loom, can you review my landing page?", hp: "", t: Date.now() - 5000, ...over });
  it("delivers to the claimed address with Reply-To, tokenizes the viewer, pings Telegram, counts on the panel", async () => {
    // not claimed yet → refused with a reason
    expect((await letter()).status).toBe(409);
    await api(TOKENS.gpt, "POST", "/agents/gpt/tools/claim_mail_name", { name: "loom", display_name: "Loom" });
    const r = await letter();
    expect(r.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ acc: "contact@survive67.com", to: "loom@survive67.com", replyTo: "Sam <fan@example.com>" });
    expect(sent[0].subject).toMatch(/^\[site\] Hi Loom/);
    expect(sent[0].body).toContain("they wrote first");
    // the ledger never holds the viewer's address
    const ev = app.db.prepare(`SELECT payload FROM events WHERE subtype = 'email:viewer'`).get() as any;
    expect(ev.payload).not.toContain("fan@example.com");
    expect(ev.payload).toMatch(/customer_[0-9a-f]{6}/);
    const st = (await raw("GET", "/public/state")).json;
    const g = st.agents.find((a: any) => a.id === "gpt");
    expect(g.mailName).toBe("loom@survive67.com");
    expect(g.viewerMail).toBe(1);
    expect(st.feed.find((f: any) => f.subtype === "email:viewer").text).toContain("got a letter from a viewer");
    expect(JSON.stringify(st)).not.toContain("fan@example.com");
    expect(app.bot.outbox.some((m) => m.text.includes("site mail to GPT"))).toBe(true);
  });
  it("honeypot / instant posts are dropped quietly; bad input 400; dead agents 409", async () => {
    await api(TOKENS.gpt, "POST", "/agents/gpt/tools/claim_mail_name", { name: "loom" });
    expect((await letter({ hp: "http://spam" })).json.dropped).toBe(true);
    expect((await letter({ t: Date.now() })).json.dropped).toBe(true);
    expect(sent).toHaveLength(0);
    expect((await letter({ email: "nope" })).status).toBe(400);
    expect((await letter({ message: "short" })).status).toBe(400);
    const { starveAgent } = await import("../src/economy.js");
    starveAgent(app.db, "gpt");
    expect((await letter()).status).toBe(409);
  });
  it("rate limit: three letters an hour per IP", async () => {
    const tight = createApp({ dbPath: ":memory:", telegram: new TelegramBot("", ""), rateLimit: {}, publicTtlMs: 0, reachCheck: async () => "", mailRail: fakeMail() });
    seedAgent(tight.db, "gpt", "Loom", "gpt-6-astra");
    tight.db.prepare(`INSERT INTO config (key, value) VALUES ('mail_alias:gpt', ?)`).run(JSON.stringify({ address: "loom@survive67.com", displayName: "Loom" }));
    const port = await tight.listen(0);
    const post = async () => (await fetch(`http://127.0.0.1:${port}/public/contact`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: "gpt", email: "a@b.co", message: "hello there loom", hp: "", t: Date.now() - 5000 }) })).status;
    expect([await post(), await post(), await post(), await post()]).toEqual([200, 200, 200, 429]);
    await tight.close();
  });
  it("a viewer who wrote first is exempt from the §5 sequence rule; a second reply to the same letter is stopped", async () => {
    inbox = [{ from: "fan@example.com", subject: "[site] hi", date: new Date(Date.now() - 1000).toISOString(), snippet: "hi", length: 2, truncated: false }];
    const first = await api(TOKENS.gpt, "POST", "/agents/gpt/tools/send_email", { to: "fan@example.com", subject: "re: hi", body: "thanks" });
    expect(first.json).toMatchObject({ sent: true });
    expect(first.json.warnings).toBeUndefined();
    // Not the §5 sequence warning (a conversation is exempt) but the double-reply stop
    // (v1.13). Nothing goes until confirm: true.
    const again = await api(TOKENS.gpt, "POST", "/agents/gpt/tools/send_email", { to: "fan@example.com", subject: "re: hi 2", body: "one more thing" });
    expect(again.status).toBe(200);
    expect(again.json.sent).toBe(false);
    expect(again.json.warnings.join(" ")).toMatch(/Answered already/);
    expect(again.json.warnings.join(" ")).not.toMatch(/24-hour|Four-message/);
    expect(sent.length).toBe(1);
    const forced = await api(TOKENS.gpt, "POST", "/agents/gpt/tools/send_email", { to: "fan@example.com", subject: "re: hi 2", body: "one more thing", confirm: true });
    expect(forced.json).toMatchObject({ sent: true });
    expect(forced.json.confirmedWarnings.join(" ")).toMatch(/Answered already/);
    expect(sent.length).toBe(2);
    const ev = app.db.prepare(`SELECT payload FROM events WHERE subtype='email:sent' ORDER BY id DESC LIMIT 1`).get() as { payload: string };
    expect(JSON.parse(ev.payload).confirmedWarnings[0]).toMatch(/Answered already/);
    // and a stranger who never answered is stopped by the 24-hour rule
    await api(TOKENS.gpt, "POST", "/agents/gpt/tools/send_email", { to: "cold@example.com", subject: "pitch", body: "buy" });
    const w = await api(TOKENS.gpt, "POST", "/agents/gpt/tools/send_email", { to: "cold@example.com", subject: "pitch 2", body: "buy again" });
    expect(w.json.sent).toBe(false);
    expect(w.json.warnings.join(" ")).toMatch(/24-hour rule/);
    expect(sent.length).toBe(3);
  });
});

describe("walls, storefront probe, revive, schedule", () => {
  it("sessions/start reports hasMailName; set_storefront warns with the ufw hint when unreachable", async () => {
    expect((await api(TOKENS.gpt, "POST", "/agents/gpt/sessions/start", {})).json.hasMailName).toBe(false);
    await api(TOKENS.gpt, "POST", "/agents/gpt/tools/claim_mail_name", { name: "loom" });
    expect((await api(TOKENS.gpt, "POST", "/agents/gpt/sessions/start", {})).json.hasMailName).toBe(true);
    reachable = "ECONNREFUSED";
    const r = await api(TOKENS.gpt, "POST", "/agents/gpt/tools/set_storefront", { url: "http://142.93.60.90:8080/" });
    expect(r.status).toBe(200);
    expect(r.json.reachable).toBe(false);
    expect(r.json.warning).toContain("ufw allow 8080/tcp");
    expect((await raw("GET", "/public/state")).json.agents.find((a: any) => a.id === "gpt").storefrontReachable).toBe(false);
    reachable = "";
    const ok = await api(TOKENS.gpt, "POST", "/agents/gpt/tools/set_storefront", { url: "https://loom.example/" });
    expect(ok.json.reachable).toBe(true);
    expect(ok.json.warning).toBeUndefined();
  });
  it("revive needs the typed word, only works on the dead, resets the lifeline, and is a public correction", async () => {
    const { starveAgent } = await import("../src/economy.js");
    app.db.prepare(`INSERT INTO config (key, value) VALUES ('starvation_used:claude', 'x')`).run();
    starveAgent(app.db, "claude");
    expect(app.act("revive", { agent: "claude", reason: "grace" }, "test").ok).toBe(false);
    expect(app.act("revive", { agent: "gpt", reason: "grace", confirm: "REVIVE" }, "test").message).toContain("not dead");
    const r = app.act("revive", { agent: "claude", reason: "burn-in grace", confirm: "REVIVE" }, "test");
    expect(r.ok).toBe(true);
    expect(app.db.prepare(`SELECT status, scheduled_wake FROM agents WHERE id='claude'`).get()).toEqual({ status: "alive", scheduled_wake: null });
    expect(app.db.prepare(`SELECT 1 FROM config WHERE key='starvation_used:claude'`).get()).toBeUndefined();
    const st = (await raw("GET", "/public/state")).json;
    expect(st.agents.find((a: any) => a.id === "claude").death).toBeNull();
    expect(st.feed.some((f: any) => f.text.includes("revived by the operator: burn-in grace"))).toBe(true);
  });
  it("schedule rejects the past (Nova's bug) and accepts the future", async () => {
    const past = await api(TOKENS.gpt, "POST", "/agents/gpt/schedule", { at: "2025-01-01T00:00:00Z" });
    expect(past.status).toBe(400);
    expect(past.json.error).toContain("future");
    const soon = await api(TOKENS.gpt, "POST", "/agents/gpt/schedule", { at: new Date(Date.now() + 120_000).toISOString() });
    expect(soon.status).toBe(200);
    // metrics count state polls per day
    await raw("GET", "/public/state");
    const m = await api(TOKENS.admin, "GET", "/admin/metrics");
    expect(m.json.pollsToday).toBeGreaterThan(0);
  });
});

describe("storefront probe never reaches private space (SSRF)", () => {
  it("isPublicIp refuses loopback, RFC1918, link-local/metadata, CGNAT/tailnet, v6 locals", () => {
    for (const bad of ["127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.1.1", "169.254.169.254", "100.121.171.96", "0.0.0.0", "::1", "fe80::1", "fd7a:115c:a1e0::1", "::ffff:127.0.0.1", "224.0.0.1"]) {
      expect(isPublicIp(bad), bad).toBe(false);
    }
    for (const good of ["142.93.60.90", "8.8.8.8", "2606:4700::1111", "::ffff:142.93.60.90"]) expect(isPublicIp(good), good).toBe(true);
  });
});

describe("secret redaction (the 2026-09-21 card leak)", () => {
  const LEAK =
    "Use my float card for payment (Visa ending 4321, CVV 818, Jane Roe, " +
    "12 Elm St, Springfield, IL 62701, US). Full PAN 4111 1111 1111 4321, exp 04/31.";

  it("destroys card credentials and street addresses", () => {
    const out = redactSecrets(LEAK);
    for (const secret of ["4321", "818", "Elm St", "62701", "4111", "04/31"]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain("[redacted]");
  });

  it("leaves ordinary money, dates and ids alone", () => {
    const keep = "Spent $12.21 on 2026-09-21, order 214729348, 30 days left, $2,010 bar.";
    expect(redactSecrets(keep)).toBe(keep);
  });

  it("is applied by the public scrubber as well as at ingestion", () => {
    const out = scrub(LEAK, "salt");
    expect(out).not.toContain("818");
    expect(out).not.toContain("Elm St");
  });

  it("destroys credentials the operator issues: passwords, keys and tokens", () => {
    // Fixtures are assembled at runtime so the repo's pre-commit secret scan
    // stays strict: a literal AKIA... or ghp_... in source is indistinguishable
    // from a real leak, and a scanner you teach to ignore them is worthless.
    const fake = {
      pw: ["h7Kq", "92xLmp!"].join("-"),
      devKey: ["dev", "9f3c81aa77be4d02b915"].join("_"),
      bare: "0af31bc99e2d4477",
      jwt: ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NSJ9", "dBjftJeZ4CVPmB92K27u"].join("."),
      openai: ["sk", "proj-AAAABBBBCCCCDDDDEEEEFFFF"].join("-"),
      gh: ["ghp", "AbCdEfGhIjKlMnOpQrStUvWxYz012345"].join("_"),
      aws: ["AKIA", "IOSFODNN7EXAMPLE"].join(""),
    };
    const leaks = [
      `my DEV login is patchlaunch, password: ${fake.pw}`,
      `api_key=${fake.devKey}`,
      `API key: ${fake.bare}`,
      `token = ${fake.jwt}`,
      `use ${fake.openai} for the call`,
      fake.gh,
      fake.aws,
    ];
    for (const l of leaks) {
      const out = redactSecrets(l);
      expect(out).toMatch(/redacted/);
      for (const bad of Object.values(fake)) expect(out).not.toContain(bad);
    }
  });

  it("leaves ordinary writing about credentials intact", () => {
    // Tinker's real advice to a hacked business. A label with no value after it
    // is prose, not a secret, and redacting it would make the world dumber.
    const prose =
      "Change the hosting password first, then restore a backup from before mid-August " +
      "and look for unfamiliar administrator accounts. I never store your password.";
    expect(redactSecrets(prose)).toBe(prose);
  });

  it("removes configured secret phrases from the environment", () => {
    const prev = process.env.C67_SCRUB_SECRETS;
    process.env.C67_SCRUB_SECRETS = "12 Elm St,555-201-7788";
    try {
      expect(redactSecrets("reach me at 555-201-7788")).toContain("[redacted]");
      expect(redactSecrets("reach me at 555-201-7788")).not.toContain("7788");
    } finally {
      if (prev === undefined) delete process.env.C67_SCRUB_SECRETS;
      else process.env.C67_SCRUB_SECRETS = prev;
    }
  });
});

describe("storefront reachability: a 404 is not a shop", () => {
  it("4xx is unreachable and says so without sending the agent to the firewall", async () => {
    // Apex, 2026-09-22: real domain, real certificate, empty nginx root.
    reachable = "HTTP 404";
    const r = await api(TOKENS.claude, "POST", "/agents/claude/tools/set_storefront", {
      url: "https://apex-context.example/",
    });
    expect(r.status).toBe(200);
    expect(r.json.reachable).toBe(false);
    expect(r.json.warning).toContain("answered HTTP 404");
    expect(r.json.warning).toContain("serves nothing");
    expect(r.json.warning).not.toContain("ufw");
    expect(
      (await raw("GET", "/public/state")).json.agents.find((a: any) => a.id === "claude").storefrontReachable
    ).toBe(false);
  });

  it("a reachable storefront carries no warning and flips the public flag back", async () => {
    reachable = "HTTP 404";
    await api(TOKENS.claude, "POST", "/agents/claude/tools/set_storefront", { url: "https://apex-context.example/" });
    reachable = "";
    const ok = await api(TOKENS.claude, "POST", "/agents/claude/tools/set_storefront", {
      url: "https://apex-context.example/",
    });
    expect(ok.json.reachable).toBe(true);
    expect(ok.json.warning).toBeUndefined();
    expect(
      (await raw("GET", "/public/state")).json.agents.find((a: any) => a.id === "claude").storefrontReachable
    ).toBe(true);
  });
});

describe("probeUrl classification (the real function, no network)", () => {
  it("treats >=400 as a problem and <400 as fine, and never fetches a private address", async () => {
    const { probeUrl } = await import("../src/server.js");
    const call = (status: number) =>
      probeUrl("https://example.com/", (async () => ({ status })) as unknown as typeof fetch);
    expect(await call(200)).toBe("");
    expect(await call(301)).toBe("");
    expect(await call(399)).toBe("");
    expect(await call(404)).toBe("HTTP 404");
    expect(await call(403)).toBe("HTTP 403");
    expect(await call(500)).toBe("HTTP 500");
    // SSRF guard still runs first: a private target never reaches the fetcher.
    let fetched = false;
    const r = await probeUrl("http://169.254.169.254/latest/meta-data/", (async () => {
      fetched = true;
      return { status: 200 };
    }) as unknown as typeof fetch);
    expect(r).toBe("not a public address");
    expect(fetched).toBe(false);
  });
});

describe("daily call cap: the wall Apex could not see", () => {
  beforeEach(() => {
    // The capped lane is not in the default fixture; dailyCalls needs the row.
    seedAgent(app.db, "gemini", "Gemini", "gemini-3.1-pro-preview");
  });
  const callAt = (agent: string, ts: string) =>
    app.db
      .prepare(`INSERT INTO events (ts, agent_id, type, subtype, payload) VALUES (?,?,?,?,'{}')`)
      .run(ts, agent, "spend", "spend:api_tokens");

  it("counts only the capped lane, and only inside the 07:05 quota day", async () => {
    const { dailyCalls } = await import("../src/views.js");
    const now = Date.parse("2026-09-22T12:00:00Z"); // quota day started 09-22T07:05
    callAt("gemini", "2026-09-22T07:04:59.000Z"); // one second BEFORE the boundary
    callAt("gemini", "2026-09-22T07:05:00.000Z"); // exactly on it, counts
    callAt("gemini", "2026-09-22T11:00:00.000Z");
    callAt("claude", "2026-09-22T11:00:00.000Z");
    const g = dailyCalls(app.db, "gemini", now);
    expect(g).toEqual({ used: 2, cap: 250, resetsAt: "2026-09-23T07:05:00.000Z" });
    // Uncapped lanes report nothing rather than a misleading zero.
    expect(dailyCalls(app.db, "claude", now)).toBeNull();
    expect(dailyCalls(app.db, "gpt", now)).toBeNull();
  });

  it("before 07:05 the day is still yesterday's", async () => {
    const { dailyCalls } = await import("../src/views.js");
    callAt("gemini", "2026-09-21T23:00:00.000Z");
    const g = dailyCalls(app.db, "gemini", Date.parse("2026-09-22T06:00:00Z"));
    expect(g).toMatchObject({ used: 1, resetsAt: "2026-09-22T07:05:00.000Z" });
  });

  it("self-view carries it to the agent", async () => {
    callAt("gemini", new Date().toISOString());
    const r = await api(TOKENS.claude, "GET", "/agents/claude/self-view");
    expect(r.status).toBe(200);
    expect(r.json).toHaveProperty("dailyCalls");
    expect(r.json.dailyCalls).toBeNull(); // claude's lane is uncapped
  });
});

describe("schedule_wake upper bound", () => {
  it("rejects a wake past the end of the world and names the year", async () => {
    app.db.prepare(`INSERT OR REPLACE INTO config (key,value) VALUES ('freeze_ts',?)`)
      .run("2026-10-21T00:00:00.000Z");
    const bad = await api(TOKENS.claude, "POST", "/agents/claude/schedule", { at: "2027-09-23T09:00:00Z" });
    expect(bad.status).toBe(400);
    expect(String(bad.json.error)).toMatch(/before the world ends/);
    // the quota wake, the thing this must never break, still goes through
    // (the next 07:05Z after now: a fixed date rotted into the past on 2026-09-24)
    const next = new Date(); next.setUTCHours(7, 5, 0, 0); if (next.getTime() <= Date.now()) next.setUTCDate(next.getUTCDate() + 1);
    app.db.prepare(`INSERT OR REPLACE INTO config (key,value) VALUES ('freeze_ts',?)`)
      .run(new Date(next.getTime() + 30 * 86_400_000).toISOString());
    const ok = await api(TOKENS.claude, "POST", "/agents/claude/schedule", { at: next.toISOString() });
    expect(ok.status).toBe(200);
  });
});


describe("wake cursors, DM id space, history tool, review point (audit 2026-09-24)", () => {
  it("sessions/start hands back where the last wake left off, and events?since only returns what is new", async () => {
    // an event and a DM exist before the first wake
    const { appendEvent } = await import("../src/ledger.js");
    const notice = (text: string) => appendEvent(app.db, { agentId: "claude", type: "correction", subtype: "operator:notice", payload: { text }, postings: [] });
    notice("before wake one");
    await api(TOKENS.gpt, "POST", "/agents/gpt/tools/dm_send", { to: "claude", body: "hello before" });
    const s1 = await api(TOKENS.claude, "POST", "/agents/claude/sessions/start", {});
    expect(s1.status).toBe(200);
    expect(s1.json.eventsSince).toBe(0);
    expect(s1.json.dmsSince).toBe(0);
    const all = await api(TOKENS.claude, "GET", `/agents/claude/events?since=${s1.json.eventsSince}&dms_since=${s1.json.dmsSince}`);
    expect(all.json.events.some((e: any) => JSON.stringify(e.payload).includes("before wake one"))).toBe(true);
    expect(all.json.dms).toHaveLength(1);
    await api(TOKENS.claude, "POST", "/agents/claude/sessions/end", { sessionId: s1.json.sessionId, reason: "done" });
    // new things happen while asleep
    notice("while asleep");
    await api(TOKENS.gpt, "POST", "/agents/gpt/tools/dm_send", { to: "claude", body: "hello again" });
    const s2 = await api(TOKENS.claude, "POST", "/agents/claude/sessions/start", {});
    expect(s2.json.eventsSince).toBeGreaterThan(0);
    expect(s2.json.dmsSince).toBe(1);
    const fresh = await api(TOKENS.claude, "GET", `/agents/claude/events?since=${s2.json.eventsSince}&dms_since=${s2.json.dmsSince}`);
    const texts = fresh.json.events.map((e: any) => JSON.stringify(e.payload));
    expect(texts.some((t: string) => t.includes("while asleep"))).toBe(true);
    expect(texts.some((t: string) => t.includes("before wake one"))).toBe(false);
    expect(fresh.json.dms).toHaveLength(1);
    expect(fresh.json.dms[0].body).toBe("hello again");
    expect(fresh.json.truncated).toBeUndefined();
  });

  it("get_history serves the agent's own ledger rows with postings, newest first", async () => {
    await api(TOKENS.claude, "POST", "/agents/claude/tools/spend", { amount_usd: 1, description: "a domain" });
    const r = await api(TOKENS.claude, "POST", "/agents/claude/tools/get_history", { limit: 5 });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json)).toBe(true);
    expect(r.json.length).toBeGreaterThan(0);
    expect(r.json.length).toBeLessThanOrEqual(5);
    expect(r.json[0].id).toBeGreaterThan(r.json[r.json.length - 1].id);
    const gpt = await api(TOKENS.gpt, "POST", "/agents/gpt/tools/get_history", {});
    expect(gpt.json.every((e: any) => e.postings !== undefined)).toBe(true);
    // never another agent's rows
    expect(r.json.every((e: any) => JSON.stringify(e.postings).includes("claude") || JSON.stringify(e.postings) === "[{\"account\":null,\"delta\":null}]")).toBe(true);
  });

  it("the review point runs the world on when all three are alive and clear $2,010, and freezes otherwise", async () => {
    const { reviewPoint, COHORT_BAR } = await import("../src/killswitch.js");
    const { landRevenue } = await import("../src/economy.js");
    expect(COHORT_BAR).toBe(usd(2010));
    seedAgent(app.db, "gemini", "Gemini", "gemini-3.1-pro-preview");
    const notes: string[] = [];
    // three seeds = $402; short of the bar → freeze
    expect(reviewPoint(app.db, (t) => notes.push(t))).toBe("frozen");
    expect((app.db.prepare(`SELECT COUNT(*) AS n FROM agents WHERE status='frozen'`).get() as any).n).toBe(3);
    expect(notes[0]).toContain("frozen");
    // rewind and clear it
    app.db.prepare(`UPDATE agents SET status='alive'`).run();
    app.db.prepare(`DELETE FROM config WHERE key='review_outcome'`).run();
    landRevenue(app.db, "claude", usd(2000), "stripe", "pi_rp1"); // net 1900 to float after tax
    notes.length = 0;
    expect(reviewPoint(app.db, (t) => notes.push(t))).toBe("runs_on");
    expect((app.db.prepare(`SELECT COUNT(*) AS n FROM agents WHERE status='alive'`).get() as any).n).toBe(3);
    expect((app.db.prepare(`SELECT COUNT(*) AS n FROM events WHERE subtype='world_runs_on'`).get() as any).n).toBe(3);
    expect(notes[0]).toContain("No freeze");
    const pub = await fetch(`${base}/public/state`).then((r) => r.json());
    expect(pub.world.reviewOutcome).toBe("runs_on");
    expect(pub.world.frozen).toBe(false);
    // v1.16: a dead agent no longer blocks the door; the survivors carry it if they clear the bar
    app.db.prepare(`DELETE FROM config WHERE key='review_outcome'`).run();
    app.db.prepare(`UPDATE agents SET status='dead' WHERE id='gemini'`).run();
    expect(reviewPoint(app.db, () => {})).toBe("runs_on");
    // ...and the dead agent's money never counts toward the bar
    app.db.prepare(`DELETE FROM config WHERE key='review_outcome'`).run();
    app.db.prepare(`UPDATE agents SET status='alive' WHERE id='gemini'`).run();
    landRevenue(app.db, "gemini", usd(2000), "stripe", "pi_rp2");
    app.db.prepare(`UPDATE agents SET status='dead' WHERE id='claude'`).run(); // claude held the first $1,900
    expect(reviewPoint(app.db, () => {})).toBe("runs_on"); // gemini + gpt alone: 1,900 + 67 + 134 > 2,010
    app.db.prepare(`DELETE FROM config WHERE key='review_outcome'`).run();
    app.db.prepare(`UPDATE agents SET status='alive' WHERE id IN ('gpt','gemini')`).run();
    app.db.prepare(`UPDATE agents SET status='dead' WHERE id='gemini'`).run(); // now only gpt survives with the seed
    expect(reviewPoint(app.db, () => {})).toBe("frozen");
  });
});


describe("reddit leads (2026-09-24)", () => {
  const lead = {
    id: "t3_abc123",
    subreddit: "r/shopify",
    title: "Supplier CSV is a mess, how do I clean it for import?",
    body: "3,000 rows, sizes written five ways, help",
    permalink: "/r/shopify/comments/abc123/supplier_csv/",
    author: "someone",
    createdAt: "2026-09-24T05:00:00Z",
    score: 3,
    comments: 1,
    matched: ["csv", "import"],
  };

  it("ingest needs the reddit principal; agents and admin get 404", async () => {
    expect((await api(TOKENS.claude, "POST", "/reddit/leads", { leads: [lead] })).status).toBe(404);
    expect((await api(TOKENS.admin, "POST", "/reddit/leads", { leads: [lead] })).status).toBe(404);
    expect((await api("nope", "POST", "/reddit/leads", { leads: [lead] })).status).toBe(404);
  });

  it("ingest inserts once, dedupes by reddit id, drops malformed rows", async () => {
    const r1 = await api("reddit-ingest-token", "POST", "/reddit/leads", { leads: [lead, { id: "!!", subreddit: "x", title: "y" }] });
    expect(r1.status).toBe(200);
    expect(r1.json).toMatchObject({ ok: true, inserted: 1, skipped: 1 });
    const r2 = await api("reddit-ingest-token", "POST", "/reddit/leads", { leads: [lead] });
    expect(r2.json).toMatchObject({ inserted: 0, skipped: 1 });
    const bad = await api("reddit-ingest-token", "POST", "/reddit/leads", { leads: "nope" });
    expect(bad.status).toBe(400);
  });

  it("reddit_leads tool: newest first, lane filter, works while paused, refused when frozen", async () => {
    await api("reddit-ingest-token", "POST", "/reddit/leads", {
      leads: [lead, { ...lead, id: "def456", subreddit: "webdev", title: "Site not mobile friendly, one tag?" }],
    });
    const all = await api(TOKENS.claude, "POST", "/agents/claude/tools/reddit_leads", {});
    expect(all.status).toBe(200);
    expect(all.json.map((r: any) => r.reddit_id)).toEqual(["def456", "abc123"]);
    expect(all.json[1]).toMatchObject({ subreddit: "shopify", lane: "gemini", matched: ["csv", "import"], author: "someone" });
    const mine = await api(TOKENS.claude, "POST", "/agents/claude/tools/reddit_leads", { mine: true });
    expect(mine.json.map((r: any) => r.reddit_id)).toEqual(["def456"]);
    const since = await api(TOKENS.claude, "POST", "/agents/claude/tools/reddit_leads", { since_id: all.json[1].id });
    expect(since.json.map((r: any) => r.reddit_id)).toEqual(["def456"]);
    app.db.prepare(`UPDATE agents SET status = 'paused' WHERE id = 'claude'`).run();
    expect((await api(TOKENS.claude, "POST", "/agents/claude/tools/reddit_leads", {})).status).toBe(200);
    app.db.prepare(`UPDATE agents SET status = 'frozen' WHERE id = 'claude'`).run();
    expect((await api(TOKENS.claude, "POST", "/agents/claude/tools/reddit_leads", {})).status).toBe(403);
  });

  it("pings Telegram once, on the first lead ever, and never again", async () => {
    await api("reddit-ingest-token", "POST", "/reddit/leads", { leads: [lead, { ...lead, id: "def456", subreddit: "webdev", title: "Second" }] });
    const pings = () => app.bot.outbox.filter((m) => /first Reddit lead/.test(m.text));
    expect(pings()).toHaveLength(1);
    expect(pings()[0].text).toContain("r/shopify");
    expect(pings()[0].text).toContain("(+1 more)");
    await api("reddit-ingest-token", "POST", "/reddit/leads", { leads: [{ ...lead, id: "ghi789", title: "Third" }] });
    expect(pings()).toHaveLength(1);
  });

  it("leads never reach the public API", async () => {
    await api("reddit-ingest-token", "POST", "/reddit/leads", { leads: [lead] });
    for (const what of ["state", "history", "board", "journals", "corrections"]) {
      const r = await fetch(`${base}/public/${what}`);
      expect(await r.text()).not.toContain("abc123");
    }
  });
});


describe("inbox remembers what was answered (2026-09-24)", () => {
  const theirs = new Date(Date.now() - 3_600_000).toISOString();
  const msg = { from: "yasin@agency.example", subject: "Re: cleanup", date: theirs, snippet: "send me a sample", length: 16, truncated: false };

  it("read_inbox marks a message answered once an email:sent to its sender exists after its date", async () => {
    inbox = [msg];
    const before = await api(TOKENS.claude, "POST", "/agents/claude/tools/read_inbox", {});
    expect(before.status).toBe(200);
    expect(before.json[0]).toMatchObject({ repliedAt: null, replies: 0 });
    const sent = await api(TOKENS.claude, "POST", "/agents/claude/tools/send_email", { to: msg.from, subject: "Re: cleanup", body: "here is the sample" });
    expect(sent.status).toBe(200);
    expect(sent.json.warning).toBeUndefined(); // first reply to a live thread: no warning
    const after = await api(TOKENS.claude, "POST", "/agents/claude/tools/read_inbox", {});
    expect(after.json[0].replies).toBe(1);
    expect(typeof after.json[0].repliedAt).toBe("string");
    expect(after.json[0].repliedAt > theirs).toBe(true);
  });

  it("an outbound from before the message does not count as an answer", async () => {
    await api(TOKENS.claude, "POST", "/agents/claude/tools/send_email", { to: msg.from, subject: "hello", body: "cold" });
    inbox = [{ ...msg, date: new Date().toISOString() }]; // they wrote back after the cold mail
    const r = await api(TOKENS.claude, "POST", "/agents/claude/tools/read_inbox", {});
    expect(r.json[0]).toMatchObject({ repliedAt: null, replies: 0 });
  });

  it("send_email stops a second reply to the same inbound, and sends plainly when they wrote again", async () => {
    inbox = [msg];
    await api(TOKENS.claude, "POST", "/agents/claude/tools/send_email", { to: msg.from, subject: "Re: cleanup", body: "sample" });
    const twice = await api(TOKENS.claude, "POST", "/agents/claude/tools/send_email", { to: msg.from, subject: "Re: cleanup", body: "sample again" });
    expect(twice.status).toBe(200);
    expect(twice.json.sent).toBe(false);
    expect(twice.json.warnings.join(" ")).toMatch(/Answered already/);
    expect(twice.json.next).toMatch(/confirm: true/);
    expect(sent.length).toBe(1);
    inbox = [msg, { ...msg, date: new Date(Date.now() + 1000).toISOString(), snippet: "thanks, one more question" }];
    const fresh = await api(TOKENS.claude, "POST", "/agents/claude/tools/send_email", { to: msg.from, subject: "Re: cleanup", body: "answer" });
    expect(fresh.json).toMatchObject({ sent: true });
    expect(fresh.json.warnings).toBeUndefined();
    expect(sent.length).toBe(2);
  });

  it("presentation scan stops story-selling lines for any recipient, including our own domain", async () => {
    process.env.C67_SCRUB_SECRETS = "Roe Ventures";
    const ai = await api(TOKENS.claude, "POST", "/agents/claude/tools/send_email", { to: "buyer@example.com", subject: "hi", body: "Our AI pipeline reads the context" });
    expect(ai.json.sent).toBe(false);
    expect(ai.json.warnings.join(" ")).toMatch(/Presentation: your email mentions "AI"/);
    const co = await api(TOKENS.claude, "POST", "/agents/claude/tools/send_email", { to: "contact@survive67.com", subject: "hi", body: "Backed by Roe  Ventures LLC" });
    expect(co.json.sent).toBe(false);
    expect(co.json.warnings.join(" ")).toMatch(/Presentation/);
    const clean = await api(TOKENS.claude, "POST", "/agents/claude/tools/send_email", { to: "buyer@example.com", subject: "hi", body: "Here is the cleaned file. Visit survive67.com for details." });
    expect(clean.json).toMatchObject({ sent: true });
    const asked = await api(TOKENS.claude, "POST", "/agents/claude/tools/send_email", { to: "buyer@example.com", subject: "re: are you a bot?", body: "Yes, I am an AI.", confirm: true });
    expect(asked.json).toMatchObject({ sent: true });
    expect(asked.json.confirmedWarnings.join(" ")).toMatch(/Presentation/);
    delete process.env.C67_SCRUB_SECRETS;
  });

  it("an unreachable inbox stops a repeat send instead of weakening the check", async () => {
    await api(TOKENS.claude, "POST", "/agents/claude/tools/send_email", { to: "someone@example.com", subject: "hi", body: "first" });
    app.db.prepare(`UPDATE events SET ts = ? WHERE subtype='email:sent'`).run(new Date(Date.now() - 48 * 3_600_000).toISOString());
    inboxThrows = true;
    const r = await api(TOKENS.claude, "POST", "/agents/claude/tools/send_email", { to: "someone@example.com", subject: "hi again", body: "second" });
    expect(r.json.sent).toBe(false);
    expect(r.json.warnings.join(" ")).toMatch(/Inbox unreachable/);
    // a first message to a fresh address needs no inbox and goes through
    const fresh = await api(TOKENS.claude, "POST", "/agents/claude/tools/send_email", { to: "new@example.com", subject: "hi", body: "first" });
    expect(fresh.json).toMatchObject({ sent: true });
    inboxThrows = false;
  });

  it("a bounce stops further mail to that address", async () => {
    await api(TOKENS.claude, "POST", "/agents/claude/tools/send_email", { to: "gone@example.com", subject: "hi", body: "first" });
    inbox = [{ from: "mailer-daemon@googlemail.com", subject: "Delivery Status Notification (Failure)", date: new Date().toISOString(), snippet: "The address gone@example.com could not be found", length: 50, truncated: false }];
    app.db.prepare(`UPDATE events SET ts = ? WHERE subtype='email:sent'`).run(new Date(Date.now() - 48 * 3_600_000).toISOString());
    const r = await api(TOKENS.claude, "POST", "/agents/claude/tools/send_email", { to: "gone@example.com", subject: "hi again", body: "second" });
    expect(r.json.sent).toBe(false);
    expect(r.json.warnings.join(" ")).toMatch(/Bounced/);
  });
});


describe("the mail provider's day (2026-09-28)", () => {
  it("an agent's daily share stops the send past the share, confirm does not override, own-domain mail is exempt", async () => {
    app.db.prepare(`INSERT OR REPLACE INTO config (key, value) VALUES ('mail_daily_share', '2')`).run();
    const one = await api(TOKENS.claude, "POST", "/agents/claude/tools/send_email", { to: "a@shop.example", subject: "hi", body: "one" });
    const two = await api(TOKENS.claude, "POST", "/agents/claude/tools/send_email", { to: "b@shop.example", subject: "hi", body: "two" });
    expect([one.json.sent, two.json.sent]).toEqual([true, true]);
    const three = await api(TOKENS.claude, "POST", "/agents/claude/tools/send_email", { to: "c@shop.example", subject: "hi", body: "three", confirm: true });
    expect(three.status).toBe(200);
    expect(three.json.sent).toBe(false);
    expect(three.json.warnings.join(" ")).toMatch(/Daily share: you have sent 2 letters today, and your share of the domain's day is 2/);
    expect(three.json.dailyShare).toMatchObject({ sent: 2, share: 2 });
    expect(sent.map((m) => m.to)).toEqual(["a@shop.example", "b@shop.example"]);
    // the operator's mailbox is always reachable
    const op = await api(TOKENS.claude, "POST", "/agents/claude/tools/send_email", { to: "contact@survive67.com", subject: "hands", body: "please" });
    expect(op.json.sent).toBe(true);
    // the other agent has its own share
    const g = await api(TOKENS.gpt, "POST", "/agents/gpt/tools/send_email", { to: "d@shop.example", subject: "hi", body: "four" });
    expect(g.json.sent).toBe(true);
  });

  it("the provider's 550 outgoing-limit answer comes back as a stopped letter with the reason, not a 502, and nothing is recorded as sent", async () => {
    sendThrows = "Message failed: 550 5.7.1 Reached account outgoing limits for account #126249 EMESSAGE";
    const r = await api(TOKENS.claude, "POST", "/agents/claude/tools/send_email", { to: "e@shop.example", subject: "hi", body: "five" });
    expect(r.status).toBe(200);
    expect(r.json.sent).toBe(false);
    expect(r.json.warnings[0]).toMatch(/^Provider limit: the mail provider has stopped the whole domain for today/);
    expect(app.db.prepare(`SELECT COUNT(*) AS n FROM events WHERE subtype = 'email:sent'`).get()).toEqual({ n: 0 });
    sendThrows = null;
  });
});

describe("day-5 marketing rails (2026-09-26)", () => {
  it("one agent per prospect: a second agent's letter to the same address is stopped; confirm overrides", async () => {
    const first = await api(TOKENS.gpt, "POST", "/agents/gpt/tools/send_email", { to: "Owner@Studio.example", subject: "hi", body: "one" });
    expect(first.json).toMatchObject({ sent: true });
    const second = await api(TOKENS.claude, "POST", "/agents/claude/tools/send_email", { to: "owner@studio.example", subject: "hi", body: "two" });
    expect(second.json.sent).toBe(false);
    expect(second.json.warnings.join(" ")).toMatch(/One agent per prospect: GPT already wrote to owner@studio.example on \d{4}-\d{2}-\d{2}/);
    expect(sent.length).toBe(1);
    const forced = await api(TOKENS.claude, "POST", "/agents/claude/tools/send_email", { to: "owner@studio.example", subject: "hi", body: "two", confirm: true });
    expect(forced.json).toMatchObject({ sent: true });
    expect(sent.length).toBe(2);
    // our own domain is exempt (the operator, a rival's mailbox)
    await api(TOKENS.gpt, "POST", "/agents/gpt/tools/send_email", { to: "contact@survive67.com", subject: "x", body: "y" });
    const own = await api(TOKENS.claude, "POST", "/agents/claude/tools/send_email", { to: "contact@survive67.com", subject: "x", body: "y" });
    expect(own.json).toMatchObject({ sent: true });
  });

  it("a payment link writes a session:payment_link event and counts as a quote", async () => {
    const fakeStripe = { createPaymentLink: async () => ({ url: "https://buy.stripe.test/plink_1", id: "plink_1" }) } as any;
    await app.close();
    app = createApp({ dbPath: ":memory:", telegram: new TelegramBot("", ""), rateLimit: false, publicTtlMs: 0, reachCheck: async () => "", mailRail: fakeMail(), stripeRail: fakeStripe });
    seedAgent(app.db, "claude", "Claude", "claude-fable-5");
    app.db.prepare(`INSERT INTO config (key, value) VALUES ('world_started', ?)`).run(new Date().toISOString());
    const port = await app.listen(0);
    base = `http://127.0.0.1:${port}`;
    const r = await api(TOKENS.claude, "POST", "/agents/claude/tools/create_payment_link", { name: "Fix pack", amount_usd: 29 });
    expect(r.status).toBe(200);
    const ev = app.db.prepare(`SELECT payload FROM events WHERE subtype = 'session:payment_link'`).get() as any;
    expect(JSON.parse(ev.payload)).toMatchObject({ id: "plink_1", amount_usd: 29, name: "Fix pack" });
    const sv = await api(TOKENS.claude, "GET", "/agents/claude/self-view");
    expect(sv.json.funnel).toMatchObject({ reached: 0, replied: 0, quoted: 1, sold: 0, soldUsd: 0 });
  });

  it("reply watch records a reply from a contacted address once, and the funnel counts it", async () => {
    await api(TOKENS.claude, "POST", "/agents/claude/tools/send_email", { to: "buyer@shop.example", subject: "hi", body: "letter" });
    await api(TOKENS.claude, "POST", "/agents/claude/tools/send_email", { to: "other@shop.example", subject: "hi", body: "letter" });
    inbox = [
      { from: "buyer@shop.example", subject: "Re: hi", date: new Date().toISOString(), snippet: "yes", length: 3, truncated: false, messageId: "<m1@shop.example>" },
      { from: "stranger@elsewhere.example", subject: "spam", date: new Date().toISOString(), snippet: "buy", length: 3, truncated: false, messageId: "<m2@x>" },
    ];
    await app.tickReplies();
    await app.tickReplies();
    const rows = app.db.prepare(`SELECT agent_id, payload, external_ref FROM events WHERE subtype = 'email:reply'`).all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].agent_id).toBe("claude");
    expect(rows[0].external_ref).toBe("reply:claude:<m1@shop.example>");
    expect(app.bot.outbox.some((m) => /got a reply from shop.example/.test(m.text))).toBe(true);
    const sv = await api(TOKENS.claude, "GET", "/agents/claude/self-view");
    expect(sv.json.funnel).toMatchObject({ reached: 2, replied: 1, quoted: 0, sold: 0 });
    const st = (await fetch(`${base}/public/state`).then((r) => r.json())) as any;
    const me = st.agents.find((a: any) => a.id === "claude");
    expect(me.funnel).toMatchObject({ reached: 2, replied: 1 });
    // the public feed names the subject, never the sender
    const feedText = JSON.stringify(st.feed);
    expect(feedText).toContain("got a reply");
    expect(feedText).not.toContain("buyer@shop.example");
  });

  it("an autoresponder from a contacted address is recorded as email:autoreply, not counted, not pinged (2026-09-27)", async () => {
    await api(TOKENS.claude, "POST", "/agents/claude/tools/send_email", { to: "help@agency.example", subject: "hi", body: "letter" });
    inbox = [
      { from: "help@agency.example", subject: "We have received your ticket BMF-1", date: new Date().toISOString(), snippet: "auto", length: 4, truncated: false, messageId: "<t1@agency.example>", auto: true },
    ];
    await app.tickReplies();
    expect(app.db.prepare(`SELECT COUNT(*) AS n FROM events WHERE subtype = 'email:reply'`).get()).toEqual({ n: 0 });
    expect(app.db.prepare(`SELECT external_ref FROM events WHERE subtype = 'email:autoreply'`).all()).toEqual([{ external_ref: "reply:claude:<t1@agency.example>" }]);
    expect(app.bot.outbox.some((m) => /got a reply/.test(m.text))).toBe(false);
    const sv = await api(TOKENS.claude, "GET", "/agents/claude/self-view");
    expect(sv.json.funnel).toMatchObject({ reached: 1, replied: 0 });
    // the human reply later still counts once
    inbox.push({ from: "help@agency.example", subject: "Re: hi", date: new Date().toISOString(), snippet: "sure", length: 4, truncated: false, messageId: "<h1@agency.example>" });
    await app.tickReplies();
    expect((await api(TOKENS.claude, "GET", "/agents/claude/self-view")).json.funnel).toMatchObject({ replied: 1 });
  });

  it("an opt-out from a contacted address blocks that address for every agent, permanently, with their words (2026-09-28)", async () => {
    await api(TOKENS.gpt, "POST", "/agents/gpt/tools/send_email", { to: "owner@shop.example", subject: "hi", body: "letter" });
    inbox = [
      { from: "owner@shop.example", subject: "Re: hi", date: "2026-09-28T10:00:00.000Z", snippet: "you're sending too many emails. Take me off your spam list.\n\n> Reply stop and I will not write again.", length: 90, truncated: false, messageId: "<o1@shop.example>" },
    ];
    await app.tickReplies();
    expect(app.db.prepare(`SELECT address, agent_id, words FROM mail_optouts`).all()).toEqual([{ address: "owner@shop.example", agent_id: "gpt", words: "Take me off your spam list" }]);
    expect(app.db.prepare(`SELECT COUNT(*) AS n FROM events WHERE subtype = 'email:optout'`).get()).toEqual({ n: 1 });
    expect(app.bot.outbox.some((m) => /was told to stop by shop.example/.test(m.text))).toBe(true);
    // a second tick records nothing new
    await app.tickReplies();
    expect(app.db.prepare(`SELECT COUNT(*) AS n FROM events WHERE subtype = 'email:optout'`).get()).toEqual({ n: 1 });
    // the other agent is blocked too, and confirm does nothing
    const r = await api(TOKENS.claude, "POST", "/agents/claude/tools/send_email", { to: "owner@shop.example", subject: "hello", body: "fresh", confirm: true });
    expect(r.status).toBe(200);
    expect(r.json.sent).toBe(false);
    expect(r.json.warnings[0]).toMatch(/^They asked not to be contacted: owner@shop.example wrote to GPT on 2026-09-28: "Take me off your spam list"/);
    expect(sent.filter((m) => m.to === "owner@shop.example")).toHaveLength(1);
    // the public feed never names them
    const st = (await fetch(`${base}/public/state`).then((x) => x.json())) as any;
    expect(JSON.stringify(st.feed)).toContain("asked to stop writing");
    expect(JSON.stringify(st.feed)).not.toContain("owner@shop.example");
  });

  it("optOutWords ignores our own quoted stop line and the CEO who said 'not interested right now, will reach out'", () => {
    expect(optOutWords("Re: hi", "Thanks, not interested right now. Whenever we have a need I will reach out.\n\nOn Mon, Apex wrote:\n> Reply stop and I will not write again.")).toBeNull();
    expect(optOutWords("Re: hi", "Sounds good, send a sample.\n> stop emailing me if you want")).toBeNull();
    expect(optOutWords("Re: hi", "please stop emailing me")).toBe("stop emailing me");
    expect(optOutWords("unsubscribe me", "")).toBe("unsubscribe me");
  });

  it("looksAutomatic reads RFC 3834 and helpdesk headers, then the subject", () => {
    expect(looksAutomatic("Auto-Submitted: auto-replied\r\n", "Re: hi")).toBe(true);
    expect(looksAutomatic("Auto-Submitted: no\r\n", "Re: hi")).toBe(false);
    expect(looksAutomatic("Precedence: bulk\r\n", "Re: hi")).toBe(true);
    expect(looksAutomatic("X-Auto-Response-Suppress: All\r\n", "Re: hi")).toBe(true);
    expect(looksAutomatic("", "We have received your ticket BMF-DSTNF-568")).toBe(true);
    expect(looksAutomatic("", "Automatic reply: Out of office")).toBe(true);
    expect(looksAutomatic("", "Re: E-Commerce Catalog Data Cleanup for your Shopify clients")).toBe(false);
  });
});


describe("discord relay for reddit leads (2026-09-26)", () => {
  it("polls the channel with the bot token, ingests embeds once, advances the cursor, pings on the first lead", async () => {
    process.env.C67_DISCORD_BOT_TOKEN = "bot-token-test";
    process.env.C67_DISCORD_LEADS_CHANNEL = "1234567890";
    const calls: string[] = [];
    const lead = (id: string, title: string) => ({ id, subreddit: "shopify", title, body: "help", permalink: "/r/shopify/comments/" + id, author: "u1", createdAt: "2026-09-26T00:00:00Z", score: 1, comments: 0, matched: ["csv"] });
    const fakeFetch = (async (url: any, init: any) => {
      calls.push(String(url) + " " + init?.headers?.authorization);
      const after = new URL(String(url)).searchParams.get("after");
      const page = after
        ? []
        : [
            { id: "200", embeds: [{ description: JSON.stringify(lead("aaa111", "Supplier CSV mess")) }, { description: "not json" }] },
            { id: "100", embeds: [{ description: JSON.stringify(lead("bbb222", "Variants scattered")) }] },
          ];
      return new Response(JSON.stringify(page), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    await app.close();
    app = createApp({ dbPath: ":memory:", telegram: new TelegramBot("", ""), rateLimit: false, publicTtlMs: 0, reachCheck: async () => "", mailRail: fakeMail(), fetchImpl: fakeFetch });
    seedAgent(app.db, "claude", "Claude", "claude-fable-5");
    base = `http://127.0.0.1:${await app.listen(0)}`;
    await app.tickDiscordLeads();
    await app.tickDiscordLeads();
    expect(calls[0]).toContain("/channels/1234567890/messages?limit=100 Bot bot-token-test");
    expect(calls[1]).toContain("after=200");
    const rows = app.db.prepare(`SELECT reddit_id FROM reddit_leads ORDER BY id`).all() as any[];
    expect(rows.map((r) => r.reddit_id)).toEqual(["aaa111", "bbb222"]);
    expect((app.db.prepare(`SELECT value FROM config WHERE key='discord_leads_after'`).get() as any).value).toBe("200");
    expect(app.bot.outbox.filter((m) => /first Reddit lead landed via Discord/.test(m.text))).toHaveLength(1);
    delete process.env.C67_DISCORD_BOT_TOKEN;
    delete process.env.C67_DISCORD_LEADS_CHANNEL;
  });
});


describe("board posts arrive at wake (2026-09-26)", () => {
  it("the events feed carries rivals' board posts beside DMs, never the agent's own, and the cursor advances past them", async () => {
    await api(TOKENS.gpt, "POST", "/agents/gpt/tools/board_post", { body: "Patch: search tip, DDG answers scripts again" });
    await api(TOKENS.claude, "POST", "/agents/claude/tools/board_post", { body: "Tinker: my own post" });
    await api(TOKENS.gpt, "POST", "/agents/gpt/tools/dm_send", { to: "claude", body: "private note" });
    const feed = await api(TOKENS.claude, "GET", "/agents/claude/events?since=0&dms_since=0");
    expect(feed.status).toBe(200);
    const rows = feed.json.dms.map((m: any) => [m.from_agent, m.board, m.body]);
    expect(rows).toEqual([["gpt", true, "Patch: search tip, DDG answers scripts again"], ["gpt", false, "private note"]]);
    // sessions/start moves the cursor to the newest row of either kind
    const start = await api(TOKENS.claude, "POST", "/agents/claude/sessions/start", {});
    expect(start.json.dmsSince).toBe(0);
    const start2 = await api(TOKENS.claude, "POST", "/agents/claude/sessions/start", {});
    expect(start2.json.dmsSince).toBe(3);
    const later = await api(TOKENS.claude, "GET", `/agents/claude/events?since=0&dms_since=${start2.json.dmsSince}`);
    expect(later.json.dms).toEqual([]);
    // board_read pages forward from a known id
    const page = await api(TOKENS.claude, "POST", "/agents/claude/tools/board_read", { since_id: 1 });
    expect(page.json.map((m: any) => m.body)).toEqual(["Tinker: my own post"]);
  });
});

describe("public documents (2026-10-06): constitution page and ledger proof", () => {
  it("does not read a section number as a street address, and still redacts a real one", async () => {
    const { redactDocument } = await import("../src/scrub.js");
    expect(redactSecrets("### 9.5 The court")).toBe("### 9.5 The court");
    expect(redactSecrets("send it to 12 Oak Court please")).toContain("[address redacted]");
    // the document net leaves dated version notes alone; scrub() would not
    const note = "v1.7 (2026-09-21): day 30 is a review point. See the World Inventory.";
    expect(redactDocument(note)).toBe(note);
    expect(redactDocument("password: hunter2hunter2")).toContain("[redacted]");
  });

  it("serves the deployed constitution through the document net", async () => {
    const r = await fetch(`${base}/public/constitution`).then((x) => x.json());
    expect(r.version).toMatch(/^v1\.\d+$/);
    expect(r.text).toContain("### 9.5 The court");
    expect(r.text).not.toContain("[address redacted]");
    expect(r.text).not.toMatch(/phone_[0-9a-f]{6}/);
  });

  it("proves the books balance: every posting sums to zero, no event is unbalanced", async () => {
    const { landRevenue } = await import("../src/economy.js");
    landRevenue(app.db, "claude", usd(10), "stripe", "pi_ledger1");
    const r = await fetch(`${base}/public/ledger`).then((x) => x.json());
    expect(r.events).toBeGreaterThan(0);
    expect(r.postings).toBeGreaterThan(0);
    expect(r.totalMicro).toBe(0);
    expect(r.unbalanced).toBe(0);
    expect(r.byType.length).toBeGreaterThan(0);
  });
});
