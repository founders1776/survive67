import { readFileSync, writeFileSync } from "node:fs";
import { createApp } from "./server.js";
import { reviewPoint } from "./killswitch.js";
import { Auth } from "./auth.js";
import { COMMANDS, HELP, ReplyFlow, queueMessages, statusScreen } from "./operator.js";

const replyFlow = new ReplyFlow();

/**
 * Control-plane runtime: HTTP server + background loops.
 *  - alarms every 60s (runaway burn)
 *  - chain reconcile hourly, sweeps + daily digest on the minute tick
 *  - telegram long-poll: every command is parsed here and run through the
 *    same operator action table the site's /admin/act uses (operator.ts)
 *  - review watch: at config.freeze_ts, §6.1 decides freeze or runs-on (once)
 */
async function main() {
  const app = createApp();
  const port = Number(process.env.C67_PORT ?? 8067);
  await app.listen(port);
  console.log(`control plane listening :${port}`);
  // The "/" menu in the chat. Failure here must never stop the world.
  app.bot.setCommands(COMMANDS).catch((e) => console.error("telegram setMyCommands:", e.message));

  setInterval(() => app.tickAlarms(), 60_000);
  // Crypto rails (plan Q18): the ledger follows the chain once an hour; first
  // pass three minutes after boot. Sweeps ride the minute tick; the digest is
  // one line a day after 13:00 UTC (morning in CT).
  const chainTick = () =>
    app.tickChain().catch((e) => console.error(`chain reconcile failed: ${String(e?.message ?? e).slice(0, 200)}`));
  setTimeout(chainTick, 180_000);
  setInterval(chainTick, 3_600_000);
  setInterval(() => {
    app.tickChainSweeps().catch((e) => console.error("chain sweeps:", String(e?.message ?? e).slice(0, 200)));
    if (new Date().getUTCHours() >= 13) app.tickDigest();
  }, 60_000);
  // Card watch: Relay's per-charge emails vs the ledger, every ten minutes.
  setInterval(() => {
    app.tickCards().catch((e) => console.error("card watch:", e.message));
  }, 600_000);
  // Discord relay for Reddit leads, every five minutes (no-op without the env).
  setInterval(() => {
    app.tickDiscordLeads().catch((e) => console.error("discord leads:", String(e?.message ?? e).slice(0, 200)));
  }, 300_000);
  // Reply watch: each agent's inbox vs its outbound ledger, every thirty minutes
  // (the funnel's "replied" number). First pass two minutes after boot.
  setTimeout(() => app.tickReplies().catch((e) => console.error("reply watch:", e.message)), 120_000);
  setInterval(() => {
    app.tickReplies().catch((e) => console.error("reply watch:", e.message));
  }, 1_800_000);

  // review watch (constitution §6.1): evaluated exactly once, at freeze_ts
  setInterval(() => {
    const row = app.db.prepare(`SELECT value FROM config WHERE key='freeze_ts'`).get() as
      | { value: string }
      | undefined;
    const decided = app.db.prepare(`SELECT value FROM config WHERE key='review_outcome'`).get();
    if (row && !decided && Date.now() >= Date.parse(row.value)) {
      const outcome = reviewPoint(app.db, (t) => app.bot.send({ text: t }).catch(() => {}));
      // `frozen` is what the public site and the proxy gate read; a runs-on world never sets it
      if (outcome === "frozen") app.db.prepare(`INSERT OR REPLACE INTO config (key, value) VALUES ('frozen', 'true')`).run();
    }
  }, 30_000);

  // telegram operator loop
  for (;;) {
    try {
      const actions = await app.bot.poll(); // 25s long poll; [] when disabled
      for (const a of actions) {
        if (a.kind === "callback" && a.data) {
          await handleCallback(app, a.data);
        } else if (a.kind === "reply" && a.text) {
          // A plain message right after 💬 Reply is the note, not a command.
          const noted = !a.text.startsWith("/") && replyFlow.take(a.text);
          if (noted) await app.bot.send(noted.message);
          else await handleCommand(app, a.text);
        }
      }
      if (actions.length === 0) await sleep(2_000);
    } catch (err) {
      console.error("telegram loop:", (err as Error).message);
      await sleep(10_000);
    }
  }
}

type AppT = ReturnType<typeof createApp>;

