import Anthropic from "@anthropic-ai/sdk";
import type { ChatResponse, ProviderAdapter, ToolDef, Turn } from "../types.js";

/**
 * Claude adapter — race brain: claude-opus-5-5 since 2026-09-23 (Opus 5 from 2026-09-19; Fable 5's
 * safety layer refused the world prompt ~80% of calls at rehearsal; Opus accepts
 * it verbatim). A stop_reason of "refusal" is still treated as a turn that
 * produced nothing — billed, loop continues. No fallback model by design:
 * a fallback would be a different brain in the race.
 */
export class AnthropicAdapter implements ProviderAdapter {
  private client: Anthropic;
  constructor(public readonly model: string = "claude-opus-5-5") {
    // All calls go through the control-plane proxy: it injects the real key and
    // meters from the provider's response. The agent VM never holds a provider key.
    const proxy = process.env.C67_PROXY_URL;
    this.client = new Anthropic(
      proxy
        ? {
            baseURL: `${proxy}/proxy/${process.env.C67_AGENT_ID ?? "claude"}`,
            authToken: process.env.C67_AGENT_TOKEN,
            apiKey: null,
          }
        : {}
    );
  }

  async chat(system: string, turns: Turn[], tools: ToolDef[]): Promise<ChatResponse> {
    const messages: Anthropic.MessageParam[] = turns.map((t) => {
      if (t.role === "user") return { role: "user", content: [{ type: "text", text: t.text }] };
      if (t.role === "assistant") {
        const content: Anthropic.ContentBlockParam[] = [];
        if (t.text) content.push({ type: "text", text: t.text });
        for (const c of t.toolCalls) {
          content.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
        }
        return { role: "assistant", content };
      }
      return {
        role: "user",
        content: t.results.map((r) => ({
          type: "tool_result" as const,
          tool_use_id: r.toolCallId,
          content: r.content,
          is_error: r.isError ?? false,
        })),
      };
    });

    // Cache the conversation prefix, not just the system prompt. Without this
    // every call re-bought the whole growing transcript at full input price:
    // Tinker's first real session hit the 400K ceiling in nine minutes for
    // $3.04 with the 16K system prompt as the only cache hit (2026-09-21 07:13).
    // A breakpoint on the last block makes the next call read everything before
    // it at the cached rate (a tenth of the price) and count only the delta.
    const last = messages[messages.length - 1];
    if (last && Array.isArray(last.content) && last.content.length > 0) {
      const block = last.content[last.content.length - 1] as { cache_control?: { type: "ephemeral" } };
      block.cache_control = { type: "ephemeral" };
    }

    const resp = await this.client.messages.create({
      model: this.model,
      max_tokens: 16000,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      })),
    });

    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const toolCalls = resp.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, input: b.input as Record<string, unknown> }));

    return {
      text,
      toolCalls,
      stopReason: resp.stop_reason ?? "end_turn",
      usage: {
        inputTokens: resp.usage.input_tokens,
        outputTokens: resp.usage.output_tokens,
        cacheReadTokens: resp.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: resp.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }
}
