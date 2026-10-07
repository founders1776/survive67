import type { DB } from "./db.js";
import { ingestLeads, type LeadInput } from "./reddit.js";

/**
 * Discord relay for Reddit leads (2026-09-26). Reddit rejected the fetch
 * domain api.survive67.com for the Devvit app, but discord.com is on Reddit's
 * global fetch allowlist. So the app posts each lead batch to a Discord
 * webhook as embeds (one lead per embed, the lead as JSON in the description),
 * and the control plane polls that channel every five minutes with a bot token
 * and ingests exactly as the direct route does. Idempotent: the last message
 * id seen is kept in config; ingestLeads ignores duplicate reddit ids anyway.
 */

export interface DiscordConfig {
  botToken: string;
  channelId: string;
}

export function discordConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DiscordConfig | null {
  const botToken = env.C67_DISCORD_BOT_TOKEN ?? "";
  const channelId = env.C67_DISCORD_LEADS_CHANNEL ?? "";
  return botToken && channelId ? { botToken, channelId } : null;
}

const AFTER_KEY = "discord_leads_after";

interface DiscordMessage {
  id: string;
  embeds?: { description?: string }[];
}

/** Snowflakes are 64-bit; compare as BigInt, never as strings. */
function maxId(a: string | null, b: string): string {
  if (!a) return b;
  return BigInt(b) > BigInt(a) ? b : a;
}

export async function pollDiscordLeads(
  db: DB,
  cfg: DiscordConfig,
  fetchImpl: typeof fetch = fetch
): Promise<{ messages: number; leads: number; inserted: number; skipped: number }> {
  const after = (db.prepare(`SELECT value FROM config WHERE key = ?`).get(AFTER_KEY) as { value: string } | undefined)?.value ?? null;
  const url = new URL(`https://discord.com/api/v10/channels/${cfg.channelId}/messages`);
  url.searchParams.set("limit", "100");
  if (after) url.searchParams.set("after", after);
  const res = await fetchImpl(url.toString(), { headers: { authorization: `Bot ${cfg.botToken}` } });
  if (!res.ok) throw new Error(`discord ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const messages = (await res.json()) as DiscordMessage[];
  if (!Array.isArray(messages) || messages.length === 0) return { messages: 0, leads: 0, inserted: 0, skipped: 0 };
  const leads: LeadInput[] = [];
  let newest: string | null = after;
  for (const m of messages) {
    newest = maxId(newest, m.id);
    for (const e of m.embeds ?? []) {
      if (!e.description) continue;
      try {
        const lead = JSON.parse(e.description) as LeadInput;
        if (lead && typeof lead === "object" && lead.id && lead.subreddit && lead.title) leads.push(lead);
      } catch {
        /* not one of ours */
      }
    }
  }
  let inserted = 0;
  let skipped = 0;
  for (let i = 0; i < leads.length; i += 100) {
    const r = ingestLeads(db, leads.slice(i, i + 100));
    inserted += r.inserted;
    skipped += r.skipped;
  }
  if (newest) db.prepare(`INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)`).run(AFTER_KEY, newest);
  return { messages: messages.length, leads: leads.length, inserted, skipped };
}
