import OpenAI from "openai";
import type { ChatResponse, ProviderAdapter, ToolDef, Turn } from "../types.js";

/**
 * GPT adapter — Responses API. Astra rejects function tools on chat/completions
 * unless reasoning is disabled ("use /v1/responses or set reasoning_effort to
 * 'none'"), and crippling the model's reasoning would rig the race. The proxy
 * allowlists /v1/responses and meters its usage shape (input_tokens/output_tokens).
 *
 * Stateless with reasoning: store:false + include reasoning.encrypted_content,
 * and every raw output item (reasoning, message, function_call) is echoed back
 * on the next call — a reasoning model requires its reasoning items to precede
 * their function_calls in the replayed input.
 */
export class OpenAIAdapter implements ProviderAdapter {
  private client: OpenAI;
  /** Raw Responses-format conversation, built up across calls in this session. */
  private items: OpenAI.Responses.ResponseInputItem[] = [];
  /** How many session turns are already reflected in `items`. */
  private turnsSeen = 0;

  constructor(public readonly model: string = "gpt-6-astra") {
    // Proxied via the control plane (key custody + metering there); the agent's
    // bearer token rides in the apiKey slot, which OpenAI sends as Authorization: Bearer.
    const proxy = process.env.C67_PROXY_URL;
    this.client = new OpenAI(
      proxy
        ? {
            baseURL: `${proxy}/proxy/${process.env.C67_AGENT_ID ?? "gpt"}/v1`,
            apiKey: process.env.C67_AGENT_TOKEN ?? "proxied",
          }
        : {}
    );
  }

  async chat(system: string, turns: Turn[], tools: ToolDef[]): Promise<ChatResponse> {
    if (this.turnsSeen > turns.length) {
      // Session history shrank (should never happen) — rebuild without reasoning
      // items rather than replaying a mismatched transcript.
      this.items = [];
      this.turnsSeen = 0;
    }
    for (const t of turns.slice(this.turnsSeen)) {
      if (t.role === "user") {
        this.items.push({ role: "user", content: t.text });
      } else if (t.role === "tool_results") {
        for (const r of t.results) {
          this.items.push({
            type: "function_call_output",
            call_id: r.toolCallId,
            output: r.content,
          });
        }
      }
      // assistant turns: already in `items` verbatim from the model's own output.
    }
    this.turnsSeen = turns.length;

    const resp = await this.client.responses.create({
      model: this.model,
      instructions: system,
      input: this.items,
      tools: tools.map((t) => ({
        type: "function" as const,
        name: t.name,
        description: t.description,
        parameters: t.inputSchema as Record<string, unknown>,
        strict: false,
      })),
      store: false,
      include: ["reasoning.encrypted_content"],
    });

    // Echo the model's raw output (reasoning + message + function_call items)
    // into the next call's input, and account for the assistant turn the
    // session will push after we return.
    this.items.push(...(resp.output as OpenAI.Responses.ResponseInputItem[]));
    this.turnsSeen += 1;

    const toolCalls = resp.output
      .filter((o): o is OpenAI.Responses.ResponseFunctionToolCall => o.type === "function_call")
      .map((c) => ({
        id: c.call_id,
        name: c.name,
        input: safeParse(c.arguments),
      }));

    const usage = resp.usage;
    const cached = usage?.input_tokens_details?.cached_tokens ?? 0;
    return {
      text: resp.output_text ?? "",
      toolCalls,
      stopReason:
        resp.status === "incomplete"
          ? resp.incomplete_details?.reason ?? "incomplete"
          : toolCalls.length
            ? "tool_use"
            : "stop",
      usage: {
        inputTokens: (usage?.input_tokens ?? 0) - cached,
        outputTokens: usage?.output_tokens ?? 0,
        cacheReadTokens: cached,
        cacheWriteTokens: 0,
      },
    };
  }
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s);
  } catch {
    return { __malformed: s };
  }
}
