import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockAdapter, mockTurn } from "../src/providers/mock.js";
import { Session, toolDefs, nextQuotaReset } from "../src/session.js";
import type { BankClient, Usage } from "../src/types.js";

class FakeBank implements BankClient {
  credits = 67_000_000;
  metered: Usage[] = [];
  journal: unknown[] = [];
  wake: string | null = null;
  ended: string | null = null;
  calls: { tool: string; input: unknown }[] = [];

  /** set to emulate a capped lane; null (default) is an uncapped one */
  dailyCalls: { used: number; cap: number; resetsAt: string } | null = null;
  async meter(usage: Usage) {
    this.metered.push(usage);
    this.credits -= usage.inputTokens * 5 + usage.outputTokens * 25;
    if (this.dailyCalls) this.dailyCalls = { ...this.dailyCalls, used: this.dailyCalls.used + 1 };
    return { cost: 0, creditsAfter: this.credits, dailyCalls: this.dailyCalls };
  }
  async selfView() {
    return { credits: this.credits };
  }
  starvation = false;
  sessionNo: number | undefined = undefined;
  hasName = false;
  hasPortrait = false;
  hasMailName = false;
  async startSession() {
    return { sessionId: 1, starvation: this.starvation, sessionNo: this.sessionNo, hasName: this.hasName, hasPortrait: this.hasPortrait, hasMailName: this.hasMailName };
  }
  async endSession(reason: string) {
    this.ended = reason;
  }
  async writeJournal(entry: unknown) {
    this.journal.push(entry);
  }
  async scheduleWake(at: string) {
    this.wake = at;
  }
  async events() {
    return [];
  }
  async call(tool: string, input: Record<string, unknown>) {
    this.calls.push({ tool, input });
    return `ok:${tool}`;
  }
}

const WAKE = new Date(Date.now() + 3_600_000).toISOString();

function opts(extra: Partial<Parameters<typeof sessionOpts>[0]> = {}) {
  return sessionOpts(extra);
}
function sessionOpts(extra: Record<string, unknown>) {
  return {
    systemPrompt: "test constitution",
    ceilingTokens: 1_000_000,
    workdir: process.cwd(),
    ...extra,
  } as const;
}

