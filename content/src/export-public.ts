import Database from "better-sqlite3";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scrub } from "./scrub.js";
import { flagMoments, type EventRow } from "./flagger.js";

/**
 * Post-run exporter: private ledger → public story dataset (plan Data Q12:
 * full ledger PII-scrubbed + all journals + flags + verdicts).
 *   C67_DB=... C67_SCRUB_SALT=... tsx src/export-public.ts [outDir]
 */
function main() {
  const dbPath = process.env.C67_DB ?? "../control-plane/data/ledger.db";
  const salt = process.env.C67_SCRUB_SALT ?? "";
  if (!salt) throw new Error("C67_SCRUB_SALT required");
  const outDir = process.argv[2] ?? "../site/seasons/export";
  const db = new Database(dbPath, { readonly: true });
  const s = (t: unknown) => scrub(String(t ?? ""), salt);

  const agents = db
    .prepare(`SELECT id, name, model, emoji, color, status FROM agents`)
    .all();

  const events = (db
    .prepare(
      `SELECT e.id, e.ts, e.agent_id, e.type, e.subtype, e.payload, e.external_ref,
              json_group_array(json_object('account', p.account, 'delta', p.delta)) AS postings
       FROM events e LEFT JOIN postings p ON p.event_id = e.id
       GROUP BY e.id ORDER BY e.id`
    )
    .all() as any[]).map((e) => ({
    ...e,
    payload: s(e.payload),
    external_ref: e.external_ref ? "ref_" + String(e.external_ref).slice(-6) : null,
    postings: JSON.parse(e.postings),
  }));

  const journals = (db
    .prepare(`SELECT agent_id, ts, plan, money_mood, status_line, prose FROM journals ORDER BY id`)
    .all() as any[]).map((j) => ({
    ...j,
    prose: s(j.prose),
    plan: s(j.plan),
    // Every free-text journal field is agent-authored and may quote customer
    // mail — all of it goes through the scrubber (security review V5).
    money_mood: s(j.money_mood),
    status_line: s(j.status_line),
  }));

  const verdicts = (db
    .prepare(`SELECT ts, ruling, text FROM verdicts ORDER BY id`)
    .all() as any[]).map((v) => ({ ...v, text: s(v.text) }));

  const rawEvents = db
    .prepare(`SELECT id, ts, agent_id, type, subtype, payload FROM events ORDER BY id`)
    .all() as EventRow[];
  const flags = flagMoments(rawEvents, new Set()).map((f) => ({ ...f, headline: s(f.headline) }));

  const daily = db
    .prepare(
      `SELECT substr(e.ts,1,10) AS day,
              substr(p.account, 7, instr(substr(p.account,7), ':') - 1) AS agent,
              SUM(p.delta) AS delta
       FROM postings p JOIN events e ON e.id = p.event_id
       WHERE p.account LIKE 'agent:%'
       GROUP BY day, agent ORDER BY day`
    )
    .all();

  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, "story.json"),
    JSON.stringify({ generated: new Date().toISOString(), agents, daily, journals, flags, verdicts, events }, null, 1)
  );
  console.log(`exported ${events.length} events, ${journals.length} journals → ${outDir}/story.json`);
}

main();
