#!/usr/bin/env node
// Publish a scrubbed snapshot of this repo to github.com/founders1776/survive67.
//
// Never pushes private history: it exports the tree at one commit, strips what
// is operator-only, scans the result, and commits it as ONE new snapshot on top
// of the public repo, authored as "James" with the GitHub no-reply address.
// Any failed check stops it before the push and exits non-zero.
//
// Usage: node infra/publish-public.mjs [commit]      (default HEAD)
//        node infra/publish-public.mjs --dry-run     (everything except the push)
//
// Run automatically by .githooks/pre-push when main goes to origin.
// What must never be published lives in secrets/public-denylist.txt (private);
// every secret value in secrets/*.env is checked too.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_REPO = "founders1776/survive67";
const AUTHOR = { name: "James", email: "243432516+founders1776@users.noreply.github.com" };
const CHECKOUT = join(ROOT, "..", "survive67-public");
/** Paths that never leave the private repo. */
const EXCLUDE = ["NEEDS-JAMES.md", "runbook", ".claude", ".ultraplan", "secrets"];
/** Files scanned but allowed to contain matches (hashes, already-public replay data). */
const SCAN_SKIP = new Set(["package-lock.json", ".githooks/pre-commit"]);
const SCAN_SKIP_DIR = ["site/seasons/"];

const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const commit = args.find((a) => !a.startsWith("--")) ?? "HEAD";

const sh = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
const fail = (why) => {
  console.error(`\n✖ PUBLISH STOPPED: ${why}\n  Nothing was pushed to ${PUBLIC_REPO}.`);
  process.exit(1);
};

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    if (n === ".git") continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// ------------------------------------------------------------------ 1. export
const sha = sh("git", ["-C", ROOT, "rev-parse", "--short", commit]);
const work = mkdtempSync(join(tmpdir(), "survive67-snap-"));
execFileSync("sh", ["-c", `git -C "${ROOT}" archive ${commit} | tar -x -C "${work}"`]);
for (const p of EXCLUDE) rmSync(join(work, p), { recursive: true, force: true });

// ------------------------------------------------------------------ 2. strip private blocks
// The marker words are assembled so this file never matches its own strip.
const BEGIN = "@private-" + "begin";
const END = "@private-" + "end";
const BLOCK = new RegExp(`^[^\\n]*${BEGIN}[\\s\\S]*?${END}[^\\n]*\\n`, "gm");
let stripped = 0;
for (const f of walk(work)) {
  const text = readFileSync(f, "utf8");
  if (text.includes("\u0000")) continue; // binary
  let out = text.replace(BLOCK, () => {
    stripped++;
    return "";
  });
  if (out !== text) writeFileSync(f, out);
}
if (walk(work).some((f) => { const t = readFileSync(f, "utf8"); return t.includes(BEGIN) || t.includes(END); })) fail("an unmatched private marker survived the strip");

// ------------------------------------------------------------------ 3. scan, with a positive control
const deny = readFileSync(join(ROOT, "secrets", "public-denylist.txt"), "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"))
  .map((l) => new RegExp(l, "i"));
const secretValues = readdirSync(join(ROOT, "secrets"))
  .filter((f) => f.endsWith(".env") || f.endsWith(".txt"))
  .flatMap((f) => readFileSync(join(ROOT, "secrets", f), "utf8").split("\n"))
  .map((l) => /^([A-Z0-9_]+)=(.+)$/.exec(l.trim()))
  // public by nature: wallet addresses (on chain), hosts, domains, RPC endpoints
  .filter((m) => m && !/(ADDR|HOST|DOMAIN|_RPC|_URL)$|_ADDR_/.test(m[1]))
  .map((m) => m[2].replace(/^"|"$/g, ""))
  .filter((v) => v.length >= 12 && !/^(true|false|\d+)$/.test(v));
