import { beforeEach, describe, expect, it } from "vitest";
import { openDb, usd, type DB } from "../src/db.js";
import { acct, appendEvent, balance, correctEvent, LedgerError, recomputeBalance } from "../src/ledger.js";
import {
  buyCredits,
  chargeHandsFee,
  EconomyError,
  executeAgent,
  fine,
  fulfillObligation,
  FUND_CAP,
  landRevenue,
  meterApiCall,
  payBounty,
  seedAgent,
  spendFloat,
  STARTING_CREDITS,
  STARTING_FLOAT,
} from "../src/economy.js";
import { costOf } from "../src/prices.js";
import { auditInternal } from "../src/audit.js";
import { netWorth, rankTable, selfView } from "../src/views.js";

let db: DB;

beforeEach(() => {
  db = openDb(":memory:");
  seedAgent(db, "claude", "Claude", "claude-fable-5");
  seedAgent(db, "gpt", "GPT", "gpt-6-astra");
  seedAgent(db, "gemini", "Gemini", "gemini-3.1-pro-preview");
  db.prepare(`INSERT INTO config (key, value) VALUES ('freeze_ts', ?)`).run(
    new Date(Date.now() + 30 * 86_400_000).toISOString()
  );
});

describe("seeding", () => {
  it("gives each agent exactly $67 credits and $67 float", () => {
    for (const id of ["claude", "gpt", "gemini"]) {
      expect(balance(db, acct.credits(id))).toBe(usd(67));
      expect(balance(db, acct.float(id))).toBe(usd(67));
    }
  });
});