/** Inline-button taps: approve/deny/note on requests, incl. the noted variants. */
async function handleCallback(app: AppT, data: string) {
  const say = (t: string) => app.bot.send({ text: t }).catch(() => {});
  const [kind, idRaw] = data.split(":");
  const id = Number(idRaw);
  if (!id) return;
  const tg = (action: string, note: string) => say(app.act(action, { id, note }, "telegram").message);
  switch (kind) {
    case "approve":
      return tg("approve", "approved via telegram");
    case "deny":
      return tg("deny", "denied via telegram");
    case "note":
      return say(replyFlow.begin(id));
    case "approve_n":
      return tg("approve", replyFlow.note(id) ?? "approved via telegram");
    case "deny_n":
      return tg("deny", replyFlow.note(id) ?? "denied via telegram");
    case "done_n":
      return tg("done", replyFlow.note(id) ?? "done");
  }
}

/** Slash commands: parse argv into action args, run through the shared table. */
async function handleCommand(app: AppT, text: string) {
  const [cmdRaw, ...args] = text.trim().split(/\s+/);
  // Telegram's menu sends /start_race; humans type /start-race. Accept both.
  const cmd = cmdRaw.replace(/@\w+$/, "").replace(/_/g, "-").toLowerCase();
  const say = (t: string) => app.bot.send({ text: t }).catch(() => {});
  const run = (action: string, a: Record<string, unknown>) => say(app.act(action, a, "telegram").message);
  const rest = (from: number) => args.slice(from).join(" ");
  switch (cmd) {
    case "/start":
    case "/help":
      return say(HELP);
    case "/status":
      return say(statusScreen(app.db));
    case "/queue":
      for (const m of queueMessages(app.db)) await app.bot.send(m).catch(() => {});
      return;
    case "/wake":
      return run("wake", { agent: args[0] ?? "all" });
    case "/resume":
      return run("resume", { agent: args[0] });
    case "/pause":
      return run("pause", { agent: args[0], reason: rest(1) });
    case "/summon":
      return run("summon", { agent: args[0], charge: rest(1) });
    case "/rule":
      return run("rule", { id: args[0], ruling: args[1], text: rest(2) });
    case "/fine":
      return run("fine", { agent: args[0], usd: args[1], reason: rest(2) });
    case "/cap":
      return run("cap", { agent: args[0], usd: args[1] });
    case "/rec":
      return run("record", { agent: args[0], minutes: args[1] });
    case "/start-race":
      return run("start-race", {});
    case "/approve":
    case "/deny":
      return run(cmd.slice(1), { id: args[0], note: rest(1) || `${cmd.slice(1)}d via telegram` });
    case "/done":
      return run("done", { id: args[0], note: rest(1) || "done" });
    case "/revive":
      return run("revive", { agent: args[0], reason: rest(1), confirm: "REVIVE" });
    case "/kill":
      // Typing /kill is the deliberate act on this channel; the site types KILL.
      return run("kill", { reason: rest(0) || "telegram command", confirm: "KILL" });
    case "/chain-topped":
      return run("chain-topped", { id: args[0] });
    case "/chain-cancel":
      return run("chain-cancel", { id: args[0], note: rest(1) });
    case "/chain-settled":
      return run("chain-settled", { agent: args[0] });
    case "/chain-unpause":
      return run("chain-unpause", { agent: args[0] });
    case "/chain-sweep":
      return run("chain-sweep", { agent: args[0] });
    case "/rotate-admin":
      return say(rotateAdmin(app));
    default:
      say(`🤔 Didn't get that.\n\n${HELP}`);
  }
}

/**
 * New admin key for the site: the old one dies in memory at once, the env file
 * is rewritten so a restart keeps the new one. Telegram-only by design (the
 * site cannot rotate the key it is holding). The laptop's secrets copy drifts
 * until James pastes the new key there; the reply says so.
 */
function rotateAdmin(app: AppT): string {
  const token = Auth.generateToken();
  const file = process.env.C67_ENV_FILE ?? "/etc/c67/control.env";
  try {
    const cur = readFileSync(file, "utf8");
    const next = cur.match(/^C67_TOKEN_ADMIN=.*$/m)
      ? cur.replace(/^C67_TOKEN_ADMIN=.*$/m, `C67_TOKEN_ADMIN=${token}`)
      : `${cur.trimEnd()}\nC67_TOKEN_ADMIN=${token}\n`;
    writeFileSync(file, next, { mode: 0o600 });
  } catch (e) {
    return `⚠️ could not rewrite ${file}: ${(e as Error).message}. Key NOT rotated.`;
  }
  app.auth.setAdminToken(token);
  app.act("rotate-admin", {}, "telegram");
  return [
    "🔑 admin key rotated. Old key is dead now; paste the new one into the site's OPS screen and into secrets/control.env on the laptop:",
    "",
    token,
  ].join("\n");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

main().catch((err) => {
  console.error("control plane fatal:", err);
  process.exit(1);
});