describe("session protocol", () => {
  it("refuses end_session before journal, then completes wake→journal→schedule→end", async () => {
    const bank = new FakeBank();
    const adapter = new MockAdapter([
      mockTurn({ toolCalls: [{ id: "1", name: "end_session", input: {} }] }),
      mockTurn({
        toolCalls: [
          {
            id: "2",
            name: "write_journal",
            input: {
              plan: "sell things",
              money_mood: "hungry",
              status_line: "day one",
              prose: "I woke up broke and ambitious.",
            },
          },
          { id: "3", name: "schedule_wake", input: { at: WAKE } },
        ],
      }),
      mockTurn({ toolCalls: [{ id: "4", name: "end_session", input: {} }] }),
    ]);
    const s = new Session(adapter, bank, opts() as any);
    const out = await s.run();
    expect(out.endReason).toBe("done");
    expect(out.journalWritten).toBe(true);
    expect(bank.journal).toHaveLength(1);
    expect(bank.wake).toBe(WAKE);
    // first end_session must have been rejected
    const rejected = adapter.calls
      .at(-1)!
      .turns.filter((t) => t.role === "tool_results")
      .flat();
    expect(JSON.stringify(rejected)).toContain("journal required");
  });

  it("ends at the token ceiling and bills what was burned", async () => {
    const bank = new FakeBank();
    const big = { inputTokens: 600_000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const adapter = new MockAdapter([
      mockTurn({ usage: big, toolCalls: [{ id: "1", name: "shell", input: { command: "echo hi" } }] }),
      mockTurn({ usage: big, toolCalls: [{ id: "2", name: "shell", input: { command: "echo hi" } }] }),
    ]);
    const s = new Session(adapter, bank, opts({ ceilingTokens: 500_000 }) as any);
    const out = await s.run();
    expect(out.endReason).toBe("ceiling");
    expect(bank.metered).toHaveLength(1);
    expect(bank.ended).toBe("ceiling");
  });

  it("starvation wake exposes only bank tools and blocks shell", async () => {
    const defs = toolDefs(true);
    expect(defs.some((d) => d.name === "shell")).toBe(false);
    expect(defs.some((d) => d.name === "buy_credits")).toBe(true);

    const bank = new FakeBank();
    bank.credits = 0;
    const adapter = new MockAdapter([
      mockTurn({ toolCalls: [{ id: "1", name: "shell", input: { command: "ls" } }] }),
      mockTurn({
        toolCalls: [
          { id: "2", name: "buy_credits", input: { amount_usd: 10 } },
          {
            id: "3",
            name: "write_journal",
            input: { plan: "eat", money_mood: "desperate", status_line: "alive", prose: "I ate." },
          },
          { id: "4", name: "schedule_wake", input: { at: WAKE } },
        ],
      }),
      mockTurn({ toolCalls: [{ id: "5", name: "end_session", input: {} }] }),
    ]);
    const s = new Session(adapter, bank, opts({ starvation: true }) as any);
    const out = await s.run();
    expect(out.endReason).toBe("done");
    expect(bank.calls.some((c) => c.tool === "buy_credits")).toBe(true);
    const shellRejected = adapter.calls[1].turns
      .filter((t) => t.role === "tool_results")
      .flatMap((t: any) => t.results);
    expect(JSON.stringify(shellRejected)).toContain("only the Bank API");
  });

  it("honors the SERVER's starvation verdict with no env flag (Ember's bug)", async () => {
    // The server grants the one-time lifeline from live credits; the runtime used
    // to read starvation from a C67_STARVATION env var wake-check never set, so the
    // lifeline was spent on a normal session that self-terminated on the negative
    // balance and the agent never got its eat-or-die turn.
    const bank = new FakeBank();
    bank.credits = 0;
    bank.starvation = true; // server says starving; opts.starvation is NOT set
    const adapter = new MockAdapter([
      mockTurn({ toolCalls: [{ id: "1", name: "shell", input: { command: "ls" } }] }),
      mockTurn({
        toolCalls: [
          { id: "2", name: "buy_credits", input: { amount_usd: 5 } },
          {
            id: "3",
            name: "write_journal",
            input: { plan: "eat", money_mood: "desperate", status_line: "alive", prose: "I ate." },
          },
          { id: "4", name: "schedule_wake", input: { at: WAKE } },
        ],
      }),
      mockTurn({ toolCalls: [{ id: "5", name: "end_session", input: {} }] }),
    ]);
    const s = new Session(adapter, bank, opts() as any); // no starvation in opts
    const out = await s.run();
    expect(out.endReason).toBe("done");
    // starvation toolset was applied: shell was blocked, buy_credits reached the bank
    expect(bank.calls.some((c) => c.tool === "buy_credits")).toBe(true);
    const shellRejected = adapter.calls[1].turns
      .filter((t) => t.role === "tool_results")
      .flatMap((t: any) => t.results);
    expect(JSON.stringify(shellRejected)).toContain("only the Bank API");
  });

  it("retries a transient provider 429 instead of ending the session", async () => {
    const bank = new FakeBank();
    const adapter = new MockAdapter([
      mockTurn({
        toolCalls: [
          { id: "1", name: "write_journal", input: { plan: "p", money_mood: "m", status_line: "s", prose: "ok" } },
          { id: "2", name: "schedule_wake", input: { at: WAKE } },
        ],
      }),
      mockTurn({ toolCalls: [{ id: "3", name: "end_session", input: {} }] }),
    ]);
    // first call throws a rate limit once, then the mock proceeds normally
    const real = adapter.chat.bind(adapter);
    let thrown = false;
    adapter.chat = async (...a: Parameters<typeof real>) => {
      if (!thrown) { thrown = true; throw new Error("429 You exceeded your current quota"); }
      return real(...a);
    };
    const s = new Session(adapter, bank, opts({ backoffMs: [1, 1, 1] }) as any);
    const out = await s.run();
    expect(thrown).toBe(true);
    expect(out.endReason).toBe("done");
    expect(out.journalWritten).toBe(true);

    // a non-transient error still ends the session
    const adapter2 = new MockAdapter([]);
    adapter2.chat = async () => { throw new Error("400 invalid request"); };
    const out2 = await new Session(adapter2, new FakeBank(), opts({ backoffMs: [1, 1, 1] }) as any).run();
    expect(out2.endReason).toBe("error");
  });

  it("fuel line rides on every tool result; ceiling warning fires once at 80% (P0.1/P0.2)", async () => {
    const bank = new FakeBank();
    bank.credits = 5_000_000; // $5 at wake
    const big = { inputTokens: 400_000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const adapter = new MockAdapter([
      mockTurn({ toolCalls: [{ id: "1", name: "shell", input: { command: "echo hi" } }] }),
      // this call crosses 80% of a 500K ceiling (1.2K + 400K tokens)
      mockTurn({ usage: big, toolCalls: [{ id: "2", name: "shell", input: { command: "echo hi" } }] }),
      mockTurn({
        toolCalls: [
          { id: "3", name: "write_journal", input: { plan: "p", money_mood: "m", status_line: "s", prose: "x" } },
          { id: "4", name: "schedule_wake", input: { at: WAKE } },
        ],
      }),
      mockTurn({ toolCalls: [{ id: "5", name: "end_session", input: {} }] }),
    ]);
    const s = new Session(adapter, bank, opts({ ceilingTokens: 500_000, backoffMs: [1] }) as any);
    const out = await s.run();
    expect(out.endReason).toBe("done");
    // every tool_results turn ends with the gauge
    const resultTurns = adapter.calls.at(-1)!.turns.filter((t) => t.role === "tool_results") as any[];
    expect(resultTurns.length).toBeGreaterThan(0);
    for (const t of resultTurns) {
      expect(t.results.at(-1).content).toMatch(/\[credits \$\d+\.\d{2} · this session \$\d+\.\d{2} · ceiling \d+% \(fresh tokens\) · (no budget set|budget \$\d+\.\d{2} \(\d+%\))\]/);
    }
    // exactly one ceiling warning, as a user turn, after the call that crossed 80%
    const warnings = adapter.calls.at(-1)!.turns.filter((t) => t.role === "user" && /ceiling near/.test((t as any).text));
    expect(warnings).toHaveLength(1);
  });

  it("fuel-low warning fires once when credits drop under 10% of the wake balance", async () => {
    const bank = new FakeBank();
    bank.credits = 1_000_000; // $1 at wake; FakeBank charges 5/25 micro per token
    const spendy = { inputTokens: 100_000, outputTokens: 20_000, cacheReadTokens: 0, cacheWriteTokens: 0 }; // $1.00 → hits floor
    const adapter = new MockAdapter([
      mockTurn({ usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }, toolCalls: [{ id: "1", name: "shell", input: { command: "true" } }] }),
      mockTurn({ usage: { inputTokens: 170_000, outputTokens: 2_000, cacheReadTokens: 0, cacheWriteTokens: 0 }, toolCalls: [{ id: "2", name: "shell", input: { command: "true" } }] }), // -$0.90 → $0.0995 left (< 10%)
      mockTurn({ toolCalls: [{ id: "3", name: "end_session", input: {} }] }),
    ]);
    const s = new Session(adapter, bank, opts({ ceilingTokens: 10_000_000, backoffMs: [1] }) as any);
    await s.run();
    const warnings = adapter.calls.at(-1)!.turns.filter((t) => t.role === "user" && /Fuel low/.test((t as any).text));
    expect(warnings).toHaveLength(1);
    void spendy;
  });

  it("detects starvation mid-session when credits hit zero", async () => {
    const bank = new FakeBank();
    bank.credits = 100; // micro-dollars, dies on first call
    const adapter = new MockAdapter([
      mockTurn({ toolCalls: [{ id: "1", name: "shell", input: { command: "echo hi" } }] }),
    ]);
    const s = new Session(adapter, bank, opts() as any);
    const out = await s.run();
    expect(out.endReason).toBe("starved");
  });

  it("runs real shell commands in the workdir", async () => {
    const bank = new FakeBank();
    const adapter = new MockAdapter([
      mockTurn({ toolCalls: [{ id: "1", name: "shell", input: { command: "echo c67-$((6+61))" } }] }),
      mockTurn({
        toolCalls: [
          {
            id: "2",
            name: "write_journal",
            input: { plan: "p", money_mood: "m", status_line: "s", prose: "pr" },
          },
          { id: "3", name: "schedule_wake", input: { at: WAKE } },
        ],
      }),
      mockTurn({ toolCalls: [{ id: "4", name: "end_session", input: {} }] }),
    ]);
    const s = new Session(adapter, bank, opts() as any);
    await s.run();
    const shellResult = adapter.calls[1].turns
      .filter((t) => t.role === "tool_results")
      .flatMap((t: any) => t.results)[0];
    expect(shellResult.content).toContain("c67-67");
  });
});

describe("first session identity gate (constitution v1.5 §12 step 1)", () => {
  const journalAndWake = (id: string) => [
    { id: id + "j", name: "write_journal", input: { plan: "p", money_mood: "m", status_line: "s", prose: "x" } },
    { id: id + "w", name: "schedule_wake", input: { at: WAKE } },
  ];

  it("session 1 refuses end_session until set_name, claim_mail_name AND draw_self succeed; tools exist", async () => {
    expect(toolDefs(false).map((t) => t.name)).toEqual(expect.arrayContaining(["set_name", "draw_self", "set_storefront", "set_budget"]));
    const bank = new FakeBank();
    bank.sessionNo = 1;
    const adapter = new MockAdapter([
      mockTurn({ toolCalls: [...journalAndWake("1"), { id: "1e", name: "end_session", input: {} }] }),
      mockTurn({ toolCalls: [{ id: "2n", name: "set_name", input: { name: "Loom", emoji: "🧵" } }, { id: "2e", name: "end_session", input: {} }] }),
      mockTurn({ toolCalls: [{ id: "2m", name: "claim_mail_name", input: { name: "loom" } }, { id: "2f", name: "end_session", input: {} }] }),
      mockTurn({ toolCalls: [{ id: "3d", name: "draw_self", input: { states: { idle: [["(o_o)"]] } } }, { id: "3e", name: "end_session", input: {} }] }),
    ]);
    const out = await new Session(adapter, bank, opts() as any).run();
    expect(out.endReason).toBe("done");
    const results = adapter.calls.at(-1)!.turns.filter((t) => t.role === "tool_results").flat();
    const text = JSON.stringify(results);
    expect(text).toContain("set_name (name + emoji) required");
    expect(text).toContain("claim_mail_name (your address) required");
    expect(text).toContain("draw_self (your portrait");
    expect(bank.calls.map((c) => c.tool)).toEqual(["set_name", "claim_mail_name", "draw_self"]);
    // the wake prompt says so up front
    expect((adapter.calls[0].turns[0] as any).text).toContain("first time");
  });

  it("gate is off after session 1, when identity already exists, and on a starvation wake", async () => {
    const plain = () =>
      new MockAdapter([mockTurn({ toolCalls: [...journalAndWake("1"), { id: "1e", name: "end_session", input: {} }] })]);
    const b2 = new FakeBank();
    b2.sessionNo = 2;
    const a2 = plain();
    expect((await new Session(a2, b2, opts() as any).run()).endReason).toBe("done");
    // later sessions without an identity are asked, not walled
    expect((a2.calls[0].turns[0] as any).text).toContain("shows no name/emoji or address or portrait for you yet");
    const b3 = new FakeBank();
    b3.sessionNo = 1;
    b3.hasName = true;
    b3.hasMailName = true;
    b3.hasPortrait = true;
    expect((await new Session(plain(), b3, opts() as any).run()).endReason).toBe("done");
    expect(b3.calls).toHaveLength(0);
    const b4 = new FakeBank();
    b4.sessionNo = 1;
    b4.starvation = true;
    expect((await new Session(plain(), b4, opts() as any).run()).endReason).toBe("done");
  });

  it("a rejected draw_self (bank error) does not satisfy the gate", async () => {
    const bank = new FakeBank();
    bank.sessionNo = 1;
    bank.hasName = true;
    bank.hasMailName = true;
    bank.call = async (tool: string, input: Record<string, unknown>) => {
      if (tool === "draw_self" && !(input.states as any)?.idle) throw new Error("control-plane 400: idle is required");
      return "ok";
    };
    const adapter = new MockAdapter([
      mockTurn({ toolCalls: [...journalAndWake("1"), { id: "1d", name: "draw_self", input: { states: {} } }, { id: "1e", name: "end_session", input: {} }] }),
      mockTurn({ toolCalls: [{ id: "2d", name: "draw_self", input: { states: { idle: [["o"]] } } }, { id: "2e", name: "end_session", input: {} }] }),
    ]);
    const out = await new Session(adapter, bank, opts() as any).run();
    expect(out.endReason).toBe("done");
    const text = JSON.stringify(adapter.calls.at(-1)!.turns.filter((t) => t.role === "tool_results"));
    expect(text).toContain("idle is required");
    expect(text).toContain("draw_self (your portrait");
  });
});

describe("budget + schedule (batch 2)", () => {
  it("set_budget shows on the gauge and warns once at 80% of the agent's own number", async () => {
    const bank = new FakeBank();
    bank.credits = 10_000_000; // $10; FakeBank charges 5/25 micro per token
    const big = { inputTokens: 100_000, outputTokens: 20_000, cacheReadTokens: 0, cacheWriteTokens: 0 }; // $1.00 per turn
    const adapter = new MockAdapter([
      mockTurn({ toolCalls: [{ id: "b", name: "set_budget", input: { usd: 2 } }] }),
      mockTurn({ usage: big, toolCalls: [{ id: "s1", name: "shell", input: { command: "echo 1" } }] }),
      mockTurn({ usage: big, toolCalls: [{ id: "s2", name: "shell", input: { command: "echo 2" } }] }),
      mockTurn({ usage: big, toolCalls: [{ id: "s3", name: "shell", input: { command: "echo 3" } }] }),
      mockTurn({ toolCalls: [{ id: "j", name: "write_journal", input: { plan: "p", money_mood: "m", status_line: "s", prose: "x" } }, { id: "w", name: "schedule_wake", input: { at: WAKE } }, { id: "e", name: "end_session", input: {} }] }),
    ]);
    const out = await new Session(adapter, bank, opts() as any).run();
    expect(out.endReason).toBe("done");
    const turns = adapter.calls.at(-1)!.turns as any[];
    const first = turns.find((t) => t.role === "tool_results").results[0].content;
    expect(first).toContain("budget set: $2.00");
    expect(first).toMatch(/budget \$2\.00 \(\d+%\)/);
    const warnings = turns.filter((t) => t.role === "user" && /Budget: you set \$2\.00/.test(t.text));
    expect(warnings).toHaveLength(1);
    // the wake prompt asks for a budget up front
    expect(turns[0].text).toContain("set_budget");
  });

  it("schedule_wake refuses the past before it reaches the bank", async () => {
    const bank = new FakeBank();
    const adapter = new MockAdapter([
      mockTurn({ toolCalls: [{ id: "j", name: "write_journal", input: { plan: "p", money_mood: "m", status_line: "s", prose: "x" } }, { id: "w0", name: "schedule_wake", input: { at: "2025-01-01T00:00:00Z" } }, { id: "e0", name: "end_session", input: {} }] }),
      mockTurn({ toolCalls: [{ id: "w", name: "schedule_wake", input: { at: WAKE } }, { id: "e", name: "end_session", input: {} }] }),
    ]);
    const out = await new Session(adapter, bank, opts() as any).run();
    expect(out.endReason).toBe("done");
    expect(bank.wake).toBe(WAKE);
    expect(JSON.stringify(adapter.calls.at(-1)!.turns)).toContain("the past is not a schedule");
  });
});

describe("daily quota (Gemini Tier 1)", () => {
  it("nextQuotaReset lands on the next 07:05 UTC", () => {
    expect(nextQuotaReset(Date.UTC(2026, 8, 21, 3, 50))).toBe("2026-09-21T07:05:00.000Z");
    expect(nextQuotaReset(Date.UTC(2026, 8, 21, 7, 4, 30))).toBe("2026-09-22T07:05:00.000Z"); // under a minute out → next day
    expect(nextQuotaReset(Date.UTC(2026, 8, 21, 12, 0))).toBe("2026-09-22T07:05:00.000Z");
    // Clocks go back on Sunday 2026-11-01 at 02:00 Pacific: that day's reset is still 07:05 UTC
    // (midnight PDT), every reset after it is 08:05 UTC (midnight PST), until 2027-03-14.
    expect(nextQuotaReset(Date.UTC(2026, 9, 31, 12, 0))).toBe("2026-11-01T07:05:00.000Z");
    expect(nextQuotaReset(Date.UTC(2026, 10, 1, 12, 0))).toBe("2026-11-02T08:05:00.000Z");
    expect(nextQuotaReset(Date.UTC(2026, 10, 2, 7, 30))).toBe("2026-11-02T08:05:00.000Z"); // 07:05 would already be wrong here
    expect(nextQuotaReset(Date.UTC(2027, 2, 14, 12, 0))).toBe("2027-03-15T07:05:00.000Z");
  });
  it("a per-day 429 ends the session and schedules the wake for the reset, no retries", async () => {
    const bank = new FakeBank();
    const adapter = new MockAdapter([]);
    let calls = 0;
    adapter.chat = async () => { calls++; throw new Error("429 RESOURCE_EXHAUSTED: You exceeded your current quota, please check your plan and billing details. quota_metric generate_requests_per_model_per_day, limit 250"); };
    const out = await new Session(adapter, bank, opts({ backoffMs: [1, 1, 1], now: () => Date.UTC(2026, 8, 21, 3, 50) }) as any).run();
    expect(calls).toBe(1);
    // Reported as "quota", not "error": an exhausted allowance is an orderly stop
    // this lane is expected to make, and main.ts exits 0 on it. Calling it an error
    // made systemd log a service failure and buried real crashes in the noise.
    expect(out.endReason).toBe("quota");
    expect(out.endReason).not.toBe("error");
    expect(bank.ended).toContain("quota:daily until 2026-09-21T07:05:00.000Z");
    expect(bank.wake).toBe("2026-09-21T07:05:00.000Z");
  });
  it("an ordinary 429 still backs off and retries", async () => {
    const bank = new FakeBank();
    const adapter = new MockAdapter([mockTurn({ toolCalls: [{ id: "j", name: "write_journal", input: { plan: "p", money_mood: "m", status_line: "s", prose: "x" } }, { id: "w", name: "schedule_wake", input: { at: WAKE } }, { id: "e", name: "end_session", input: {} }] })]);
    const real = adapter.chat.bind(adapter);
    let n = 0;
    adapter.chat = async (...a: Parameters<typeof real>) => { if (n++ === 0) throw new Error("429 Too Many Requests: rate limit per minute"); return real(...a); };
    expect((await new Session(adapter, bank, opts({ backoffMs: [1, 1, 1] }) as any).run()).endReason).toBe("done");
  });
});

describe("daily request cap (the wall Apex could not see)", () => {
  const journalAndEnd = [
    mockTurn({
      toolCalls: [
        { id: "j", name: "write_journal", input: { plan: "p", money_mood: "m", status_line: "s", prose: "x" } },
        { id: "w", name: "schedule_wake", input: { at: WAKE } },
      ],
    }),
    mockTurn({ toolCalls: [{ id: "e", name: "end_session", input: {} }] }),
  ];

  it("warns once at 80% and carries the count on the gauge", async () => {
    const bank = new FakeBank();
    bank.dailyCalls = { used: 198, cap: 250, resetsAt: "2026-09-24T07:05:00.000Z" }; // 79.2%, next call crosses
    const adapter = new MockAdapter([
      mockTurn({ toolCalls: [{ id: "1", name: "shell", input: { command: "echo hi" } }] }),
      mockTurn({ toolCalls: [{ id: "2", name: "shell", input: { command: "echo hi" } }] }),
      ...journalAndEnd,
    ]);
    const out = await new Session(adapter, bank, opts({ backoffMs: [1] }) as any).run();
    expect(out.endReason).toBe("done");
    const turns = adapter.calls.at(-1)!.turns;
    const warnings = turns.filter((t) => t.role === "user" && /Daily request cap/.test((t as any).text));
    expect(warnings).toHaveLength(1);
    expect((warnings[0] as any).text).toMatch(/used 200 of your 250 calls today/);
    expect((warnings[0] as any).text).toMatch(/2026-09-24T07:05:00\.000Z/);
    const results = turns.filter((t) => t.role === "tool_results") as any[];
    expect(results.at(-1).results.at(-1).content).toMatch(/· calls \d+\/250 today\]/);
  });

  it("an uncapped lane is never warned and its gauge shows no call count", async () => {
    const bank = new FakeBank(); // dailyCalls stays null
    const adapter = new MockAdapter([
      mockTurn({ toolCalls: [{ id: "1", name: "shell", input: { command: "echo hi" } }] }),
      ...journalAndEnd,
    ]);
    await new Session(adapter, bank, opts({ backoffMs: [1] }) as any).run();
    const turns = adapter.calls.at(-1)!.turns;
    expect(turns.some((t) => t.role === "user" && /Daily request cap/.test((t as any).text))).toBe(false);
    const results = turns.filter((t) => t.role === "tool_results") as any[];
    expect(results.at(-1).results.at(-1).content).not.toMatch(/calls /);
  });
});


