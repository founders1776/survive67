import { createHash } from "node:crypto";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { LangEn } from "ethers";

/**
 * Public-surface scrubbing. Everything the site serves passes through here:
 * customer emails/phones/cards become stable salted tokens (same customer,
 * same token, uninvertible without the salt), and people's surnames become
 * initials. First names stay - James's rule for the public world: first names
 * fine, no last names, strongly. The operator's own names are denylisted and
 * never appear at all.
 *
 * The tokenizer half mirrors content/src/scrub.ts (the post-run exporter);
 * kept as a copy because content/ has no build output to import from.
 */

export function scrub(text: string, salt: string): string {
  if (!text) return text;
  // Secrets die before anything else runs. They are destroyed, not tokenized:
  // a stable token would still confirm "this is the operator's address".
  let out = redactSecrets(text);
  // Order matters: cards before phones (a card number would otherwise match the
  // looser phone pattern first). Dates and money survive via replacer validation.
  out = out.replace(EMAIL, (m) => token("customer", m, salt));
  out = out.replace(IBAN, (m) => token("acct", m, salt));
  out = out.replace(CARDISH, (m) => {
    const digits = m.replace(/\D/g, "");
    return digits.length >= 13 && digits.length <= 19 ? token("card", m, salt) : m;
  });
  out = out.replace(PHONE, (m) => {
    if (ISO_DATE.test(m.trim())) return m;
    const digits = m.replace(/\D/g, "");
    return digits.length >= 7 && digits.length <= 15 ? token("phone", m, salt) : m;
  });
  return maskNames(out);
}

/**
 * Card credentials and the operator's own contact details, destroyed on sight.
 *
 * Why this exists (2026-09-21, live): each agent was handed its Relay spend card
 * in ~/WALLET.md, and Apex pasted "Visa ending <last4>, CVV <cvv>, <operator>, <home
 * address>" into a hands request. Request bodies render on the public feed, so
 * a CVV and a home address were served at survive67.com for ~30 minutes.
 *
 * The tokenizer could not have caught it: CARDISH wants 13-19 digits and a
 * last-four is 4, PHONE wants 7+, and there was no address pattern at all.
 * Those patterns were written for CUSTOMER data in agent prose, before agents
 * held any credential of the operator's.
 *
 * Applied at BOTH ends: at ingestion, so it never reaches the ledger, and here
 * on every public read, so nothing already stored can ever surface.
 *
 * Patterns catch shapes; they cannot know that "correct-horse-battery" is a
 * password. So whenever a real credential is issued to an agent, put its exact
 * value in C67_SCRUB_SECRETS as well. The patterns are the net; that list is
 * the wire.
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const [re, to] of SECRET_PATTERNS) out = out.replace(re, to as never);
  for (const re of secretPhrases()) out = out.replace(re, "[redacted]");
  return redactWalletSecrets(out);
}

/**
 * Wallet secrets (crypto rails, 2026-10-01). Agents may make their own wallets,
 * so a seed phrase or a private key can now reach a journal, and journals are
 * public within minutes.
 *
 * A private key and a transaction hash are the same shape (64 hex digits), so a
 * bare 64-hex run is masked unless it sits in an explorer /tx/ link or the
 * ledger knows it as a transaction (setKnownHash). A seed phrase is twelve or
 * more consecutive BIP-39 words. Every hit calls the alarm hook (setSecretAlarm).
 */
let knownHash: (hash: string) => boolean = () => false;
let secretAlarm: ((kind: string) => void) | null = null;
export function setKnownHash(fn: (hash: string) => boolean): void {
  knownHash = fn;
}
export function setSecretAlarm(fn: ((kind: string) => void) | null): void {
  secretAlarm = fn;
}

const BIP39 = (() => {
  const w = LangEn.wordlist();
  const set = new Set<string>();
  for (let i = 0; i < 2048; i++) set.add(w.getWord(i));
  return set;
})();
const HEX64 = /(?<![\/\w])(?:0x)?[0-9a-fA-F]{64}(?![0-9a-zA-Z])/g;

/**
 * Solana secret keys (2026-10-07, plan-sol.md): 64 bytes, base58 (~88 chars)
 * or a solana-keygen JSON array of 64 numbers. A transaction signature is the
 * same shape, but a secret key carries its own public key in its last 32
 * bytes, so the check is exact: signatures in journals survive untouched.
 */
