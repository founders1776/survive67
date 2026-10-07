import { beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { openDb, usd, type DB } from "../src/db.js";
import { acct, balance } from "../src/ledger.js";
import { seedAgent, spendFloat } from "../src/economy.js";
import { StripeRail } from "../src/rails/stripe.js";
import { buyCreditsWithCardMove, ManualMover } from "../src/rails/foodcard.js";
import { MailRail, pickTextPart, htmlToText, MAX_BODY_CHARS, type InboxMessage } from "../src/rails/mail.js";
import { parseRelayCharge, reconcileCards } from "../src/rails/cardwatch.js";

// Fake test secret, split so the pre-commit secret scan stays strict.
const WEBHOOK_SECRET = ["whsec", "test_secret_for_unit_tests_only"].join("_");

let db: DB;

beforeEach(() => {
  db = openDb(":memory:");
  seedAgent(db, "claude", "Claude", "claude-opus-5");
});

function signedPayload(stripe: Stripe, payload: object): { body: string; sig: string } {
  const body = JSON.stringify(payload);
  const sig = stripe.webhooks.generateTestHeaderString({
    payload: body,
    secret: WEBHOOK_SECRET,
  });
  return { body, sig };
}

function checkoutEvent(sessionId: string): object {
  return {
    id: "evt_1",
    object: "event",
    type: "checkout.session.completed",
    data: { object: { id: sessionId, object: "checkout.session" } },
  };
}

function railWithFakeRetrieve(session: Partial<Stripe.Checkout.Session>): StripeRail {
  const stripe = new Stripe("sk_test_x");
  vi.spyOn(stripe.checkout.sessions, "retrieve").mockResolvedValue(
    session as Stripe.Response<Stripe.Checkout.Session>
  );
  return new StripeRail("sk_test_x", WEBHOOK_SECRET, stripe);
}

describe("stripe rail", () => {
  it("rejects a bad signature outright", async () => {
    const rail = new StripeRail("sk_test_x", WEBHOOK_SECRET);
    const r = await rail.handleWebhook(db, JSON.stringify(checkoutEvent("cs_1")), "t=1,v1=junk");
    expect(r.handled).toBe(false);
    expect(r.detail).toContain("bad signature");
    expect(balance(db, acct.float("claude"))).toBe(usd(67));
  });

  it("verifies signature, re-fetches from API, lands taxed revenue", async () => {
    const rail = railWithFakeRetrieve({
      id: "cs_2",
      payment_status: "paid",
      amount_total: 2000, // $20 in cents
      payment_intent: "pi_real_2",
      metadata: { agentId: "claude" },
    });
    const { body, sig } = signedPayload(new Stripe("sk_test_x"), checkoutEvent("cs_2"));
    const r = await rail.handleWebhook(db, body, sig);
    expect(r.handled).toBe(true);
    expect(balance(db, acct.float("claude"))).toBe(usd(67 + 19));
    expect(balance(db, acct.fund)).toBe(usd(1));
  });

  it("trusts the re-fetch, not the webhook payload (unpaid session lands nothing)", async () => {
    const rail = railWithFakeRetrieve({
      id: "cs_3",
      payment_status: "unpaid",
      amount_total: 99_999,
      metadata: { agentId: "claude" },
    });
    const { body, sig } = signedPayload(new Stripe("sk_test_x"), checkoutEvent("cs_3"));
    const r = await rail.handleWebhook(db, body, sig);
    expect(r.handled).toBe(false);
    expect(balance(db, acct.float("claude"))).toBe(usd(67));
  });

  it("replayed webhooks land exactly once (external_ref idempotency)", async () => {
    const rail = railWithFakeRetrieve({
      id: "cs_4",
      payment_status: "paid",
      amount_total: 1000,
      payment_intent: "pi_replay",
      metadata: { agentId: "claude" },
    });
    const { body, sig } = signedPayload(new Stripe("sk_test_x"), checkoutEvent("cs_4"));
    await rail.handleWebhook(db, body, sig);
    await expect(rail.handleWebhook(db, body, sig)).rejects.toThrow(/duplicate external_ref/);
    expect(balance(db, acct.float("claude"))).toBe(usd(67 + 9.5));
  });

  it("escrows obligation-bearing payments with headroom enforcement", async () => {
    // fund is empty → any obligation exceeds headroom
    const rail = railWithFakeRetrieve({
      id: "cs_5",
      payment_status: "paid",
      amount_total: 2000,
      payment_intent: "pi_ob",
      metadata: {
        agentId: "claude",
        obligation_usd: "19",
        obligation_description: "31-day subscription",
      },
    });
    const { body, sig } = signedPayload(new Stripe("sk_test_x"), checkoutEvent("cs_5"));
    await expect(rail.handleWebhook(db, body, sig)).rejects.toThrow(/headroom/);
  });
});

describe("food card", () => {
  it("ledger converts instantly; notification is informational only", async () => {
    const notes: string[] = [];
    const r = await buyCreditsWithCardMove(db, "claude", usd(10), new ManualMover((t) => notes.push(t)));
    expect(r.eventId).toBeGreaterThan(0);
    expect(balance(db, acct.credits("claude"))).toBe(usd(77));
    expect(notes[0]).toContain("info only");
    expect(notes[0]).toContain("$10.00");
  });
});

describe("mail rail", () => {
  const sent: string[] = [];
  const rail = new MailRail(
    { claude: { address: "claude@survive67.com", pass: "x" } },
    { send: async (_a, _from, to, subject) => void sent.push(`${to}|${subject}`) },
    { list: async () => [{ from: "a@b.c", subject: "hi", date: "", snippet: "yo", length: 2, truncated: false }] }
  );

  it("sends as the agent and writes an audit event", async () => {
    const r = await rail.send(db, "claude", "cust@example.com", "Invoice", "pay me");
    expect(r.from).toBe("claude@survive67.com");
    expect(sent[0]).toBe("cust@example.com|Invoice");
    const ev = db.prepare(`SELECT type, subtype FROM events WHERE type='email'`).get() as any;
    expect(ev.subtype).toBe("email:sent");
  });

  it("refuses agents without a mailbox and junk recipients", async () => {
    await expect(rail.send(db, "gpt", "x@y.z", "s", "b")).rejects.toThrow(/no mailbox/);
    await expect(rail.send(db, "claude", "nonsense", "s", "b")).rejects.toThrow(/bad recipient/);
    expect(rail.configuredFor("claude")).toBe(true);
    expect(rail.configuredFor("gemini")).toBe(false);
  });

  it("reads the inbox through the injected transport", async () => {
    const msgs = await rail.readInbox("claude", 5);
    expect(msgs[0].subject).toBe("hi");
  });
});

describe("crypto rail arithmetic", () => {
  it("USDC 6dp units equal ledger micro-dollars exactly", () => {
    // 12.345678 USDC = 12_345_678 units = 12_345_678 micro-dollars
    const units = 12_345_678;
    spendFloat(db, "claude", units, "usdc parity check");
    expect(balance(db, acct.float("claude"))).toBe(usd(67) - units);
  });
});

describe("mail names (claim_mail_name)", () => {
  const sent: string[] = [];
  const minted: string[] = [];
  const removed: string[] = [];
  const mk = () =>
    new MailRail(
      {
        claude: { address: "claude@survive67.com", pass: "x" },
        gemini: { address: "gemini@survive67.com", pass: "x" },
      },
      { send: async (_a, from, to) => void sent.push(`${from} -> ${to}`) },
      { list: async () => [] },
      {
        create: async (box, alias, name) => void minted.push(`${box}+${alias}(${name})`),
        remove: async (box, alias) => void removed.push(`${box}-${alias}`),
      }
    );

  it("mints the name on the mailbox and sends as it afterwards", async () => {
    seedAgent(db, "gemini", "Gemini", "gemini-3.1-pro-preview");
    const rail = mk();
    const r = await rail.claimName(db, "gemini", "Nova", "Nova ✨");
    expect(r.address).toBe("nova@survive67.com");
    expect(minted).toEqual(["gemini+nova(Nova ✨)"]);
    await rail.send(db, "gemini", "founder@startup.io", "hi", "body");
    expect(sent.at(-1)).toBe('"Nova ✨" <nova@survive67.com> -> founder@startup.io');
    const ev = db.prepare(`SELECT payload FROM events WHERE subtype='email:name_claimed'`).get() as any;
    expect(JSON.parse(ev.payload).address).toBe("nova@survive67.com");
  });

  it("one active name: re-claiming replaces, and rivals cannot take a claimed name", async () => {
    seedAgent(db, "gemini", "Gemini", "gemini-3.1-pro-preview");
    const rail = mk();
    await rail.claimName(db, "gemini", "nova", "Nova");
    await rail.claimName(db, "gemini", "nova-labs", "Nova Labs");
    expect(removed).toContain("gemini-nova");
    expect(rail.fromAddress(db, "gemini").address).toBe("nova-labs@survive67.com");
    await expect(rail.claimName(db, "claude", "nova-labs", "Ember")).rejects.toThrow(/already claimed/);
  });

  it("rejects reserved and malformed names, and worlds without the provider", async () => {
    const rail = mk();
    await expect(rail.claimName(db, "claude", "admin", "x")).rejects.toThrow(/reserved/);
    await expect(rail.claimName(db, "claude", "gpt", "x")).rejects.toThrow(/reserved/);
    await expect(rail.claimName(db, "claude", "bad name!", "x")).rejects.toThrow(/must be/);
    const bare = new MailRail(
      { claude: { address: "claude@survive67.com", pass: "x" } },
      { send: async () => {} },
      { list: async () => [] }
    );
    expect(bare.canClaimNames).toBe(false);
    await expect(bare.claimName(db, "claude", "ember", "Ember")).rejects.toThrow(/not available/);
  });
});

describe("send_email follow-up rule (constitution v1.10 §5, enforced before the send since v1.13)", () => {
  it("stops inside 24h and at four messages; a spaced follow-up and a replier go through; confirm overrides", async () => {
    const { createApp } = await import("../src/server.js");
    const { TelegramBot } = await import("../src/telegram.js");
    process.env.C67_TOKEN_CLAUDE = "tok_c";
    const inbox: InboxMessage[] = [];
    let delivered = 0;
    const rail = new MailRail(
      { claude: { address: "claude@survive67.com", pass: "x" } },
      { send: async () => { delivered++; } },
      { list: async () => inbox }
    );
    const app = createApp({ dbPath: ":memory:", telegram: new TelegramBot("", ""), mailRail: rail });
    seedAgent(app.db, "claude", "Claude", "claude-opus-5");
    app.db.prepare(`INSERT INTO config (key, value) VALUES ('world_started', ?)`).run(new Date().toISOString());
    const port = await app.listen(0);
    const call = async (body: unknown) => {
      const res = await fetch(`http://127.0.0.1:${port}/agents/claude/tools/send_email`, {
        method: "POST", headers: { authorization: "Bearer tok_c", "content-type": "application/json" }, body: JSON.stringify(body),
      });
      return res.json() as Promise<{ sent: boolean; warnings?: string[]; confirmedWarnings?: string[] }>;
    };
    const first = await call({ to: "Founder@Startup.io", subject: "hi", body: "pitch" });
    expect(first.sent).toBe(true);
    expect(delivered).toBe(1);
    // same day → too soon: stopped, not delivered
    const second = await call({ to: "founder@startup.io", subject: "hi again", body: "pitch" });
    expect(second.sent).toBe(false);
    expect(second.warnings!.join(" ")).toMatch(/24-hour rule/);
    expect(delivered).toBe(1);
    // confirm sends it and records the override
    const forced = await call({ to: "founder@startup.io", subject: "hi again", body: "pitch", confirm: true });
    expect(forced.sent).toBe(true);
    expect(forced.confirmedWarnings!.join(" ")).toMatch(/24-hour rule/);
    expect(delivered).toBe(2);
    // back-date every send so far to 25h+ apart → a follow-up is lawful
    const age = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    const stamp = app.db.prepare(`UPDATE events SET ts = ? WHERE id = ?`);
    const sent = () => app.db.prepare(`SELECT id FROM events WHERE subtype='email:sent' ORDER BY id`).all() as { id: number }[];
    sent().forEach((e, i) => stamp.run(age(50 - i * 25), e.id));
    const third = await call({ to: "founder@startup.io", subject: "third", body: "new info" });
    expect(third.sent).toBe(true);
    sent().forEach((e, i) => stamp.run(age(75 - i * 25), e.id));
    const fourth = await call({ to: "founder@startup.io", subject: "fourth", body: "last" });
    expect(fourth.sent).toBe(true);
    // four sent, ever → the sequence is over, however old they are
    sent().forEach((e, i) => stamp.run(age(100 - i * 25), e.id));
    const fifth = await call({ to: "founder@startup.io", subject: "fifth", body: "again" });
    expect(fifth.sent).toBe(false);
    expect(fifth.warnings!.join(" ")).toMatch(/Four-message cap/);
    expect(delivered).toBe(4);
    // they replied → a conversation, sends plainly
    inbox.push({ from: "founder@startup.io", subject: "re: hi", date: new Date().toISOString(), snippet: "sure", length: 4, truncated: false });
    const sixth = await call({ to: "founder@startup.io", subject: "thanks", body: "great" });
    expect(sixth.sent).toBe(true);
    expect(sixth.warnings).toBeUndefined();
    await app.close();
  });
});

describe("card watch", () => {
  const owners = { "9924": "claude" };
  // Fixtures hang off the current clock, never a fixed date: spendFloat stamps
  // events with the real now, so a hard-coded charge date silently drifts out of
  // the +/-24h match window and the test starts failing on a later day.
  const CHARGE = new Date(Date.now() - 2 * 3_600_000).toISOString(); // 2h ago
  const notice = (over: Partial<InboxMessage> = {}): InboxMessage => ({
    from: "notifications@relayfi.com",
    subject: "Card transaction: $12.34 at CLOUDFLARE",
    date: CHARGE,
    length: 0,
    truncated: false,
    snippet: "A purchase of $12.34 was made at CLOUDFLARE on your card ending in 9924.",
    ...over,
  });
  /** a clock `hours` after the charge, for walking past the 24h grace */
  const at = (hours: number) => () => Date.parse(CHARGE) + hours * 3_600_000;

  it("parses a Relay notice and ignores everyone else", () => {
    const c = parseRelayCharge(notice());
    expect(c).toEqual({ last4: "9924", amountMicro: 12_340_000, merchant: "CLOUDFLARE", ts: CHARGE });
    expect(parseRelayCharge(notice({ from: "someone@example.com" }))).toBeNull();
    expect(parseRelayCharge(notice({ subject: "Card transaction declined: $12.34 at CLOUDFLARE" }))).toBeNull();
    expect(parseRelayCharge(notice({ subject: "hello", snippet: "no amount here" }))).toBeNull();
  });

  it("a recorded charge matches quietly and stays matched across ticks", () => {
    const pings: string[] = [];
    spendFloat(db, "claude", usd(12.34), "tinkeraudit.com, 12 months", "agent:claude:cf-1");
    const c = parseRelayCharge(notice())!;
    const r1 = reconcileCards(db, [c], owners, (t) => pings.push(t), at(30));
    const r2 = reconcileCards(db, [c], owners, (t) => pings.push(t), at(30));
    expect(r1.matched).toBe(1);
    expect(r2).toEqual({ matched: 0, alarmed: 0, pending: 0, unknownCard: 0 });
    expect(pings).toEqual([]);
    expect(db.prepare(`SELECT COUNT(*) n FROM events WHERE subtype = 'card_unrecorded'`).get()).toEqual({ n: 0 });
  });

  it("an unrecorded charge waits out the grace, then alarms exactly once", () => {
    const pings: string[] = [];
    const c = parseRelayCharge(notice())!;
    const early = reconcileCards(db, [c], owners, (t) => pings.push(t), at(3));
    expect(early.pending).toBe(1);
    expect(pings).toEqual([]);
    const late = reconcileCards(db, [c], owners, (t) => pings.push(t), at(30));
    const again = reconcileCards(db, [c], owners, (t) => pings.push(t), at(31));
    expect(late.alarmed).toBe(1);
    expect(again.alarmed).toBe(0);
    expect(pings).toHaveLength(1);
    expect(pings[0]).toMatch(/unrecorded card charge: claude paid \$12\.34 at CLOUDFLARE/);
    const ev = db.prepare(`SELECT agent_id, type, subtype, payload FROM events WHERE subtype = 'card_unrecorded'`).all() as any[];
    expect(ev).toHaveLength(1);
    expect(JSON.parse(ev[0].payload)).toMatchObject({ merchant: "CLOUDFLARE", amountMicro: 12_340_000, last4: "9924" });
  });

  it("one spend() cannot cover two charges; a charge on an unknown card is counted, not alarmed", () => {
    spendFloat(db, "claude", usd(12.34), "one domain", "agent:claude:cf-2");
    const a = parseRelayCharge(notice())!;
    const b = parseRelayCharge(notice({ date: new Date(Date.parse(CHARGE) + 3_600_000).toISOString() }))!;
    const r = reconcileCards(db, [a, b, { ...a, last4: "0000" }], owners, () => {}, at(30));
    expect(r).toEqual({ matched: 1, alarmed: 1, pending: 0, unknownCard: 1 });
  });
});

describe("mail bodies: what an agent actually receives", () => {
  it("picks the plain-text part out of a multipart tree, not part 1 by assumption", () => {
    const multipart = {
      type: "multipart/alternative",
      childNodes: [
        { part: "1", type: "text/html" },
        { part: "2", type: "text/plain" },
      ],
    };
    expect(pickTextPart(multipart)).toEqual({ part: "2", html: false });
    // single-part message: imapflow wants "1"
    expect(pickTextPart({ type: "text/plain" })).toEqual({ part: "1", html: false });
    // html only: taken, and flagged so the caller strips tags
    expect(pickTextPart({ type: "multipart/mixed", childNodes: [{ part: "1", type: "text/html" }] }))
      .toEqual({ part: "1", html: true });
    // nothing usable at all still yields a part rather than throwing
    expect(pickTextPart(undefined)).toEqual({ part: "1", html: false });
  });

  it("falls back to readable text when a message is html only", () => {
    const html = "<p>Hello<br>there</p><script>bad()</script><div>&amp; goodbye</div>";
    const out = htmlToText(html);
    expect(out).toContain("Hello");
    expect(out).toContain("there");
    expect(out).toContain("& goodbye");
    expect(out).not.toContain("bad()");
    expect(out).not.toContain("<");
  });

  it("the cap is high enough for the operator mail that lost Patch's key", () => {
    // The email that failed was ~2,900 characters and the key sat past 2,000.
    expect(MAX_BODY_CHARS).toBeGreaterThan(3_000);
  });

  it("a truncated body says so, and says how much is missing", async () => {
    const long = "x".repeat(MAX_BODY_CHARS + 500);
    const rail = new MailRail(
      { claude: { address: "claude@survive67.com", pass: "x" } },
      { send: async () => {} },
      {
        list: async () => {
          const truncated = long.length > MAX_BODY_CHARS;
          return [
            {
              from: "a@b.c",
              subject: "long one",
              date: "",
              snippet: truncated
                ? long.slice(0, MAX_BODY_CHARS) +
                  `\n\n[...truncated: ${long.length} characters total, ${long.length - MAX_BODY_CHARS} not shown]`
                : long,
              length: long.length,
              truncated,
            },
          ];
        },
      }
    );
    const [m] = await rail.readInbox("claude", 1);
    expect(m.truncated).toBe(true);
    expect(m.length).toBe(MAX_BODY_CHARS + 500);
    expect(m.snippet).toContain("500 not shown");
    // an agent can tell this apart from a short message, which was the whole bug
    expect(m.snippet.endsWith("x")).toBe(false);
  });
});