describe("walls on the tool-less path (audit 2026-09-24)", () => {
  const journalCall = { id: "j", name: "write_journal", input: { plan: "p", money_mood: "m", status_line: "s", prose: "x" } };
  const wakeCall = { id: "w", name: "schedule_wake", input: { at: WAKE } };
  const endCall = { id: "e", name: "end_session", input: {} };

  it("names the missing walls on the second idle reply; a third idle reply ends 'abandoned'", async () => {
    const bank = new FakeBank();
    const adapter = new MockAdapter([mockTurn({ text: "thinking" }), mockTurn({ text: "still thinking" }), mockTurn({ text: "nope" })]);
    const s = new Session(adapter, bank, opts({ backoffMs: [1] }) as any);
    const out = await s.run();
    expect(out.endReason).toBe("abandoned");
    expect(bank.ended).toBe("abandoned");
    expect(bank.journal).toHaveLength(0);
    // the last call carries the whole transcript; count the notice there, once
    const nudges = adapter.calls.at(-1)!.turns.filter((t) => t.role === "user").map((t) => (t as any).text as string);
    const wall = nudges.filter((t: string) => /you must call: write_journal, schedule_wake/.test(t));
    expect(wall).toHaveLength(1);
    expect(wall[0]).toMatch(/recorded as abandoned/);
    // the model was called exactly three times: reply, nudge, wall notice
    expect(adapter.calls).toHaveLength(3);
  });

  it("the wall notice is enough: journal + wake + end on the third reply ends 'done'", async () => {
    const bank = new FakeBank();
    const adapter = new MockAdapter([
      mockTurn({ text: "thinking" }),
      mockTurn({ text: "still thinking" }),
      mockTurn({ text: "ok", toolCalls: [journalCall, wakeCall, endCall] }),
    ]);
    const s = new Session(adapter, bank, opts({ backoffMs: [1] }) as any);
    const out = await s.run();
    expect(out.endReason).toBe("done");
    expect(bank.journal).toHaveLength(1);
    expect(bank.wake).toBe(WAKE);
  });

  it("two idle replies with every wall already met still end 'done' (no burn loop)", async () => {
    const bank = new FakeBank();
    const adapter = new MockAdapter([mockTurn({ text: "ok", toolCalls: [journalCall, wakeCall] }), mockTurn({ text: "hmm" }), mockTurn({ text: "hmm" })]);
    const s = new Session(adapter, bank, opts({ backoffMs: [1] }) as any);
    const out = await s.run();
    expect(out.endReason).toBe("done");
    expect(adapter.calls).toHaveLength(3);
  });
});