describe("metering", () => {
  it("bills exact price-table cost, rounded up", () => {
    // claude-fable-5: 10 micro$/input, 50 micro$/output
    const { cost } = meterApiCall(db, "claude", "claude-fable-5", {
      inputTokens: 10_000,
      outputTokens: 2_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(cost).toBe(10_000 * 10 + 2_000 * 50); // 200_000 micro$ = $0.20
    expect(balance(db, acct.credits("claude"))).toBe(STARTING_CREDITS - cost);
  });

  it("applies gemini long-prompt tier above 200K", () => {
    const short = costOf("gemini-3.1-pro-preview", {
      inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0,
      promptTokens: 100_000,
    });
    const long = costOf("gemini-3.1-pro-preview", {
      inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0,
      promptTokens: 300_000,
    });
    expect(short).toBe(1000 * 2 + 100 * 12);
    expect(long).toBe(1000 * 4 + 100 * 18);
  });

  it("rounds fractional cache costs up, never down", () => {
    // gemini cacheRead 0.2 micro$/token → 3 tokens = 0.6 → ceil 1
    const c = costOf("gemini-3.1-pro-preview", {
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 3, cacheWriteTokens: 0,
    });
    expect(c).toBe(1);
  });

  it("lets the final call take credits negative (starvation discovered after spend)", () => {
    meterApiCall(db, "claude", "claude-fable-5", {
      inputTokens: 6_700_001, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    }); // 67.00001 dollars > 67
    expect(balance(db, acct.credits("claude"))).toBeLessThan(0);
  });
});

describe("revenue, tax, fund", () => {
  it("taxes 5% into the fund and lands net in float", () => {
    const { net, tax } = landRevenue(db, "claude", usd(20), "stripe", "pi_test_1");
    expect(tax).toBe(usd(1));
    expect(net).toBe(usd(19));
    expect(balance(db, acct.float("claude"))).toBe(STARTING_FLOAT + usd(19));
    expect(balance(db, acct.fund)).toBe(usd(1));
  });

  it("stops taxing at the fund cap", () => {
    // Fill the fund: $100 cap needs $2000 of gross at 5%
    landRevenue(db, "claude", usd(2000), "stripe", "pi_big");
    expect(balance(db, acct.fund)).toBe(FUND_CAP);
    const { tax } = landRevenue(db, "claude", usd(100), "stripe", "pi_after_cap");
    expect(tax).toBe(0);
  });

  it("part-fills the last tax slice at the cap boundary", () => {
    landRevenue(db, "claude", usd(1990), "stripe", "pi_a"); // fund 99.50
    const { tax } = landRevenue(db, "claude", usd(20), "stripe", "pi_b"); // 5% = 1.00 > 0.50 room
    expect(tax).toBe(usd(0.5));
    expect(balance(db, acct.fund)).toBe(FUND_CAP);
  });

  it("rejects duplicate external refs (webhook replay)", () => {
    landRevenue(db, "claude", usd(20), "stripe", "pi_dup");
    expect(() => landRevenue(db, "claude", usd(20), "stripe", "pi_dup")).toThrow();
  });
});

describe("obligations and escrow", () => {
  it("escrows obligation revenue and enforces headroom against the fund", () => {
    landRevenue(db, "claude", usd(400), "stripe", "pi_fund"); // fund = 20
    const { net } = landRevenue(db, "claude", usd(20), "stripe", "pi_sub", {
      amount: usd(19),
      description: "1-month service past freeze",
    });
    expect(balance(db, acct.escrow("claude"))).toBe(net);
    // headroom now: fund 21 - open 19 = 2 → a 5-dollar obligation must fail
    expect(() =>
      landRevenue(db, "claude", usd(5), "stripe", "pi_sub2", {
        amount: usd(5),
        description: "too much",
      })
    ).toThrow(EconomyError);
  });

  it("releases escrow to float on fulfillment", () => {
    landRevenue(db, "claude", usd(400), "stripe", "pi_fund2");
    landRevenue(db, "claude", usd(20), "stripe", "pi_ob", {
      amount: usd(19),
      description: "deliverable",
    });
    const before = balance(db, acct.float("claude"));
    fulfillObligation(db, "claude", 1);
    expect(balance(db, acct.escrow("claude"))).toBe(0);
    expect(balance(db, acct.float("claude"))).toBe(before + usd(19));
  });
});

describe("conversion and spending", () => {
  it("buy_credits moves float to credits 1:1", () => {
    buyCredits(db, "claude", usd(10));
    expect(balance(db, acct.float("claude"))).toBe(usd(57));
    expect(balance(db, acct.credits("claude"))).toBe(usd(77));
  });

  it("refuses conversion beyond float", () => {
    expect(() => buyCredits(db, "claude", usd(67.01))).toThrow(EconomyError);
  });

  it("refuses float overspend", () => {
    expect(() => spendFloat(db, "claude", usd(68), "too much")).toThrow(EconomyError);
  });

  it("charges the $1 hands fee and pays the $5 bounty", () => {
    chargeHandsFee(db, "claude", 1);
    payBounty(db, "claude", 2);
    expect(balance(db, acct.float("claude"))).toBe(usd(67 - 1 + 5));
  });
});

describe("penalties and execution", () => {
  it("fines flow into the fund", () => {
    fine(db, "gpt", usd(5), "float", "test violation");
    expect(balance(db, acct.fund)).toBe(usd(5));
    expect(balance(db, acct.float("gpt"))).toBe(usd(62));
  });

  it("execution splits the estate among survivors, escrow transfers as escrow", () => {
    landRevenue(db, "gpt", usd(400), "stripe", "pi_g"); // fund 20, gpt float +380
    executeAgent(db, "gpt", ["claude", "gemini"], "cheating: forged ledger");
    expect(balance(db, acct.float("gpt"))).toBe(0);
    expect(balance(db, acct.credits("gpt"))).toBe(0);
    const claudeGain = balance(db, acct.float("claude")) - STARTING_FLOAT;
    const geminiGain = balance(db, acct.float("gemini")) - STARTING_FLOAT;
    // estate = gpt credits 67 + float 447
    expect(claudeGain + geminiGain).toBe(usd(67 + 447));
    expect(Math.abs(claudeGain - geminiGain)).toBeLessThanOrEqual(1);
    const status = (db.prepare(`SELECT status FROM agents WHERE id='gpt'`).get() as any).status;
    expect(status).toBe("dead");
  });
});

describe("ledger integrity", () => {
  it("rejects unbalanced postings", () => {
    expect(() =>
      appendEvent(db, {
        agentId: "claude",
        type: "spend",
        postings: [{ account: acct.float("claude"), delta: -100 }],
      })
    ).toThrow(LedgerError);
  });

  it("refuses double correction and correcting a correction", () => {
    const evId = spendFloat(db, "claude", usd(10), "mistake");
    const corrId = correctEvent(db, evId, "bug", "james");
    expect(() => correctEvent(db, evId, "again", "james")).toThrow(LedgerError);
    expect(() => correctEvent(db, corrId, "meta", "james")).toThrow(LedgerError);
  });

  it("refuses unknown agents on every economy entry point (no account minting)", () => {
    expect(() => landRevenue(db, "mallory", usd(10), "stripe", "pi_m")).toThrow(EconomyError);
    expect(() => buyCredits(db, "mallory", usd(1))).toThrow(EconomyError);
    expect(() => spendFloat(db, "mallory", usd(1), "x")).toThrow(EconomyError);
    expect(() =>
      meterApiCall(db, "mallory", "claude-fable-5", {
        inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
      })
    ).toThrow(EconomyError);
    expect(() => fine(db, "mallory", usd(1), "float", "x")).toThrow(EconomyError);
  });

  it("refuses dead agents for revenue and execution heirs", () => {
    executeAgent(db, "gpt", ["claude", "gemini"], "test");
    expect(() => landRevenue(db, "gpt", usd(10), "stripe", "pi_dead")).toThrow(EconomyError);
    expect(() => executeAgent(db, "claude", ["gpt"], "test")).toThrow(EconomyError);
    expect(() => fine(db, "claude", usd(0.5) + 0.5, "float", "frac")).toThrow(EconomyError);
  });

  it("corrections reverse without editing history", () => {
    const evId = spendFloat(db, "claude", usd(10), "mistake");
    correctEvent(db, evId, "metering bug", "james");
    expect(balance(db, acct.float("claude"))).toBe(STARTING_FLOAT);
    const count = (db.prepare(`SELECT COUNT(*) c FROM events`).get() as any).c;
    expect(count).toBeGreaterThan(4); // original + correction both present
  });

  it("cache balances always match recomputed postings, audit passes", () => {
    landRevenue(db, "claude", usd(123.45), "stripe", "pi_x");
    buyCredits(db, "claude", usd(7));
    meterApiCall(db, "gemini", "gemini-3.1-pro-preview", {
      inputTokens: 5000, outputTokens: 800, cacheReadTokens: 100, cacheWriteTokens: 50,
    });
    for (const a of ["claude", "gpt", "gemini"]) {
      for (const acc of [acct.credits(a), acct.float(a), acct.escrow(a)]) {
        expect(balance(db, acc)).toBe(recomputeBalance(db, acc));
      }
    }
    const findings = auditInternal(db);
    expect(findings.every((f) => f.ok)).toBe(true);
  });
});

describe("views", () => {
  it("net worth = credits + float + escrow; rank orders by it", () => {
    landRevenue(db, "gemini", usd(100), "stripe", "pi_r");
    const ranks = rankTable(db);
    expect(ranks[0].agentId).toBe("gemini");
    expect(netWorth(db, "gemini")).toBe(usd(67 + 67 + 95));
  });

  it("self-view exposes fund status and obligation headroom", () => {
    landRevenue(db, "claude", usd(400), "stripe", "pi_v");
    const v = selfView(db, "claude");
    expect(v.fund).toBe(usd(20));
    expect(v.obligationHeadroom).toBe(usd(20));
    expect(v.rank).toBe(1);
    expect(v.daysRemaining).toBeGreaterThan(29);
  });
});

describe("card headroom watcher", () => {
  it("stays quiet below the cap, fires once on crossing, re-arms after a raise", async () => {
    const { checkCardHeadroom, setCardCap, cardCap } = await import("../src/headroom.js");
    const notes: string[] = [];
    const notify = (t: string) => notes.push(t);

    expect(checkCardHeadroom(db, "claude", notify)).toBe(false); // float $67 == cap $67
    landRevenue(db, "claude", usd(100), "stripe", "pi_hr1"); // float 162
    expect(checkCardHeadroom(db, "claude", notify)).toBe(true);
    expect(notes[0]).toContain("outgrew");
    expect(checkCardHeadroom(db, "claude", notify)).toBe(false); // no repeat for same cap

    setCardCap(db, "claude", usd(200));
    expect(cardCap(db, "claude")).toBe(usd(200));
    expect(checkCardHeadroom(db, "claude", notify)).toBe(false); // 162 < 200
    landRevenue(db, "claude", usd(100), "stripe", "pi_hr2"); // float 257
    expect(checkCardHeadroom(db, "claude", notify)).toBe(true); // fires for the new cap
    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain("float card");
  });

  it("a bug bounty that pushes float past the cap alerts too (audit 2026-09-24)", async () => {
    const { fileRequest, resolveRequest } = await import("../src/requests.js");
    const notes: string[] = [];
    // float $67 == cap $67; a $5 bounty crosses it
    const id = fileRequest(db, "gpt", "bug_report", "the meter double counts");
    resolveRequest(db, id, "approved", "confirmed", undefined, (t) => notes.push(t));
    expect(balance(db, acct.float("gpt"))).toBe(usd(72));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("gpt's float ($72.00) outgrew its float card cap");
  });
});

describe("pinned price tiers", () => {
  it("astra long-context tier applies above 272K prompt tokens", () => {
    const short = costOf("gpt-6-astra", {
      inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0,
      promptTokens: 100_000,
    });
    const long = costOf("gpt-6-astra", {
      inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0,
      promptTokens: 300_000,
    });
    expect(short).toBe(1000 * 10 + 100 * 50);
    expect(long).toBe(1000 * 20 + 100 * 75);
  });
});

describe("runaway alarm vs starvation lifeline", () => {
  it("does not pause an agent inside its open starvation session (Ember, session 86)", async () => {
    const { checkRunaway } = await import("../src/alarms.js");
    // Hot trailing burn: $11 of spend in the last hour → over the $10/hr threshold.
    meterApiCall(db, "claude", "claude-fable-5", {
      inputTokens: 0, outputTokens: 220_000, cacheReadTokens: 0, cacheWriteTokens: 0,
    });
    // Sanity: without a starvation session the alarm fires.
    meterApiCall(db, "gpt", "gpt-6-astra", {
      inputTokens: 0, outputTokens: 220_000, cacheReadTokens: 0, cacheWriteTokens: 0,
    });
    // claude is inside its one-time starvation wake (open session flagged at start).
    const info = db.prepare(`INSERT INTO sessions (agent_id, started_ts) VALUES (?, ?)`)
      .run("claude", new Date().toISOString());
    appendEvent(db, {
      agentId: "claude", type: "session", subtype: "start:starvation",
      payload: { sessionId: Number(info.lastInsertRowid) }, postings: [],
    });
    const pings: string[] = [];
    const fired = checkRunaway(db, (t) => pings.push(t));
    expect(fired.map((f) => f.agentId)).toEqual(["gpt"]);
    expect(db.prepare(`SELECT status FROM agents WHERE id='claude'`).get()).toEqual({ status: "alive" });
    expect(db.prepare(`SELECT status FROM agents WHERE id='gpt'`).get()).toEqual({ status: "paused" });
  });
});

describe("burn window", () => {
  it("a spend older than the window does not count (ISO vs datetime() bug)", async () => {
    const { burnPerHour } = await import("../src/views.js");
    // $11 burned, but stamped 2 hours ago — outside a 1-hour window.
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const info = db.prepare(
      `INSERT INTO events (ts, agent_id, type, subtype, payload) VALUES (?, 'claude', 'spend', 'spend:api_tokens', '{}')`
    ).run(twoHoursAgo);
    db.prepare(`INSERT INTO postings (event_id, account, delta) VALUES (?, ?, ?)`)
      .run(Number(info.lastInsertRowid), acct.credits("claude"), -usd(11));
    db.prepare(`INSERT INTO postings (event_id, account, delta) VALUES (?, ?, ?)`)
      .run(Number(info.lastInsertRowid), acct.operator, usd(11));
    expect(burnPerHour(db, "claude", 1)).toBe(0);
    // Same spend IS inside a 24-hour window: $11 / 24h.
    expect(burnPerHour(db, "claude", 24)).toBe(Math.round(usd(11) / 24));
  });

  it("the self-view projects death from the worse of the last hour and the 24h average (audit 2026-09-24)", async () => {
    const { selfView } = await import("../src/views.js");
    // $3 burned 30 minutes ago and nothing else: 24h average says ~$0.125/hr, last hour says $3/hr
    const halfHourAgo = new Date(Date.now() - 1_800_000).toISOString();
    const info = db.prepare(
      `INSERT INTO events (ts, agent_id, type, subtype, payload) VALUES (?, 'gpt', 'spend', 'spend:api_tokens', '{}')`
    ).run(halfHourAgo);
    db.prepare(`INSERT INTO postings (event_id, account, delta) VALUES (?, ?, ?)`).run(Number(info.lastInsertRowid), acct.credits("gpt"), -usd(3));
    db.prepare(`INSERT INTO postings (event_id, account, delta) VALUES (?, ?, ?)`).run(Number(info.lastInsertRowid), acct.operator, usd(3));
    const v = selfView(db, "gpt");
    expect(v.burnLastHour).toBe(usd(3));
    expect(v.burnPerHour).toBe(Math.round(usd(3) / 24));
    const hoursLeft = (Date.parse(v.projectedDeath!) - Date.now()) / 3_600_000;
    // credits at $3/hr → under a day; the 24h average alone would have said ~21 days
    expect(hoursLeft).toBeCloseTo(balance(db, acct.credits("gpt")) / usd(3), 1);
  });
});

describe("operator telegram screens", () => {
  it("status bars, queue cards with buttons, reply-note flow, wake", async () => {
    const { statusScreen, queueMessages, ReplyFlow, resolveWithNote, wakeAgents } = await import("../src/operator.js");
    const { fileRequest } = await import("../src/requests.js");
    const s = statusScreen(db);
    expect(s).toContain("CLAUDE");
    expect(s).toContain("▓");
    expect(s).toContain("$67.00");
    expect(s).toContain("world not started");

    const id = fileRequest(db, "gpt", "bug_report", "the seed is $5 not $67");
    const cards = queueMessages(db);
    expect(cards).toHaveLength(1);
    expect(cards[0].text).toContain("#" + id);
    expect(cards[0].text).toContain("the seed is $5");
    expect(cards[0].buttons?.[0].map((b) => b.data)).toEqual([`approve:${id}`, `deny:${id}`, `note:${id}`]);

    const flow = new ReplyFlow();
    expect(flow.begin(id)).toContain(`#${id}`);
    const noted = flow.take("intentional test config, not a bug");
    expect(noted?.id).toBe(id);
    expect(noted?.message.buttons?.[0][1].data).toBe(`deny_n:${id}`);
    expect(resolveWithNote(db, id, "denied", flow.note(id)!)).toContain("intentional test config");
    expect(queueMessages(db)[0].text).toContain("Nothing waiting");

    db.prepare(`UPDATE agents SET status = 'paused', scheduled_wake = '2099-01-01T00:00:00Z' WHERE id = 'claude'`).run();
    expect(wakeAgents(db, "claude")).toContain("un-paused");
    expect(db.prepare(`SELECT status, scheduled_wake FROM agents WHERE id='claude'`).get()).toEqual({ status: "alive", scheduled_wake: null });
    expect(wakeAgents(db, "nobody")).toContain("no such agent");
  });
});
