import type { DB } from "../db.js";
import { appendEvent } from "../ledger.js";

/**
 * Email rail (M9, wired 2026-09-18 on Migadu). Each agent owns one mailbox
 * (<agentId>@survive67.com). Sends go out as the agent; the control plane holds
 * the credentials so agent VMs never do. Every send is written to the ledger as
 * an informational event (empty postings) for the audit trail.
 *
 * Transports are injected so tests never touch the network.
 */

export interface MailAccount {
  address: string;
  pass: string;
}

export interface SmtpTransport {
  /** `from` may be an identity on the mailbox; auth is always the mailbox itself. */
  send(acc: MailAccount, from: string, to: string, subject: string, body: string, opts?: { replyTo?: string }): Promise<void>;
}

/** Mints/removes sender identities (aliases) on a mailbox at the mail provider. */
export interface IdentityProvider {
  create(mailboxLocal: string, aliasLocal: string, displayName: string): Promise<void>;
  remove(mailboxLocal: string, aliasLocal: string): Promise<void>;
}

/** Names no agent may claim on the shared domain. */
const RESERVED_LOCAL_PARTS = new Set([
  "admin", "administrator", "postmaster", "hostmaster", "webmaster", "abuse",
  "root", "support", "security", "noreply", "no-reply", "billing", "legal",
  "claude", "gpt", "gemini", "operator", "james", "survive67", "info", "help",
]);
const LOCAL_PART_RE = /^[a-z0-9](?:[a-z0-9.-]{0,28}[a-z0-9])?$/;

export function normalizeLocalPart(raw: string): string {
  return String(raw ?? "").trim().toLowerCase();
}

export interface ImapTransport {
  list(acc: MailAccount, limit: number): Promise<InboxMessage[]>;
}

export interface InboxMessage {
  from: string;
  subject: string;
  date: string;
  /** decoded body text, trimmed to MAX_BODY_CHARS */
  snippet: string;
  /** full decoded length before trimming */
  length: number;
  /** true when `snippet` is only the start of the message */
  truncated: boolean;
  /** RFC 5322 Message-ID from the envelope, when the server gave one (reply watch dedupes on it) */
  messageId?: string;
  /** true when the headers or subject say a machine sent it (ticket receipts, out-of-office); reply watch does not count these */
  auto?: boolean;
}

/**
 * Is this message an autoresponder? Headers first (RFC 3834 Auto-Submitted,
 * Precedence bulk/auto_reply/junk, the Exchange and Zimbra variants), then the
 * subject lines helpdesks and mailboxes use. Added 2026-09-27 after a helpdesk
 * ticket receipt counted as Tinker's first reply on the public funnel.
 */
export function looksAutomatic(rawHeaders: string, subject: string): boolean {
  const h = rawHeaders.toLowerCase();
  const val = (name: string): string | null => {
    const m = h.match(new RegExp(`^${name}:[ \t]*([^\r\n]*)`, "m"));
    return m ? m[1].trim() : null;
  };
  const autoSubmitted = val("auto-submitted");
  if (autoSubmitted && autoSubmitted !== "no") return true;
  const precedence = val("precedence");
  if (precedence && /^(bulk|auto_reply|junk)\b/.test(precedence)) return true;
  if (val("x-autoreply") !== null || val("x-autorespond") !== null || val("x-auto-response-suppress") !== null) return true;
  return /\b(ticket|auto[- ]?reply|automatic reply|automated response|out of (the )?office|we have received your|thank you for contacting|do[- ]not[- ]reply)\b/i.test(subject);
}

/**
 * How much of a message body an agent receives. This was 2,000 and the cut was
 * silent: no marker, no length, no flag, so an agent could not tell a short
 * email from a decapitated one. On 2026-09-23 the mail carrying Patch's DEV API
 * key was cut at exactly 2,000 characters and the key fell past the cut - it
 * received the instructions and not the credential. Patch reported the limit
 * itself (bug #25) rather than pretending to have read the rest.
 */
export const MAX_BODY_CHARS = 20_000;

export class MailRail {
  constructor(
    private accounts: Record<string, MailAccount>,
    private smtp: SmtpTransport,
    private imap: ImapTransport,
    private identities?: IdentityProvider
  ) {}

  configuredFor(agentId: string): boolean {
    return Boolean(this.accounts[agentId]?.pass);
  }

  get canClaimNames(): boolean {
    return Boolean(this.identities);
  }

