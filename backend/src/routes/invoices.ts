import { createRouter, HttpError } from "../lib/httpRouter.js";
import { nanoid } from "../lib/id.js";
import db, { runInTransaction } from "../db/index.js";
import { calcVat, RATES } from "../lib/taxEngine.js";
import { findInvoiceMatches } from "../lib/invoiceMatcher.js";
import { branchClause, writeBranch, round2, todayStr } from "../lib/branch.js";
import { applySaleStock, getProduct } from "../lib/inventory.js";
import { assertCancellable, cancelInvoiceCore, getInvoice, nextInvoiceNumber } from "../lib/invoicing.js";

export const invoicesRouter = createRouter();

invoicesRouter.get("/", (req, res) => {
  const c = branchClause(req, "invoices.branch_id");
  res.json(
    db.prepare(
      `SELECT invoices.*, customers.name AS customer_name, branches.code AS branch_code,
              (SELECT status FROM einvoices e WHERE e.invoice_id = invoices.id AND e.doc_type = 'invoice' ORDER BY e.seq DESC LIMIT 1) AS einvoice_status
       FROM invoices
       LEFT JOIN customers ON customers.id = invoices.customer_id
       LEFT JOIN branches ON branches.id = invoices.branch_id
       WHERE 1=1${c.sql}
       ORDER BY issue_date DESC, invoices.created_at DESC`
    ).all(...c.params)
  );
});

invoicesRouter.get("/:id", (req, res) => {
  const inv = getInvoice(req.params.id);
  const lines = db.prepare(`SELECT * FROM invoice_lines WHERE invoice_id = ?`).all(inv.id);
  const customer = inv.customer_id ? db.prepare(`SELECT * FROM customers WHERE id = ?`).get(inv.customer_id) : null;
  const einvoices = db.prepare(`SELECT id, doc_type, doc_number, status, irn FROM einvoices WHERE invoice_id = ? ORDER BY seq`).all(inv.id);
  res.json({ ...inv, customer, lines, einvoices });
});

/**
 * Create an invoice. Two forms:
 *  - itemised:  { lines: [{ productId?, description?, qty, unitPrice?, vatRate? }], ... }
 *    product lines default to the product's name/price/VAT rate and are deducted from the
 *    selected branch's stock (rejected if the branch doesn't have enough).
 *  - simple:    { amount, includeVat }   (original behaviour, no stock effect)
 */
invoicesRouter.post("/", (req, res) => {
  const b = req.body ?? {};
  const branchId = writeBranch(req, b.branchId);
  const issueDate: string = b.issueDate ?? todayStr();
  const dueDate: string = b.dueDate ?? new Date(new Date(issueDate).getTime() + 30 * 86400000).toISOString().slice(0, 10);

  if (b.customerId && !db.prepare(`SELECT 1 FROM customers WHERE id = ?`).get(b.customerId)) {
    throw new HttpError(400, "unknown customerId");
  }

  type Line = { productId: string | null; description: string; qty: number; unitPrice: number; vatRate: number; net: number; vat: number; total: number };
  const lines: Line[] = [];
  let amount = 0, vatAmount = 0;

  if (Array.isArray(b.lines) && b.lines.length > 0) {
    b.lines.forEach((l: any, i: number) => {
      const product = l.productId ? getProduct(l.productId) : null;
      const qty = Number(l.qty);
      const unitPrice = Number(l.unitPrice ?? product?.sell_price);
      const description = String(l.description ?? product?.name ?? "").trim();
      const vatRate = b.includeVat === false ? 0 : Number(l.vatRate ?? product?.vat_rate ?? RATES.vatRate);
      if (!description) throw new HttpError(400, `line ${i + 1}: description is required`);
      if (!(qty > 0)) throw new HttpError(400, `line ${i + 1}: qty must be > 0`);
      if (!Number.isFinite(unitPrice) || unitPrice < 0) throw new HttpError(400, `line ${i + 1}: unitPrice is required`);
      if (!Number.isFinite(vatRate) || vatRate < 0 || vatRate > 1) throw new HttpError(400, `line ${i + 1}: vatRate must be between 0 and 1`);
      const net = round2(qty * unitPrice);
      const vat = round2(net * vatRate);
      lines.push({ productId: product?.id ?? null, description, qty, unitPrice, vatRate, net, vat, total: round2(net + vat) });
    });
    amount = round2(lines.reduce((s, l) => s + l.net, 0));
    vatAmount = round2(lines.reduce((s, l) => s + l.vat, 0));
  } else {
    if (b.amount === undefined || !(Number(b.amount) > 0)) throw new HttpError(400, "either lines[] or a positive amount is required");
    amount = round2(Number(b.amount));
    vatAmount = b.includeVat === false ? 0 : calcVat(amount);
  }
  const totalAmount = round2(amount + vatAmount);

  const invoiceNumber: string = b.invoiceNumber ? String(b.invoiceNumber).trim() : nextInvoiceNumber(branchId);
  if (db.prepare(`SELECT 1 FROM invoices WHERE invoice_number = ?`).get(invoiceNumber)) {
    throw new HttpError(409, `invoice number ${invoiceNumber} already exists`);
  }

  const id = nanoid();
  runInTransaction(() => {
    db.prepare(
      `INSERT INTO invoices (id, invoice_number, customer_id, issue_date, due_date, amount, vat_amount, total_amount, branch_id)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(id, invoiceNumber, b.customerId ?? null, issueDate, dueDate, amount, vatAmount, totalAmount, branchId);

    const insLine = db.prepare(
      `INSERT INTO invoice_lines (id, invoice_id, product_id, description, qty, unit_price, vat_rate, net, vat, total) VALUES (?,?,?,?,?,?,?,?,?,?)`
    );
    for (const l of lines) insLine.run(nanoid(), id, l.productId, l.description, l.qty, l.unitPrice, l.vatRate, l.net, l.vat, l.total);

    if (lines.length) applySaleStock(id, branchId, issueDate, lines);
  });

  res.status(201).json({ id, invoiceNumber, branchId, amount, vatAmount, totalAmount });
});

// Re-run the matcher for a given invoice against unmatched verified payments.
invoicesRouter.get("/:id/suggested-matches", (req, res) => {
  const inv = getInvoice(req.params.id);
  const unmatched = db.prepare(
    `SELECT * FROM payment_events WHERE verification_status = 'verified' AND matched_invoice_id IS NULL`
  ).all() as any[];

  const results = unmatched
    .map((p) => {
      const matches = findInvoiceMatches({ amount: p.amount, counterpartyName: p.counterparty_name, counterpartyPhone: p.counterparty_phone });
      const mine = matches.find((m) => m.invoiceId === inv.id);
      return mine ? { paymentEventId: p.id, ...mine } : null;
    })
    .filter(Boolean);

  res.json(results);
});

invoicesRouter.post("/:id/cancel", (req, res) => {
  assertCancellable(req.params.id);
  runInTransaction(() => cancelInvoiceCore(req.params.id));
  res.json({ ok: true });
});

invoicesRouter.patch("/:id/status", (req, res) => {
  const { status } = req.body ?? {};
  if (!["open", "partially_paid", "paid", "overdue", "cancelled"].includes(status)) throw new HttpError(400, "invalid status");
  if (status === "cancelled") {
    assertCancellable(req.params.id);
    runInTransaction(() => cancelInvoiceCore(req.params.id));
  } else {
    db.prepare(`UPDATE invoices SET status = ? WHERE id = ?`).run(status, req.params.id);
  }
  res.json({ ok: true });
});
