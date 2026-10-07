import type { DB } from "./db.js";
import { usd } from "./db.js";
import { balance, acct, appendEvent } from "./ledger.js";
import { meterApiCall } from "./economy.js";
import type { Usage } from "./prices.js";

/**
 * LLM proxy: agents' brains speak to their provider THROUGH the control plane.
 * Why (Sec Q2 + metering honesty): agents have root on their VMs, so anything on the VM
 * — keys, self-reported usage — is tamperable. The proxy keeps provider keys here and
 * meters from the provider's own response body. The agent VM never sees a key and never
 * reports its own usage.
 *
 * Providers' base URLs are overridden in the runtime adapters via env:
 *   ANTHROPIC_BASE_URL / OPENAI_BASE_URL / GOOGLE_GEMINI_BASE_URL → http://<control>/proxy/<agent>
 */

export type Provider = "anthropic" | "openai" | "google";

export interface ProxyConfig {
  provider: Provider;
  /** metering model id (price table key), pinned at Day 0 */
  meterModel: string;
  upstream: string; // real API base
  apiKeyEnv: string; // env var holding the provider key (control plane only)
  /**
   * Requests per day this lane is allowed, if its provider caps them. Only the
   * Google lane has one (Tier 1: 250/model/day, resetting at midnight Pacific; confirmed in AI Studio 2026-10-01); the
   * asymmetry is disclosed in price-tables.md and lives here so the world can
   * show the agent its own number instead of letting it find the wall.
   */
  dailyCallCap?: number;
}

/**
 * Midnight Pacific plus five minutes, in UTC ms, for the Pacific calendar day
 * that starts on UTC date (y, m, d). Google's daily quota resets at midnight
 * Pacific: 07:00 UTC in summer, 08:00 UTC in winter. The offset is read at
 * 07:30 UTC, which is still the same side of either clock change (they happen
 * at 02:00 local), so the switch days come out right.
 */
function pacificResetUtc(y: number, m: number, d: number): number {
  const probe = new Date(Date.UTC(y, m, d, 7, 30));
  const tz = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", timeZoneName: "shortOffset" })
    .formatToParts(probe)
    .find((p) => p.type === "timeZoneName")?.value ?? "GMT-8";
  const offsetHours = -Number(tz.replace("GMT", "") || "-8"); // "GMT-7" -> 7
  return Date.UTC(y, m, d, offsetHours, 5, 0);
}

/**
 * Start of the quota day containing `t`, as an ISO string. The day runs from
 * five minutes past midnight Pacific to the next (07:05 UTC in summer, 08:05 in
 * winter; it was pinned to 07:05 UTC until 2026-10-01, an hour early after the
 * clocks change on Nov 1). Counterpart to nextQuotaReset() in
 * agent-runtime/src/session.ts; change one and you must change the other.
 */
export function quotaDayStart(t: number): string {
  const d = new Date(t);
  for (let back = 0; back <= 2; back++) {
    const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back));
    const b = pacificResetUtc(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
    if (b <= t) return new Date(b).toISOString();
  }
  throw new Error("unreachable: no quota boundary in the last three days");
}

/** End of that same window: the moment the allowance refills. */
export function quotaDayEnd(t: number): string {
  // The next day's start, not start + 24h: the day the clocks go back is 25 hours
  // long and the day they go forward 23. Jumping 26h lands inside the next day.
  return quotaDayStart(Date.parse(quotaDayStart(t)) + 26 * 3_600_000);
}

export const PROVIDERS: Record<string, ProxyConfig> = {
  claude: {
    provider: "anthropic",
    // Lineup change 2026-09-19 (James): Fable 5's safety layer refuses the
    // world prompt ~80% of the time (measured); Opus 5 accepts it verbatim.
    meterModel: "claude-opus-5-5",
    upstream: "https://api.anthropic.com",
    apiKeyEnv: "C67_ANTHROPIC_KEY",
  },
  gpt: {
    provider: "openai",
    meterModel: "gpt-6-astra",
    upstream: "https://api.openai.com",
    apiKeyEnv: "C67_OPENAI_KEY",
  },
  gemini: {
    provider: "google",
    meterModel: "gemini-3.1-pro-preview",
    upstream: "https://generativelanguage.googleapis.com",
    apiKeyEnv: "C67_GOOGLE_KEY",
    dailyCallCap: 250,
  },
};

/** Bounded overdraft for the starvation wake (constitution §12). */
export const OVERDRAFT_FLOOR = -usd(2);

