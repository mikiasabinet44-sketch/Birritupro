import { createRouter } from "../lib/httpRouter.js";
import db from "../db/index.js";
import { branchOf, branchName } from "../lib/branch.js";
import { inventoryValuation } from "../lib/inventory.js";
import { reorderSuggestions } from "../lib/ai/reorder.js";
import { detectAnomalies } from "../lib/ai/anomalies.js";

export const dashboardRouter = createRouter();

dashboardRouter.get("/summary", (req, res) => {
  const b = branchOf(req);
  const bw = b ? " AND branch_id = ?" : "";
  const bp = b ? [b] : [];
  const one = (sql: string, ...params: any[]) => db.prepare(sql).get(...params) as any;

  const income = one(`SELECT COALESCE(SUM(amount),0) as v FROM transactions WHERE amount > 0${bw}`, ...bp).v;
  const expense = one(`SELECT COALESCE(SUM(amount),0) as v FROM transactions WHERE amount < 0${bw}`, ...bp).v;
  const pendingReview = one(`SELECT COUNT(*) as c FROM transactions WHERE category_status = 'suggested'${bw}`, ...bp).c;
  const unparsedSms = one(`SELECT COUNT(*) as c FROM payment_events WHERE verification_status = 'unparsed'${bw}`, ...bp).c;
  const verifiedSms = one(`SELECT COUNT(*) as c FROM payment_events WHERE verification_status = 'verified'${bw}`, ...bp).c;
  const openInvoices = one(`SELECT COUNT(*) as c, COALESCE(SUM(total_amount-amount_paid),0) as outstanding FROM invoices WHERE status IN ('open','partially_paid','overdue')${bw}`, ...bp);
  const taxDue = one(`SELECT COALESCE(SUM(tax_amount),0) as v FROM tax_filings WHERE status = 'due'`).v; // company-wide by nature
  const employeeCount = one(`SELECT COUNT(*) as c FROM employees WHERE active = 1${bw}`, ...bp).c;
  const einv = one(
    `SELECT COALESCE(SUM(status = 'pending'),0) AS pending, COALESCE(SUM(status = 'registered'),0) AS registered, COALESCE(SUM(status = 'rejected'),0) AS rejected FROM einvoices WHERE 1=1${bw}`, ...bp
  );
  const insights = detectAnomalies(b);

  res.json({
    scope: branchName(b),
    income,
    expense,
    net: income + expense,
    pendingReview,
    unparsedSms,
    verifiedSms,
    openInvoiceCount: openInvoices.c,
    openInvoiceOutstanding: openInvoices.outstanding,
    taxDue,
    employeeCount,
    inventoryValue: inventoryValuation(b).total,
    reorderCount: reorderSuggestions(b).suggestions.length,
    einvoicePending: einv.pending,
    einvoiceRegistered: einv.registered,
    einvoiceRejected: einv.rejected,
    attention: {
      high: insights.filter((i) => i.severity === "high").length,
      medium: insights.filter((i) => i.severity === "medium").length,
      low: insights.filter((i) => i.severity === "low").length,
    },
  });
});
