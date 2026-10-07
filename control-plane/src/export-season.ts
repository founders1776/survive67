import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "./db.js";
import { createPublic } from "./public.js";

/**
 * Freeze a season for replay: the same five documents the live site polls,
 * written as static JSON so survive67.com/?season=<n> shows the old world
 * from files. Run against the archived ledger BEFORE the Day-0 wipe.
 *
 *   npx tsx src/export-season.ts <ledger.db> <season> [site dir]
 *   -> <site>/seasons/<season>/{state,journals,board,law,history}.json
 */
const [dbPath, season, siteDir = join(process.cwd(), "..", "site")] = process.argv.slice(2);
if (!dbPath || !season) {
  console.error("usage: export-season <ledger.db> <season> [site dir]");
  process.exit(2);
}
const db = openDb(dbPath);
const pub = createPublic(db, { ttlMs: 0 });
const out = join(siteDir, "seasons", season);
mkdirSync(out, { recursive: true });
const docs: Record<string, unknown> = {
  state: pub.state(),
  journals: pub.journals(500),
  board: pub.board(500),
  law: pub.law(),
  history: pub.history(),
};
docs.corrections = pub.corrections();
for (const [name, value] of Object.entries(docs)) {
  writeFileSync(join(out, `${name}.json`), JSON.stringify(value));
}
// The replay's event rows open too: one file per feed event.
mkdirSync(join(out, "event"), { recursive: true });
let n = 0;
for (const f of (docs.state as { feed: { id: number }[] }).feed) {
  const ev = pub.event(f.id);
  if (ev) {
    writeFileSync(join(out, "event", `${f.id}.json`), JSON.stringify(ev));
    n++;
  }
}
console.log(`${n} event detail files`);
console.log(`season ${season} exported to ${out}: ${Object.keys(docs).join(", ")}`);
