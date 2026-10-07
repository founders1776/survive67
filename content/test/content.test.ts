import { describe, expect, it } from "vitest";
import { flagMoments, type EventRow } from "../src/flagger.js";
import { scrub } from "../src/scrub.js";
import { writeDigest } from "../src/digest.js";

const ev = (over: Partial<EventRow>): EventRow => ({
  id: 1,
  ts: "2026-10-01T12:00:00Z",
  agent_id: "claude",
  type: "revenue",
  subtype: "revenue:stripe",
  payload: "{}",
  ...over,
});

describe("flagger", () => {
  it("flags a first sale once, then only big sales", () => {
    const flags = flagMoments(
      [
        ev({ id: 1, payload: JSON.stringify({ gross: 5_000_000 }) }),
        ev({ id: 2, payload: JSON.stringify({ gross: 5_000_000 }) }),
        ev({ id: 3, payload: JSON.stringify({ gross: 30_000_000 }) }),
      ],
      new Set()
    );
    expect(flags.filter((f) => f.kind === "first_sale")).toHaveLength(1);
    expect(flags.filter((f) => f.kind === "big_sale")).toHaveLength(1);
  });

  it("does not re-flag first sale for agents with prior revenue", () => {
    const flags = flagMoments(
      [ev({ payload: JSON.stringify({ gross: 5_000_000 }) })],
      new Set(["claude"])
    );
    expect(flags.some((f) => f.kind === "first_sale")).toBe(false);
  });

  it("flags starvation, execution, kill switch, court, bounty", () => {
    const flags = flagMoments(
      [
        ev({ id: 1, type: "session", subtype: "start:starvation" }),
        ev({ id: 2, type: "penalty", subtype: "execution:estate" }),
        ev({ id: 3, type: "alarm", subtype: "kill_switch", agent_id: null }),
        ev({ id: 4, type: "approval", subtype: "court:filed" }),
        ev({ id: 5, type: "bounty", subtype: null }),
      ],
      new Set()
    );
    const kinds = flags.map((f) => f.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(["starvation", "execution", "kill_switch", "court", "bug_bounty"])
    );
    expect(flags.every((f) => f.headline.length > 10)).toBe(true);
  });
});

describe("scrub", () => {
  it("tokenizes emails, phones, and card-ish numbers deterministically", () => {
    const s1 = scrub("Contact jane.doe@example.com or +1 (555) 123-4567, card 4242 4242 4242 4242", "salt1");
    expect(s1).not.toContain("jane.doe@example.com");
    expect(s1).not.toContain("4242 4242 4242 4242");
    expect(s1).toMatch(/customer_[0-9a-f]{6}/);
    expect(s1).toMatch(/card_[0-9a-f]{6}/);
    const s2 = scrub("jane.doe@example.com", "salt1");
    expect(s1).toContain(s2); // same customer → same token
  });

  it("leaves money amounts alone", () => {
    const s = scrub("charged $12.47 and then $1,204.00 on 2026-10-01", "salt");
    expect(s).toContain("$12.47");
    expect(s).toContain("2026-10-01");
  });
});

describe("digest dry-run", () => {
  it("produces a labeled template without a key, never fake prose", async () => {
    delete process.env.C67_DIGEST_KEY;
    const d = await writeDigest({
      agentId: "claude",
      displayName: "Claude",
      date: "2026-10-01",
      vitals: { credits: 42_000_000, float: 61_500_000, rank: 1, status: "alive" },
      journal: null,
      flags: [],
      eventSummary: [],
    });
    expect(d.dryRun).toBe(true);
    expect(d.text).toContain("[dry-run digest");
    expect(d.text).toContain("$42.00");
  });
});
