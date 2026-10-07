import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Bearer-token auth. One token per agent (scopes to that agent's own resources only),
 * one admin token (operator). Tokens live in env / a file OUTSIDE the repo:
 *   C67_TOKEN_CLAUDE, C67_TOKEN_GPT, C67_TOKEN_GEMINI, C67_TOKEN_ADMIN, C67_TOKEN_REDDIT
 * Rotation = restart with new env (kill switch rotates by wiping the map).
 */
export class Auth {
  private tokens = new Map<string, string>(); // token -> principal ("agent:<id>" | "admin")
  private revoked = false;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    for (const [envKey, principal] of [
      ["C67_TOKEN_CLAUDE", "agent:claude"],
      ["C67_TOKEN_GPT", "agent:gpt"],
      ["C67_TOKEN_GEMINI", "agent:gemini"],
      ["C67_TOKEN_ADMIN", "admin"],
      // The operator's Reddit pull engine (a Devvit app) posts leads with this one.
      // It can do exactly one thing: POST /reddit/leads. See reddit.ts.
      ["C67_TOKEN_REDDIT", "reddit"],
    ] as const) {
      const t = env[envKey];
      if (t) this.tokens.set(t, principal);
    }
  }

  static generateToken(): string {
    return randomBytes(32).toString("hex");
  }

  /** /rotate_admin: the old admin key dies in memory now; the env file is rewritten by the caller. */
  setAdminToken(token: string): void {
    for (const [t, p] of this.tokens) if (p === "admin") this.tokens.delete(t);
    this.tokens.set(token, "admin");
  }

  /** Kill switch: every token dies instantly; only process restart restores access. */
  revokeAll(): void {
    this.revoked = true;
    this.tokens.clear();
  }

  principal(authHeader: string | undefined): string | null {
    if (this.revoked || !authHeader?.startsWith("Bearer ")) return null;
    const presented = authHeader.slice(7);
    for (const [token, principal] of this.tokens) {
      const a = Buffer.from(presented);
      const b = Buffer.from(token);
      if (a.length === b.length && timingSafeEqual(a, b)) return principal;
    }
    return null;
  }

  /** agent tokens may act only as themselves; admin may act as anyone */
  authorizeAgent(principal: string | null, agentId: string): boolean {
    return principal === `agent:${agentId}` || principal === "admin";
  }
}
