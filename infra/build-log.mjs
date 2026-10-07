#!/usr/bin/env node
// Build site/log/index.json from site/log/*.md front matter (title, date, teaser).
// Newest first. No dependencies; run by deploy-site.sh.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "site", "log");
const posts = [];
for (const f of readdirSync(dir)) {
  if (!f.endsWith(".md")) continue;
  const md = readFileSync(join(dir, f), "utf8");
  const m = /^---\n([\s\S]*?)\n---/.exec(md);
  const fm = {};
  if (m) for (const line of m[1].split("\n")) { const i = line.indexOf(":"); if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"|"$/g, ""); }
  const slug = f.replace(/\.md$/, "");
  if (fm.draft === "true" && !process.env.INCLUDE_DRAFTS) continue;
  posts.push({ slug, title: fm.title || slug, date: fm.date || slug.slice(0, 10), teaser: fm.teaser || "" });
}
posts.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
writeFileSync(join(dir, "index.json"), JSON.stringify(posts, null, 1) + "\n");
console.log(`log index: ${posts.length} post(s)`);