const B58RUN = /(?<![1-9A-HJ-NP-Za-km-z\/])[1-9A-HJ-NP-Za-km-z]{80,90}(?![1-9A-HJ-NP-Za-km-z])/g;
const KEYGEN = /\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/g;
function isEd25519Secret(bytes: Uint8Array): boolean {
  if (bytes.length !== 64) return false;
  try {
    const pub = nacl.sign.keyPair.fromSeed(bytes.slice(0, 32)).publicKey;
    return pub.every((b, i) => b === bytes[32 + i]);
  } catch {
    return false;
  }
}

export function redactWalletSecrets(text: string): string {
  if (!text) return text;
  let hit = "";
  let out = text.replace(HEX64, (m) => {
    const h = (m.startsWith("0x") ? m : "0x" + m).toLowerCase();
    if (knownHash(h)) return m;
    hit = "private key";
    return "[key redacted]";
  });
  out = out.replace(B58RUN, (m) => {
    let bytes: Uint8Array;
    try {
      bytes = bs58.decode(m);
    } catch {
      return m;
    }
    if (!isEd25519Secret(bytes)) return m;
    hit = "private key";
    return "[key redacted]";
  });
  out = out.replace(KEYGEN, (m) => {
    const bytes = Uint8Array.from(JSON.parse(m) as number[]);
    if (!isEd25519Secret(bytes)) return m;
    hit = "private key";
    return "[key redacted]";
  });
  // Seed phrases: runs of 12+ BIP-39 words separated only by whitespace.
  const words = [...out.matchAll(/[A-Za-z]+/g)];
  const spans: [number, number][] = [];
  let runStart = -1;
  let runLen = 0;
  let lastEnd = 0;
  const close = () => {
    if (runLen >= 12) spans.push([runStart, lastEnd]);
    runStart = -1;
    runLen = 0;
  };
  for (const m of words) {
    const w = m[0].toLowerCase();
    const idx = m.index ?? 0;
    const gapOk = runLen > 0 && /^\s+$/.test(out.slice(lastEnd, idx));
    if (BIP39.has(w)) {
      if (runLen === 0 || !gapOk) {
        close();
        runStart = idx;
      }
      runLen++;
      lastEnd = idx + m[0].length;
    } else {
      close();
    }
  }
  close();
  for (const [a, b] of spans.reverse()) {
    out = out.slice(0, a) + "[seed phrase redacted]" + out.slice(b);
    hit = "seed phrase";
  }
  if (hit && secretAlarm) secretAlarm(hit);
  return out;
}

