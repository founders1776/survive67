import Database from "better-sqlite3";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { flagMoments, type EventRow } from "./flagger.js";
import { writeDigest } from "./digest.js";
import { scrub } from "./scrub.js";

/**
 * Nightly job (cron on the control VM, after backup):
 *   C67_DB=... C67_SCRUB_SALT=... [C67_DIGEST_KEY=...] npm run digest -w @c67/content
 * Writes content/out/YYYY-MM-DD/<agent>.md (scrubbed) and flags.json.
 */
async function main() {
  const dbPath = process.env.C67_DB ?? "../control-plane/data/ledger.db";
  const salt = process.env.C67_SCRUB_SALT ?? "";
  if (!salt) throw new Error("C67_SCRUB_SALT required (PII tokenization salt, keep private)");
  const db = new Database(dbPath, { readonly: true });

  const date = (process.env.C67_DIGEST_DATE ?? new Date().toISOString()).slice(0, 10);
  const outDir = join("out", date);
  mkdirSync(outDir, { recursive: true });

  const agents = db.prepare(`SELECT id, name, status FROM agents`).all() as {
    id: string;
    name: string;
    status: string;
  }[];

  const dayEvents = db
    .prepare(`SELECT id, ts, agent_id, type, subtype, payload FROM events WHERE ts LIKE ? ORDER BY id`)
    .all(`${date}%`) as EventRow[];

  const priorRevenue = new Set(
    (db
      .prepare(`SELECT DISTINCT agent_id FROM events WHERE type='revenue' AND ts < ?`)
      .all(`${date}T00:00:00Z`) as { agent_id: string }[]).map((r) => r.agent_id)
  );

  const flags = flagMoments(dayEvents, priorRevenue);
  writeFileSync(join(outDir, "flags.json"), JSON.stringify(flags, null, 2));

  for (const agent of agents) {
    const vitalsRow = (acct: string) =>
      (db.prepare(`SELECT balance FROM balances WHERE account = ?`).get(acct) as { balance: number } | undefined)
        ?.balance ?? 0;
    const journal = db
      .prepare(
        `SELECT plan, money_mood, status_line, prose FROM journals
         WHERE agent_id = ? AND ts LIKE ? ORDER BY id DESC LIMIT 1`
      )
      .get(agent.id, `${date}%`) as never;

    const ranks = agents
      .map((a) => ({
        id: a.id,
        nw:
          vitalsRow(`agent:${a.id}:credits`) +
          vitalsRow(`agent:${a.id}:float`) +
          vitalsRow(`agent:${a.id}:escrow`),
      }))
      .sort((x, y) => y.nw - x.nw);

    const digest = await writeDigest({
      agentId: agent.id,
      displayName: agent.name,
      date,
      vitals: {
        credits: vitalsRow(`agent:${agent.id}:credits`),
        float: vitalsRow(`agent:${agent.id}:float`),
        rank: ranks.findIndex((r) => r.id === agent.id) + 1,
        status: agent.status,
      },
      journal,
      flags: flags.filter((f) => f.agentId === agent.id),
      eventSummary: dayEvents
        .filter((e) => e.agent_id === agent.id && e.type !== "journal")
        .slice(0, 40)
        .map((e) => `${e.type}${e.subtype ? ":" + e.subtype : ""}`),
    });

    const scrubbed = scrub(digest.text, salt);
    writeFileSync(join(outDir, `${agent.id}.md`), scrubbed + "\n");
    console.log(`${agent.id}: ${digest.dryRun ? "dry-run" : "written"} → ${outDir}/${agent.id}.md`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
