import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type DB = Database.Database;

const HERE = dirname(fileURLToPath(import.meta.url));

export function openDb(path: string = process.env.C67_DB ?? "data/ledger.db"): DB {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const schema = readFileSync(join(HERE, "schema.sql"), "utf8");
  db.exec(schema);
  migrate(db);
  return db;
}

/**
 * Additive migrations for a live world. schema.sql only CREATEs, so columns
 * added after Day 0 of a running ledger land here: idempotent ALTERs guarded
 * by pragma table_info. Never drops, never rewrites rows.
 */
const AGENT_COLUMNS: [string, string][] = [
  ["portrait", "TEXT"], // JSON sprite sheet drawn by the agent (draw_self)
  ["storefront_url", "TEXT"], // the agent's own public site (set_storefront)
];

function migrate(db: DB): void {
  const have = new Set(
    (db.pragma("table_info(agents)") as { name: string }[]).map((c) => c.name)
  );
  for (const [col, type] of AGENT_COLUMNS) {
    if (!have.has(col)) db.exec(`ALTER TABLE agents ADD COLUMN ${col} ${type}`);
  }
}

export function nowUtc(): string {
  return new Date().toISOString();
}

/** Micro-dollar helpers. 1 USD = 1_000_000 micro. */
export const USD = 1_000_000;
export function usd(n: number): number {
  return Math.round(n * USD);
}
export function fmtUsd(micro: number): string {
  return (micro / USD).toFixed(2);
}
