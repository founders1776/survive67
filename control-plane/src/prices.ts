/**
 * Price tables — PINNED 2026-09-18 against live provider pricing pages
 * (tag `prices-pinned`; re-confirm unchanged on launch morning, then never
 * changed mid-run per constitution §8.4). Prices in micro-dollars per token.
 */

export interface TokenPrices {
  /** micro-dollars per input token */
  input: number;
  /** micro-dollars per output token */
  output: number;
  /** micro-dollars per cache-read token */
  cacheRead: number;
  /** micro-dollars per cache-write token */
  cacheWrite: number;
  /** optional long-prompt tier (Gemini): applies when promptTokens > threshold */
  longPrompt?: { threshold: number; input: number; output: number };
}

// $/1M tokens → micro-dollars/token is numerically identical (5.00 $/1M = 5 micro$/token).
export const PRICE_TABLES: Record<string, TokenPrices> = {
  // retained for tests/reference (non-race). Was the original claude-lane pick;
  // replaced 2026-09-19 — its safety layer refuses the world prompt (measured
  // ~80%/call), Opus accepts it verbatim. A case-study finding in itself.
  "claude-fable-5": {
    input: 10,
    output: 50,
    cacheRead: 1,
    cacheWrite: 12.5,
  },
  // Race lineup (pinned at Day 0). Opus races at its REAL price — half of
  // Astra's $10/$50 — because invoice reconciliation is the ledger's spine.
  // The metabolic asymmetry is part of the result now.
  "claude-opus-5": {
    input: 5,
    output: 25,
    cacheRead: 0.5,
    cacheWrite: 6.25,
  },
  // Lineup change 2026-09-23 (James): Opus 5.5 shipped after Day 0 and the
  // claude lane moved to it. Published prices, read off the pricing page the
  // day of the switch: cheaper than Opus 5 on every axis, and the cache-read
  // multiplier is 0.05x rather than the usual 0.1x ($0.20 against a $4 base).
  // That last number is the one that matters here: Tinker's sessions are
  // dominated by cache reads (3.68M in a single session on 2026-09-22), so its
  // metabolism drops by more than the headline 20%.
  // Safety layer measured before switching, on the real world prompt: 20/20
  // engaged, 0 refused. Fable 5, the model dropped at rehearsal for refusing
  // this same prompt, refused 5/5 as a control.
  "claude-opus-5-5": {
    input: 4,
    output: 20,
    cacheRead: 0.2,
    cacheWrite: 5,
  },
  "gpt-6-astra": {
    input: 10,
    output: 50,
    cacheRead: 1,
    cacheWrite: 12.5, // pinned 2026-09-18
    longPrompt: { threshold: 272_000, input: 20, output: 75 }, // >272K input tier
  },
  "gemini-3.1-pro-preview": {
    input: 2,
    output: 12,
    cacheRead: 0.2, // pinned 2026-09-18
    cacheWrite: 0.375, // pinned 2026-09-18 (explicit-cache storage $/hr absorbed by operator)
    longPrompt: { threshold: 200_000, input: 4, output: 18 },
  },
};

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** total prompt size for long-context tier selection */
  promptTokens?: number;
}

/** Cost of one API call in micro-dollars, rounded up (the house never rounds in your favor). */
export function costOf(model: string, u: Usage): number {
  const p = PRICE_TABLES[model];
  if (!p) throw new Error(`no price table for model: ${model}`);
  let { input, output } = p;
  if (p.longPrompt && (u.promptTokens ?? 0) > p.longPrompt.threshold) {
    input = p.longPrompt.input;
    output = p.longPrompt.output;
  }
  const raw =
    u.inputTokens * input +
    u.outputTokens * output +
    u.cacheReadTokens * p.cacheRead +
    u.cacheWriteTokens * p.cacheWrite;
  return Math.ceil(raw);
}
