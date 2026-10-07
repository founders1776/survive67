import type { BankClient, DailyCalls, Usage } from "./types.js";

/**
 * HTTP client for the control plane. Authenticated per-agent bearer token —
 * the token authorizes ONLY that agent's own scope; cross-agent reads 404 by design.
 */
export class HttpBankClient implements BankClient {
  private sessionId: number | null = null;

  constructor(
    private baseUrl: string,
    private agentId: string,
    private token: string
  ) {}

  private async req(path: string, body?: unknown): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`control-plane ${res.status}: ${text.slice(0, 300)}`);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async meter(usage: Usage) {
    // The proxy already metered and debited this call from the provider's own
    // response body (security V1: /meter is admin-only, self-reported usage is
    // not trusted). The session only needs the post-call balance for its
    // starvation stop — usage stays a parameter for the ceiling bookkeeping
    // and the test fake.
    void usage;
    const view = (await this.selfView()) as { credits?: number; dailyCalls?: DailyCalls | null };
    return {
      cost: 0,
      creditsAfter: Number(view.credits ?? 0),
      dailyCalls: view.dailyCalls ?? null,
    };
  }
  async selfView() {
    return this.req(`/agents/${this.agentId}/self-view`);
  }
  async startSession() {
    const r = await this.req(`/agents/${this.agentId}/sessions/start`, {});
    this.sessionId = r.sessionId;
    // The SERVER decides starvation from the live credit balance and grants the
    // one-time lifeline; the runtime must honor that verdict, not a stale env var.
    return {
      sessionId: r.sessionId as number,
      starvation: Boolean(r.starvation),
      sessionNo: typeof r.sessionNo === "number" ? r.sessionNo : undefined,
      hasName: Boolean(r.hasName),
      hasPortrait: Boolean(r.hasPortrait),
      hasMailName: Boolean(r.hasMailName),
      eventsSince: typeof r.eventsSince === "number" ? r.eventsSince : undefined,
      dmsSince: typeof r.dmsSince === "number" ? r.dmsSince : undefined,
      wakeNotices: Array.isArray(r.wakeNotices) ? (r.wakeNotices as unknown[]).map(String) : undefined,
    };
  }
  async joinSession(sessionId: number) {
    this.sessionId = sessionId;
    return { sessionId, starvation: false, sessionNo: 0 };
  }

  async endSession(reason: string) {
    await this.req(`/agents/${this.agentId}/sessions/end`, { sessionId: this.sessionId, reason });
  }
  async writeJournal(entry: { plan: string; moneyMood: string; statusLine: string; prose: string }) {
    await this.req(`/agents/${this.agentId}/journal`, { ...entry, sessionId: this.sessionId });
  }
  async scheduleWake(atIso: string) {
    await this.req(`/agents/${this.agentId}/schedule`, { at: atIso });
  }
  async events(sinceId = 0, dmsSinceId = 0) {
    return this.req(`/agents/${this.agentId}/events?since=${sinceId}&dms_since=${dmsSinceId}`);
  }
  async call(tool: string, input: Record<string, unknown>) {
    const r = await this.req(`/agents/${this.agentId}/tools/${tool}`, input);
    return typeof r === "string" ? r : JSON.stringify(r);
  }
}
