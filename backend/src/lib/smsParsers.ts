/**
 * SMS parsers for Ethiopian payment-notification messages.
 *
 * IMPORTANT / LIMITATION: Banks and telcos change their SMS wording without
 * notice and do not publish a stable spec. These parsers are written against
 * the most commonly reported CBE, Telebirr and Bank of Abyssinia (BOA)
 * notification formats as of early 2026, using a set of fallback regexes so
 * minor wording changes still extract the key fields. Treat anything the
 * parser could not fully read as "unparsed" and let a human confirm it
 * instead of silently dropping or mis-posting it.
 */

export type Provider = "CBE" | "TELEBIRR" | "BOA" | "UNKNOWN";

export interface ParsedSms {
  provider: Provider;
  parsedOk: boolean;
  amount?: number;
  currency?: string;
  counterpartyName?: string;
  counterpartyPhone?: string;
  reference?: string;
  balanceAfter?: number;
  txnTime?: string;
  direction?: "credit" | "debit";
}

function num(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const n = Number(s.replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Detects which provider a raw SMS most likely came from.
 *
 * `sender` is the SMS sender ID / address (e.g. "CBE", "telebirr", "BOA",
 * or a short numeric code) if the forwarding app can supply it. This matters
 * in practice: real bank/telco notification texts often do NOT spell out
 * their own name inside the message body (that's carried by the sender ID
 * instead), so body-only detection misses a lot of real-world messages.
 * Sender is checked first and, when it clearly identifies a provider, wins;
 * otherwise we fall back to scanning the message body.
 */
export function detectProvider(raw: string, sender?: string): Provider {
  if (sender) {
    const s = sender.toLowerCase().replace(/[^a-z]/g, "");
    if (s.includes("telebirr")) return "TELEBIRR";
    if (s.includes("cbe")) return "CBE";
    if (s.includes("boa") || s.includes("abyssinia")) return "BOA";
  }
  const t = raw.toLowerCase();
  if (t.includes("telebirr")) return "TELEBIRR";
  if (t.includes("commercial bank of ethiopia") || t.includes("cbe") || /\bebirr\b/.test(t)) return "CBE";
  if (t.includes("bank of abyssinia") || t.includes("boa") || t.includes("abyssinia")) return "BOA";
  return "UNKNOWN";
}

/**
 * CBE sample formats (varies by product / channel):
 *  "Dear Customer, your Account 1*****1234 has been Credited with ETB 1,500.00
 *   from ABEBE KEBEDE on 23/10/2026. Your Current Balance is ETB 25,430.55.
 *   Ref No: FT24296XXXXX"
 */
function parseCbe(raw: string): ParsedSms {
  const amount = num(raw.match(/credited with\s*(?:ETB|Birr)?\s*([\d,]+(?:\.\d+)?)/i)?.[1])
    ?? num(raw.match(/(?:ETB|Birr)\s*([\d,]+(?:\.\d+)?)\s*(?:has been|was)?\s*(?:credited|debited)/i)?.[1]);
  const direction: "credit" | "debit" = /debit/i.test(raw) && !/credit/i.test(raw) ? "debit" : "credit";
  const counterpartyName = raw.match(/from\s+([A-Z][A-Za-z.\s]{2,40}?)\s+on\s+\d/i)?.[1]?.trim()
    ?? raw.match(/from\s+([A-Z][A-Za-z.\s]{2,40}?)\./i)?.[1]?.trim();
  const balanceAfter = num(raw.match(/(?:current\s+)?balance\s+is\s*(?:ETB|Birr)?\s*([\d,]+(?:\.\d+)?)/i)?.[1]);
  const reference = raw.match(/ref(?:erence)?(?:\.?\s*no\.?)?\s*[:\-]?\s*([A-Z0-9]{6,})/i)?.[1];
  const txnTime = raw.match(/on\s+(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}(?:\s+\d{1,2}:\d{2})?)/i)?.[1];

  const parsedOk = amount !== undefined;
  return {
    provider: "CBE",
    parsedOk,
    amount,
    currency: "ETB",
    counterpartyName,
    reference,
    balanceAfter,
    txnTime,
    direction,
  };
}

/**
 * Telebirr sample format:
 *  "You have received ETB 350.00 from ABEBE KEBEDE(251911XXXXXX). Your
 *   current balance is ETB 2,300.00. Transaction No. CFH1X2Y3Z4 at
 *   2026-10-23 14:05:11"
 */
function parseTelebirr(raw: string): ParsedSms {
  const amount = num(raw.match(/received\s*(?:ETB|Birr)?\s*([\d,]+(?:\.\d+)?)/i)?.[1])
    ?? num(raw.match(/(?:ETB|Birr)\s*([\d,]+(?:\.\d+)?)\s*(?:has been\s*)?(?:received|sent|paid)/i)?.[1]);
  const direction: "credit" | "debit" = /received/i.test(raw) ? "credit" : "debit";
  const counterpartyName = raw.match(/from\s+([A-Za-z.\s]{2,40}?)\s*\(/i)?.[1]?.trim();
  const counterpartyPhone = raw.match(/\((\+?251\d{9}|0\d{9})\)/)?.[1];
  const balanceAfter = num(raw.match(/current\s+balance\s+is\s*(?:ETB|Birr)?\s*([\d,]+(?:\.\d+)?)/i)?.[1]);
  const reference = raw.match(/transaction\s*(?:no\.?|number|id)\s*[:\-]?\s*([A-Z0-9]{6,})/i)?.[1];
  const txnTime = raw.match(/at\s+(\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}(?::\d{2})?)?)/i)?.[1];

  const parsedOk = amount !== undefined;
  return {
    provider: "TELEBIRR",
    parsedOk,
    amount,
    currency: "ETB",
    counterpartyName,
    counterpartyPhone,
    reference,
    balanceAfter,
    txnTime,
    direction,
  };
}