export class ProxyDeniedError extends Error {
  constructor(
    public code: "dead" | "frozen" | "starved" | "paused",
    message: string
  ) {
    super(message);
  }
}

/** Token ceiling for an operator-funded final journal (constitution §12: last words). */
export const FINAL_JOURNAL_TOKEN_CEILING = 50_000;

/**
 * Only the endpoints we can meter are reachable (security review V1). Anything
 * else — images, audio, batches, streaming — would consume the operator's key
 * without a usage block to bill from. Fail closed.
 */
const ALLOWED_PATHS: Record<Provider, RegExp> = {
  anthropic: /^\/v1\/messages$/,
  openai: /^\/v1\/(responses|chat\/completions)$/,
  google: /^\/v1beta\/models\/[\w.:-]+:generateContent$/,
};

export function validateProxyRequest(
  cfg: Pick<ProxyConfig, "provider" | "meterModel">,
  path: string,
  body: string | undefined
): string | null {
  const { provider, meterModel } = cfg;
  const bare = path.split("?")[0];
  if (!ALLOWED_PATHS[provider].test(bare)) return `endpoint not meterable: ${bare}`;
  // The lane is priced for exactly one model (price-tables.md). Until 2026-09-24
  // any model named in the request was billed at the lane's pinned price; the
  // integrity of the meter rests on the request and the price table agreeing.
  if (provider === "google") {
    const m = /\/models\/([^:]+):/.exec(bare)?.[1];
    if (m && m !== meterModel) return `model ${m} is not meterable on this lane; use ${meterModel}`;
  }
  if (body) {
    try {
      const parsed = JSON.parse(body);
      if (parsed && parsed.stream === true) return "streaming is not meterable — set stream:false";
      if (provider !== "google" && parsed && typeof parsed.model === "string" && parsed.model !== meterModel) {
        return `model ${parsed.model} is not meterable on this lane; use ${meterModel}`;
      }
    } catch {
      return "request body must be JSON";
    }
  }
  return null;
}

/** Gate a proxy call BEFORE forwarding: status + credits (the $0 hard stop). */
export function gateProxyCall(
  db: DB,
  agentId: string,
  inStarvationSession: boolean,
  inFinalJournal = false
): void {
  const agent = db.prepare(`SELECT status FROM agents WHERE id = ?`).get(agentId) as
    | { status: string }
    | undefined;
  if (!agent) throw new ProxyDeniedError("dead", "unknown agent");
  // The funeral exemption: a final-journal session runs for dead or frozen agents,
  // on the operator's dime, so last words never depend on a balance.
  if (inFinalJournal) return;
  if (agent.status === "dead") throw new ProxyDeniedError("dead", "agent is dead");
  if (agent.status === "frozen") throw new ProxyDeniedError("frozen", "world is frozen");
  if (agent.status === "paused") throw new ProxyDeniedError("paused", "agent paused (alarm)");

  const credits = balance(db, acct.credits(agentId));
  if (credits <= 0) {
    if (!inStarvationSession) {
      throw new ProxyDeniedError("starved", "credits exhausted — starvation wake only");
    }
    if (credits <= OVERDRAFT_FLOOR) {
      throw new ProxyDeniedError("starved", "overdraft floor reached — the world stops paying");
    }
  }
}

