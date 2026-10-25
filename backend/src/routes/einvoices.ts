import { createRouter, HttpError } from "../lib/httpRouter.js";
import db, { runInTransaction } from "../db/index.js";
import { branchClause } from "../lib/branch.js";
import { createEInvoiceDoc, getAdapter, qrFor, verifyChain, type EInvoicePayload } from "../lib/einvoice.js";
import { cancelInvoiceCore } from "../lib/invoicing.js";

export const einvoicesRouter = createRouter();

// NOTE: static paths are registered before "/:id" because the router matches in registration order.

einvoicesRouter.get("/mode", (_req, res) => {
  const a = getAdapter();
  res.json({
    mode: a.mode,
    note: a.mode === "sandbox"
      ? "Sandbox: documents are validated locally and receive SBX- numbers that have no legal effect. Real IRN registration with the Ministry of Revenue is not connected."
      : "MoR mode selected, but the MoR adapter is not implemented yet - registration will fail until it is.",
  });
});

einvoicesRouter.get("/verify-chain", (_req, res) => {
  res.json(verifyChain());
});

einvoicesRouter.get("/", (req, res) => {
  const c = branchClause(req, "e.branch_id");
  res.json(
    db.prepare(
      `SELECT e.id, e.invoice_id, e.doc_type, e.doc_number, e.seq, e.status, e.irn, e.registration_mode, e.issued_at, e.registered_at, e.reason,
              i.invoice_number, b.code AS branch_code,
              json_extract(e.payload, '$.totals.total') AS total, json_extract(e.payload, '$.buyer.name') AS buyer
       FROM einvoices e JOIN invoices i ON i.id = e.invoice_id LEFT JOIN branches b ON b.id = e.branch_id
       WHERE 1=1${c.sql} ORDER BY e.seq DESC`
    ).all(...c.params)
  );
});

einvoicesRouter.get("/:id", (req, res) => {
  const e = db.prepare(`SELECT * FROM einvoices WHERE id = ?`).get(req.params.id) as any;
  if (!e) throw new HttpError(404, "e-invoice not found");
  res.json({ ...e, payload: JSON.parse(e.payload) });
});

einvoicesRouter.post("/from-invoice/:invoiceId", (req, res) => {
  let out: any;
  runInTransaction(() => { out = createEInvoiceDoc(req.params.invoiceId, "invoice"); });
  res.status(201).json(out);
});

/** Submit for registration. Pending or previously rejected documents can be (re)submitted. */
einvoicesRouter.post("/:id/register", async (req, res) => {
  const e = db.prepare(`SELECT * FROM einvoices WHERE id = ?`).get(req.params.id) as any;
  if (!e) throw new HttpError(404, "e-invoice not found");
  if (e.status === "registered") throw new HttpError(409, "already registered");
  if (e.status === "cancelled") throw new HttpError(409, "this document was cancelled");

  const payload = JSON.parse(e.payload) as EInvoicePayload;
  const result = await getAdapter().register({ docNumber: e.doc_number, payload, chainHash: e.chain_hash });
  const now = new Date().toISOString();

  if (!result.ok) {
    db.prepare(`UPDATE einvoices SET status = 'rejected', registration_mode = ?, submission_log = ? WHERE id = ?`)
      .run(result.mode, JSON.stringify({ at: now, errors: result.errors }), e.id);
    res.status(422).json({ ok: false, status: "rejected", errors: result.errors });
    return;
  }

  let refundDue = 0;
  runInTransaction(() => {
    db.prepare(
      `UPDATE einvoices SET status = 'registered', irn = ?, registration_mode = ?, registered_at = ?, qr_data = ?, submission_log = ? WHERE id = ?`
    ).run(result.irn, result.mode, now, qrFor(payload, e.chain_hash, result.irn ?? null), JSON.stringify({ at: now, ok: true }), e.id);

    // A registered credit note is what actually reverses the sale: cancel the invoice and return its stock.
    if (e.doc_type === "credit_note") {
      const inv = db.prepare(`SELECT amount_paid FROM invoices WHERE id = ?`).get(e.invoice_id) as { amount_paid: number };
      refundDue = inv.amount_paid;
      cancelInvoiceCore(e.invoice_id);
    }
  });
  res.json({ ok: true, status: "registered", irn: result.irn, mode: result.mode, refundDue });
});

einvoicesRouter.post("/:id/credit-note", (req, res) => {
  const orig = db.prepare(`SELECT * FROM einvoices WHERE id = ?`).get(req.params.id) as any;
  if (!orig) throw new HttpError(404, "e-invoice not found");
  if (orig.doc_type !== "invoice") throw new HttpError(400, "a credit note can only be issued against an invoice document");
  if (orig.status !== "registered") throw new HttpError(409, "only a registered e-invoice can be credited - cancel an unregistered one instead");
  const reason = String(req.body?.reason ?? "").trim();
  if (!reason) throw new HttpError(400, "reason is required");
  const existing = db.prepare(`SELECT doc_number FROM einvoices WHERE related_einvoice_id = ? AND status IN ('pending','registered')`).get(orig.id) as any;
  if (existing) throw new HttpError(409, `a credit note (${existing.doc_number}) already exists for this e-invoice`);

  let out: any;
  runInTransaction(() => { out = createEInvoiceDoc(orig.invoice_id, "credit_note", { reason, relatedId: orig.id }); });
  res.status(201).json({ ...out, note: "Credit note created (full reversal). Register it to cancel the invoice and return stock." });
});