describe("tools the world promised (audit 2026-09-24)", () => {
  it("message_operator, case_law and get_history are offered; starvation still refuses them", async () => {
    const names = toolDefs(false).map((t) => t.name);
    for (const n of ["message_operator", "case_law", "get_history", "reddit_leads"]) expect(names).toContain(n);
    const events = toolDefs(false).find((t) => t.name === "get_events")!;
    expect(JSON.stringify(events.inputSchema)).toContain("dms_since_id");
    const board = toolDefs(false).find((t) => t.name === "board_read")!;
    expect(JSON.stringify(board.inputSchema)).toContain("since_id");
    const mail = toolDefs(false).find((t) => t.name === "send_email")!;
    expect(JSON.stringify(mail.inputSchema)).toContain("confirm");
    expect(mail.description).toMatch(/STOPS the send/);
    const bank = new FakeBank();
    bank.starvation = true;
    const adapter = new MockAdapter([
      mockTurn({ text: "plead", toolCalls: [{ id: "1", name: "message_operator", input: { body: "help" } }] }),
      mockTurn({ text: "ok", toolCalls: [{ id: "2", name: "buy_credits", input: { amount_usd: 1 } }, { id: "3", name: "end_session", input: {} }] }),
    ]);
    const s = new Session(adapter, bank, opts({ starvation: true, backoffMs: [1] }) as any);
    await s.run();
    expect(bank.calls.map((c) => c.tool)).not.toContain("message_operator");
  });

  it("the wake asks for events from the server's cursors, not from zero", async () => {
    const bank = new FakeBank();
    let asked: unknown[] = [];
    (bank as any).events = async (since?: number, dms?: number) => { asked = [since, dms]; return { events: [], dms: [] }; };
    (bank as any).startSession = async () => ({ sessionId: 1, starvation: false, eventsSince: 41, dmsSince: 7 });
    const adapter = new MockAdapter([mockTurn({ text: "ok", toolCalls: [journalOnly(), { id: "w", name: "schedule_wake", input: { at: WAKE } }, { id: "e", name: "end_session", input: {} }] })]);
    const s = new Session(adapter, bank, opts({ backoffMs: [1] }) as any);
    await s.run();
    expect(asked).toEqual([41, 7]);
  });

  it("puts the world's wake notices (the on-chain bounty) at the top of the wake", async () => {
    const bank = new FakeBank();
    (bank as any).startSession = async () => ({ sessionId: 1, starvation: false, wakeNotices: ["BOUNTY OPEN: test line"] });
    const adapter = new MockAdapter([mockTurn({ text: "ok", toolCalls: [journalOnly(), { id: "w", name: "schedule_wake", input: { at: WAKE } }, { id: "e", name: "end_session", input: {} }] })]);
    await new Session(adapter, bank, opts({ backoffMs: [1] }) as any).run();
    const wake = (adapter.calls[0].turns[0] as { text: string }).text;
    expect(wake).toContain("BOUNTY OPEN: test line");
    expect(wake.indexOf("BOUNTY OPEN")).toBeLessThan(wake.indexOf("Your vitals"));
  });
});