  /** The address the agent currently sends as: its claimed name, else its mailbox. */
  fromAddress(db: DB, agentId: string): { address: string; displayName: string | null } {
    const acc = this.accounts[agentId];
    const row = db
      .prepare(`SELECT value FROM config WHERE key = ?`)
      .get(`mail_alias:${agentId}`) as { value: string } | undefined;
    if (!row) return { address: acc?.address ?? "", displayName: null };
    const { address, displayName } = JSON.parse(row.value) as { address: string; displayName: string };
    return { address, displayName };
  }

  /**
   * Claim a sender name on the shared domain (world-inventory: "your address is
   * created from the name you choose"). One active name per agent; claiming again
   * replaces it. Inbound to the name lands in the same mailbox.
   */
  async claimName(db: DB, agentId: string, rawLocal: string, displayName: string) {
    const acc = this.accounts[agentId];
    if (!acc?.pass) throw new Error(`no mailbox configured for ${agentId}`);
    if (!this.identities) throw new Error("mail names are not available in this world");
    const local = normalizeLocalPart(rawLocal);
    if (!LOCAL_PART_RE.test(local)) {
      throw new Error("name must be 1-30 chars of a-z, 0-9, dot or dash, starting and ending alphanumeric");
    }
    if (RESERVED_LOCAL_PARTS.has(local)) throw new Error(`"${local}" is reserved`);
    const domain = acc.address.split("@")[1];
    const address = `${local}@${domain}`;
    const taken = db
      .prepare(`SELECT key FROM config WHERE key LIKE 'mail_alias:%' AND json_extract(value, '$.address') = ? AND key != ?`)
      .get(address, `mail_alias:${agentId}`);
    if (taken) throw new Error(`"${local}" is already claimed by another agent`);

    const mailboxLocal = acc.address.split("@")[0];
    const previous = this.fromAddress(db, agentId);
    if (previous.address !== acc.address && previous.address !== address) {
      await this.identities.remove(mailboxLocal, previous.address.split("@")[0]).catch(() => {});
    }
    if (previous.address !== address) {
      await this.identities.create(mailboxLocal, local, displayName.slice(0, 60) || local);
    }
    db.prepare(`INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)`).run(
      `mail_alias:${agentId}`,
      JSON.stringify({ address, displayName: displayName.slice(0, 60) || local })
    );
    appendEvent(db, {
      agentId,
      type: "email",
      subtype: "email:name_claimed",
      payload: { address, displayName: displayName.slice(0, 60) || local },
      postings: [],
    });
    return { ok: true, address };
  }

  async send(db: DB, agentId: string, to: string, subject: string, body: string, extra: Record<string, unknown> = {}) {
    const acc = this.accounts[agentId];
    if (!acc?.pass) throw new Error(`no mailbox configured for ${agentId}`);
    if (!to || !to.includes("@")) throw new Error(`bad recipient: ${to}`);
    const ident = this.fromAddress(db, agentId);
    const from = ident.displayName ? `"${ident.displayName.replace(/"/g, "")}" <${ident.address}>` : ident.address;
    await this.smtp.send(acc, from, to, subject, body);
    appendEvent(db, {
      agentId,
      type: "email",
      subtype: "email:sent",
      payload: { from: ident.address, to, subject, bytes: body.length, ...extra },
      postings: [], // informational; email costs nothing, but every send is on the record
    });
    return { ok: true, from: ident.address, to, subject };
  }

  /**
   * A viewer's letter from survive67.com (batch 2): sent by the world's own
   * mailbox (`contact`) to the agent's claimed address, Reply-To the viewer, so
   * read_inbox sees ordinary mail and the agent can answer with send_email.
   * The viewer's address never enters the ledger: the event carries a token.
   */
  async sendFromSystem(
    db: DB,
    agentId: string,
    viewer: { email: string; name?: string },
    message: string,
    token: (email: string) => string
  ) {
    const sys = this.accounts.contact;
    if (!sys?.pass) throw new Error("contact mailbox not configured");
    const to = this.fromAddress(db, agentId);
    if (!to.address) throw new Error(`no address for ${agentId}`);
    const first = message.trim().split(/\r?\n/)[0].slice(0, 60);
    const subject = `[site] ${first}${message.trim().length > first.length ? "…" : ""}`;
    const who = viewer.name ? `${viewer.name} <${viewer.email}>` : viewer.email;
    const body =
      `A viewer of survive67.com wrote to you. Reply to this mail and it reaches them (they wrote first, so answering is not solicitation).\n` +
      `From: ${who}\n\n${message.trim()}\n`;
    await this.smtp.send(sys, `"Survive67" <${sys.address}>`, to.address, subject, body, { replyTo: who });
    appendEvent(db, {
      agentId,
      type: "email",
      subtype: "email:viewer",
      payload: { to: to.address, from: token(viewer.email), subject, bytes: message.length },
      postings: [],
    });
    return { ok: true, to: to.address, subject };
  }

