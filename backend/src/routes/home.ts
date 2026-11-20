import { createRouter, HttpError } from "../lib/httpRouter.js";
import db from "../db/index.js";
import { branchOf, branchClause, branchName } from "../lib/branch.js";
import { reorderSuggestions } from "../lib/ai/reorder.js";
import { detectAnomalies } from "../lib/ai/anomalies.js";

export const homeRouter = createRouter();

const round2 = (n: number) => Math.round(n * 100) / 100;
const PROVIDERS: Array<{ code: string; label: string }> = [
  { code: "CBE", label: "Commercial Bank of Ethiopia" },
  { code: "TELEBIRR", label: "Telebirr" },
  { code: "BOA", label: "Bank of Abyssinia" },
];
const LABELS: Record<string, string> = { CBE: "CBE", TELEBIRR: "Telebirr", BOA: "BOA", UNKNOWN: "Unrecognised sender" };

/**
 * Where the money came from: money in and out per payment channel (CBE, Telebirr, BOA ...),
 * from the parsed payment messages / API payments, plus everything entered by hand.
 * ?period=YYYY-MM (default: this month) or ?period=all
 */
homeRouter.get("/sources", (req, res) => {
  const requested = req.query.get("period");
  const period = requested ?? new Date().toISOString().slice(0, 7);
  if (period !== "all" && !/^\d{4}-\d{2}$/.test(period)) throw new HttpError(400, "period must be YYYY-MM or 'all'");

  const bc = branchClause(req);
  const pw = period === "all" ? "" : " AND substr(received_at,1,7) = ?";
  const pp = period === "all" ? [] : [period];

  const rows = db.prepare(
    `SELECT provider,
            COALESCE(SUM(CASE WHEN direction = 'debit' THEN 0 ELSE amount END), 0) AS inflow,
            COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount ELSE 0 END), 0) AS outflow,
            COUNT(*) AS n,
            COALESCE(SUM(verification_status = 'verified'), 0) AS verified,
            COALESCE(SUM(verification_status = 'pending'), 0) AS needs_review,
            MAX(received_at) AS last_at
     FROM payment_events
     WHERE parsed_ok = 1 AND amount IS NOT NULL
       AND verification_status NOT IN ('duplicate','rejected','unparsed')${pw}${bc.sql}
     GROUP BY provider`
  ).all(...pp, ...bc.params) as any[];
  const byProvider = new Map(rows.map((r) => [r.provider, r]));

  const payers = db.prepare(
    `SELECT COALESCE(NULLIF(TRIM(counterparty_name), ''), 'Unnamed sender') AS name, SUM(amount) AS total
     FROM payment_events
     WHERE provider = ? AND parsed_ok = 1 AND amount IS NOT NULL AND direction != 'debit'
       AND verification_status NOT IN ('duplicate','rejected','unparsed')${pw}${bc.sql}
     GROUP BY name ORDER BY total DESC LIMIT 3`
  );

  const tw = period === "all" ? "" : " AND substr(date,1,7) = ?";
  const other = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS inflow, COUNT(*) AS n FROM transactions
     WHERE amount > 0 AND source != 'sms_payment'${tw}${bc.sql}`
  ).get(...pp, ...bc.params) as any;

  const codes = [...PROVIDERS.map((p) => p.code), ...[...byProvider.keys()].filter((k) => !PROVIDERS.some((p) => p.code === k))];
  const sources = codes.map((code) => {
    const r = byProvider.get(code);
    return {
      provider: code,
      label: LABELS[code] ?? code,
      fullName: PROVIDERS.find((p) => p.code === code)?.label ?? LABELS[code] ?? code,
      inflow: round2(r?.inflow ?? 0),
      outflow: round2(r?.outflow ?? 0),
      count: r?.n ?? 0,
      verified: r?.verified ?? 0,
      needsReview: r?.needs_review ?? 0,
      lastAt: r?.last_at ?? null,
      topPayers: r ? (payers.all(code, ...pp, ...bc.params) as any[]).map((p) => ({ name: p.name, amount: round2(p.total) })) : [],
    };
  });

  const otherIn = round2(other.inflow);
  const totalIn = round2(sources.reduce((s, x) => s + x.inflow, 0) + otherIn);
  const share = (v: number) => (totalIn > 0 ? Math.round((v / totalIn) * 1000) / 10 : 0);

  res.json({
    scope: branchName(branchOf(req)),
    period,
    totalIn,
    sources: sources.map((s) => ({ ...s, sharePct: share(s.inflow) })),
    other: { label: "Cash, invoices & other entries", inflow: otherIn, count: other.n, sharePct: share(otherIn) },
  });
});

/**
 * A short "today" briefing for the copilot. Every item says what it found and where to go next.
 * It only reads data: nothing here changes the books.
 */
homeRouter.get("/briefing", (req, res) => {
  const b = branchOf(req);
  const bc = branchClause(req);
  const today = new Date().toISOString().slice(0, 10);
  const items: Array<{ kind: string; level: "info" | "attention" | "urgent"; text: string; route?: string; ask?: string }> = [];
  const etb = (n: number) => `ETB ${round2(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  // Money received today, by channel
  const todayRows = db.prepare(
    `SELECT provider, COALESCE(SUM(amount),0) AS total, COUNT(*) AS n FROM payment_events
     WHERE parsed_ok = 1 AND amount IS NOT NULL AND direction != 'debit' AND substr(received_at,1,10) = ?
       AND verification_status NOT IN ('duplicate','rejected','unparsed')${bc.sql}
     GROUP BY provider ORDER BY total DESC`
  ).all(today, ...bc.params) as any[];
  if (todayRows.length) {
    const sum = todayRows.reduce((s, r) => s + r.total, 0);
    const parts = todayRows.map((r) => `${etb(r.total)} via ${LABELS[r.provider] ?? r.provider}`).join(", ");
    items.push({ kind: "money", level: "info", text: `Money in today: ${etb(sum)} (${parts}).`, ask: "Who paid me today?" });
  } else {
    items.push({ kind: "money", level: "info", text: "No payments have arrived today yet.", route: "payments" });
  }

  const review = db.prepare(
    `SELECT COUNT(*) AS c FROM payment_events WHERE verification_status = 'pending' AND parsed_ok = 1${bc.sql}`
  ).get(...bc.params) as any;
  const unread = db.prepare(`SELECT COUNT(*) AS c FROM payment_events WHERE verification_status = 'unparsed'${bc.sql}`).get(...bc.params) as any;
  if (review.c > 0) items.push({ kind: "payments", level: "attention", text: `${review.c} payment${review.c === 1 ? "" : "s"} could not be matched to an invoice and need a look.`, route: "payments" });
  if (unread.c > 0) items.push({ kind: "payments", level: "attention", text: `${unread.c} message${unread.c === 1 ? "" : "s"} could not be read automatically. Enter ${unread.c === 1 ? "it" : "them"} by hand.`, route: "payments" });

  const suggested = db.prepare(`SELECT COUNT(*) AS c FROM transactions WHERE category_status = 'suggested'${bc.sql}`).get(...bc.params) as any;
  if (suggested.c > 0) items.push({ kind: "categories", level: "info", text: `${suggested.c} entr${suggested.c === 1 ? "y has" : "ies have"} a suggested category waiting for your OK.`, route: "transactions" });

  const overdue = db.prepare(
    `SELECT COUNT(*) AS c, COALESCE(SUM(total_amount - amount_paid),0) AS owed FROM invoices
     WHERE status IN ('open','partially_paid','overdue') AND due_date IS NOT NULL AND due_date < ?${bc.sql}`
  ).get(today, ...bc.params) as any;
  if (overdue.c > 0) items.push({ kind: "invoices", level: "urgent", text: `${overdue.c} invoice${overdue.c === 1 ? " is" : "s are"} past due, ${etb(overdue.owed)} still unpaid.`, route: "invoices", ask: "Who owes me money?" });

  const tax = db.prepare(
    `SELECT tax_type, tax_amount, due_date FROM tax_filings WHERE status = 'due' AND tax_amount > 0 AND due_date IS NOT NULL ORDER BY due_date LIMIT 3`
  ).all() as any[];
  for (const t of tax) {
    const days = Math.round((new Date(t.due_date).getTime() - new Date(today).getTime()) / 86400000);
    if (days <= 10) {
      items.push({ kind: "tax", level: days < 0 ? "urgent" : "attention", text: `${String(t.tax_type).replace(/_/g, " ")} of ${etb(t.tax_amount)} is ${days < 0 ? `${-days} day(s) overdue` : days === 0 ? "due today" : `due in ${days} day(s)`}.`, route: "tax" });
    }
  }

  const reorder = reorderSuggestions(b).suggestions.length;
  if (reorder > 0) items.push({ kind: "stock", level: "attention", text: `${reorder} product${reorder === 1 ? "" : "s"} should be reordered soon.`, route: "inventory", ask: "What should I reorder?" });

  const high = detectAnomalies(b).filter((i) => i.severity === "high" && !/overdue/i.test(`${i.kind} ${i.title}`)).slice(0, 2);
  for (const h of high) items.push({ kind: "unusual", level: "urgent", text: h.title, route: "ai" });

  const rank = { urgent: 0, attention: 1, info: 2 } as const;
  items.sort((a, c) => rank[a.level] - rank[c.level]);
  const needs = items.filter((i) => i.level !== "info").length;

  res.json({
    scope: branchName(b),
    date: today,
    headline: needs === 0 ? "Nothing needs your attention right now." : `${needs} thing${needs === 1 ? "" : "s"} need${needs === 1 ? "s" : ""} your attention.`,
    items,
  });
});