/**
 * BOA sample format:
 *  "Dear Customer your A/C 123****789 is credited with ETB 4,000.00 by
 *   ABEBE KEBEDE Ref: BOAFT2345678 Available Balance ETB 10,200.00
 *   Date: 23-10-2026"
 */
function parseBoa(raw: string): ParsedSms {
  const amount = num(raw.match(/credited with\s*(?:ETB|Birr)?\s*([\d,]+(?:\.\d+)?)/i)?.[1])
    ?? num(raw.match(/(?:ETB|Birr)\s*([\d,]+(?:\.\d+)?)\s*(?:has been\s*)?(?:credited|debited)/i)?.[1]);
  const direction: "credit" | "debit" = /debit/i.test(raw) && !/credit/i.test(raw) ? "debit" : "credit";
  const counterpartyName = raw.match(/by\s+([A-Z][A-Za-z.\s]{2,40}?)\s+ref/i)?.[1]?.trim();
  const balanceAfter = num(raw.match(/(?:available\s+)?balance\s*(?:ETB|Birr)?\s*([\d,]+(?:\.\d+)?)/i)?.[1]);
  const reference = raw.match(/ref(?:erence)?\s*[:\-]?\s*([A-Z0-9]{6,})/i)?.[1];
  const txnTime = raw.match(/date\s*[:\-]?\s*(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4})/i)?.[1];

  const parsedOk = amount !== undefined;
  return {
    provider: "BOA",
    parsedOk,
    amount,
    currency: "ETB",
    counterpartyName,
    reference,
    balanceAfter,
    txnTime,
    direction,
  };
}

export function parseSms(raw: string, providerHint?: Provider, sender?: string): ParsedSms {
  const provider = providerHint && providerHint !== "UNKNOWN" ? providerHint : detectProvider(raw, sender);
  switch (provider) {
    case "CBE":
      return parseCbe(raw);
    case "TELEBIRR":
      return parseTelebirr(raw);
    case "BOA":
      return parseBoa(raw);
    default:
      return { provider: "UNKNOWN", parsedOk: false };
  }
}
