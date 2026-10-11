/**
 * fill_from_mail (2026-10-11): the approved path from a credential in the
 * agent's mailbox to the login form that consumes it (constitution §5: a
 * credential goes in the form that consumes it and nowhere else).
 *
 * Patch's question that started it: its browser control is shell plus
 * Playwright, so logging in meant quoting the password into a command or a
 * script, which is plaintext outside the form. This tool fetches the operator's
 * credential mail, pulls one field out of it and types it straight into a
 * field of the agent's own local browser over the Chrome DevTools Protocol.
 *
 * The value never enters a tool argument, a tool result, an error message, a
 * file or the model's context. Only operator mail (contact@survive67.com) is a
 * source, only a local browser is a target, and only a page on the host the
 * agent names, over https, receives it.
 */

export const OPERATOR_SENDER = "contact@survive67.com";

export interface MailMsg {
  from: string;
  subject: string;
  date: string;
  snippet: string;
}

export interface CdpTarget {
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): void;
}

export interface Cdp {
  targets(port: number): Promise<CdpTarget[]>;
  open(wsUrl: string): Promise<CdpSession>;
}

export interface FillRequest {
  subject: string;
  field: string;
  port: number;
  selector: string;
  host: string;
}

export class FillError extends Error {}

/** Pick the newest operator mail whose subject contains `subject`, and read `field: value` from it. */
export function credentialFrom(inbox: MailMsg[], subject: string, field: string): { value: string; mailSubject: string } {
  const want = subject.trim().toLowerCase();
  if (!want) throw new FillError("subject is required: part of the operator email's subject line");
  const hits = inbox
    .filter((m) => m.from.toLowerCase().includes(OPERATOR_SENDER) && m.subject.toLowerCase().includes(want))
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  if (!hits.length) throw new FillError(`no email from ${OPERATOR_SENDER} with "${subject}" in its subject. Only the operator's credential mail can be used.`);
  const esc = field.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`^[ \\t]*${esc}[ \\t]*:[ \\t]*(\\S+)[ \\t]*$`, "im").exec(hits[0].snippet);
  if (!m) throw new FillError(`the email "${hits[0].subject}" has no "${field}:" line`);
  return { value: m[1], mailSubject: hits[0].subject };
}

/** Default transport: the browser's own DevTools endpoint on localhost, Node's global WebSocket. */
export const localCdp: Cdp = {
  async targets(port) {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`);
    if (!res.ok) throw new FillError(`no DevTools endpoint on 127.0.0.1:${port} (start Chromium with --remote-debugging-port=${port})`);
    return (await res.json()) as CdpTarget[];
  },
  async open(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((ok, bad) => {
      ws.addEventListener("open", () => ok(), { once: true });
      ws.addEventListener("error", () => bad(new FillError("could not open the DevTools connection")), { once: true });
    });
    let id = 0;
    const waiting = new Map<number, (v: Record<string, unknown>) => void>();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as { id?: number; result?: Record<string, unknown>; error?: { message: string } };
      if (msg.id && waiting.has(msg.id)) {
        waiting.get(msg.id)!(msg.error ? { __error: msg.error.message } : msg.result ?? {});
        waiting.delete(msg.id);
      }
    });
    return {
      send(method, params = {}) {
        const n = ++id;
        ws.send(JSON.stringify({ id: n, method, params }));
        return new Promise((ok) => waiting.set(n, ok));
      },
      close() {
        ws.close();
      },
    };
  },
};

/** Fill the field. Returns only what is safe to show: which page, how many characters. */
export async function fillFromMail(inbox: MailMsg[], req: FillRequest, cdp: Cdp = localCdp): Promise<{ filled: true; chars: number; page: string; from: string }> {
  const port = Number(req.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new FillError("port must be your browser's local DevTools port (1024-65535)");
  const host = String(req.host ?? "").trim().toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) throw new FillError("host must be the site's hostname, e.g. github.com");
  const selector = String(req.selector ?? "").trim();
  if (!selector) throw new FillError("selector is required, e.g. #password");

  const { value, mailSubject } = credentialFrom(inbox, req.subject, req.field);
  const pages = (await cdp.targets(port)).filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
  const page = pages.find((t) => {
    try {
      const u = new URL(t.url);
      return u.protocol === "https:" && u.hostname.toLowerCase() === host;
    } catch {
      return false;
    }
  });
  if (!page) {
    const open = pages.map((t) => {
      try {
        return new URL(t.url).hostname;
      } catch {
        return "?";
      }
    });
    throw new FillError(`no https page on ${host} open in the browser on port ${port} (open: ${open.join(", ") || "none"})`);
  }
  const s = await cdp.open(page.webSocketDebuggerUrl!);
  try {
    const sel = JSON.stringify(selector);
    const focus = await s.send("Runtime.evaluate", {
      expression: `(() => { const el = document.querySelector(${sel}); if (!el) return "missing"; if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return "not-input"; el.focus(); el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`,
      returnByValue: true,
    });
    const state = (focus.result as { value?: string } | undefined)?.value;
    if (state !== "ok") throw new FillError(state === "missing" ? `no element matches ${selector}` : `${selector} is not a text field`);
    await s.send("Input.insertText", { text: value });
    const check = await s.send("Runtime.evaluate", {
      expression: `(() => { const el = document.querySelector(${sel}); return el ? el.value.length : -1; })()`,
      returnByValue: true,
    });
    const len = Number((check.result as { value?: number } | undefined)?.value ?? -1);
    if (len !== value.length) throw new FillError(`the field holds ${len} characters after filling, expected ${value.length}; the page may have changed`);
    return { filled: true, chars: len, page: host, from: mailSubject };
  } finally {
    s.close();
  }
}
