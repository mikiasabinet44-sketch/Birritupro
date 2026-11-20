import { createRouter } from "../lib/httpRouter.js";
import { nanoid } from "../lib/id.js";
import db from "../db/index.js";
import { calcVat, calcWithholding, RATES } from "../lib/taxEngine.js";

export const taxRouter = createRouter();

taxRouter.get("/filings", (_req, res) => {
  res.json(db.prepare(`SELECT * FROM tax_filings ORDER BY period DESC, tax_type`).all());
});

taxRouter.patch("/filings/:id/status", (req, res) => {
  const { status } = req.body ?? {};
  db.prepare(`UPDATE tax_filings SET status = ? WHERE id = ?`).run(status, req.params.id);
  res.json({ ok: true });
});

taxRouter.get("/rates", (_req, res) => res.json(RATES));

/**
 * Computes net VAT for a period (output VAT on invoices issued, less input VAT paid on purchases),
 * and withholding tax due on recorded expense transactions tagged
 * "Supplies & Inventory" or "Tax Payment" as a simplified proxy for
 * withholding-applicable purchases. Upserts rows into tax_filings.
 */
taxRouter.post("/compute/:period", (req, res) => {
  const period = req.params.period; // 'YYYY-MM'

  // Output VAT = invoices issued in the period that stand, plus invoices later reversed by a registered
  // credit note (they were real sales in their own period), minus credit notes registered in this period.
  // Plainly cancelled invoices (never registered) never happened and are excluded. Covers every branch:
  // VAT is filed per taxpayer, not per branch.
  const invoices = db.prepare(
    `SELECT i.* FROM invoices i WHERE i.issue_date LIKE ?
       AND (i.status != 'cancelled' OR EXISTS (SELECT 1 FROM einvoices e WHERE e.invoice_id = i.id AND e.doc_type = 'credit_note' AND e.status = 'registered'))`
  ).all(`${period}%`) as any[];
  const credits = db.prepare(
    `SELECT COALESCE(SUM(json_extract(payload,'$.totals.net')),0) AS net, COALESCE(SUM(json_extract(payload,'$.totals.vat')),0) AS vat, COUNT(*) AS n
     FROM einvoices WHERE doc_type = 'credit_note' AND status = 'registered' AND registered_at LIKE ?`
  ).get(`${period}%`) as { net: number; vat: number; n: number };
  const vatBase = round2(invoices.reduce((s, i) => s + i.amount, 0) - credits.net);
  const vatAmount = round2(invoices.reduce((s, i) => s + i.vat_amount, 0) - credits.vat);

  // Input VAT: VAT paid on purchases in the period (only where it was recorded against a valid supplier invoice).
  const inputVat = round2(
    (db.prepare(`SELECT COALESCE(SUM(input_vat),0) AS v FROM transactions WHERE date LIKE ? AND amount < 0`).get(`${period}%`) as { v: number }).v
  );
  const netVat = round2(vatAmount - inputVat); // negative = a credit to carry forward / claim, not a payment

  // Withholding is on the pre-VAT value of qualifying purchases.
  const expenseTxns = db.prepare(
    `SELECT amount, input_vat FROM transactions WHERE date LIKE ? AND amount < 0 AND category = 'Supplies & Inventory'`
  ).all(`${period}%`) as any[];
  const whBase = round2(expenseTxns.reduce((s, t) => s + Math.abs(t.amount) - (t.input_vat ?? 0), 0));
  const whAmount = calcWithholding(whBase);

  const vatLocked = !upsert(period, "vat", vatBase, netVat, { outputVat: vatAmount, inputVat, netVat, creditCarriedForward: netVat < 0 ? -netVat : 0 });
  const whLocked = !upsert(period, "withholding", whBase, whAmount);

  res.json({
    period,
    vat: { base: vatBase, outputVat: vatAmount, inputVat, netPayable: netVat, creditNotesDeducted: credits.n, locked: vatLocked },
    withholding: { base: whBase, tax: whAmount, locked: whLocked },
  });
});

/** Returns false (and changes nothing) when the filing was already marked filed/paid: a closed period must not silently change. */
function upsert(period: string, taxType: string, base: number, tax: number, detail?: object): boolean {
  const existing = db.prepare(`SELECT id, status FROM tax_filings WHERE period = ? AND tax_type = ?`).get(period, taxType) as any;
  const d = detail ? JSON.stringify(detail) : null;
  if (existing) {
    if (existing.status !== "due") return false;
    db.prepare(`UPDATE tax_filings SET base_amount = ?, tax_amount = ?, detail = ? WHERE id = ?`).run(round2(base), round2(tax), d, existing.id);
  } else {
    db.prepare(`INSERT INTO tax_filings (id, period, tax_type, base_amount, tax_amount, due_date, detail) VALUES (?,?,?,?,?,?,?)`)
      .run(nanoid(), period, taxType, round2(base), round2(tax), nextMonthDeadline(period), d);
  }
  return true;
}

function nextMonthDeadline(period: string): string {
  const [y, m] = period.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 10));
  return d.toISOString().slice(0, 10);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
