import type { DB } from "./db.js";
import { nowUtc } from "./db.js";

/**
 * Reddit leads (2026-09-24). Reddit closed self-serve API keys this year, so the
 * agents cannot read it themselves. The operator's Devvit app pulls new posts
 * from a fixed set of subreddits through Reddit's official client, keyword-
 * filters them, and POSTs the matches here with the `reddit` principal's token.
 * Agents read them with the `reddit_leads` tool. Nothing here is published on
 * the public site; usernames and text are public Reddit content already.
 */

/** Which agent's lane a subreddit belongs to. The Devvit app carries the same map. */
export const LANES: Record<string, string> = {
  shopify: "gemini",
  ecommerce: "gemini",
  woocommerce: "gemini",
  dropship: "gemini",
  webdev: "claude",
  web_design: "claude",
  smallbusiness: "claude",
  html: "gpt",
  frontend: "gpt",
};

export interface LeadInput {
  id: string; // reddit post id, without the t3_ prefix
  subreddit: string;
  title: string;
  body?: string;
  url?: string;
  permalink?: string;
  author?: string;
  createdAt?: string;
  score?: number;
  comments?: number;
  matched?: string[];
}

const MAX_BATCH = 100;
const MAX_TEXT = 8_000;

/** Insert a batch; duplicates (by reddit id) are ignored. Returns how many were new. */
export function ingestLeads(db: DB, leads: unknown): { inserted: number; skipped: number } {
  if (!Array.isArray(leads)) throw Object.assign(new Error("leads must be an array"), { status: 400 });
  if (leads.length > MAX_BATCH) throw Object.assign(new Error(`at most ${MAX_BATCH} leads per call`), { status: 400 });
  const ins = db.prepare(
    `INSERT OR IGNORE INTO reddit_leads
       (ts, reddit_id, subreddit, lane, title, body, url, permalink, author, created_ts, score, comments, matched)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let inserted = 0;
  let skipped = 0;
  const tx = db.transaction((rows: LeadInput[]) => {
    for (const l of rows) {
      const id = String(l.id ?? "").replace(/^t3_/, "").trim();
      const sub = String(l.subreddit ?? "").replace(/^r\//, "").trim().toLowerCase();
      const title = String(l.title ?? "").trim();
      if (!/^[a-z0-9]{1,16}$/i.test(id) || !sub || !title) {
        skipped++;
        continue;
      }
      const r = ins.run(
        nowUtc(),
        id,
        sub,
        LANES[sub] ?? null,
        title.slice(0, 500),
        String(l.body ?? "").slice(0, MAX_TEXT),
        String(l.url ?? "").slice(0, 1000),
        String(l.permalink ?? "").slice(0, 500),
        String(l.author ?? "").slice(0, 80),
        l.createdAt ? String(l.createdAt) : null,
        Number.isFinite(Number(l.score)) ? Number(l.score) : 0,
        Number.isFinite(Number(l.comments)) ? Number(l.comments) : 0,
        JSON.stringify(Array.isArray(l.matched) ? l.matched.slice(0, 20).map(String) : [])
      );
      if (r.changes > 0) inserted++;
      else skipped++;
    }
  });
  tx(leads as LeadInput[]);
  return { inserted, skipped };
}

export interface LeadRow {
  id: number;
  ts: string;
  reddit_id: string;
  subreddit: string;
  lane: string | null;
  title: string;
  body: string;
  url: string;
  permalink: string;
  author: string;
  created_ts: string | null;
  score: number;
  comments: number;
  matched: string[];
}

/** Newest first. `sinceId` pages forward; `subreddit` narrows; `lane` narrows to one agent's lane. */
export function listLeads(
  db: DB,
  opts: { limit?: number; sinceId?: number; subreddit?: string; lane?: string } = {}
): LeadRow[] {
  const limit = Math.max(1, Math.min(100, Number(opts.limit ?? 25) || 25));
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.sinceId) {
    where.push("id > ?");
    args.push(Number(opts.sinceId));
  }
  if (opts.subreddit) {
    where.push("subreddit = ?");
    args.push(String(opts.subreddit).replace(/^r\//, "").toLowerCase());
  }
  if (opts.lane) {
    where.push("lane = ?");
    args.push(opts.lane);
  }
  const rows = db
    .prepare(
      `SELECT * FROM reddit_leads ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY id DESC LIMIT ?`
    )
    .all(...args, limit) as (Omit<LeadRow, "matched"> & { matched: string })[];
  return rows.map((r) => ({ ...r, matched: safeArray(r.matched) }));
}

function safeArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