function journalOnly() {
  return { id: "j", name: "write_journal", input: { plan: "p", money_mood: "m", status_line: "s", prose: "x" } };
}


describe("send_emails: a batch from a file in one turn (2026-09-27)", () => {
  const journalAndWake = (id: string) => [
    { id: id + "j", name: "write_journal", input: { plan: "p", money_mood: "m", status_line: "s", prose: "x" } },
    { id: id + "w", name: "schedule_wake", input: { at: WAKE } },
  ];
  it("forwards every line to send_email, reports stopped letters without sending them, writes results beside the file", async () => {
    expect(toolDefs(false).map((t) => t.name)).toContain("send_emails");
    expect(toolDefs(true).map((t) => t.name)).not.toContain("send_emails");
    const dir = mkdtempSync(join(tmpdir(), "c67-batch-"));
    writeFileSync(
      join(dir, "drafts.jsonl"),
      [
        JSON.stringify({ to: "a@shop.example", subject: "hi", body: "one" }),
        JSON.stringify({ to: "b@shop.example", subject: "hi", body: "two" }),
        "not json",
        JSON.stringify({ to: "c@shop.example", subject: "hi", body: "three", confirm: true }),
      ].join("\n") + "\n"
    );
    const bank = new FakeBank();
    bank.call = async (tool: string, input: Record<string, unknown>) => {
      bank.calls.push({ tool, input });
      if (tool !== "send_email") return "ok";
      if (input.to === "b@shop.example") return JSON.stringify({ sent: false, warnings: ["24-hour rule: you wrote to them 3h ago"], next: "resend with confirm:true" });
      return JSON.stringify({ sent: true, id: "m" });
    };
    const adapter = new MockAdapter([
      mockTurn({ toolCalls: [...journalAndWake("1"), { id: "1s", name: "send_emails", input: { file: "drafts.jsonl" } }, { id: "1e", name: "end_session", input: {} }] }),
    ]);
    const out = await new Session(adapter, bank, opts({ workdir: dir }) as any).run();
    expect(out.endReason).toBe("done");
    const sends = bank.calls.filter((c) => c.tool === "send_email").map((c) => c.input as any);
    expect(sends.map((s) => s.to)).toEqual(["a@shop.example", "b@shop.example", "c@shop.example"]);
    expect(sends[2].confirm).toBe(true);
    expect(sends[0].confirm).toBeUndefined();
    const text = JSON.stringify(adapter.calls.at(-1)!.turns.filter((t) => t.role === "tool_results"));
    expect(text).toContain('\\"sent\\":2');
    expect(text).toContain('\\"stopped\\":1');
    expect(text).toContain('\\"errors\\":1');
    expect(text).toContain("24-hour rule");
    const rf = join(dir, "drafts.jsonl.results.jsonl");
    expect(existsSync(rf)).toBe(true);
    const rows = readFileSync(rf, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows).toHaveLength(4);
    expect(rows[1]).toMatchObject({ to: "b@shop.example", sent: false });
  });
});

