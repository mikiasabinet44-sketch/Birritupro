import db from "../../db/index.js";
import { round2, todayStr } from "../branch.js";
import { tokenize } from "./learner.js";
import { verifyChain } from "../einvoice.js";
import { stockOnHand } from "../inventory.js";

export interface Insight {
  id: string;
  severity: "high" | "medium" | "low";
  kind: string;
  title: string;
  detail: string;
}

const SEV: Record<Insight["severity"], number> = { high: 0, medium: 1, low: 2 };
const money = (n: number) => `ETB ${round2(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dayDiff = (a: string, b: string) => Math.round((new Date(a).getTime() - new Date(b).getTime()) / 86400000);

function jaccard(a: string[], b: string[]): number {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Rule + statistics based checks across ledger, payments, invoices, stock, e-invoices, payroll and tax. */
export function detectAnomalies(branchId: string | null): Insight[] {
  const out: Insight[] = [];
  const bw = branchId ? " AND branch_id = ?" : "";
  const bp = branchId ? [branchId] : [];
  const today = todayStr();
  let n = 0;
  const add = (i: Omit<Insight, "id">) => out.push({ id: `i${++n}`, ...i });

  // 1. Possible duplicate entries: same amount, within 3 days, similar wording.
  const txns = db.prepare(
    `SELECT id, date, description, amount, source, branch_id FROM transactions
     WHERE date >= date('now','-90 days')${bw} ORDER BY date DESC LIMIT 1500`
  ).all(...bp) as any[];
  const toks = txns.map((t) => tokenize(t.description));
  let dupes = 0;
  for (let i = 0; i < txns.length && dupes < 15; i++) {
    for (let j = i + 1; j < txns.length && dupes < 15; j++) {
      const a = txns[i], b = txns[j];
      if (Math.abs(a.amount - b.amount) > 0.005 || a.branch_id !== b.branch_id) continue;
      if (Math.abs(dayDiff(a.date, b.date)) > 3) continue;
      if (jaccard(toks[i], toks[j]) < 0.6) continue;
      dupes++;
      add({
        severity: a.source === "manual" && b.source === "manual" ? "medium" : "low", kind: "possible_duplicate",
        title: `Possible duplicate: ${money(Math.abs(a.amount))}`,
        detail: `"${a.description}" (${a.date}) and "${b.description}" (${b.date}) have the same amount and similar wording.`,
      });
    }
  }

  // 2. Unusually large expenses compared with the same category's own history (robust z-score).
  const exp = db.prepare(
    `SELECT category, amount, date, description FROM transactions WHERE amount < 0 AND date >= date('now','-365 days')${bw}`
  ).all(...bp) as any[];
  const byCat = new Map<string, any[]>();
  for (const e of exp) byCat.set(e.category ?? "Uncategorized", [...(byCat.get(e.category ?? "Uncategorized") ?? []), e]);
  for (const [cat, rows] of byCat) {
    if (rows.length < 6) continue;
    const vals = rows.map((r) => Math.abs(r.amount));
    const med = median(vals);
    const mad = median(vals.map((v) => Math.abs(v - med)));
    for (const r of rows) {
      if (dayDiff(today, r.date) > 60) continue;
      const v = Math.abs(r.amount);
      const z = mad > 0 ? (0.6745 * (v - med)) / mad : v > med * 3 ? 99 : 0;
      if (z > 3.5) {
        add({ severity: "medium", kind: "unusual_expense", title: `Unusually large ${cat} expense: ${money(v)}`, detail: `"${r.description}" on ${r.date}. Typical ${cat} spend is about ${money(med)}.` });
      }
    }
  }

  // 3. Payments received that nobody has matched to an invoice.
  const unmatched = db.prepare(
    `SELECT COUNT(*) AS c, COALESCE(SUM(amount),0) AS s FROM payment_events
     WHERE verification_status = 'verified' AND direction = 'credit' AND matched_invoice_id IS NULL AND received_at < datetime('now','-2 days')${bw}`
  ).get(...bp) as any;
  if (unmatched.c > 0) {
    add({ severity: "medium", kind: "unmatched_payment", title: `${unmatched.c} verified payment(s) not matched to any invoice`, detail: `${money(unmatched.s)} received over 2 days ago. Match them on the Invoices page, or they may be non-invoice income.` });
  }

  const unparsed = (db.prepare(`SELECT COUNT(*) AS c FROM payment_events WHERE verification_status = 'unparsed'${bw}`).get(...bp) as any).c;
  if (unparsed > 0) add({ severity: "medium", kind: "unparsed_sms", title: `${unparsed} payment SMS could not be read`, detail: "Review them under Payment Verification - the bank may have changed its SMS wording." });

  // 4. Payer does not look like the customer it was matched to.
  const mism = db.prepare(
    `SELECT p.amount, p.counterparty_name, p.counterparty_phone, i.invoice_number, c.name AS cname, c.phone AS cphone
     FROM payment_events p JOIN invoices i ON i.id = p.matched_invoice_id JOIN customers c ON c.id = i.customer_id
     WHERE p.counterparty_name IS NOT NULL${bw.replace("branch_id", "p.branch_id")}`
  ).all(...bp) as any[];
  for (const m of mism) {
    const shared = jaccard(tokenize(m.counterparty_name), tokenize(m.cname)) > 0;
    const samePhone = m.counterparty_phone && m.cphone && m.counterparty_phone.replace(/\D/g, "").slice(-9) === m.cphone.replace(/\D/g, "").slice(-9);
    if (!shared && !samePhone) {
      add({ severity: "low", kind: "payer_mismatch", title: `Payment for ${m.invoice_number} came from a different name`, detail: `Paid by "${m.counterparty_name}" but the customer is "${m.cname}" (${money(m.amount)}). Fine if a third party paid; worth a glance.` });
    }
  }

  // 5. Overdue receivables.
  const overdue = db.prepare(
    `SELECT i.invoice_number, i.due_date, i.total_amount - i.amount_paid AS owed, c.name AS cname
     FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
     WHERE i.status IN ('open','partially_paid','overdue') AND i.due_date IS NOT NULL AND i.due_date < ?${bw.replace("branch_id", "i.branch_id")}
     ORDER BY i.due_date LIMIT 15`
  ).all(today, ...bp) as any[];
  for (const o of overdue) {
    const days = dayDiff(today, o.due_date);
    add({ severity: days > 30 ? "high" : "medium", kind: "overdue_invoice", title: `${o.invoice_number} is ${days} day(s) overdue`, detail: `${o.cname ?? "Customer"} owes ${money(o.owed)} (due ${o.due_date}).` });
  }

  // 6. Inventory: negative stock and large write-downs.
  const products = db.prepare(`SELECT id, name, cost_price FROM products WHERE active = 1`).all() as any[];
  const branches = db.prepare(`SELECT id, name FROM branches WHERE active = 1${branchId ? " AND id = ?" : ""}`).all(...bp) as any[];
  for (const p of products) for (const b of branches) {
    const q = stockOnHand(p.id, b.id);
    if (q < 0) add({ severity: "high", kind: "negative_stock", title: `Negative stock: ${p.name} at ${b.name} (${q})`, detail: "Stock went below zero - a delivery wasn't recorded or a sale was posted to the wrong branch." });
  }
  const writedowns = db.prepare(
    `SELECT m.qty, m.unit_cost, m.date, m.note, p.name, b.name AS bname FROM stock_movements m JOIN products p ON p.id = m.product_id JOIN branches b ON b.id = m.branch_id
     WHERE m.type = 'adjustment' AND m.qty < 0 AND m.date >= date('now','-60 days')${bw.replace("branch_id", "m.branch_id")}`
  ).all(...bp) as any[];
  for (const w of writedowns) {
    const value = Math.abs(w.qty) * (w.unit_cost ?? 0);
    if (value >= 500) add({ severity: "medium", kind: "stock_writedown", title: `Stock written down: ${Math.abs(w.qty)} x ${w.name} at ${w.bname}`, detail: `About ${money(value)} of stock removed on ${w.date}${w.note ? ` (${w.note})` : ""}. Confirm it is genuine shrinkage/damage.` });
  }

  // 7. E-invoicing health.
  const rejected = db.prepare(`SELECT doc_number, submission_log FROM einvoices WHERE status = 'rejected'${bw}`).all(...bp) as any[];
  for (const r of rejected) {
    let why = "";
    try { why = (JSON.parse(r.submission_log)?.errors ?? []).join("; "); } catch { /* ignore */ }
    add({ severity: "high", kind: "einvoice_rejected", title: `E-invoice ${r.doc_number} was rejected`, detail: why || "See the submission log." });
  }
  const noEinv = (db.prepare(
    `SELECT COUNT(*) AS c FROM invoices i WHERE i.status != 'cancelled'${bw.replace("branch_id", "i.branch_id")}
       AND NOT EXISTS (SELECT 1 FROM einvoices e WHERE e.invoice_id = i.id AND e.doc_type = 'invoice' AND e.status IN ('pending','registered'))`
  ).get(...bp) as any).c;
  if (noEinv > 0) add({ severity: "low", kind: "missing_einvoice", title: `${noEinv} invoice(s) have no e-invoice yet`, detail: "VAT invoices will need to be registered as e-invoices once the Ministry of Revenue rollout reaches your business." });
  const chain = verifyChain();
  if (!chain.intact) add({ severity: "high", kind: "einvoice_chain_broken", title: "E-invoice audit chain is broken", detail: chain.problems.map((p) => `${p.docNumber}: ${p.problem}`).join(" | ") });

  // 8. Payroll data gaps and tax deadlines.
  const gaps = (db.prepare(`SELECT COUNT(*) AS c FROM employees WHERE active = 1 AND (tin IS NULL OR tin = '' OR pension_number IS NULL OR pension_number = '')${bw}`).get(...bp) as any).c;
  if (gaps > 0) add({ severity: "low", kind: "payroll_data_gap", title: `${gaps} employee(s) are missing a TIN or pension number`, detail: "These are needed for income-tax and pension filings." });

  const filings = db.prepare(`SELECT period, tax_type, tax_amount, due_date FROM tax_filings WHERE status = 'due' AND due_date IS NOT NULL`).all() as any[];
  for (const f of filings) {
    const d = dayDiff(f.due_date, today);
    if (d < 0) add({ severity: "high", kind: "tax_overdue", title: `${f.tax_type.replace(/_/g, " ")} filing for ${f.period} is ${-d} day(s) overdue`, detail: `${money(f.tax_amount)} was due ${f.due_date}.` });
    else if (d <= 5) add({ severity: "medium", kind: "tax_due_soon", title: `${f.tax_type.replace(/_/g, " ")} filing for ${f.period} is due in ${d} day(s)`, detail: `${money(f.tax_amount)} due ${f.due_date}.` });
  }

  return out.sort((a, b) => SEV[a.severity] - SEV[b.severity]);
}
