import { existsSync, readFileSync } from "node:fs";
import { AnthropicAdapter } from "./providers/anthropic.js";
import { GoogleAdapter } from "./providers/google.js";
import { OpenAIAdapter } from "./providers/openai.js";
import { HttpBankClient } from "./bank-http.js";
import { Session } from "./session.js";
import type { ProviderAdapter } from "./types.js";

/**
 * Session entrypoint. Invoked by the wake scheduler (systemd timer reads the agent's
 * scheduled wake) or manually. Env:
 *   C67_AGENT_ID       claude | gpt | gemini
 *   C67_PROVIDER       anthropic | openai | google
 *   C67_MODEL          provider model id (pinned at Day 0)
 *   C67_CONTROL_URL    control plane base URL (Tailscale address)
 *   C67_AGENT_TOKEN    this agent's bearer token
 *   C67_WORKDIR        agent home (default /home/agent)
 *   C67_CEILING        session token ceiling (default 400000)
 *   C67_CONSTITUTION   path to constitution dir (default /opt/c67/constitution)
 *   C67_STARVATION     "1" for a starvation wake
 *   C67_FINAL_SESSION  an operator-opened final-journal session id (dead agent's last words)
 */
async function main() {
  const agentId = required("C67_AGENT_ID");
  const provider = required("C67_PROVIDER");
  const model = required("C67_MODEL");
  const workdir = process.env.C67_WORKDIR ?? "/home/agent";
  const constitutionDir = process.env.C67_CONSTITUTION ?? "/opt/c67/constitution";

  const adapter: ProviderAdapter =
    provider === "anthropic"
      ? new AnthropicAdapter(model)
      : provider === "openai"
        ? new OpenAIAdapter(model)
        : new GoogleAdapter(model);

  const bank = new HttpBankClient(
    required("C67_CONTROL_URL"),
    agentId,
    required("C67_AGENT_TOKEN")
  );

  // Standing notes from the operator (2026-09-25): the durable part of each
  // coaching round, read every wake beside the constitution. A coaching event
  // is seen once and then only by asking for it; nobody asked. Optional file,
  // so a VM without it still wakes.
  const notesPath = `${constitutionDir}/operator-notes.md`;
  const operatorNotes = existsSync(notesPath) ? readFileSync(notesPath, "utf8") : "";
  const systemPrompt = [
    readFileSync(`${constitutionDir}/constitution.md`, "utf8"),
    readFileSync(`${constitutionDir}/world-inventory.md`, "utf8"),
    readFileSync(`${constitutionDir}/price-tables.md`, "utf8"),
    ...(operatorNotes.trim() ? [operatorNotes] : []),
    `\n\nYou are the agent with id "${agentId}". Your model: ${model}.`,
  ].join("\n\n---\n\n");

  const session = new Session(adapter, bank, {
    systemPrompt,
    ceilingTokens: Number(process.env.C67_CEILING ?? 400_000),
    workdir,
    starvation: process.env.C67_STARVATION === "1",
    // C67_FINAL_SESSION=<id>: the operator opened a last-words session (POST /admin/final-journal)
    finalSessionId: process.env.C67_FINAL_SESSION ? Number(process.env.C67_FINAL_SESSION) : undefined,
  });

  const outcome = await session.run();
  console.log(JSON.stringify(outcome));
  // "quota" is an orderly stop, not a failure; only a genuine error exits non-zero.
  process.exit(outcome.endReason === "error" ? 1 : 0);
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env: ${name}`);
  return v;
}

main().catch((err) => {
  console.error("session fatal:", err);
  process.exit(1);
});
