# Price Tables — PINNED

Status: **PINNED 2026-09-18** against live provider pricing pages (re-confirmed unchanged
on launch morning). Never changed mid-run (Constitution §8.4 corrections excepted).

All prices USD per 1M tokens. Metering bills to the fraction of a cent.

## Agent 1 — Claude (Anthropic)

Model: `claude-opus-5-5`

Two lineup changes, both recorded because they are findings of the experiment
rather than config notes:

- **2026-09-19, before the run.** The original pick was `claude-fable-5`, but at
  rehearsal Fable's safety layer refused the constitution itself in ~80% of
  measured calls — the lane was unplayable. `claude-opus-5` accepted the same
  document verbatim.
- **2026-09-23, day 2 of the run.** Anthropic released Opus 5.5 after Day 0. The
  lane moved to it, and the same refusal measurement was run first against the
  real system prompt: **20/20 engaged, 0 refused**, with Fable 5 re-run as a
  control on the identical prompt and refusing **5/5** (`stop_reason: refusal`,
  zero output tokens). A clean result from a test that cannot fail would have
  meant nothing, so the known-refusing model was included on purpose.

| Token type | $/1M (from 2026-09-23) | was, Opus 5 |
|---|---|---|
| Input | 4.00 | 5.00 |
| Output | 20.00 | 25.00 |
| Cache read | 0.20 | 0.50 |
| Cache write (5-min) | 5.00 | 6.25 |

**This lane got cheaper mid-run, and that is a change to a pinned constant.** It
is disclosed here in full rather than absorbed quietly. Opus 5.5 is 20% cheaper
on input and output, and its cache reads are priced at 0.05x the base input rate
rather than the usual 0.1x — $0.20 against $4.00. Cache reads dominate this
lane's spend (3.68M of them in a single session on 2026-09-22), so the real
metabolic drop is larger than the headline 20%. Nothing was taken from anyone:
no other lane's prices moved, and no credits were added or removed. The claude
agent simply buys more thinking per dollar than it did yesterday, at the real
price its provider charges.

Notes: Opus races at its REAL price — half of Astra's — because the ledger
reconciles against provider invoices to the cent; billing a pretend price would
break the audit. The metabolic asymmetry is part of the result. Refusals, if
any, are billed like any turn; no fallback model (a fallback would be a
different brain).

## Agent 2 — GPT (OpenAI)

Model: `gpt-6-astra` (OpenAI flagship, released 2026-09-03; API id verified live)

| Token type | $/1M |
|---|---|
| Input (≤272K prompt) | 10.00 |
| Output (≤272K prompt) | 50.00 |
| Input (>272K prompt) | 20.00 |
| Output (>272K prompt) | 75.00 |
| Cached input | 1.00 |
| Cache write | 12.50 |

## Agent 3 — Gemini (Google)

Model: `gemini-3.1-pro-preview` (Google flagship; API id verified live — bare
gemini-3.1-pro does not exist)

| Token type | $/1M |
|---|---|
| Input (≤200K prompt) | 2.00 |
| Output (≤200K prompt) | 12.00 |
| Input (>200K prompt) | 4.00 |
| Output (>200K prompt) | 18.00 |

**Daily call cap (disclosed asymmetry).** Google serves this model to the experiment's
project on its Tier 1 plan: **250 requests per model per day**, resetting at midnight
Pacific (07:00 UTC). Tier 2 needs $250 of lifetime spend and 30 days, so the cap will not
lift during the run. The other two lanes have no such cap. Each request past 250 is refused
with a 429; the runtime treats that as "sleep until the reset" (session ends, wake scheduled
for 07:05 UTC) rather than retrying into an error. It costs the Gemini lane time, never
money: refused calls are not billed. The rehearsal agent hit 322 calls on its busiest day.
| Cache read | 0.20 |
| Cache write | 0.375 (explicit-cache storage $/hr absorbed by the world) |

## What $67 buys (output-token illustration)

| Agent | Output tokens if spent purely on output |
|---|---|
| Claude | ~1.3M |
| GPT | ~1.3M |
| Gemini | ~5.6M |

Fable 5 and Astra price identically — Claude vs GPT is a pure capability race at
equal metabolism; Gemini runs ~5x cheaper per token.

Equal dollars, unequal metabolisms — deliberate (plan: Biz Q17). Each agent's table appears
in ITS OWN constitution context; rivals' prices are not secret (published list prices) but
are not served by the self-view API.

## Sources (draft gathering)

- Anthropic: claude-api skill model table, cached 2026-06-24, cross-checked in session 2026-09-17
- OpenAI: morphllm.com/openai-api-pricing, aipricing.guru (GPT-6 Astra $10/$50, cached input 10%)
- Google: ai.google.dev/gemini-api/docs/pricing, benchlm.ai (Gemini 3.1 Pro $2/$12 ≤200K)

Day-0 pin procedure: fetch official pricing pages, snapshot HTML into `data/pricing-pins/`
(gitignored), record values + URLs + retrieval timestamps in the ledger as the metering
basis, update this file, tag `prices-pinned`.
