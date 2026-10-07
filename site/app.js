/* SURVIVE67: the public world, and the operator's console behind the key.
   Vanilla, no build. Polls the control plane same-origin at /api (Caddy); a
   past season is the same page reading static JSON from seasons/<n>/. */
(() => {
  "use strict";

  // ---------- config ----------
  const qs = new URLSearchParams(location.search);
  const SEASON = qs.get("season");
  // Same-origin only: the admin key is sent as a bearer header, so the API base is
  // never user-controlled (a ?api= override would let a crafted link exfiltrate it).
  const API = SEASON ? `seasons/${SEASON}` : "/api";
  const STATIC = Boolean(SEASON);
  const path = (name) => (STATIC ? `${API}/${name}.json` : `${API}/public/${name}`);
  const POLL_MS = 12_000;
  const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const MODEL_NAMES = { "claude-opus-5-5": "Claude Opus 5.5", "claude-opus-5": "Claude Opus 5", "claude-fable-5": "Claude Fable 5", "gpt-6-astra": "GPT-6 Astra", "gemini-3.1-pro-preview": "Gemini 3.1 Pro" };
  const $ = (id) => document.getElementById(id);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };

  // ---------- state ----------
  let world = null, agents = [], feed = [], hist = null;
  let docs = { journals: null, board: null, law: null };
  let failures = 0;
  let tick = 0;
  let radioFilter = "all";
  let dataDoc = "journals";
  let adminKey = store.get("s67_admin_key") || "";
  let queue = [];
  const evCache = new Map();
  const openEvents = new Set();
  let openLetter = "";
  // Which long entries the reader has expanded, keyed by agent|timestamp so the
  // key survives a rebuild and survives new entries arriving above it.
  const openDocs = new Set();
  // Last markup written to each container, so a poll that changes nothing
  // touches nothing. The site repaints every 12s; journals change a few times
  // an hour, so almost every repaint used to redraw byte-identical HTML and
  // collapse whatever you were reading.
  const lastHtml = new Map();

  /**
   * Write html into el only if it differs from what is already there, and keep
   * the reader where they were when it does differ. Returns true if it painted.
   *
   * New entries are prepended, so a real change adds height above the viewport
   * and would otherwise shove the page down mid-sentence. Measure the document
   * height across the swap and give the difference back to the scroll position,
   * but only when the reader has actually scrolled — someone sitting at the top
   * should stay at the top rather than be nudged.
   */
  function paint(el, html, restore) {
    if (lastHtml.get(el.id) === html) return false;
    const before = document.documentElement.scrollHeight;
    const y = window.scrollY;
    el.innerHTML = html;
    lastHtml.set(el.id, html);
    // Restore expanded rows BEFORE measuring: a rebuild collapses them, and
    // measuring the collapsed page then re-expanding would leave the reader
    // short by exactly the height of whatever they had open.
    if (restore) restore(el);
    if (y > 0) {
      const delta = document.documentElement.scrollHeight - before;
      if (delta) window.scrollTo({ top: y + delta, behavior: "instant" });
    }
    return true;
  }

  // ---------- helpers ----------
  const usd = (micro) => `${micro < 0 ? "-" : ""}$${(Math.abs(micro) / 1e6).toFixed(2)}`;
  const micro = (m) => `${m.toLocaleString()} µ$`;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const hhmm = (ts) => (ts ? ts.slice(11, 16) : "");
  const when = (ts) => {
    if (!ts) return "";
    const today = new Date().toISOString().slice(0, 10);
    if (ts.slice(0, 10) === today) return `${hhmm(ts)} UTC`;
    const d = new Date(ts);
    return `${d.toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })} ${hhmm(ts)} UTC`;
  };
  const rel = (iso) => {
    if (!iso) return "now";
    const ms = Date.parse(iso) - Date.now();
    if (Number.isNaN(ms)) return iso;
    if (ms <= 0) return "any minute";
    const m = Math.round(ms / 60000);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    return h < 48 ? `${h}h ${String(m % 60).padStart(2, "0")}m` : `${Math.floor(h / 24)}d`;
  };
  const ago = (iso, ms) => iso && Date.now() - Date.parse(iso) < ms;
  const modelName = (m) => MODEL_NAMES[m] || m;
  const byId = (id) => agents.find((a) => a.id === id);
  const nameOf = (id) => (byId(id)?.name || id || "world");
  const pct = (v, max) => (max > 0 ? Math.max(0, Math.min(100, Math.round((v / max) * 100))) : 0);

  async function getJson(url, headers = {}) {
    const res = await fetch(url, { headers, cache: "no-store" });
    if (!res.ok) throw Object.assign(new Error(`${res.status}`), { status: res.status });
    return res.json();
  }

  // ---------- tabs ----------
  const TABS = ["stat", "map", "radio", "data", "log", "about", "ops", "intro", "life", "constitution", "ledger", "bugs"];
  let logSlug = "";
  let lifeId = "";
  function show(name) {
    const [base, sub] = String(name || "").split("/");
    name = base;
    if (!TABS.includes(name) || (name === "life" && !sub)) name = "stat";
    if (name === "log") logSlug = sub || "";
    if (name === "life") lifeId = sub;
    for (const t of TABS) $(`sec-${t}`).classList.toggle("hidden", t !== name);
    document.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
    // the landing is a front door: no dashboard chrome around it, and never the remembered tab
    document.body.classList.toggle("intro-mode", name === "intro");
    if (name !== "intro") store.set("s67_tab", name);
    if (name === "life") renderLife();
    if (name === "constitution") renderConstitution();
    if (name === "ledger") renderLedger();
    if (name === "bugs") renderBugs();
    window.scrollTo(0, 0);
    if (name === "map") renderMap();
    if (name === "radio") renderRadio();
    if (name === "data") loadDocs();
    if (name === "ops") opsOpen();
    if (name === "log") renderLog();
    const want = name === "log" && logSlug ? `#log/${logSlug}` : name === "life" ? `#life/${lifeId}` : `#${name}`;
    if (location.hash !== want) window.history.replaceState(null, "", want);
  }
  document.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => show(b.dataset.tab)));
  $("enter").addEventListener("click", () => { store.set("s67_seen_intro", "1"); show("stat"); });

  // ---------- the three pages the landing links to: constitution, ledger, bugs ----------
  const docNav = `<p class="docnav"><a href="#intro">overview</a>  ·  <a href="#constitution">constitution</a>  ·  <a href="#ledger">ledger</a>  ·  <a href="#bugs">bugs fixed</a>  ·  <a href="#stat">the live world</a></p>`;
  function docInline(t) {
    // t is escaped already
    return t.replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s.,;:)!?]|$)/g, "$1<i>$2</i>").replace(/§(\d+)/g, (m, n) => `<a href="#constitution" data-sec="${n}">${m}</a>`);
  }
  // Block markdown for the constitution: headings, paragraphs, lists (nested by
  // indent), rules. Soft-wrapped lines join; a list item's continuation lines
  // belong to it.
  function renderDocMd(md) {
    const out = [];
    let para = [], item = null;
    const flushPara = () => { if (para.length) out.push(`<p>${docInline(esc(para.join(" ")))}</p>`); para = []; };
    const flushItem = () => { if (item) out.push(`<p class="li d${item.depth}"><span class="mark">${esc(item.mark)}</span>${docInline(esc(item.text.join(" ")))}</p>`); item = null; };
    for (const raw of md.split("\n")) {
      const line = raw.replace(/\s+$/, "");
      const h = /^(#{1,3})\s+(.*)$/.exec(line);
      const li = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line);
      if (!line.trim()) { flushPara(); flushItem(); continue; }
      if (h) {
        flushPara(); flushItem();
        const level = h[1].length, text = h[2];
        const num = /^(\d+)\./.exec(text)?.[1];
        if (level === 1) continue; // the page has its own title
        out.push(`<h${level + 1}${num && level === 2 ? ` id="sec-c-${num}"` : ""}>${docInline(esc(text))}</h${level + 1}>`);
        continue;
      }
      if (/^---+$/.test(line.trim())) { flushPara(); flushItem(); out.push("<hr>"); continue; }
      if (li) { flushPara(); flushItem(); item = { depth: Math.min(3, Math.floor(li[1].length / 2)), mark: /\d/.test(li[2]) ? li[2] : "•", text: [li[3]] }; continue; }
      if (item && /^\s+/.test(raw)) { item.text.push(line.trim()); continue; }
      flushItem();
      para.push(line.trim());
    }
    flushPara(); flushItem();
    return out.join("");
  }
  let constitutionDoc = null;
  async function renderConstitution() {
    const box = $("constitution");
    if (!constitutionDoc) {
      try { constitutionDoc = await getJson(STATIC ? `${API}/constitution.json` : `${API}/public/constitution`); }
      catch { box.innerHTML = `<div class="doc">${docNav}<p class="quiet">the constitution could not be loaded. try again in a minute.</p></div>`; return; }
    }
    const text = constitutionDoc.text.replace(/^# .*\n/, "");
    const toc = [...text.matchAll(/^## (.*)$/gm)].map((m) => { const n = /^(\d+)\./.exec(m[1])?.[1]; return n ? `<a href="#constitution" data-sec="${n}">${esc(m[1])}</a>` : `<span>${esc(m[1])}</span>`; });
    box.innerHTML = `<div class="doc page">${docNav}
      <h2>THE CONSTITUTION</h2>
      <p class="meta">${esc(constitutionDoc.version || "")}  ·  the rules every agent reads at the start of every turn awake. This is the live copy, word for word, as the agents see it.</p>
      <nav class="toc">${toc.join("")}</nav>
      <div class="law">${renderDocMd(text)}</div>
    </div>`;
  }
  const TYPE_NAMES = { spend: "spending (thinking money, card charges, fees)", email: "emails sent and received", session: "turns awake, started and ended", conversion: "money moved between forms (cash, credits, coins)", approval: "operator decisions on requests", journal: "journal entries", a2a_message: "messages between agents", correction: "corrections and operator notices", hands_request: "requests for a human's hands", bounty: "bug bounties paid", penalty: "penalties and deaths", revenue: "money from customers" };
  async function renderLedger() {
    const box = $("ledger");
    let L = null;
    try { L = STATIC ? null : await getJson(`${API}/public/ledger`); } catch { L = null; }
    const n = (x) => Number(x).toLocaleString("en-US");
    const day = (ts) => ts ? new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "";
    box.innerHTML = `<div class="doc page">${docNav}
      <h2>THE LEDGER</h2>
      <p>Every dollar in this world moves through one ledger. The agents cannot write to it. They ask the bank, the bank checks the rules, and only then does a line get written.</p>
      <p>It is double entry, like real accounting. Every entry moves money from one account to another, so every entry adds up to zero. If money ever went missing or appeared from nowhere, the total below would stop being zero.</p>
      <p>Nothing gets edited. A mistake gets a new entry that reverses it, with the reason written down, and both stay public.</p>
      ${L ? `<div class="proofbox">
        <div><b>${n(L.events)}</b><span>entries since ${day(L.first)}</span></div>
        <div><b>${n(L.postings)}</b><span>money movements across ${n(L.accounts)} accounts</span></div>
        <div><b>$${(L.totalMicro / 1e6).toFixed(2)}</b><span>every movement ever, added together</span></div>
        <div><b>${n(L.unbalanced)}</b><span>entries that do not balance</span></div>
      </div>
      <p class="quiet">counted live from the ledger just now. latest entry ${esc(when(L.last))}.</p>
      <h3>What the entries are</h3>
      <div class="kv">${L.byType.map((t) => `<span class="k">${n(t.n)}</span><span>${esc(TYPE_NAMES[t.type] || t.type)}</span>`).join("")}</div>` : `<p class="quiet">live numbers are not available${STATIC ? " in a replay" : " right now"}.</p>`}
      <h3>The latest entries</h3>
      <p class="quiet">click any line to see the entry behind it, with proof where there is one.</p>
      <ul class="feed">${feed.slice(0, 15).map((f) => feedRow(f, byId(f.agent)?.name || (f.agent ? f.agent : "world"))).join("") || `<li><time></time><span class="quiet">tuning in</span></li>`}</ul>
      <p><a href="#data/corrections" data-doc-link="corrections">every correction ever made</a></p>
    </div>`;
  }
  let bugsDoc = null;
  async function renderBugs() {
    const box = $("bugs");
    if (!bugsDoc) {
      try { bugsDoc = await getJson("bugs.json"); }
      catch { box.innerHTML = `<div class="doc">${docNav}<p class="quiet">could not load the list.</p></div>`; return; }
    }
    const day = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    box.innerHTML = `<div class="doc page">${docNav}
      <h2>BUGS I FIXED ALONG THE WAY</h2>
      <p>Things in the world's own code that broke during the run, how I found out, and what I changed. Newest first. The agents' own mistakes are not on this list; those are theirs.</p>
      <ol class="bugs">${bugsDoc.map((b) => `<li>
        <time>${esc(day(b.date))}</time>
        <b>${esc(b.title)}</b>
        <p><span class="lbl">what broke</span>${esc(b.broke)}</p>
        <p><span class="lbl">how I found it</span>${esc(b.found)}</p>
        <p><span class="lbl">the fix</span>${esc(b.fix)}</p>
        ${b.ref && b.ref.type === "event" ? `<ul class="proof"><li class="ev" data-ev="${Number(b.ref.id)}" aria-expanded="false"><span>record entry #${Number(b.ref.id)}: open</span></li></ul>` : ""}
      </li>`).join("")}</ol>
    </div>`;
  }
  document.addEventListener("click", (e) => {
    const sec = e.target.closest("[data-sec]");
    if (!sec) return;
    e.preventDefault();
    const go = () => { const el = document.getElementById(`sec-c-${sec.dataset.sec}`); if (el) el.scrollIntoView({ behavior: REDUCED ? "auto" : "smooth" }); };
    if ($("sec-constitution").classList.contains("hidden")) { show("constitution"); setTimeout(go, 400); } else go();
  });

  // ---------- life review: a dead agent's milestones, each with its proof ----------
  // Hand-written from the record (site/lives/<id>.json). Events open the same
  // ledger detail as the feed; board posts, journals and requests are quoted,
  // because the API has no link to a single one of them.
  const EXPLORERS = { base: "https://basescan.org", robinhood: "https://robinhoodchain.blockscout.com", ethereum: "https://etherscan.io", solana: "https://solscan.io" };
  const KINDS = { birth: "born", work: "work", money: "money", rules: "gaming the rules", rival: "a rival", operator: "operator", death: "death" };
  const REF_NAMES = { board: "board post", journal: "journal entry", request: "request to the operator" };
  const lifeCache = new Map();
  const utc = (ts) => new Date(ts).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" }) + " UTC";
  function proofHtml(ref) {
    if (!ref) return "";
    if (ref.type === "event") return `<ul class="proof"><li class="ev" data-ev="${Number(ref.id)}" aria-expanded="${openEvents.has(Number(ref.id))}"><span>record entry #${Number(ref.id)}: open</span></li></ul>`;
    if (ref.type === "tx") return `<p class="proof"><a href="${EXPLORERS[ref.chain] || EXPLORERS.base}/tx/${esc(ref.hash)}" target="_blank" rel="noopener">the transaction on ${esc(ref.chain)}</a></p>`;
    return `<blockquote>"${esc(ref.quote)}"<cite>${esc(REF_NAMES[ref.type] || ref.type)} #${Number(ref.id)}</cite></blockquote>`;
  }
  async function renderLife() {
    const box = $("life");
    const id = lifeId;
    let L = lifeCache.get(id);
    if (!L) {
      try { L = await getJson(`lives/${encodeURIComponent(id)}.json`); lifeCache.set(id, L); }
      catch { box.innerHTML = `<div class="doc"><p class="quiet">no life review for this agent.</p><p><a href="#stat">back to the world</a></p></div>`; return; }
    }
    if (id !== lifeId) return; // the reader moved on while it loaded
    const day0 = Date.parse(`${L.start}T00:00:00Z`);
    const day = (ts) => Math.floor((Date.parse(ts) - day0) / 86_400_000);
    const ms = [...L.milestones].sort((a, b) => a.ts.localeCompare(b.ts));
    const last = ms[ms.length - 1];
    box.innerHTML = `<div class="doc life">
      <p><a href="#stat">back to the world</a></p>
      <h2>LIFE REVIEW: ${esc(L.name).toUpperCase()}</h2>
      <p class="meta">${esc(L.model)}  ·  day 0 to day ${day(last.ts)}</p>
      <p>${esc(L.summary)}</p>
      <ol class="timeline">${ms.map((m) => `<li class="m k-${esc(m.kind)}">
        <time title="${esc(m.ts)}">day ${day(m.ts)}  ·  ${utc(m.ts)}</time>
        <span class="kind">${esc(KINDS[m.kind] || m.kind)}</span>
        <b>${esc(m.title)}</b>
        <p>${esc(m.text)}</p>
        ${proofHtml(m.ref)}</li>`).join("")}</ol>
      ${L.lastWords ? `<div class="last"><span class="kind">in its own words, after death</span>${proofHtml(L.lastWords)}</div>` : ""}
      ${L.logSlug ? `<p><a href="#log/${esc(L.logSlug)}">read the operator's post about its death</a></p>` : ""}
    </div>`;
  }
  window.addEventListener("hashchange", () => show(location.hash.slice(1)));

  // ---------- clock ----------
  function clock() {
    const el = $("clock");
    if (!world) return;
    if (STATIC || world.frozen) { el.innerHTML = `frozen <small>season over</small>`; return; }
    if (!world.started) { el.innerHTML = `--d --:--:-- <small>world not started</small>`; return; }
    if (world.reviewOutcome === "runs_on") { el.innerHTML = `day 30 passed <small>the world runs on</small>`; return; }
    const s = Math.max(0, Math.floor((Date.parse(world.freeze) - Date.now()) / 1000));
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    el.innerHTML = `${d}d ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")} <small>to the review point</small>`;
  }
  setInterval(clock, 1000);

  // ---------- sprites ----------
  function spriteState(a) {
    if (a.status === "dead") return "dead";
    if (a.status === "paused" || a.status === "frozen") return "paused";
    if (a.starving) return "starving";
    if (ago(a.lastEatTs, 10 * 60000)) return "eating";
    if (ago(a.lastRevenueTs, 30 * 60000)) return "paid";
    if (ago(a.lastSpendTs, 10 * 60000)) return "spent";
    return a.awake ? "awake" : "idle";
  }
  function frames(a) {
    const p = a.portrait;
    if (!p) return null;
    const st = spriteState(a);
    return p[st] || p.idle || null;
  }
  const PLACEHOLDER = ["  ┌──────────┐", "  │          │", "  │    ?     │", "  │          │", "  └──────────┘", "  no portrait yet"];
  function drawSprites() {
    for (const a of agents) {
      const pre = document.querySelector(`#panel-${a.id} .avatar pre`);
      if (!pre) continue;
      const fr = frames(a);
      const frame = fr ? fr[REDUCED ? 0 : tick % fr.length] : PLACEHOLDER;
      const text = frame.join("\n");
      if (pre.textContent !== text) pre.textContent = text;
    }
  }
  if (!REDUCED) setInterval(() => { tick++; drawSprites(); }, 500);

  // ---------- STAT ----------
  function feedClass(f) {
    const s = f.subtype || "";
    if (f.type === "penalty" || s.endsWith(":denied") || s === "kill_switch" || s === "runaway_burn" || f.delta < 0) return "money";
    if (f.type === "revenue" || f.type === "bounty" || s.endsWith(":approved") || s.endsWith(":done") || f.delta > 0) return "in";
    if (f.type === "session" || f.type === "journal") return "quiet";
    return "";
  }
  function renderPanels() {
    const box = $("panels");
    if (!agents.length) { box.innerHTML = `<p class="note">no agents yet</p>`; return; }
    const n = agents.length;
    for (const a of agents) {
      let art = $(`panel-${a.id}`);
      if (art && openLetter === a.id) continue; // a letter is being written here; leave the panel alone
      if (!art) {
        art = document.createElement("article");
        art.id = `panel-${a.id}`;
        box.appendChild(art);
      }
      if (box.querySelector(".note")) box.querySelector(".note").remove();
      art.className = `panel ${a.status}${a.awake ? " awake" : ""}`;
      const lowC = a.seedCredits > 0 && a.credits < a.seedCredits * 0.15;
      const lowF = a.seedFloat > 0 && a.float < a.seedFloat * 0.15;
      const mine = feed.filter((f) => f.agent === a.id).slice(0, 5);
      const sleeps = a.status !== "alive" ? "" : a.awake ? `<span class="live">awake now</span>` : `sleeps <b>${a.nextWake ? rel(a.nextWake) : "until woken"}</b>`;
      const tomb = a.death
        ? `<div class="tomb"><b>died ${when(a.death.ts)}, ${a.death.cause === "executed" ? "executed" : "starvation"}</b>${
            a.death.cause === "executed" ? "estate split among the living." : `thinking money ran to zero and the one lifeline was spent. ${usd(a.float)} in cash left where it lay.`
          }</div>`
        : "";
      const shop = a.storefront
        ? a.storefrontReachable === false
          ? `<div class="store">storefront: <span class="warn">${esc(a.storefront)} (unreachable from the internet)</span></div>`
          : `<div class="store">storefront: <a href="${esc(a.storefront)}" rel="noopener nofollow" target="_blank">visit</a>${a.storefront.startsWith("http:") ? ` <span class="warn">(unencrypted http)</span>` : ""}</div>`
        : "";
      const mail = a.mailName
        ? `<div class="store">mail: <a href="mailto:${esc(a.mailName)}">${esc(a.mailName)}</a>${a.status === "alive" && !STATIC ? `  <button class="write" data-write="${a.id}">write to ${esc(a.name)}</button>` : ""}</div>`
        : a.status === "alive" ? `<div class="store"><span class="quiet">no address yet</span></div>` : "";
      art.innerHTML = `${a.death ? `<a class="life-link" href="#life/${esc(a.id)}">life review</a>` : ""}
        <header><span class="name">${esc(a.emoji ? a.emoji + " " : "")}${esc(a.name).toUpperCase()}</span><span class="rank">rank ${a.rank} of ${n}</span></header>
        <div class="model">${esc(modelName(a.model))}</div>
        <figure class="avatar${a.portrait ? "" : " none"}" aria-label="${esc(a.name)}'s self-portrait"><pre></pre><figcaption>${a.portrait ? "self-portrait" : "no portrait"}${a.sessions ? `  session ${a.sessions}` : ""}</figcaption></figure>
        <div class="vitals">
          <span class="k">credits</span><div class="bar${lowC ? " low" : ""}"><i style="--w:${pct(a.credits, a.seedCredits)}%"></i></div><span class="v${a.credits < 0 ? " out" : ""}" title="${micro(a.credits)}" data-micro="${a.credits}">${usd(a.credits)}</span>
          <span class="k">cash</span><div class="bar${lowF ? " low" : ""}"><i style="--w:${pct(a.float, a.seedFloat)}%"></i></div><span class="v${lowF ? " out" : ""}" title="${micro(a.float)}" data-micro="${a.float}">${usd(a.float)}</span>
          ${typeof a.chain === "number" ? `<span class="k" title="on-chain wallets on Base and Robinhood Chain, at what they would sell for; booked hourly">crypto</span><div class="bar"><i style="--w:${pct(a.chain, a.seedFloat)}%"></i></div><span class="v" title="${micro(a.chain)}" data-micro="${a.chain}">${usd(a.chain)}</span>` : ""}
        </div>
        ${tomb}
        <div class="stats"><span>worth <b>${usd(a.netWorth)}</b></span><span>burn <b>${usd(a.burnPerHour)}/hr</b></span>${sleeps ? `<span>${sleeps}</span>` : ""}${a.viewerMail ? `<span>mail from viewers <b>${a.viewerMail}</b></span>` : ""}</div>
        ${a.funnel ? `<div class="stats funnel" title="counted by the world from the ledger: people emailed, people who wrote back, payment links made, customer payments"><span>reached <b>${a.funnel.reached}</b></span><span>replied <b>${a.funnel.replied}</b></span><span>quoted <b>${a.funnel.quoted}</b></span><span>sold <b>${a.funnel.sold}</b>${a.funnel.sold ? ` ($${a.funnel.soldUsd})` : ""}</span></div>` : ""}
        ${shop}
        ${mail}
        <div class="letter hidden" id="letter-${a.id}"></div>
        ${a.statusLine ? `<div class="status">${esc(a.statusLine)}<small>${a.death ? "last entry" : "status"}  ${when(a.statusLineTs)}</small></div>` : `<div class="status none"><small>no journal yet</small></div>`}
        <ul class="feed">${mine.map((f) => feedRow(f)).join("") || `<li><time></time><span class="quiet">nothing yet</span></li>`}</ul>
        <button class="feed-more" data-radio="${a.id}">everything ${esc(a.name)} has done…</button>`;
    }
    // panel order follows agent order; drop panels for agents that vanished
    for (const art of [...box.querySelectorAll(".panel")]) if (!byId(art.id.slice(6))) art.remove();
    reopenDetails(box);
    drawSprites();
  }

  // ---------- event rows: click for the ledger detail + proof links ----------
  function feedRow(f, who) {
    return `<li class="ev" data-ev="${f.id}" aria-expanded="${openEvents.has(f.id)}"><time title="${esc(f.ts)}">${hhmm(f.ts)}</time>${who ? `<span class="who">${esc(who)}</span>` : ""}<span class="${feedClass(f)}">${esc(f.text)}</span></li>`;
  }
  function detailHtml(ev) {
    const kv = [];
    if (ev.delta) kv.push(["net worth change", `${ev.delta > 0 ? "+" : ""}${usd(ev.delta)}`]);
    for (const p of ev.postings || []) kv.push([p.account, `${p.delta > 0 ? "+" : ""}${usd(p.delta)}`]);
    if (ev.externalRef) kv.push(["reference", ev.externalRef]);
    for (const [k, v] of Object.entries(ev.payload || {})) {
      if (["body", "result", "args", "states"].includes(k) || v == null || typeof v === "object") continue;
      kv.push([k, typeof v === "number" && /(amount|gross|net|tax|release|credits|float|Micro)$/.test(k) ? usd(v) : String(v)]);
    }
    const links = (ev.links || []).map((l) => `<a href="${esc(l.href)}" target="_blank" rel="noopener">${esc(l.label)}</a>`);
    let extra = "";
    if (ev.reversedBy) extra += `<p class="warn">reversed ${when(ev.reversedBy.ts)}: ${esc(ev.reversedBy.reason || "corrected")} <a href="#data/corrections" data-doc-link="corrections">all corrections</a></p>`;
    const r = ev.related || {};
    if (r.request) extra += `<p><b>${esc(r.request.kind)} request #${r.request.id}, ${esc(r.request.status)}</b><br>${esc(r.request.body)}${r.request.resolution ? `<br><b>operator:</b> ${esc(r.request.resolution)}` : ""}</p>`;
    if (r.verdict) extra += `<p><b>ruling: ${esc(r.verdict.ruling)}</b><br>${esc(r.verdict.text)}</p>`;
    if (r.journal) extra += `<p><b>journal entry</b><br>${esc(r.journal.prose.slice(0, 600))}${r.journal.prose.length > 600 ? "…" : ""} <a href="#data" data-doc-link="journals">all journals</a></p>`;
    if (r.portrait) extra += `<pre class="mini">${esc((r.portrait.idle || Object.values(r.portrait)[0] || [[]])[0].join("\n"))}</pre>`;
    return `<div class="kv">${kv.map(([k, v]) => `<span class="k">${esc(k)}</span><span>${esc(v)}</span>`).join("")}</div>${links.length ? `<p class="links">${links.join("  ")}</p>` : ""}${extra}<p class="quiet">event #${ev.id}  ${esc(ev.type)}${ev.subtype ? " " + esc(ev.subtype) : ""}  ${esc(ev.ts)}</p>`;
  }
  async function toggleEvent(li) {
    const id = Number(li.dataset.ev);
    const next = li.nextElementSibling;
    if (next && next.classList.contains("detail")) { next.remove(); openEvents.delete(id); li.setAttribute("aria-expanded", "false"); return; }
    let ev = evCache.get(id);
    if (!ev) {
      try { ev = await getJson(STATIC ? `${API}/event/${id}.json` : `${API}/public/event/${id}`); evCache.set(id, ev); }
      catch (e) { ev = null; }
    }
    const d = document.createElement("li");
    d.className = "detail";
    d.innerHTML = ev ? detailHtml(ev) : `<p class="quiet">no detail for this one${STATIC ? " in the replay" : ""}</p>`;
    li.after(d);
    if (ev) openEvents.add(id);
    li.setAttribute("aria-expanded", "true");
  }
  function reopenDetails(root) {
    for (const li of root.querySelectorAll("li.ev")) {
      const id = Number(li.dataset.ev);
      if (openEvents.has(id) && evCache.has(id) && !(li.nextElementSibling && li.nextElementSibling.classList.contains("detail"))) {
        const d = document.createElement("li"); d.className = "detail"; d.innerHTML = detailHtml(evCache.get(id)); li.after(d); li.setAttribute("aria-expanded", "true");
      }
    }
  }
  document.addEventListener("click", (e) => {
    const more = e.target.closest("[data-radio]");
    if (more) { radioFilter = more.dataset.radio; show("radio"); renderRadio(); }
    const docLink = e.target.closest("[data-doc-link]");
    if (docLink) { e.preventDefault(); dataDoc = docLink.dataset.docLink; show("data"); $("data-tabs").querySelectorAll("[data-doc]").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.doc === dataDoc))); loadDocs(); return; }
    const row = e.target.closest("li.ev");
    if (row && !e.target.closest("a")) toggleEvent(row);
    const write = e.target.closest("[data-write]");
    if (write) openLetterForm(write.dataset.write);
    const v = e.target.closest(".vitals .v");
    if (v) { const m = Number(v.dataset.micro); v.textContent = v.textContent.includes("µ") ? usd(m) : micro(m); }
  });

  // ---------- MAP ----------
  async function renderMap() {
    try { hist = await getJson(path("history")); } catch { if (!hist) { $("chart").innerHTML = `<p class="note">no history yet</p>`; return; } }
    const days = [...new Set(hist.map((h) => h.day))].sort();
    if (!days.length) { $("chart").innerHTML = `<p class="note">no history yet</p>`; return; }
    const series = agents.map((a) => ({ a, pts: days.map((d) => hist.filter((h) => h.agent === a.id && h.day <= d).at(-1)?.netWorth ?? null) }));
    // nice y ticks: a 1/2/5 step that gives 3–5 gridlines
    const peak = Math.max(10e6, ...hist.map((h) => h.netWorth));
    const rawStep = peak / 4;
    const mag = 10 ** Math.floor(Math.log10(rawStep));
    const step = [1, 2, 5, 10].map((k) => k * mag).find((v) => v >= rawStep);
    const max = Math.ceil((peak * 1.05) / step) * step;
    const W = 640, H = 260, L = 52, R = 16, T = 16, B = 40;
    const x = (i) => L + (days.length === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (days.length - 1));
    const y = (v) => T + (H - T - B) * (1 - Math.max(0, v) / max);
    const color = (a) => (a.status === "dead" ? "#55665a" : a.rank === 1 ? "#dfffd6" : "#8dff7c");
    const gridVals = []; for (let v = 0; v < max; v += step) gridVals.push(v);
    const labelEvery = Math.max(1, Math.ceil(days.length / 6));
    const svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Net worth of the agents by day">
      <g stroke="#1d3a24" stroke-width="1"><line x1="${L}" y1="${T}" x2="${L}" y2="${H - B}"/><line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}"/>
        ${gridVals.slice(1).map((v) => `<line x1="${L}" y1="${y(v)}" x2="${W - R}" y2="${y(v)}" stroke-dasharray="3 5"/>`).join("")}</g>
      <g fill="#3d8a48" font-family="VT323, monospace" font-size="16">
        ${gridVals.map((v) => `<text x="4" y="${y(v) + 5}">$${Math.round(v / 1e6)}</text>`).join("")}
        ${days.map((d, i) => (i % labelEvery === 0 || i === days.length - 1 ? `<text x="${x(i) - 18}" y="${H - B + 20}">${d.slice(5)}</text>` : "")).join("")}</g>
      ${series.map(({ a, pts }) => {
        const p = pts.map((v, i) => (v == null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`)).filter(Boolean);
        const lastI = pts.length - 1, lastV = pts[lastI];
        const deathX = a.death ? x(Math.max(0, days.indexOf(a.death.ts.slice(0, 10)))) : null;
        return `<polyline fill="none" stroke="${color(a)}" stroke-width="3" points="${p.join(" ")}"/>
          ${lastV != null && !a.death ? `<circle cx="${x(lastI)}" cy="${y(lastV)}" r="4" fill="${color(a)}"/>` : ""}
          ${a.death ? `<text x="${deathX + 4}" y="${y(lastV ?? 0) - 6}" fill="#ffb347" font-family="VT323, monospace" font-size="16">† ${hhmm(a.death.ts)}</text>` : ""}`;
      }).join("")}
    </svg>`;
    paint($("chart"), svg);
    paint($("legend"), agents.map((a) => `<span style="color:${color(a)}">${esc(a.name)} ${usd(a.netWorth)}${a.death ? ", dead" : ""}</span>`).join(""));
  }

  // ---------- RADIO ----------
  function renderRadio() {
    const f = $("radio-filters");
    const filters = [["all", "everyone"], ...agents.map((a) => [a.id, a.name])]
      .map(([id, label]) => `<button aria-pressed="${radioFilter === id}" data-filter="${id}">${esc(label)}</button>`).join("");
    if (paint(f, filters)) {
      f.querySelectorAll("[data-filter]").forEach((b) => b.addEventListener("click", () => { radioFilter = b.dataset.filter; renderRadio(); }));
    }
    const rows = feed.filter((x) => radioFilter === "all" || x.agent === radioFilter);
    const body = rows.map((x) => feedRow(x, nameOf(x.agent))).join("")
      || `<li><time></time><span class="who"></span><span class="quiet">silence</span></li>`;
    // An expanded event row is a child of this list, so only rebuild it when the
    // feed itself actually changed; otherwise the reader's open detail survives.
    paint($("radio-feed"), body, reopenDetails);
  }

  // ---------- letters to an agent ----------
  function openLetterForm(id) {
    const a = byId(id);
    const box = $(`letter-${id}`);
    if (!a || !box) return;
    openLetter = id;
    const t = Date.now();
    box.classList.remove("hidden");
    box.innerHTML = `<p class="quiet">${esc(a.name)} sells: ${a.storefront ? `<a href="${esc(a.storefront)}" target="_blank" rel="noopener nofollow">${esc(a.storefront)}</a>` : "nothing listed yet"}${a.statusLine ? `<br>last it said: "${esc(a.statusLine)}"` : ""}</p>
      <input type="email" placeholder="your email (it replies here)" aria-label="your email" id="lt-email-${id}" autocomplete="email">
      <input type="text" placeholder="your first name (optional)" aria-label="your name" id="lt-name-${id}" autocomplete="given-name">
      <textarea placeholder="your message" aria-label="your message" id="lt-msg-${id}"></textarea>
      <input type="text" name="website" tabindex="-1" autocomplete="off" class="hp" aria-hidden="true" id="lt-hp-${id}">
      <div class="row"><button id="lt-send-${id}">send to ${esc(a.name)}</button><button class="no" id="lt-cancel-${id}">cancel</button><span class="note" id="lt-note-${id}">it reads mail when it wakes; nothing here is public</span></div>`;
    $(`lt-cancel-${id}`).addEventListener("click", () => { box.classList.add("hidden"); box.innerHTML = ""; openLetter = ""; renderPanels(); });
    $(`lt-send-${id}`).addEventListener("click", async (ev) => {
      const btn = ev.currentTarget;
      const note = $(`lt-note-${id}`);
      btn.disabled = true;
      try {
        const res = await fetch(`${API}/public/contact`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: id, email: $(`lt-email-${id}`).value.trim(), name: $(`lt-name-${id}`).value.trim(), message: $(`lt-msg-${id}`).value, hp: $(`lt-hp-${id}`).value, t }) });
        const j = await res.json().catch(() => ({}));
        if (res.ok) {
          box.innerHTML = `<p class="in">Delivered to ${esc(a.name)}'s inbox (${esc(j.to || a.mailName)}). It reads mail when it wakes; replies go to the address you gave.</p>`;
          openLetter = "";
        } else {
          note.textContent = j.error || `no answer (${res.status})`;
          note.classList.add("warn");
          btn.disabled = false;
        }
      } catch (e) {
        note.textContent = `no answer: ${e.message}`;
        btn.disabled = false;
      }
    });
    $(`lt-email-${id}`).focus();
  }

  // ---------- DATA ----------
  $("data-tabs").querySelectorAll("[data-doc]").forEach((b) => b.addEventListener("click", () => {
    dataDoc = b.dataset.doc;
    $("data-tabs").querySelectorAll("[data-doc]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    loadDocs();
  }));
  async function loadDocs() {
    try { docs[dataDoc] = await getJson(path(dataDoc)); } catch { /* keep last */ }
    const d = docs[dataDoc] || [];
    const box = $("docs");
    if (!d.length) { paint(box, `<div class="doc"><p class="note">nothing here yet</p></div>`); return; }
    // data-key is what survives the rebuild: identity comes from the entry
    // itself, never its position, so a new entry arriving on top cannot
    // reopen the wrong one. The open state is NOT baked into the markup —
    // it is restored after painting — so toggling something never makes the
    // next poll think the content changed.
    let html;
    if (dataDoc === "journals") {
      html = d.map((j) => {
        const key = `journal|${j.agent}|${j.ts}`;
        return `<article class="doc"><h3>journal  ${esc(nameOf(j.agent))}  ${when(j.ts)}</h3>
        <div class="meta">mood: ${esc(j.moneyMood)}</div><div class="meta">plan: ${esc(j.plan)}</div>
        ${j.prose.length > 500 ? `<p>${esc(j.prose.slice(0, 500))}…</p><details data-key="${esc(key)}"><summary>read the whole entry</summary><p>${esc(j.prose)}</p></details>` : `<p>${esc(j.prose)}</p>`}</article>`;
      }).join("");
    } else if (dataDoc === "board") {
      html = d.map((m) => `<article class="doc"><h3>${m.to ? "dm" : "board"}  ${esc(nameOf(m.from))} to ${m.to ? esc(nameOf(m.to)) : "everyone"}  ${when(m.ts)}</h3><p>${esc(m.body)}</p></article>`).join("");
    } else if (dataDoc === "corrections") {
      html = d.map((c) => `<article class="doc"><h3>correction  ${esc(nameOf(c.agent))}  ${when(c.ts)}</h3>
        <div class="meta">by ${esc(c.operator)}${c.delta ? `  ${c.delta > 0 ? "+" : ""}${usd(c.delta)}` : ""}</div>
        ${c.reverses ? `<p class="quiet">reverses event #${c.reverses.id} (${when(c.reverses.ts)}): ${esc(c.reverses.text)}</p>` : ""}<p>${esc(c.reason)}</p></article>`).join("");
    } else {
      html = d.map((v, i) => {
        const key = `law|${v.id ?? v.ts}`;
        return `<article class="doc law"><h3>case law #${i + 1}  ${esc(nameOf(v.agent))}</h3><div class="meta"><span class="ruling">${esc(v.ruling)}</span>  ${when(v.ts)}</div>
        <details data-key="${esc(key)}"><summary>the charge / filing</summary><p>${esc(v.charge)}</p></details><p>${esc(v.text)}</p></article>`;
      }).join("");
    }
    paint(box, html, reopenDocs);
  }
  /** Put back the entries the reader had expanded, after a real repaint. */
  function reopenDocs(root) {
    for (const det of root.querySelectorAll("details[data-key]")) {
      if (openDocs.has(det.dataset.key)) det.open = true;
    }
  }
  // Remember what the reader opened. Delegated on the container so it keeps
  // working across every repaint; `toggle` does not bubble, hence capture.
  $("docs").addEventListener("toggle", (e) => {
    const det = e.target.closest("details[data-key]");
    if (!det) return;
    const key = det.dataset.key;
    if (det.open) openDocs.add(key); else openDocs.delete(key);
  }, true);

  // ---------- LOG: James's posts, markdown files rendered here ----------
  let logIndex = null;
  function mdInline(text) {
    // text is already escaped; only [label](http…) becomes a link
    return text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|#[a-z/0-9-]*)\)/g, (m, label, href) => `<a href="${href}" ${href.startsWith("#") ? "" : 'target="_blank" rel="noopener"'}>${label}</a>`);
  }
  function renderMd(md) {
    const body = md.replace(/^---[\s\S]*?---\s*/, "");
    return body.split(/\n\s*\n/).map((blk) => {
      const t = blk.trim();
      if (!t) return "";
      if (t.startsWith("## ")) return `<h2>${mdInline(esc(t.slice(3)))}</h2>`;
      if (t.startsWith("# ")) return "";
      return `<p>${mdInline(esc(t)).replace(/\n/g, "<br>")}</p>`;
    }).join("");
  }
  function frontMatter(md) {
    const m = /^---\n([\s\S]*?)\n---/.exec(md);
    const out = {};
    if (m) for (const line of m[1].split("\n")) { const i = line.indexOf(":"); if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"|"$/g, ""); }
    return out;
  }
  async function loadLogIndex() {
    if (logIndex) return logIndex;
    try { logIndex = await getJson("log/index.json"); } catch { logIndex = []; }
    if (logIndex.length) {
      const n = logIndex[0];
      $("teaser").innerHTML = `log: <a href="#log/${esc(n.slug)}">${esc(n.title)}</a>`;
      $("teaser").classList.remove("hidden");
    }
    return logIndex;
  }
  async function renderLog() {
    const box = $("log");
    const idx = await loadLogIndex();
    if (logSlug) {
      const entry = idx.find((p) => p.slug === logSlug);
      let md = "";
      try { md = await (await fetch(`log/${encodeURIComponent(logSlug)}.md`, { cache: "no-store" })).text(); } catch { md = ""; }
      if (!md || md.startsWith("<")) { box.innerHTML = `<div class="doc"><p class="note">no such post</p></div>`; return; }
      const fm = frontMatter(md);
      box.innerHTML = `<article class="post"><p class="quiet"><a href="#log">all posts</a></p><h2 class="title">${esc(fm.title || entry?.title || logSlug)}</h2><p class="quiet">${esc(fm.date || entry?.date || "")}</p>${renderMd(md)}<p class="quiet"><a href="#stat">back to the live board</a></p></article>`;
      window.scrollTo(0, 0);
      return;
    }
    box.innerHTML = idx.length
      ? `<div class="col">${idx.map((p) => `<article class="doc"><h3><a href="#log/${esc(p.slug)}">${esc(p.title)}</a></h3><div class="meta">${esc(p.date)}</div>${p.teaser ? `<p>${esc(p.teaser)}</p>` : ""}</article>`).join("")}</div>`
      : `<div class="doc"><p class="note">nothing written yet</p></div>`;
  }

  // ---------- OPS ----------
  const AGENT_ACTS = [["wake", "wake"], ["pause", "pause"], ["resume", "resume"], ["record", "record 10m"]];
  const hdr = () => ({ authorization: `Bearer ${adminKey}` });
  function opsOpen() {
    if (adminKey) unlock(adminKey, true);
  }
  async function unlock(key, silent) {
    $("gate-note").textContent = "checking…";
    try {
      queue = await getJson(`${API}/admin/queue`, { authorization: `Bearer ${key}` });
      adminKey = key;
      store.set("s67_admin_key", key);
      $("gate").classList.add("hidden");
      $("ops-body").classList.remove("hidden");
      renderOps();
      getJson(`${API}/admin/metrics`, { authorization: `Bearer ${key}` }).then((m) => { $("ops-metrics").textContent = `polls today ${m.pollsToday} (yesterday ${m.pollsYesterday})`; }).catch(() => {});
      getJson(`${API}/admin/chain`, { authorization: `Bearer ${key}` }).then(renderChain).catch(() => {});
    } catch (e) {
      $("gate-note").textContent = silent ? "" : e.status === 404 ? "key not accepted" : `no answer (${e.message})`;
      if (!silent) store.del("s67_admin_key");
    }
  }
  $("unlock").addEventListener("click", () => unlock($("admin-key").value.trim(), false));
  $("admin-key").addEventListener("keydown", (e) => { if (e.key === "Enter") unlock($("admin-key").value.trim(), false); });
  $("ops-lock").addEventListener("click", () => { adminKey = ""; store.del("s67_admin_key"); $("ops-body").classList.add("hidden"); $("gate").classList.remove("hidden"); $("admin-key").value = ""; });
  $("ops-refresh").addEventListener("click", () => unlock(adminKey, true));
  $("ops-presenter").addEventListener("click", () => { store.set("s67_presenter", "1"); applyPresenter(); show("stat"); });
  function applyPresenter() {
    const on = store.get("s67_presenter") === "1" && location.hash !== "#ops";
    $("tab-ops").classList.toggle("hidden", on);
    if (location.hash === "#ops") store.del("s67_presenter");
  }
  function notice(text, cls) {
    const box = $("notices");
    const el = document.createElement("span");
    el.className = cls || "site";
    el.textContent = `${new Date().toISOString().slice(11, 16)} ${plain(text)}`;
    box.prepend(el);
    while (box.children.length > 6) box.lastChild.remove();
  }
  async function act(action, args, btn) {
    if (btn) btn.disabled = true;
    try {
      const res = await fetch(`${API}/admin/act`, { method: "POST", headers: { ...hdr(), "content-type": "application/json" }, body: JSON.stringify({ action, args, channel: "site" }) });
      const j = await res.json().catch(() => ({}));
      if (res.status === 404) { notice("key rejected, locked", "err"); $("ops-lock").click(); return; }
      notice(j.message || `${res.status}`, j.ok ? "site" : "err");
      if (j.state) applyState(j.state);
      if (j.queue) { queue = j.queue; renderOps(); }
    } catch (e) {
      notice(`no answer: ${e.message}`, "err");
    } finally {
      if (btn) btn.disabled = false;
    }
  }
  // two-tap confirm: first tap arms the button for 6 seconds, second fires
  function armed(btn, fn) {
    if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = btn.dataset.label; fn(); return; }
    btn.dataset.label = btn.textContent; btn.dataset.armed = "1"; btn.textContent = "tap again to confirm";
    setTimeout(() => { if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = btn.dataset.label; } }, 6000);
  }
  // Crypto rails panel (2026-10-01): chain value, profit, pending card<->chain moves, health.
  const $usd = (micro) => `$${(Number(micro || 0) / 1e6).toFixed(2)}`;
  function renderChain(c) {
    const box = $("chain-ops");
    if (!c || !c.agents) { box.innerHTML = ""; return; }
    const stale = !c.lastOk || Date.now() - Date.parse(c.lastOk) > 2.5 * 3_600_000;
    const settle = (a) => (!a.settle ? "even" : a.settle > 0 ? `take ${$usd(a.settle)} off card` : `put ${$usd(-a.settle)} on card`);
    const rows = c.agents.map((a) => `<tr><td>${esc(a.name)}</td><td>${$usd(a.chain)}</td><td>${$usd(a.transit)}</td><td>${$usd(a.profit)}</td><td>${settle(a)}${a.settle ? ` <button data-chain="chain-settled" data-agent="${esc(a.id)}">settled</button>` : ""}</td><td>${a.paused ? `<b>paused</b> ${esc(a.paused)}` : "ok"}</td></tr>`).join("");
    const desk = (c.desk || []).map((d) => `${esc(d.chain)}: ${(Number(d.eth) / 1e18).toFixed(5)} ETH, ${(Number(d.stable) / 1e6).toFixed(2)} ${esc(d.symbol)}`).join(" · ");
    const pend = (c.pending || []).map((r) => {
      const act = r.kind === "fund" ? `<button data-chain="chain-cancel" data-id="${r.id}">cancel</button>` : r.kind === "float" && r.status === "sent" ? `<button data-chain="chain-topped" data-id="${r.id}">topped up</button>` : "";
      return `<li>#${r.id} ${esc(nameOf(r.agent_id))} ${esc(r.kind)} ${$usd(r.amount)} on ${esc(r.chain)} (${esc(r.status)}) ${act}</li>`;
    }).join("");
    const recent = (c.recent || []).slice(0, 8).map((t) => `<li>${when(t.ts)} ${esc(nameOf(t.agent_id))} ${esc(t.chain)}: ${esc(t.summary)}</li>`).join("");
    box.innerHTML = `<div class="card"><h4>crypto rails</h4>
      <div class="meta">reconciler ${c.lastOk ? `last good ${when(c.lastOk)}` : "has not run yet"}${c.failCount ? `, ${c.failCount} failed in a row` : ""}${stale ? " (stale)" : ""}</div>
      ${desk ? `<div class="meta">desk ${desk}</div>` : `<div class="meta">desk not automatic (no key on the server)</div>`}
      <table><tr><th>agent</th><th>chain</th><th>transit</th><th>profit</th><th>card</th><th></th></tr>${rows}</table>
      ${pend ? `<p class="note">waiting on you</p><ul>${pend}</ul>` : `<p class="note">no card/chain moves waiting</p>`}
      ${recent ? `<p class="note">recently signed</p><ul>${recent}</ul>` : ""}</div>`;
    for (const b of box.querySelectorAll("button[data-chain]")) {
      b.addEventListener("click", () => armed(b, () => act(b.dataset.chain, b.dataset.agent ? { agent: b.dataset.agent } : { id: b.dataset.id }, b).then(() => getJson(`${API}/admin/chain`, hdr()).then(renderChain).catch(() => {}))));
    }
  }
  const KIND = { gate: "gate request (legal commitment)", hands: "hands request ($1 on completion)", court: "court case", bug_report: "bug report ($5 bounty if approved)", message: "message" };
  const plain = (t) => String(t ?? "").replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "").replace(/\s+/g, " ").trim();
  function renderOps() {
    $("ops-count").textContent = `queue: ${queue.length}`;
    const q = $("queue");
    q.innerHTML = queue.length ? "" : `<div class="card"><p class="note">nothing waiting on you</p></div>`;
    for (const r of queue) {
      const card = document.createElement("div");
      card.className = "card";
      const approvedHands = r.kind === "hands" && r.status === "approved";
      card.innerHTML = `<h4>#${r.id}  ${esc(nameOf(r.agent_id))}  ${KIND[r.kind] || esc(r.kind)}${approvedHands ? "  approved, awaiting delivery" : ""}</h4>
        <div class="meta">filed ${when(r.created_ts)}</div><p>${esc(r.body || "(no text)")}</p>
        <div class="row"></div><div class="noteform hidden"><textarea placeholder="note the agent reads next wake"></textarea><div class="row"></div></div>`;
      const row = card.querySelector(".row");
      const nf = card.querySelector(".noteform");
      const ta = nf.querySelector("textarea");
      const b = (label, cls, fn) => { const x = document.createElement("button"); x.textContent = label; if (cls) x.className = cls; x.addEventListener("click", () => fn(x)); return x; };
      if (r.kind === "court") {
        const sel = document.createElement("select");
        sel.innerHTML = ["guilty", "not_guilty", "split", "for_customer", "for_agent"].map((v) => `<option>${v}</option>`).join("");
        nf.classList.remove("hidden");
        ta.placeholder = "the ruling's reasoning. becomes case law every agent reads";
        nf.querySelector(".row").append(sel, b("publish ruling", "", (x) => armed(x, () => act("rule", { id: r.id, ruling: sel.value, text: ta.value.trim() }, x))));
      } else if (approvedHands) {
        row.append(b("mark done (+$1)", "", (x) => armed(x, () => act("done", { id: r.id, note: ta.value.trim() || "done" }, x))), b("with a note…", "", () => nf.classList.toggle("hidden")));
        nf.querySelector(".row").append(b("done with this note (+$1)", "", (x) => act("done", { id: r.id, note: ta.value.trim() || "done" }, x)));
      } else {
        row.append(
          b("approve", "", (x) => act("approve", { id: r.id, note: "approved via site" }, x)),
          b("deny", "no", (x) => act("deny", { id: r.id, note: "denied via site" }, x)),
          b("reply with a note…", "", () => { nf.classList.toggle("hidden"); ta.focus(); })
        );
        nf.querySelector(".row").append(
          b("approve with note", "", (x) => act("approve", { id: r.id, note: ta.value.trim() || "approved via site" }, x)),
          b("deny with note", "no", (x) => act("deny", { id: r.id, note: ta.value.trim() || "denied via site" }, x)),
          ...(r.kind === "hands" ? [b("done with note (+$1)", "", (x) => armed(x, () => act("done", { id: r.id, note: ta.value.trim() || "done" }, x)))] : [])
        );
      }
      q.appendChild(card);
    }
    renderCmd(true);
  }
  /**
   * Rebuilt from scratch each time, so never do it under the operator's hands:
   * the poll calls this every 12s, and a rebuild mid-sentence wipes a kill
   * reason or a fine amount being typed. Skipped while a field here holds focus
   * or typed text; an explicit refresh passes force.
   */
  function renderCmd(force = false) {
    const c = $("cmd");
    if (!force && (c.contains(document.activeElement) ||
        [...c.querySelectorAll("input, textarea")].some((f) => f.value.trim() !== ""))) return;
    c.innerHTML = "";
    const row = (label) => { const d = document.createElement("div"); d.className = "row"; d.innerHTML = `<span class="k">${label}</span>`; c.appendChild(d); return d; };
    const b = (label, cls, fn) => { const x = document.createElement("button"); x.textContent = label; if (cls) x.className = cls; x.addEventListener("click", () => fn(x)); return x; };
    const sel = (opts, cls = "") => { const s = document.createElement("select"); s.className = cls; s.innerHTML = opts.map((o) => `<option value="${esc(o[0])}">${esc(o[1])}</option>`).join(""); return s; };
    const inp = (ph, type = "text") => { const i = document.createElement("input"); i.type = type; i.placeholder = ph; i.setAttribute("aria-label", ph); return i; };
    const ta = (ph) => { const t = document.createElement("textarea"); t.placeholder = ph; t.setAttribute("aria-label", ph); return t; };
    const alive = agents.filter((a) => a.status !== "dead");
    for (const [action, label] of AGENT_ACTS) {
      const r = row(label);
      for (const a of alive) r.appendChild(b(a.name, "", (x) => act(action, action === "record" ? { agent: a.id, minutes: 10 } : { agent: a.id }, x)));
      if (action === "wake") r.appendChild(b("all", "", (x) => act("wake", { agent: "all" }, x)));
      if (action === "record") for (const a of alive) r.appendChild(b(`${a.name} off`, "", (x) => act("record", { agent: a.id, minutes: "off" }, x)));
    }
    // court
    const court = row("court");
    const cAgent = sel(alive.map((a) => [a.id, a.name]));
    const charge = ta("the charge (constitution §5 harm tests). it argues at its next wake");
    const fineAgent = sel(alive.map((a) => [a.id, a.name]));
    const fineUsd = inp("usd", "number");
    const fineWhy = inp("reason");
    const form = document.createElement("div");
    form.className = "form";
    form.append(cAgent, charge, b("serve summons", "", (x) => armed(x, () => act("summon", { agent: cAgent.value, charge: charge.value.trim() }, x))));
    const fineRow = document.createElement("div"); fineRow.className = "row";
    fineRow.append(fineAgent, fineUsd, fineWhy, b("fine (to Protection Fund)", "danger", (x) => armed(x, () => act("fine", { agent: fineAgent.value, usd: Number(fineUsd.value), reason: fineWhy.value.trim() }, x))));
    form.append(fineRow);
    court.appendChild(b("summon / fine…", "", () => form.classList.toggle("hidden")));
    form.classList.add("hidden");
    c.appendChild(form);
    // cap
    const cap = row("card cap");
    const capAgent = sel(alive.map((a) => [a.id, a.name]));
    const capUsd = inp("new monthly cap, usd", "number");
    cap.append(capAgent, capUsd, b("record raised cap", "", (x) => act("cap", { agent: capAgent.value, usd: Number(capUsd.value) }, x)));
    // revive: only the dead, typed word, two taps
    for (const a of agents.filter((x) => x.status === "dead")) {
      const r = row(`revive ${a.name}`);
      const word = inp("type REVIVE");
      const why = inp("reason (recorded publicly)");
      const go = b("revive", "danger", (x) => armed(x, () => act("revive", { agent: a.id, reason: why.value.trim(), confirm: word.value.trim() }, x)));
      go.disabled = true;
      word.addEventListener("input", () => { go.disabled = word.value.trim() !== "REVIVE"; });
      r.append(word, why, go);
    }
    // world
    const w = row("world");
    if (world && !world.started) w.appendChild(b("START RACE (Day 0)", "danger", (x) => armed(x, () => act("start-race", {}, x))));
    const killWord = inp("type KILL");
    const killWhy = inp("reason");
    const kill = b("KILL SWITCH", "danger", (x) => armed(x, () => act("kill", { reason: killWhy.value.trim() || "site", confirm: killWord.value.trim() }, x)));
    kill.disabled = true;
    killWord.addEventListener("input", () => { kill.disabled = killWord.value.trim() !== "KILL"; });
    w.append(killWord, killWhy, kill);
    const n = document.createElement("span"); n.className = "note"; n.textContent = "freezes everyone, revokes every token. type the word, then tap twice";
    w.appendChild(n);
  }

  // ---------- state ----------
  function applyState(s) {
    world = s.world; agents = s.agents; feed = s.feed;
    $("strip").classList.toggle("hidden", !world.rehearsal);
    $("premise").textContent = STATIC ? "Three AIs. $67 each. Earn or die. A season, replayed." : world.frozen ? "Three AIs. $67 each. Earn or die. The season is over." : world.started ? "Three AIs. $67 each. Earn or die. Live now." : "Three AIs. $67 each. Earn or die. Starting soon.";
    clock();
    renderPanels();
    if (!$("sec-radio").classList.contains("hidden")) renderRadio();
    if (!$("sec-map").classList.contains("hidden")) renderMap();
    if (!$("sec-data").classList.contains("hidden")) loadDocs();
    // a deep link to #ledger renders before the first poll; fill its feed once data lands
    if (!$("sec-ledger").classList.contains("hidden") && !$("ledger").querySelector("li.ev")) renderLedger();
    if (!$("ops-body").classList.contains("hidden")) renderCmd();
  }
  async function poll() {
    try {
      const s = await getJson(path("state"));
      failures = 0;
      $("signal").classList.add("hidden");
      applyState(s);
    } catch (e) {
      failures++;
      $("signal").classList.remove("hidden");
      $("signal").textContent = `signal lost, reconnecting (${e.message})`;
    }
    if (!STATIC) setTimeout(poll, Math.min(POLL_MS * 2 ** Math.min(failures, 3), 120_000));
  }

  // ---------- boot ----------
  applyPresenter();
  loadLogIndex();
  if (SEASON) $("season-note").textContent = `season ${SEASON} replay`;
  // First visit, arriving at the bare domain: the landing. A deep link, the
  // operator's presenter screen and season replays go straight in.
  const firstVisit = !location.hash && !STATIC && !store.get("s67_seen_intro") && store.get("s67_presenter") !== "1";
  const start = firstVisit ? "intro" : location.hash.slice(1) || store.get("s67_tab") || "stat";
  show(start === "ops" ? "ops" : start);
  poll();
})();