const keyShapes = [
  /sk-ant-[A-Za-z0-9_-]{10,}/,
  /sk_live_[0-9A-Za-z]{8,}/,
  /whsec_[0-9A-Za-z]{8,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /xox[baprs]-[0-9A-Za-z-]{10,}/,
  /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];

function scan(files) {
  const hits = [];
  for (const f of files) {
    const rel = relative(work, f);
    if (SCAN_SKIP.has(rel) || SCAN_SKIP_DIR.some((d) => rel.startsWith(d))) continue;
    const text = readFileSync(f, "utf8");
    for (const re of [...deny, ...keyShapes]) if (re.test(text)) hits.push(`${rel}: matches ${re}`);
    for (const v of secretValues) if (text.includes(v)) hits.push(`${rel}: contains a value from secrets/ (${v.slice(0, 3)}…)`);
  }
  return hits;
}

const canary = join(work, ".publish-canary");
writeFileSync(canary, `canary ${readFileSync(join(ROOT, "secrets", "public-denylist.txt"), "utf8").split("\n").find((l) => l && !l.startsWith("#"))}\n`);
if (!scan([canary]).length) fail("the scanner did not catch its own canary, so a clean result would mean nothing");
rmSync(canary);
const files = walk(work);
const hits = scan(files);
if (hits.length) fail(`${hits.length} sensitive match(es):\n  ${hits.slice(0, 20).join("\n  ")}`);
console.log(`✓ export ${sha}: ${files.length} files, ${stripped} private block(s) stripped, scan clean (${deny.length} denylist patterns, ${secretValues.length} secret values, canary caught)`);

// ------------------------------------------------------------------ 4. snapshot commit on top of the public repo
if (!existsSync(join(CHECKOUT, ".git"))) {
  mkdirSync(CHECKOUT, { recursive: true });
  sh("gh", ["repo", "clone", PUBLIC_REPO, CHECKOUT]);
}
sh("git", ["-C", CHECKOUT, "fetch", "-q", "origin", "main"]);
sh("git", ["-C", CHECKOUT, "reset", "-q", "--hard", "origin/main"]);
execFileSync("rsync", ["-a", "--delete", "--exclude", ".git", `${work}/`, `${CHECKOUT}/`]);
rmSync(work, { recursive: true, force: true });
sh("git", ["-C", CHECKOUT, "config", "user.name", AUTHOR.name]);
sh("git", ["-C", CHECKOUT, "config", "user.email", AUTHOR.email]);
sh("git", ["-C", CHECKOUT, "config", "core.hooksPath", "/dev/null"]);
// -z: NUL-separated, never trimmed (a trimmed porcelain line loses its first path character)
const changed = execFileSync("git", ["-C", CHECKOUT, "status", "--porcelain=v1", "-z", "--untracked-files=all"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean)
  .map((e) => e.slice(3));
if (!changed.length) {
  console.log("✓ public repo already matches this snapshot; nothing to publish");
  process.exit(0);
}
// Name every path (global rule: never bulk-add).
const list = join(tmpdir(), `survive67-paths-${Date.now()}.txt`);
writeFileSync(list, changed.join("\n") + "\n");
sh("git", ["-C", CHECKOUT, "add", "-A", "--pathspec-from-file", list]);
rmSync(list);
const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
sh("git", ["-C", CHECKOUT, "commit", "-q", "-m", `Snapshot ${stamp} UTC`]);
const author = sh("git", ["-C", CHECKOUT, "log", "-1", "--format=%an <%ae>"]);
if (author !== `${AUTHOR.name} <${AUTHOR.email}>`) fail(`commit author is ${author}`);
const tracked = Number(sh("sh", ["-c", `git -C "${CHECKOUT}" ls-files | wc -l`]));
console.log(`✓ snapshot commit: ${changed.length} path(s) changed, ${tracked} files tracked, author ${author}`);

if (dry) {
  sh("git", ["-C", CHECKOUT, "reset", "-q", "--hard", "origin/main"]);
  console.log("✓ dry run: snapshot built and discarded; nothing pushed");
  process.exit(0);
}

// ------------------------------------------------------------------ 5. push and verify from outside
const vis = sh("gh", ["repo", "view", PUBLIC_REPO, "--json", "visibility", "--jq", ".visibility"]);
console.log(`  repo visibility: ${vis}`);
sh("git", ["-C", CHECKOUT, "push", "-q", "origin", "main"]);
const remote = Number(sh("gh", ["api", `repos/${PUBLIC_REPO}/git/trees/main?recursive=1`, "--jq", '[.tree[] | select(.type=="blob")] | length']));
const status = async (path) => (await fetch(`https://raw.githubusercontent.com/${PUBLIC_REPO}/main/${path}`, { cache: "no-store" })).status;
const readme = await status("README.md");
const excluded = await status("NEEDS-JAMES.md");
if (remote !== tracked) fail(`GitHub shows ${remote} files, expected ${tracked} (push already happened: check it)`);
if (readme !== 200 || excluded !== 404) fail(`outside check: README ${readme} (want 200), NEEDS-JAMES.md ${excluded} (want 404)`);
console.log(`✓ published ${sha} to https://github.com/${PUBLIC_REPO}: ${remote} files; README 200, excluded file 404`);
