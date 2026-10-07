import { FunctionCallingConfigMode, GoogleGenAI, type Content } from "@google/genai";
import type { ChatResponse, ProviderAdapter, ToolDef, Turn } from "../types.js";

/**
 * Gemini adapter. Model id pinned at Day 0 (pinned: gemini-3.1-pro-preview).
 * VERIFY-AT-REHEARSAL: exact model id, usageMetadata field names, long-context tier.
 */
export class GoogleAdapter implements ProviderAdapter {
  private client: GoogleGenAI;
  /**
   * Raw Content history, kept verbatim across calls in this session. Gemini 3.1
   * attaches a thoughtSignature to functionCall parts and 400s if it is missing
   * on replay — so the model's own content objects are echoed back untouched
   * instead of being rebuilt from the lossy Turn structs.
   */
  private history: Content[] = [];
  /** How many session turns are already reflected in `history`. */
  private turnsSeen = 0;

  constructor(public readonly model: string = "gemini-3.1-pro-preview") {
    // Proxied via the control plane; bearer token in an explicit header since the
    // genai SDK's own auth header (x-goog-api-key) is overwritten by the proxy.
    const proxy = process.env.C67_PROXY_URL;
    this.client = new GoogleGenAI(
      proxy
        ? {
            apiKey: "proxied",
            httpOptions: {
              baseUrl: `${proxy}/proxy/${process.env.C67_AGENT_ID ?? "gemini"}`,
              headers: { authorization: `Bearer ${process.env.C67_AGENT_TOKEN ?? ""}` },
            },
          }
        : {}
    );
  }

  async chat(system: string, turns: Turn[], tools: ToolDef[]): Promise<ChatResponse> {
    if (this.turnsSeen > turns.length) {
      // Session history shrank (should never happen) — rebuild rather than
      // replay a mismatched transcript. Loses signatures; first call is safe.
      this.history = [];
      this.turnsSeen = 0;
    }
    for (const t of turns.slice(this.turnsSeen)) {
      if (t.role === "user") {
        this.history.push({ role: "user", parts: [{ text: t.text }] });
      } else if (t.role === "tool_results") {
        this.history.push({
          role: "user",
          parts: t.results.map((r) => ({
            functionResponse: {
              name: r.toolCallId.split("::")[0] ?? "tool",
              response: { output: r.content, isError: r.isError ?? false },
            },
          })),
        });
      }
      // assistant turns: already in `history` verbatim from the model's output.
    }
    this.turnsSeen = turns.length;

    const resp = await this.client.models.generateContent({
      model: this.model,
      contents: this.history,
      config: {
        systemInstruction: system,
        tools: [
          {
            functionDeclarations: tools.map((t) => ({
              name: t.name,
              description: t.description,
              parametersJsonSchema: t.inputSchema,
            })),
          },
        ],
        toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
      },
    });

    // Echo the model's raw content (thoughtSignature intact) into the next
    // call's history, and account for the assistant turn the session will push.
    const modelContent = resp.candidates?.[0]?.content;
    if (modelContent) this.history.push(modelContent);
    this.turnsSeen += 1;

    const parts = modelContent?.parts ?? [];
    let i = 0;
    const toolCalls = parts
      .filter((p) => p.functionCall)
      .map((p) => ({
        // Gemini has no call ids; synthesize name::index so results can be mapped back
        id: `${p.functionCall!.name}::${i++}`,
        name: p.functionCall!.name ?? "unknown",
        input: (p.functionCall!.args ?? {}) as Record<string, unknown>,
      }));
    const text = parts.filter((p) => p.text).map((p) => p.text).join("\n");

    const um = resp.usageMetadata;
    const cached = um?.cachedContentTokenCount ?? 0;
    const prompt = um?.promptTokenCount ?? 0;
    return {
      text,
      toolCalls,
      stopReason: resp.candidates?.[0]?.finishReason ?? "STOP",
      usage: {
        inputTokens: Math.max(0, prompt - cached),
        outputTokens: (um?.candidatesTokenCount ?? 0) + (um?.thoughtsTokenCount ?? 0),
        cacheReadTokens: cached,
        cacheWriteTokens: 0,
        promptTokens: prompt,
      },
    };
  }
}
