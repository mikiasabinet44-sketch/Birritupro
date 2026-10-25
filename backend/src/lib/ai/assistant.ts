import db from "../../db/index.js";
import { round2, todayStr } from "../branch.js";
import { DEFAULT_RULES } from "../categorizer.js";
import { inventoryValuation } from "../inventory.js";
import { detectAnomalies } from "./anomalies.js";
import { cashForecast } from "./forecast.js";
import { reorderSuggestions } from "./reorder.js";
import { llmComplete, llmConfigured, llmModel } from "./llm.js";

export interface AssistantTable { columns: string[]; rows: Array<Array<string | number>> }
export interface AssistantReply { mode: "llm" | "offline"; answer: string; table?: AssistantTable; note?: string; scope: string }

const money = (n: number) => `ETB ${round2(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---------------------------------------------------------------------------
// Period + branch parsing from the question
// ---------------------------------------------------------------------------
function ymd(d: Date) { return d.toISOString().slice(0, 10); }

function parsePeriod(q: string): { from: string; to: string; label: string } {
  const now = new Date();
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  const tomorrow = ymd(new Date(now.getTime() + 86400000));
  if (/\btoday\b/.test(q)) return { from: ymd(now), to: tomorrow, label: "today" };
  if (/\byesterday\b/.test(q)) return { from: ymd(new Date(now.getTime() - 86400000)), to: ymd(now), label: "yesterday" };
  if (/last month/.test(q)) return { from: ymd(new Date(Date.UTC(y, m - 1, 1))), to: ymd(new Date(Date.UTC(y, m, 1))), label: "last month" };
  if (/this year|year to date|ytd/.test(q)) return { from: ymd(new Date(Date.UTC(y, 0, 1))), to: tomorrow, label: "this year" };
  if (/last 90 days|quarter/.test(q)) return { from: ymd(new Date(now.getTime() - 90 * 86400000)), to: tomorrow, label: "in the last 90 days" };
  if (/last 30 days/.test(q)) return { from: ymd(new Date(now.getTime() - 30 * 86400000)), to: tomorrow, label: "in the last 30 days" };
  if (/last week/.test(q)) return { from: ymd(new Date(now.getTime() - 14 * 86400000)), to: ymd(new Date(now.getTime() - 7 * 86400000)), label: "last week" };
  if (/this week|past week/.test(q)) return { from: ymd(new Date(now.getTime() - 7 * 86400000)), to: tomorrow, label: "in the past 7 days" };
  return { from: ymd(new Date(Date.UTC(y, m, 1))), to: ymd(new Date(Date.UTC(y, m + 1, 1))), label: "this month" };
}

function branchFromQuestion(q: string): string | null {
  const branches = db.prepare(`SELECT id, code, name FROM branches WHERE active = 1`).all() as any[];
  for (const b of branches) {
    const words = [b.code.toLowerCase(), ...b.name.toLowerCase().replace(/\b(branch|office|head)\b/g, " ").split(/\s+/).filter((w: string) => w.length >= 3)];
    if (words.some((w) => new RegExp(`\\b${esc(w)}\\b`).test(q))) return b.id;
  }
  return null;
}

function findCategory(q: string): string | null {
  const cats = new Set<string>(DEFAULT_RULES.map((r) => r.category));
  for (const r of db.prepare(`SELECT DISTINCT category FROM transactions WHERE category IS NOT NULL`).all() as any[]) cats.add(r.category);
  for (const c of cats) if (q.includes(c.toLowerCase())) return c;
  for (const rule of DEFAULT_RULES) if (rule.keywords.some((k) => new RegExp(`\\b${esc(k.toLowerCase())}`).test(q))) return rule.category;
  return null;
}

// ---------------------------------------------------------------------------
// Snapshot used as the grounding data for the LLM (and by the offline answers)
// ---------------------------------------------------------------------------
export function buildSnapshot(branchId: string | null) {
  const bw = branchId ? " AND branch_id = ?" : "";
  const bp = branchId ? [branchId] : [];
  const now = new Date();
  const month = ymd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
  const lastMonth = ymd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
  const today = todayStr();

  const byMonth = db.prepare(
    `SELECT substr(date,1,7) AS month, COALESCE(SUM(CASE WHEN amount>0 THEN amount END),0) AS income, COALESCE(SUM(CASE WHEN amount<0 THEN -amount END),0) AS expense
     FROM transactions WHERE date >= date('now','-6 months')${bw} GROUP BY month ORDER BY month`
  ).all(...bp);
  const expCat = (from: string, to: string) => db.prepare(
    `SELECT COALESCE(category,'Uncategorized') AS category, ROUND(SUM(-amount),2) AS total FROM transactions WHERE amount<0 AND date>=? AND date<?${bw} GROUP BY category ORDER BY total DESC`
  ).all(from, to, ...bp);
  const reorder = reorderSuggestions(branchId);

  return {
    asOf: today,
    currency: "ETB",
    scope: branchId ? (db.prepare(`SELECT name FROM branches WHERE id = ?`).get(branchId) as any)?.name : "All branches",
    cashPositionLedger: round2((db.prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE 1=1${bw}`).get(...bp) as any).s),
    incomeExpenseByMonth: byMonth,
    expensesByCategoryThisMonth: expCat(month, ymd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)))),
    expensesByCategoryLastMonth: expCat(lastMonth, month),
    revenueByBranchThisMonth: db.prepare(
      `SELECT b.name AS branch, ROUND(COALESCE(SUM(CASE WHEN t.amount>0 THEN t.amount END),0),2) AS income FROM branches b LEFT JOIN transactions t ON t.branch_id = b.id AND t.date >= ?${branchId ? " AND t.branch_id = ?" : ""} WHERE b.active = 1 GROUP BY b.id`
    ).all(month, ...bp),
    openInvoices: db.prepare(
      `SELECT i.invoice_number AS invoice, c.name AS customer, br.name AS branch, i.total_amount AS total, i.amount_paid AS paid, i.due_date AS due
       FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id LEFT JOIN branches br ON br.id = i.branch_id
       WHERE i.status IN ('open','partially_paid','overdue')${bw.replace("branch_id", "i.branch_id")} ORDER BY i.due_date LIMIT 25`
    ).all(...bp),
    topCustomers90d: db.prepare(
      `SELECT c.name AS customer, ROUND(SUM(i.total_amount),2) AS invoiced, COUNT(*) AS invoices FROM invoices i JOIN customers c ON c.id = i.customer_id
       WHERE i.status != 'cancelled' AND i.issue_date >= date('now','-90 days')${bw.replace("branch_id", "i.branch_id")} GROUP BY c.id ORDER BY invoiced DESC LIMIT 8`
    ).all(...bp),
    inventory: {
      valueAtCost: inventoryValuation(branchId).total,
      reorderNow: reorder.suggestions.slice(0, 10).map((s) => ({ product: s.name, branch: s.branchName, onHand: s.onHand, suggestedQty: s.suggestedQty, urgency: s.urgency })),
      slowMoving: reorder.slowMoving.slice(0, 5),
      transferSuggestions: reorder.transfers.slice(0, 5),
    },
    payroll: db.prepare(`SELECT COUNT(*) AS employees, ROUND(COALESCE(SUM(basic_salary + transport_allowance + other_allowance),0),2) AS monthlyGross FROM employees WHERE active = 1${bw}`).get(...bp),
    taxFilingsDue: db.prepare(`SELECT period, tax_type AS type, tax_amount AS amount, due_date AS due FROM tax_filings WHERE status = 'due' ORDER BY due_date`).all(),
    einvoices: db.prepare(`SELECT doc_type AS type, status, COUNT(*) AS count FROM einvoices WHERE 1=1${bw} GROUP BY doc_type, status`).all(...bp),
    attentionItems: detectAnomalies(branchId).slice(0, 10).map((i) => ({ severity: i.severity, title: i.title })),
    forecast: (() => { const f = cashForecast(branchId, 8); return { confidence: f.confidence, firstNegativeWeek: f.firstNegativeWeek, closingCashIn8Weeks: f.weeks[f.weeks.length - 1]?.closing }; })(),
  };
}

