import db from "../db/index.js";
import { HttpError } from "./httpRouter.js";
import { reverseInvoiceStock } from "./inventory.js";

export function getInvoice(id: string): any {
  const inv = db.prepare(`SELECT * FROM invoices WHERE id = ?`).get(id);
  if (!inv) throw new HttpError(404, "invoice not found");
  return inv;
}

/** Next human-readable number for a branch, e.g. BOLE-INV-1003. Skips any number already taken. */
export function nextInvoiceNumber(branchId: string): string {
  const b = db.prepare(`SELECT code FROM branches WHERE id = ?`).get(branchId) as { code: string };
  let n = (db.prepare(`SELECT COUNT(*) AS c FROM invoices WHERE branch_id = ?`).get(branchId) as { c: number }).c + 1001;
  for (;;) {
    const candidate = `${b.code}-INV-${n}`;
    if (!db.prepare(`SELECT 1 FROM invoices WHERE invoice_number = ?`).get(candidate)) return candidate;
    n++;
  }
}

/** The state change of cancelling an invoice. Does NOT open its own transaction - callers wrap it. */
export function cancelInvoiceCore(invoiceId: string) {
  db.prepare(`UPDATE invoices SET status = 'cancelled' WHERE id = ?`).run(invoiceId);
  reverseInvoiceStock(invoiceId);
  db.prepare(`UPDATE einvoices SET status = 'cancelled' WHERE invoice_id = ? AND doc_type = 'invoice' AND status IN ('pending','rejected')`).run(invoiceId);
}

/** Guarded cancellation for the plain "cancel invoice" action (credit notes bypass the guards via cancelInvoiceCore). */
export function assertCancellable(invoiceId: string) {
  const inv = getInvoice(invoiceId);
  if (inv.status === "cancelled") throw new HttpError(409, "invoice is already cancelled");
  if (inv.amount_paid > 0) throw new HttpError(409, "this invoice has payments recorded - issue a credit note instead of cancelling");
  const registered = db.prepare(`SELECT 1 FROM einvoices WHERE invoice_id = ? AND doc_type = 'invoice' AND status = 'registered'`).get(invoiceId);
  if (registered) throw new HttpError(409, "this invoice is registered as an e-invoice - issue a credit note instead of cancelling");
}
