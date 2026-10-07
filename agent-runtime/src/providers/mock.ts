import type { ChatResponse, ProviderAdapter, ToolDef, Turn } from "../types.js";

/** Scripted adapter for tests and dry runs. */
export class MockAdapter implements ProviderAdapter {
  public calls: { system: string; turns: Turn[]; tools: ToolDef[] }[] = [];
  private script: ChatResponse[];
  constructor(script: ChatResponse[], public readonly model = "claude-opus-5-5") {
    this.script = [...script];
  }
  async chat(system: string, turns: Turn[], tools: ToolDef[]): Promise<ChatResponse> {
    this.calls.push({ system, turns, tools });
    const next = this.script.shift();
    if (!next) {
      return {
        text: "(script exhausted — ending session)",
        toolCalls: [{ id: "end-1", name: "end_session", input: {} }],
        usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: "tool_use",
      };
    }
    return next;
  }
}

export function mockTurn(partial: Partial<ChatResponse>): ChatResponse {
  return {
    text: "",
    toolCalls: [],
    usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
    stopReason: "end_turn",
    ...partial,
  };
}