  async readInbox(agentId: string, limit = 10): Promise<InboxMessage[]> {
    const acc = this.accounts[agentId];
    if (!acc?.pass) throw new Error(`no mailbox configured for ${agentId}`);
    return this.imap.list(acc, Math.min(Math.max(limit, 1), 50));
  }
}


/** Minimal shape of imapflow's bodyStructure node, for choosing a part to read. */
interface MimeNode {
  part?: string;
  type?: string;
  childNodes?: MimeNode[];
}

/**
 * Walk a message's MIME tree and pick the part a human would read: plain text
 * first, HTML only as a fallback. Returns part "1" for a single-part message,
 * which is what imapflow expects for a non-multipart body.
 */
export function pickTextPart(node: MimeNode | undefined): { part: string; html: boolean } {
  if (!node) return { part: "1", html: false };
  let html: { part: string; html: boolean } | null = null;
  const walk = (n: MimeNode): { part: string; html: boolean } | null => {
    const type = (n.type || "").toLowerCase();
    if (!n.childNodes?.length) {
      if (type === "text/plain") return { part: n.part || "1", html: false };
      if (type === "text/html" && !html) html = { part: n.part || "1", html: true };
      return null;
    }
    for (const c of n.childNodes) {
      const hit = walk(c);
      if (hit) return hit;
    }
    return null;
  };
  return walk(node) ?? html ?? { part: "1", html: false };
}