/** Extract usage from a provider response body. Unknown shape = bill nothing, flag loudly. */
export function extractUsage(provider: Provider, body: any): Usage | null {
  try {
    if (provider === "anthropic" && body?.usage) {
      return {
        inputTokens: body.usage.input_tokens ?? 0,
        outputTokens: body.usage.output_tokens ?? 0,
        cacheReadTokens: body.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: body.usage.cache_creation_input_tokens ?? 0,
      };
    }
    if (provider === "openai" && body?.usage) {
      const u = body.usage;
      // Two shapes: Responses API (input_tokens/output_tokens/input_tokens_details)
      // and Chat Completions (prompt_tokens/completion_tokens/prompt_tokens_details).
      const prompt = u.input_tokens ?? u.prompt_tokens ?? 0;
      const out = u.output_tokens ?? u.completion_tokens ?? 0;
      const cached =
        u.input_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
      return {
        inputTokens: Math.max(0, prompt - cached),
        outputTokens: out,
        cacheReadTokens: cached,
        cacheWriteTokens: 0,
        promptTokens: prompt, // drives the >272K Astra long-context tier
      };
    }
    if (provider === "google" && body?.usageMetadata) {
      const um = body.usageMetadata;
      const cached = um.cachedContentTokenCount ?? 0;
      const prompt = um.promptTokenCount ?? 0;
      return {
        inputTokens: Math.max(0, prompt - cached),
        outputTokens: (um.candidatesTokenCount ?? 0) + (um.thoughtsTokenCount ?? 0),
        cacheReadTokens: cached,
        cacheWriteTokens: 0,
        promptTokens: prompt,
      };
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Forward one call upstream, meter from the response. Returns the upstream response
 * body + status verbatim (the runtime SDK parses it as if it spoke to the provider).
 */
export async function proxyCall(
  db: DB,
  agentId: string,
  path: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  opts: {
    inStarvationSession: boolean;
    inFinalJournal?: boolean;
    sessionId?: number;
    fetchImpl?: typeof fetch;
    onUnmeterable?: (detail: string) => void;
  }
): Promise<{ status: number; body: string; cost: number }> {
  const cfg = PROVIDERS[agentId];
  if (!cfg) throw new ProxyDeniedError("dead", `no provider config for ${agentId}`);
  const invalid = validateProxyRequest(cfg, path, body);
  if (invalid) throw new ProxyDeniedError("paused", invalid);
  gateProxyCall(db, agentId, opts.inStarvationSession, opts.inFinalJournal ?? false);
  if (opts.inFinalJournal && opts.sessionId) {
    // The funeral is generous, not infinite (V3): enforce the ceiling.
    const used = (
      db
        .prepare(
          `SELECT COALESCE(SUM(
             json_extract(payload,'$.inputTokens') + json_extract(payload,'$.outputTokens')
           ), 0) AS t FROM events
           WHERE subtype = 'spend:final_journal' AND json_extract(payload,'$.sessionId') = ?`
        )
        .get(opts.sessionId) as { t: number }
    ).t;
    if (used >= FINAL_JOURNAL_TOKEN_CEILING) {
      db.prepare(`UPDATE sessions SET ended_ts = ? WHERE id = ? AND ended_ts IS NULL`).run(
        new Date().toISOString(),
        opts.sessionId
      );
      throw new ProxyDeniedError("dead", "final journal token ceiling reached — rest now");
    }
  }

  const key = process.env[cfg.apiKeyEnv];
  const fwdHeaders: Record<string, string> = {
    "content-type": headers["content-type"] ?? "application/json",
  };
  if (cfg.provider === "anthropic") {
    fwdHeaders["x-api-key"] = key ?? "";
    fwdHeaders["anthropic-version"] = headers["anthropic-version"] ?? "2023-06-01";
  } else if (cfg.provider === "openai") {
    fwdHeaders["authorization"] = `Bearer ${key ?? ""}`;
  } else {
    fwdHeaders["x-goog-api-key"] = key ?? "";
  }

  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(`${cfg.upstream}${path}`, {
    method,
    headers: fwdHeaders,
    body,
  });
  const text = await res.text();

  let cost = 0;
  if (res.ok) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* non-JSON success — unmeterable */
    }
    const usage = parsed ? extractUsage(cfg.provider, parsed) : null;
    if (usage && opts.inFinalJournal) {
      // Funeral tokens are the operator's cost, on the record but never billed.
      appendEvent(db, {
        agentId,
        type: "spend",
        subtype: "spend:final_journal",
        payload: { model: cfg.meterModel, ...usage, sessionId: opts.sessionId ?? null },
        postings: [],
      });
    } else if (usage) {
      cost = meterApiCall(db, agentId, cfg.meterModel, usage, opts.sessionId).cost;
    } else {
      // A successful call we cannot meter is a billing hole. Fail closed on the
      // money, not on the agent's life (audit 2026-09-24; V1 paused it until the
      // operator noticed, which turned a provider quirk into an outage): bill a
      // conservative estimate — three bytes a token, both directions, at the
      // lane's price — record it as such, and alarm the operator.
      const estimate: Usage = {
        inputTokens: Math.ceil(Buffer.byteLength(body ?? "", "utf8") / 3),
        outputTokens: Math.ceil(Buffer.byteLength(text, "utf8") / 3),
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      cost = opts.inFinalJournal ? 0 : meterApiCall(db, agentId, cfg.meterModel, estimate, opts.sessionId).cost;
      appendEvent(db, {
        agentId,
        type: "alarm",
        subtype: "unmeterable_response",
        payload: { path, provider: cfg.provider, estimated: estimate, costMicro: cost },
        postings: [],
      });
      opts.onUnmeterable?.(`unmeterable ${cfg.provider} response on ${path} — ${agentId} billed an estimate of $${(cost / 1e6).toFixed(4)}`);
    }
  }
  return { status: res.status, body: text, cost };
}
