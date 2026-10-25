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
 * Computes VAT output tax for a period from invoices issued in that period,
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

  const expenseTxns = db.prepare(
    `SELECT * FROM transactions WHERE date LIKE ? AND amount < 0 AND category = 'Supplies & Inventory'`
  ).all(`${period}%`) as any[];
  const whBase = expenseTxns.reduce((s, t) => s + Math.abs(t.amount), 0);
  const whAmount = calcWithholding(whBase);

  upsert(period, "vat", vatBase, vatAmount);
  upsert(period, "withholding", whBase, whAmount);

  res.json({
    period,
    vat: { base: vatBase, tax: vatAmount, creditNotesDeducted: credits.n },
    withholding: { base: whBase, tax: whAmount },
  });
});

function upsert(period: string, taxType: string, base: number, tax: number) {
  const existing = db.prepare(`SELECT id FROM tax_filings WHERE period = ? AND tax_type = ?`).get(period, taxType) as any;
  if (existing) {
    db.prepare(`UPDATE tax_filings SET base_amount = ?, tax_amount = ? WHERE id = ?`).run(round2(base), round2(tax), existing.id);
  } else {
    db.prepare(`INSERT INTO tax_filings (id, period, tax_type, base_amount, tax_amount, due_date) VALUES (?,?,?,?,?,?)`)
      .run(nanoid(), period, taxType, round2(base), round2(tax), nextMonthDeadline(period));
  }
}

function nextMonthDeadline(period: string): string {
  const [y, m] = period.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 10));
  return d.toISOString().slice(0, 10);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
