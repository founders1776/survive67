import { describe, expect, it } from "vitest";
import { credentialFrom, fillFromMail, FillError, type Cdp, type MailMsg } from "../src/tools/fillsecret.js";

const SECRET = "Zq7-pass-word!x";
const inbox: MailMsg[] = [
  { from: "noreply@github.com", subject: "Your GitHub launch code", date: "2026-10-07T03:17:00Z", snippet: "Password: 25825112" },
  {
    from: "Survive67 operator <contact@survive67.com>",
    subject: "GitHub login (hands request #55)",
    date: "2026-10-07T03:50:00Z",
    snippet: "Username: patch-page-fixes\nPassword: 25825112\n",
  },
  {
    from: "Survive67 operator <contact@survive67.com>",
    subject: "GitHub login (hands request #55), corrected",
    date: "2026-10-07T04:27:00Z",
    snippet: `The earlier email was wrong.\n\nUsername: patch-page-fixes\nEmail: patch@survive67.com\nPassword: ${SECRET}\n`,
  },
];

/** A fake browser: records every DevTools call and keeps one input's value. */
function fakeBrowser(url = "https://github.com/login", selectorExists = true) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let value = "";
  const cdp: Cdp = {
    targets: async () => [{ type: "page", url, webSocketDebuggerUrl: "ws://127.0.0.1:9224/devtools/page/1" }],
    open: async () => ({
      async send(method, params = {}) {
        calls.push({ method, params });
        if (method === "Input.insertText") value += String(params.text);
        if (method === "Runtime.evaluate") {
          const expr = String(params.expression);
          if (expr.includes("el.focus()")) {
            value = "";
            return { result: { value: selectorExists ? "ok" : "missing" } };
          }
          return { result: { value: value.length } };
        }
        return {};
      },
      close() {},
    }),
  };
  return { cdp, calls, get value() { return value; } };
}

describe("fill_from_mail: a credential goes into the form and nowhere else (§5)", () => {
  it("takes the newest operator mail, never a stranger's, and reads one field", () => {
    expect(credentialFrom(inbox, "GitHub login (hands request #55)", "Password").value).toBe(SECRET); // the corrected one is newest
    expect(() => credentialFrom(inbox, "launch code", "Password")).toThrow(/Only the operator's credential mail/);
  });

  it("types the value into the field and returns only the length", async () => {
    const b = fakeBrowser();
    const out = await fillFromMail(inbox, { subject: "corrected", field: "Password", port: 9224, host: "github.com", selector: "#password" }, b.cdp);
    expect(b.value).toBe(SECRET);
    expect(out).toEqual({ filled: true, chars: SECRET.length, page: "github.com", from: "GitHub login (hands request #55), corrected" });
    expect(JSON.stringify(out)).not.toContain(SECRET);
    // the value travels only in the one insertText call, never inside an evaluated script
    const carrying = b.calls.filter((c) => JSON.stringify(c.params).includes(SECRET));
    expect(carrying.map((c) => c.method)).toEqual(["Input.insertText"]);
  });

  it("refuses a page on another host, or not over https, and never touches the browser", async () => {
    for (const url of ["https://github.com.evil.example/login", "http://github.com/login"]) {
      const b = fakeBrowser(url);
      await expect(fillFromMail(inbox, { subject: "corrected", field: "Password", port: 9224, host: "github.com", selector: "#password" }, b.cdp)).rejects.toThrow(FillError);
      expect(b.calls).toEqual([]);
    }
  });

  it("never puts the secret in an error message", async () => {
    const b = fakeBrowser("https://github.com/login", false);
    const err = await fillFromMail(inbox, { subject: "corrected", field: "Password", port: 9224, host: "github.com", selector: "#nope" }, b.cdp).catch((e: Error) => e);
    expect(err).toBeInstanceOf(FillError);
    expect(String((err as Error).message)).not.toContain(SECRET);
    const noField = await fillFromMail(inbox, { subject: "corrected", field: "Token", port: 9224, host: "github.com", selector: "#password" }, fakeBrowser().cdp).catch((e: Error) => e);
    expect(String((noField as Error).message)).toMatch(/no "Token:" line/);
    expect(String((noField as Error).message)).not.toContain(SECRET);
  });
});