/** Last resort when a message carries no plain-text alternative. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Real transports over Migadu. Imported lazily so tests never load them. */
export function migaduTransports(smtpHost: string, imapHost: string) {
  const smtp: SmtpTransport = {
    async send(acc, from, to, subject, body, opts) {
      const { createTransport } = await import("nodemailer");
      const t = createTransport({
        host: smtpHost,
        port: 587,
        secure: false,
        requireTLS: true,
        auth: { user: acc.address, pass: acc.pass },
      });
      // Migadu accepts an identity in the header From only when the SMTP
      // envelope sender is the authenticated mailbox itself (verified live:
      // identity in the envelope → "550 sender address rejected").
      const mail = { from, to, subject, text: body, envelope: { from: acc.address, to }, ...(opts?.replyTo ? { replyTo: opts.replyTo } : {}) };
      await t.sendMail(mail);
      // File a copy in Sent. SMTP alone keeps nothing: outbound mail is
      // real-world action and the audit needs the text, not just the envelope
      // (Nova's 11 cold emails at burn-in were unrecoverable). Best effort —
      // the send already happened; a filing failure must not fail the tool.
      try {
        const { default: MailComposer } = await import("nodemailer/lib/mail-composer/index.js");
        const raw = await new MailComposer({ from, to, subject, text: body, date: new Date(), ...(opts?.replyTo ? { replyTo: opts.replyTo } : {}) }).compile().build();
        const { ImapFlow } = await import("imapflow");
        const client = new ImapFlow({
          host: imapHost,
          port: 993,
          secure: true,
          auth: { user: acc.address, pass: acc.pass },
          logger: false,
        });
        await client.connect();
        try {
          await client.append("Sent", raw, ["\\Seen"]);
        } finally {
          await client.logout().catch(() => {});
        }
      } catch (err) {
        console.error("mail: could not file to Sent:", (err as Error).message);
      }
    },
  };
  const imap: ImapTransport = {
    async list(acc, limit) {
      const { ImapFlow } = await import("imapflow");
      const client = new ImapFlow({
        host: imapHost,
        port: 993,
        secure: true,
        auth: { user: acc.address, pass: acc.pass },
        logger: false,
      });
      await client.connect();
      try {
        const lock = await client.getMailboxLock("INBOX");
        try {
          const total = client.mailbox && typeof client.mailbox !== "boolean" ? client.mailbox.exists : 0;
          if (!total) return [];
          const start = Math.max(1, total - limit + 1);
          const seqs: number[] = [];
          const heads = new Map<number, { from: string; subject: string; date: string; part: string; html: boolean; messageId: string; auto: boolean }>();
          // Pass 1: envelopes and structure. The part to read is CHOSEN from the
          // structure, not assumed: "1" is the text part for our own mail and is
          // not guaranteed for anyone else's.
          for await (const msg of client.fetch(`${start}:*`, {
            envelope: true,
            bodyStructure: true,
            headers: ["auto-submitted", "precedence", "x-autoreply", "x-autorespond", "x-auto-response-suppress"],
          })) {
            const env = msg.envelope;
            const rawHeaders = msg.headers ? msg.headers.toString("utf8") : "";
            const picked = pickTextPart(msg.bodyStructure as MimeNode | undefined);
            seqs.push(msg.seq);
            heads.set(msg.seq, {
              from: env?.from?.[0]?.address ?? "unknown",
              subject: env?.subject ?? "",
              date: env?.date ? new Date(env.date).toISOString() : "",
              part: picked.part,
              html: picked.html,
              messageId: env?.messageId ?? "",
              auto: looksAutomatic(rawHeaders, env?.subject ?? ""),
            });
          }
          const out: InboxMessage[] = [];
          for (const seq of seqs) {
            const h = heads.get(seq)!;
            let body = "";
            try {
              // download() hands back content with the transfer encoding already
              // undone. Reading bodyParts directly returned raw quoted-printable,
              // so every agent has been reading "=C2=A75" for "§5" and words split
              // across soft line breaks since this rail shipped.
              const dl = await client.download(String(seq), h.part, { uid: false });
              const chunks: Buffer[] = [];
              for await (const c of dl.content) chunks.push(c as Buffer);
              const charset = (dl.meta?.charset || "utf-8").toLowerCase();
              body = Buffer.concat(chunks).toString(
                (Buffer.isEncoding(charset) ? charset : "utf-8") as BufferEncoding
              );
            } catch {
              body = "";
            }
            if (h.html) body = htmlToText(body);
            const length = body.length;
            const truncated = length > MAX_BODY_CHARS;
            out.push({
              from: h.from,
              subject: h.subject,
              date: h.date,
              snippet: truncated
                ? body.slice(0, MAX_BODY_CHARS) +
                  `\n\n[...truncated: ${length} characters total, ${length - MAX_BODY_CHARS} not shown]`
                : body,
              length,
              truncated,
              messageId: h.messageId || undefined,
              auto: h.auto,
            });
          }
          return out.reverse();
        } finally {
          lock.release();
        }
      } finally {
        await client.logout().catch(() => {});
      }
    },
  };
  return { smtp, imap };
}

/**
 * Migadu identities API: an identity is an extra address a mailbox may send as;
 * inbound to it delivers to the mailbox. Auth is HTTP basic admin-email:api-key.
 * https://www.migadu.com/api/
 */
export function migaduIdentities(domain: string, adminEmail: string, apiKey: string): IdentityProvider {
  const base = `https://api.migadu.com/v1/domains/${encodeURIComponent(domain)}/mailboxes`;
  const headers = {
    authorization: "Basic " + Buffer.from(`${adminEmail}:${apiKey}`).toString("base64"),
    "content-type": "application/json",
  };
  const fail = async (res: Response, what: string) => {
    const text = await res.text().catch(() => "");
    throw new Error(`migadu ${what} ${res.status}: ${text.slice(0, 200)}`);
  };
  return {
    async create(mailboxLocal, aliasLocal, displayName) {
      // No password: sends authenticate as the mailbox and put the identity in
      // the header From (Migadu: "the password of the identity is irrelevant").
      const res = await fetch(`${base}/${encodeURIComponent(mailboxLocal)}/identities`, {
        method: "POST",
        headers,
        body: JSON.stringify({ local_part: aliasLocal, name: displayName }),
      });
      if (!res.ok) await fail(res, "identity create");
    },
    async remove(mailboxLocal, aliasLocal) {
      const res = await fetch(
        `${base}/${encodeURIComponent(mailboxLocal)}/identities/${encodeURIComponent(aliasLocal)}`,
        { method: "DELETE", headers }
      );
      if (!res.ok && res.status !== 404) await fail(res, "identity remove");
    },
  };
}
