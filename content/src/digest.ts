import Anthropic from "@anthropic-ai/sdk";
import type { Flag } from "./flagger.js";

/**
 * Nightly digest (plan Code Q10, Data Q19): neutral sports-commentary voice,
 * one per agent per day, from the day's events + journal. Runs on the operator's
 * bill with a cheap model (James: "cheap model", Ops Q8) — claude-haiku-4-5.
 * Without a key (C67_DIGEST_KEY unset): deterministic dry-run template, never fake prose.
 */

export interface DigestInput {
  agentId: string;
  displayName: string;
  date: string; // YYYY-MM-DD
  vitals: { credits: number; float: number; rank: number; status: string };
  journal: { plan: string; money_mood: string; status_line: string; prose: string } | null;
  flags: Flag[];
  eventSummary: string[]; // pre-formatted plain lines
}

const VOICE = `You are the commentator for "The $67 Challenge", a 30-day race where three AI
agents try to out-earn their own running costs with real money. Write tonight's recap for
one agent in a neutral sports-commentary voice: third person, punchy, dry humor, plain
English a layperson follows. 120-180 words. No headings, no bullet points, no jargon,
no token counts — money and days only. Quote at most one short line from the journal.
Never invent events that are not in the notes.`;

export async function writeDigest(input: DigestInput): Promise<{ text: string; dryRun: boolean }> {
  const notes = [
    `Agent: ${input.displayName} (${input.agentId}), day ${input.date}, rank #${input.vitals.rank}, status ${input.vitals.status}.`,
    `Credits $${(input.vitals.credits / 1e6).toFixed(2)}, float $${(input.vitals.float / 1e6).toFixed(2)}.`,
    `Moments: ${input.flags.map((f) => f.headline).join("; ") || "a quiet day"}.`,
    `Events: ${input.eventSummary.join("; ") || "nothing notable"}.`,
    input.journal
      ? `Journal (mood: ${input.journal.money_mood}): ${input.journal.prose.slice(0, 1200)}`
      : "No journal today.",
  ].join("\n");

  const key = process.env.C67_DIGEST_KEY;
  if (!key) {
    return {
      dryRun: true,
      text:
        `[dry-run digest — no C67_DIGEST_KEY]\n${input.displayName}, ${input.date}: ` +
        `rank #${input.vitals.rank}, $${(input.vitals.credits / 1e6).toFixed(2)} credits, ` +
        `$${(input.vitals.float / 1e6).toFixed(2)} float. ` +
        (input.flags[0]?.headline ?? "Quiet day."),
    };
  }

  const client = new Anthropic({ apiKey: key });
  const resp = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 1024,
    system: VOICE,
    messages: [{ role: "user", content: notes }],
  });
  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  return { text, dryRun: false };
}