// ---------------------------------------------------------------------------
// Offline intent engine
// ---------------------------------------------------------------------------
const HELP = [
  "How much did we spend on rent this month?",
  "What are our sales this month?",
  "Who owes us money?",
  "What should I reorder?",
  "Will we run out of cash?",
  "Anything unusual I should look at?",
  "Compare the branches",
  "What taxes are due?",
];

function answerOffline(question: string, branchId: string | null): AssistantReply {
  const q = question.toLowerCase();
  const asked = branchFromQuestion(q);
  const b = asked ?? branchId;
  const bw = b ? " AND branch_id = ?" : "";
  const bp = b ? [b] : [];
  const scope = b ? ((db.prepare(`SELECT name FROM branches WHERE id = ?`).get(b) as any)?.name ?? "Branch") : "all branches";
  const reply = (answer: string, table?: AssistantTable): AssistantReply => ({ mode: "offline", answer, table, scope });

  if (/anomal|unusual|suspicious|fraud|duplicate|red flag|attention|problem|worry|wrong/.test(q)) {
    const items = detectAnomalies(b);
    if (!items.length) return reply(`Nothing unusual found for ${scope}.`);
    return reply(`I found ${items.length} item(s) worth a look for ${scope}. The most serious first:`, { columns: ["Severity", "What", "Detail"], rows: items.slice(0, 12).map((i) => [i.severity, i.title, i.detail]) });
  }

  if (/forecast|runway|predict|projection|cash ?flow|run out of (cash|money)|next (few )?(weeks?|months?)/.test(q)) {
    const f = cashForecast(b, 8);
    const last = f.weeks[f.weeks.length - 1];
    const head = f.firstNegativeWeek
      ? `Based on recent activity, cash for ${scope} is projected to go negative in the week of ${f.firstNegativeWeek}.`
      : `Based on recent activity, cash for ${scope} stays positive through the next 8 weeks, ending around ${money(last.closing)} (range ${money(last.closingLow)} to ${money(last.closingHigh)}).`;
    return reply(`${head} Forecast confidence: ${f.confidence}. ${f.notes[0] && f.confidence === "low" ? f.notes[0] : ""}`.trim(), {
      columns: ["Week of", "Expected in", "Expected out", "Payroll", "Taxes", "Closing cash"],
      rows: f.weeks.map((w) => [w.weekStart, money(w.expectedIn), money(w.expectedOut), money(w.payroll), money(w.taxes), money(w.closing)]),
    });
  }

  if (/stock|inventory|reorder|restock|running out|out of stock|low on/.test(q)) {
    const r = reorderSuggestions(b);
    if (!r.suggestions.length && !r.slowMoving.length) return reply(`Stock levels look healthy for ${scope}; nothing needs reordering.`);
    const parts = [`${r.suggestions.length} item(s) should be reordered for ${scope}`];
    if (r.transfers.length) parts.push(`${r.transfers.length} could be covered by transferring from another branch instead`);
    if (r.slowMoving.length) parts.push(`${r.slowMoving.length} item(s) haven't sold in 60 days`);
    return reply(parts.join("; ") + ".", {
      columns: ["Product", "Branch", "On hand", "Days of cover", "Suggested qty", "Urgency"],
      rows: r.suggestions.slice(0, 12).map((s) => [s.name, s.branchName, s.onHand, s.daysOfCover ?? "-", s.suggestedQty, s.urgency]),
    });
  }

  if (/payroll|salar|wage|staff|employee/.test(q)) {
    const p = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(basic_salary + transport_allowance + other_allowance),0) AS gross FROM employees WHERE active = 1${bw}`).get(...bp) as any;
    const runs = db.prepare(`SELECT period, status, total_gross, total_net FROM payroll_runs ORDER BY period DESC LIMIT 5`).all() as any[];
    return reply(`${scope}: ${p.n} active employee(s) with a monthly gross payroll of about ${money(p.gross)}.`, runs.length ? { columns: ["Period", "Status", "Gross", "Net"], rows: runs.map((r) => [r.period, r.status, money(r.total_gross), money(r.total_net)]) } : undefined);
  }

  if (/\btax|vat|withholding|pension|paye/.test(q)) {
    const f = db.prepare(`SELECT period, tax_type, tax_amount, due_date, status FROM tax_filings ORDER BY due_date DESC LIMIT 12`).all() as any[];
    const due = f.filter((x) => x.status === "due");
    if (!f.length) return reply("No tax filings have been computed yet. Use Tax Compliance to compute a period.");
    return reply(`${due.length} filing(s) are currently due, totalling ${money(due.reduce((s, x) => s + x.tax_amount, 0))}. Tax is calculated company-wide, not per branch.`, { columns: ["Period", "Type", "Amount", "Due", "Status"], rows: f.map((x) => [x.period, x.tax_type.replace(/_/g, " "), money(x.tax_amount), x.due_date ?? "-", x.status]) });
  }

  if (/owe|outstanding|unpaid|receivable|overdue|collect/.test(q)) {
    const rows = db.prepare(
      `SELECT i.invoice_number, c.name AS customer, i.total_amount - i.amount_paid AS owed, i.due_date FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
       WHERE i.status IN ('open','partially_paid','overdue')${bw.replace("branch_id", "i.branch_id")} ORDER BY owed DESC LIMIT 15`
    ).all(...bp) as any[];
    if (!rows.length) return reply(`No outstanding invoices for ${scope}.`);
    const total = rows.reduce((s, r) => s + r.owed, 0);
    return reply(`Outstanding receivables for ${scope}: ${money(total)} across ${rows.length} open invoice(s).`, { columns: ["Invoice", "Customer", "Owed", "Due"], rows: rows.map((r) => [r.invoice_number, r.customer ?? "-", money(r.owed), r.due_date ?? "-"]) });
  }

  if (/customer|client|who (buys|pays)/.test(q)) {
    const rows = db.prepare(
      `SELECT c.name, ROUND(SUM(i.total_amount),2) AS invoiced, COUNT(*) AS n FROM invoices i JOIN customers c ON c.id = i.customer_id
       WHERE i.status != 'cancelled' AND i.issue_date >= date('now','-90 days')${bw.replace("branch_id", "i.branch_id")} GROUP BY c.id ORDER BY invoiced DESC LIMIT 8`
    ).all(...bp) as any[];
    if (!rows.length) return reply(`No invoices to customers in the last 90 days for ${scope}.`);
    return reply(`Top customers for ${scope} over the last 90 days:`, { columns: ["Customer", "Invoiced", "Invoices"], rows: rows.map((r) => [r.name, money(r.invoiced), r.n]) });
  }

  if (/e-?invoice|\birn\b|fiscal|credit note/.test(q)) {
    const rows = db.prepare(`SELECT doc_type, status, COUNT(*) AS c FROM einvoices WHERE 1=1${bw} GROUP BY doc_type, status`).all(...bp) as any[];
    if (!rows.length) return reply("No e-invoices have been created yet.");
    return reply(`E-invoice documents for ${scope}:`, { columns: ["Type", "Status", "Count"], rows: rows.map((r) => [r.doc_type.replace("_", " "), r.status, r.c]) });
  }

  if (!b && /branch|compare|location/.test(q)) {
    const rows = db.prepare(
      `SELECT br.name, COALESCE(SUM(CASE WHEN t.amount>0 THEN t.amount END),0) AS income, COALESCE(SUM(CASE WHEN t.amount<0 THEN -t.amount END),0) AS expense
       FROM branches br LEFT JOIN transactions t ON t.branch_id = br.id AND t.date >= ? WHERE br.active = 1 GROUP BY br.id ORDER BY income DESC`
    ).all(parsePeriod(q).from) as any[];
    return reply(`Branch comparison ${parsePeriod(q).label}:`, { columns: ["Branch", "Income", "Expenses", "Net"], rows: rows.map((r) => [r.name, money(r.income), money(r.expense), money(r.income - r.expense)]) });
  }

  if (/spen|spent|expens|cost|paid out|outgoing/.test(q)) {
    const { from, to, label } = parsePeriod(q);
    const cat = findCategory(q);
    const rows = db.prepare(
      `SELECT COALESCE(category,'Uncategorized') AS category, SUM(-amount) AS total, COUNT(*) AS n FROM transactions WHERE amount < 0 AND date >= ? AND date < ?${bw}${cat ? " AND category = ?" : ""} GROUP BY category ORDER BY total DESC`
    ).all(from, to, ...bp, ...(cat ? [cat] : [])) as any[];
    const total = rows.reduce((s, r) => s + r.total, 0);
    if (!rows.length) return reply(`No ${cat ? cat.toLowerCase() + " " : ""}expenses recorded ${label} for ${scope}.`);
    return reply(cat ? `${scope} spent ${money(total)} on ${cat} ${label} (${rows[0].n} transaction(s)).` : `${scope} spent ${money(total)} ${label}. Biggest categories:`,
      cat ? undefined : { columns: ["Category", "Spent", "Transactions"], rows: rows.slice(0, 10).map((r) => [r.category, money(r.total), r.n]) });
  }

  if (/sale|revenue|income|earn|turnover|profit|made/.test(q)) {
    const { from, to, label } = parsePeriod(q);
    const sum = (f: string, t: string) => db.prepare(
      `SELECT COALESCE(SUM(CASE WHEN amount>0 THEN amount END),0) AS income, COALESCE(SUM(CASE WHEN amount<0 THEN -amount END),0) AS expense FROM transactions WHERE date >= ? AND date < ?${bw}`
    ).get(f, t, ...bp) as { income: number; expense: number };
    const cur = sum(from, to);
    const spanDays = Math.max(1, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86400000));
    const prev = sum(ymd(new Date(new Date(from).getTime() - spanDays * 86400000)), from);
    const change = prev.income > 0 ? ` (${cur.income >= prev.income ? "up" : "down"} ${Math.abs(round2(((cur.income - prev.income) / prev.income) * 100))}% on the previous period)` : "";
    const profit = /profit/.test(q) ? ` Income minus expenses is ${money(cur.income - cur.expense)}.` : "";
    return reply(`${scope} received ${money(cur.income)} ${label}${change}.${profit}`);
  }

  if (/cash|balance|position|how much (money|do we have)/.test(q)) {
    const s = (db.prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE 1=1${bw}`).get(...bp) as any).s;
    return reply(`The recorded ledger balance for ${scope} is ${money(s)}. This is the sum of transactions in the books, not a bank statement balance.`);
  }

  return reply("I can answer questions about spending, sales, who owes you money, stock, payroll, taxes, e-invoices, branch comparisons, cash forecasts and anything unusual in your books. Try one of these:", { columns: ["Example questions"], rows: HELP.map((h) => [h]) });
}

// ---------------------------------------------------------------------------
export async function askAssistant(question: string, branchId: string | null): Promise<AssistantReply> {
  if (!llmConfigured()) return answerOffline(question, branchId);

  try {
    const snapshot = buildSnapshot(branchId);
    const answer = await llmComplete(
      "You are the bookkeeping assistant inside an Ethiopian SME accounting app. Answer ONLY from the JSON books snapshot provided. " +
        "If the snapshot does not contain what is needed, say so plainly instead of guessing. Amounts are in ETB. Be concise (under 150 words), " +
        "lead with the answer, and mention which branch/period you are describing. Do not give legal or tax-filing advice; point to a qualified accountant for that.",
      `Books snapshot (JSON):\n${JSON.stringify(snapshot)}\n\nQuestion: ${question}`
    );
    return { mode: "llm", answer: answer.trim(), scope: String(snapshot.scope), note: `Answered by ${llmModel()} from a summary of your books.` };
  } catch (err: any) {
    const fallback = answerOffline(question, branchId);
    return { ...fallback, note: `The language model was unavailable (${err?.message ?? "error"}), so this answer came from the built-in rules.` };
  }
}