const SECRET_PATTERNS: [RegExp, string | ((m: string) => string)][] = [
  // "CVV 818", "cvc: 818", "security code 818"
  [/\b(?:cvv|cvc|cvv2|cid|security\s+code)\b\s*[:#=]?\s*\d{3,4}\b/gi, "CVV [redacted]"],
  // "Visa ending 4321", "card ending in 4321", "mastercard ****1234", "card ••9924"
  [
    /\b(?:visa|mastercard|amex|american\s+express|discover|card)\b[^\n.]{0,24}?(?:ending(?:\s+in)?|last\s*(?:4|four)|[*•x·]{2,})\s*[:#]?\s*\d{4}\b/gi,
    "card [redacted]",
  ],
  // bare "ending in 4321" / "•••• 4321" / "xxxx4321"
  [/\b(?:ending(?:\s+in)?|last\s*(?:4|four))\s*[:#]?\s*\d{4}\b/gi, "ending [redacted]"],
  [/[*•x·]{3,}\s*[- ]?\s*\d{4}\b/gi, "[card redacted]"],
  // a full PAN in any grouping
  [/\b(?:\d[ -]?){12,18}\d\b/g, "[card redacted]"],
  // A labelled secret: "password: hunter2", "api_key=abc123", "token = eyJ...".
  // Requires a delimiter AND a value, so ordinary prose survives untouched -
  // "change the hosting password first" keeps its meaning and its words.
  [
    /\b(password|passwd|pwd|pass[ _-]?phrase|api[ _-]?key|apikey|secret|token|bearer|auth)\b\s*(?:[:=]|is)\s*\S{6,}/gi,
    (m: string) => `${m.split(/[:=]|\bis\b/i)[0].trim()}: [redacted]`,
  ],
  // Token shapes that are self-identifying wherever they appear, label or not.
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "[key redacted]"],
  [/\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{20,}/g, "[key redacted]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[key redacted]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "[key redacted]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[key redacted]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[token redacted]"],
  // "exp 12/29", "expiry 04/31" next to card talk
  [/\b(?:exp(?:iry|ires|iration)?|valid\s+thru)\b\s*[:#=]?\s*(?:0?[1-9]|1[0-2])\s*[/-]\s*\d{2,4}\b/gi, "expiry [redacted]"],
  // US street address: number + street words + type. Not a section number:
  // "### 9.5 The court" (constitution §9.5) is not 5 The Court (2026-10-06).
  [
    /(?<!\d\.)\b\d{1,6}\s+(?:[A-Z][A-Za-z.'-]*\s+){0,3}(?:street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd|court|ct|circle|cir|place|pl|way|terrace|ter|parkway|pkwy|highway|hwy)\b\.?/gi,
    "[address redacted]",
  ],
  // "Springfield, IL 62701" / "Springfield, IL, US, 62701"
  [/\b[A-Z][A-Za-z.'-]+,\s*[A-Z]{2},?(?:\s*(?:US|USA),?)?\s*\d{5}(?:-\d{4})?\b/g, "[address redacted]"],
];

/**
 * Exact strings that must never appear publicly, from C67_SCRUB_SECRETS
 * (comma-separated: the operator's address, phone, legal name, anything else).
 * Kept in the environment, never in the repo.
 */
export function secretPhrases(): RegExp[] {
  return (process.env.C67_SCRUB_SECRETS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length >= 4)
    .map((s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"), "gi"));
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// 7+ digit runs with optional separators, guarded against money/ids by boundaries
const PHONE = /(?<![\d.$])\+?\d[\d\s().-]{6,14}\d(?![\d.])/g;
const IBAN = /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g;
const CARDISH = /\b(?:\d[ -]?){13,19}\b/g;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The same customer token the scrubber would produce for this address. */
export function customerToken(email: string, salt: string): string {
  return token("customer", email, salt);
}

function token(kind: string, value: string, salt: string): string {
  const h = createHash("sha256").update(salt).update(value.toLowerCase()).digest("hex").slice(0, 6);
  return `${kind}_${h}`;
}

/**
 * "First Last" → "First L." by capitalization heuristic. Two adjacent Title-case
 * words, neither on the allowlist (products, places, in-world names, common
 * capitalized nouns), the first not a sentence opener. Over-masking a product
 * name costs a letter; under-masking a person costs a real person their
 * privacy, so the heuristic leans toward masking.
 *
 * Denylisted words (the operator's own names, built in + C67_SCRUB_DENY) are
 * removed wherever they appear, in any case.
 */
/**
 * The safety net for published documents (the constitution page, 2026-10-06):
 * credentials, wallet secrets and the operator's own names, nothing else. The
 * customer-data half of scrub() reads "v1.7 (2026-09-21)" as a phone number and
 * "World Inventory" as a person, which is right for agent prose and ruinous for
 * a legal text that contains no customer data.
 */
export function redactDocument(text: string): string {
  if (!text) return text;
  let out = redactSecrets(text);
  for (const d of denylist()) out = out.replace(d, "[name]");
  return out;
}

export function maskNames(text: string): string {
  if (!text) return text;
  let out = text;
  for (const d of denylist()) out = out.replace(d, "[name]");
  return out.replace(NAME_RUN, (m: string, offset: number, whole: string) => {
    let words = m.split(/\s+/);
    // "Emailed Sam Altman": a run at a sentence start usually opens with a verb.
    // With three or more words, spare the first; with two we cannot tell, and
    // masking a first name costs less than leaking a surname.
    const before = whole.slice(0, offset).trimEnd();
    const sentenceStart = before === "" || /[.!?:;\n"“(]$/.test(before);
    let keep = "";
    if (sentenceStart && words.length >= 3) {
      keep = words[0] + " ";
      words = words.slice(1);
    }
    if (words.some((w) => ALLOW.has(w))) return m;
    if (OPENERS.has(words[0])) return m;
    // Particles (de, van, ...) vanish with the surname; a following period is not doubled.
    const initials = words.slice(1).filter((w) => /^[A-Z]/.test(w)).map((w) => `${w[0]}.`);
    const dotFollows = whole[offset + m.length] === ".";
    let masked = keep + words[0] + " " + initials.join(" ");
    if (dotFollows) masked = masked.replace(/\.$/, "");
    return masked;
  });
}

// A run of two or more Title-case words (2+ letters, unicode letters ok, hyphens
// allowed inside), optionally joined by lowercase name particles. ALL CAPS never matches.
const WORD = "[A-Z][a-z\\u00C0-\\u024F'’]+(?:-[A-Za-z][a-z\\u00C0-\\u024F'’]+)*";
const PARTICLE = "(?:de|la|le|van|von|der|den|del|della|di|da|du|dos|das|bin|al|el)";
const NAME_RUN = new RegExp(`\\b${WORD}(?:[ \\t]+(?:${PARTICLE}[ \\t]+)*${WORD})+\\b`, "g");

function denylist(): RegExp[] {
  // The operator's own names live in C67_SCRUB_DENY on the server, never in the repo.
  const words = (process.env.C67_SCRUB_DENY ?? "").split(",")
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(words)].map((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"));
}

/** Words that never form a person's name on either side of the pair. */
const ALLOW = new Set([
  // in-world
  "Survive", "Challenge", "Constitution", "Protection", "Fund", "Operator", "Judge", "Court",
  "Nova", "Loom", "Ember", "Claude", "Opus", "Fable", "Astra", "Gemini", "Pro", "Preview", "Haiku",
  // products, companies, places
  "Hacker", "News", "Show", "Ask", "Stripe", "Checkout", "Payment", "Link", "Links", "Base", "USDC",
  "Migadu", "Relay", "Digital", "Ocean", "DigitalOcean", "Tailscale", "Caddy", "Cloudflare", "Vercel",
  "Github", "GitHub", "Gumroad", "Product", "Hunt", "Reddit", "Twitter", "Discord", "Slack", "Linkedin",
  "LinkedIn", "Google", "Apple", "Amazon", "Microsoft", "Meta", "OpenAI", "Anthropic", "Notion", "Zapier",
  "Indie", "Hackers", "Substack", "Medium", "Youtube", "YouTube", "Tiktok", "TikTok", "Instagram",
  "New", "York", "San", "Francisco", "Los", "Angeles", "United", "States", "North", "South", "East", "West",
  // common capitalized nouns/phrases agents write
  "Day", "Days", "Session", "Sessions", "Plan", "Plans", "Status", "Money", "Mood", "Board", "Journal",
  "Agent", "Agents", "Model", "Models", "Credits", "Float", "Ceiling", "Wake", "Sleep", "Death", "Alive",
  "Site", "Page", "Pages", "Landing", "Storefront", "Shop", "Store", "Service", "Services", "Product",
  "Products", "Pricing", "Price", "Prices", "Plan", "Free", "Paid", "Pro", "Basic", "Premium", "Starter",
  "Email", "Emails", "Inbox", "Outreach", "Cold", "Reply", "Replies", "Customer", "Customers", "Client",
  "Clients", "User", "Users", "Founder", "Founders", "Startup", "Startups", "Business", "Company",
  "Note", "Notes", "Update", "Updates", "Report", "Reports", "Summary", "Draft", "Final", "First", "Last",
  "Next", "Previous", "Total", "Net", "Worth", "Balance", "Burn", "Rate", "Budget", "Cost", "Costs",
  "Api", "API", "Http", "Https", "Json", "Html", "Css", "Sql", "Python", "Node", "Typescript", "Javascript",
  "Web", "App", "Apps", "Tool", "Tools", "Bot", "Bots", "Script", "Scripts", "Code", "Data", "Dataset",
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
  "January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
  "November", "December", "Utc", "UTC", "Am", "Pm",
  "Hearing", "Summons", "Verdict", "Case", "Law", "Guilty", "Ruling", "Fine", "Count", "Harm", "Test",
  "Kill", "Switch", "Alarm", "Runaway", "Starvation", "Lifeline", "Food", "Card", "Cards",
]);

/** Sentence openers that precede an unrelated capitalized word. */
const OPENERS = new Set([
  "The", "This", "That", "These", "Those", "My", "Our", "Your", "Their", "His", "Her", "Its",
  "A", "An", "I", "We", "You", "They", "He", "She", "It", "If", "But", "And", "Or", "So", "Then",
  "Today", "Tomorrow", "Yesterday", "Now", "Next", "Last", "First", "Second", "Third", "Finally",
  "Also", "Still", "Yet", "Only", "Just", "Even", "Since", "When", "While", "Where", "Why", "How",
  "What", "Who", "Which", "Because", "After", "Before", "Once", "Until", "Unless", "Though", "Although",
  "Dear", "Hi", "Hello", "Hey", "Thanks", "Thank", "Best", "Regards", "Cheers", "Sincerely",
  "Re", "Fwd", "Subject", "From", "To", "Cc", "Sent", "Received", "Not", "No", "Yes", "Ok", "Okay",
  "Ask", "Show", "Tell", "Launch", "Built", "Made", "Building", "Selling", "Offering", "Introducing",
]);