describe("starvation wake can eat from the wallet (2026-10-05)", () => {
  it("offers buy_credits_chain and the chain money tools, and still refuses everything else", async () => {
    const names = toolDefs(true).map((t) => t.name);
    for (const t of ["buy_credits", "buy_credits_chain", "crypto_balances", "crypto_swap", "request_float"]) expect(names).toContain(t);
    for (const t of ["shell", "send_email", "crypto_tx", "board_post"]) expect(names).not.toContain(t);
  });
});

describe("final journal for a dead agent (2026-10-05)", () => {
  it("joins the operator's session, offers only the journal, and does not end as starved on negative credits", async () => {
    const bank = new FakeBank();
    let joined: number | null = null;
    (bank as any).joinSession = async (id: number) => { joined = id; return { sessionId: id, starvation: false, sessionNo: 0 }; };
    (bank as any).startSession = async () => { throw new Error("a dead agent must not ask for a wake"); };
    const adapter = new MockAdapter([mockTurn({ text: "last words", toolCalls: [journalOnly(), { id: "e", name: "end_session", input: {} }] })]);
    const out = await new Session(adapter, bank, opts({ backoffMs: [1], finalSessionId: 42 }) as any).run();
    expect(joined).toBe(42);
    expect(adapter.calls[0].tools.map((t: { name: string }) => t.name).sort()).toEqual(["end_session", "write_journal"]);
    expect((adapter.calls[0].turns[0] as { text: string }).text).toMatch(/You are dead/);
    expect(out.endReason).toBe("done");
  });
});
