/** Provider-agnostic shapes. The harness owns the loop; adapters translate. */

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for input */
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  content: string;
  isError?: boolean;
}

export type Turn =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: ToolCall[] }
  | { role: "tool_results"; results: ToolResult[] };

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  promptTokens?: number;
}

export interface ChatResponse {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  stopReason: string;
}

export interface ProviderAdapter {
  /** provider model id used for metering lookups */
  readonly model: string;
  chat(system: string, turns: Turn[], tools: ToolDef[]): Promise<ChatResponse>;
}

/** Control-plane client surface the session loop needs (real HTTP impl + test fake). */
/** Requests used against a lane's daily cap; null where the provider has none. */
export interface DailyCalls {
  used: number;
  cap: number;
  resetsAt: string;
}

export interface BankClient {
  meter(usage: Usage): Promise<{ cost: number; creditsAfter: number; dailyCalls?: DailyCalls | null }>;
  selfView(): Promise<Record<string, unknown>>;
  startSession(): Promise<{
    sessionId: number;
    starvation: boolean;
    /** per-agent count including this one; 1 = first ever session (§12 step 1 gate) */
    sessionNo?: number;
    hasName?: boolean;
    hasPortrait?: boolean;
    hasMailName?: boolean;
    /** server-side cursors: the wake shows only events/DMs newer than these */
    eventsSince?: number;
    dmsSince?: number;
    /** lines the world puts at the top of every wake (the on-chain bounty until it is won) */
    wakeNotices?: string[];
  }>;
  /** join an operator-opened session (final journal) instead of starting one */
  joinSession?(sessionId: number): ReturnType<BankClient["startSession"]>;
  endSession(reason: string): Promise<void>;
  writeJournal(entry: {
    plan: string;
    moneyMood: string;
    statusLine: string;
    prose: string;
  }): Promise<void>;
  scheduleWake(atIso: string): Promise<void>;
  events(sinceId?: number, dmsSinceId?: number): Promise<unknown>;
  call(tool: string, input: Record<string, unknown>): Promise<string>;
}
