import { createHash } from "node:crypto";

/**
 * PII tokenization (plan Data Q13): customer emails/phones/names-in-emails become
 * stable tokens before anything leaves the private store. Deterministic per run
 * (salted hash), so the same customer is the same token across documents while
 * the mapping stays uninvertible without the salt (kept private, never published).
 */

export function scrub(text: string, salt: string): string {
  // Order matters: cards before phones (a card number would otherwise match the
  // looser phone pattern first). Dates and money survive via replacer validation.
  let out = text.replace(EMAIL, (m) => token("customer", m, salt));
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
  return out;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// 7+ digit runs with optional separators, guarded against money/ids by boundaries
const PHONE = /(?<![\d.$])\+?\d[\d\s().-]{6,14}\d(?![\d.])/g;
const IBAN = /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g;
const CARDISH = /\b(?:\d[ -]?){13,19}\b/g;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function token(kind: string, value: string, salt: string): string {
  const h = createHash("sha256").update(salt).update(value.toLowerCase()).digest("hex").slice(0, 6);
  return `${kind}_${h}`;
}
