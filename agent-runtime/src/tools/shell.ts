import { exec } from "node:child_process";

const MAX_OUTPUT = 30_000;

/**
 * Full shell on the agent's own VM (constitution §1). No allowlist by design —
 * the VM is the agent's; blast radius is the VM. Timeout guards the session loop,
 * not the agent's freedom: long jobs belong in nohup/tmux, which the agent can use.
 */
export function runShell(command: string, timeoutMs = 120_000, cwd?: string): Promise<string> {
  return new Promise((resolve) => {
    exec(
      command,
      { timeout: timeoutMs, cwd, maxBuffer: 10 * 1024 * 1024, shell: "/bin/bash" },
      (err, stdout, stderr) => {
        let out = "";
        if (stdout) out += stdout;
        if (stderr) out += (out ? "\n--- stderr ---\n" : "") + stderr;
        if (err && !err.killed) out += `\n--- exit: ${err.code ?? "signal"} ---`;
        if (err?.killed) out += `\n--- killed: timeout after ${timeoutMs}ms (use nohup/tmux for long jobs) ---`;
        if (out.length > MAX_OUTPUT) {
          out = out.slice(0, MAX_OUTPUT) + `\n--- truncated at ${MAX_OUTPUT} chars ---`;
        }
        resolve(out || "(no output)");
      }
    );
  });
}
