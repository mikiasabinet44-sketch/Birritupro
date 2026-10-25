import { createRouter } from "../lib/httpRouter.js";
import { nanoid } from "../lib/id.js";
import db from "../db/index.js";
import { parseSms, type Provider } from "../lib/smsParsers.js";
import { findInvoiceMatches } from "../lib/invoiceMatcher.js";
import { smartCategorize } from "../lib/ai/learner.js";
import { branchClause, writeBranch } from "../lib/branch.js";

export const smsRouter = createRouter();

/**
 * Webhook ingestion endpoint. Point an SMS-forwarding app/service (e.g. an
 * Android forwarder that POSTs incoming texts to a URL) at:
 *   POST /api/sms/ingest
 *   {
 *     "rawText": "...",
 *     "sender": "CBE" | "telebirr" | "BOA" | "127..." (optional, strongly recommended),
 *     "provider": "CBE" | "TELEBIRR" | "BOA" (optional, forces detection)
 *   }
 *
 * `sender` is the SMS sender ID/address most forwarder apps can report
 * (e.g. Android's getOriginatingAddress()/displayOriginatingAddress). Real
 * bank/telco texts frequently don't name themselves in the body, so sending
 * `sender` makes provider detection far more reliable than body text alone.
 *
 * Optionally protect this route with the X-Webhook-Secret header (see
 * backend/.env.example / SMS_WEBHOOK_SECRET).
 */
smsRouter.post("/ingest", (req, res) => {
  const secret = process.env.SMS_WEBHOOK_SECRET;
  if (secret && req.header("x-webhook-secret") !== secret) {
    return res.status(401).json({ error: "invalid webhook secret" });
  }

  const { rawText, provider, sender } = req.body ?? {};
  if (!rawText || typeof rawText !== "string") {
    return res.status(400).json({ error: "rawText is required" });
  }
  // Multi-branch: each branch's phone forwards with its own branch code, e.g. "branch": "BOLE"
  // (or the X-Branch-Id header). Without one, the payment belongs to the head office.
  const branchId = writeBranch(req, req.body?.branch ?? req.body?.branchCode ?? req.body?.branchId);

  const parsed = parseSms(rawText, provider as Provider | undefined, typeof sender === "string" ? sender : undefined);
  const id = nanoid();

  // Simple duplicate guard: same provider + reference (when we have one) within the table already.
  let verificationStatus: string = parsed.parsedOk ? "verified" : "unparsed";
  if (parsed.parsedOk && parsed.reference) {
    const dup = db.prepare(`SELECT id FROM payment_events WHERE provider = ? AND reference = ?`)
      .get(parsed.provider, parsed.reference);
    if (dup) verificationStatus = "duplicate";
  }

  db.prepare(
    `INSERT INTO payment_events
      (id, provider, sender, raw_text, parsed_ok, amount, currency, counterparty_name, counterparty_phone,
       reference, balance_after, txn_time, direction, verification_status, branch_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    parsed.provider,
    typeof sender === "string" ? sender : null,
    rawText,
    parsed.parsedOk ? 1 : 0,
    parsed.amount ?? null,
    parsed.currency ?? "ETB",
    parsed.counterpartyName ?? null,
    parsed.counterpartyPhone ?? null,
    parsed.reference ?? null,
    parsed.balanceAfter ?? null,
    parsed.txnTime ?? null,
    parsed.direction ?? "credit",
    verificationStatus,
    branchId
  );

  let transactionId: string | null = null;
  let matchResult: ReturnType<typeof findInvoiceMatches> = [];

  if (verificationStatus === "verified" && parsed.amount) {
    // 1. Post to the bookkeeping ledger automatically (AI-categorized as Sales Revenue-ish).
    const catResult = smartCategorize(
      `${parsed.direction === "debit" ? "payment sent to" : "payment received from"} ${parsed.counterpartyName ?? "unknown"} via ${parsed.provider}`,
      parsed.direction === "debit" ? -parsed.amount : parsed.amount
    );
    transactionId = nanoid();
    db.prepare(
      `INSERT INTO transactions
        (id, date, description, amount, category, category_confidence, category_status, source, source_ref_id, branch_id)
       VALUES (?,?,?,?,?,?,?, 'sms_payment', ?, ?)`
    ).run(
      transactionId,
      new Date().toISOString().slice(0, 10),
      `${parsed.provider} ${parsed.direction} of ${parsed.amount} ETB from ${parsed.counterpartyName ?? "unknown"} (ref ${parsed.reference ?? "n/a"})`,
      parsed.direction === "debit" ? -parsed.amount : parsed.amount,
      catResult.category,
      catResult.confidence,
      "suggested",
      id,
      branchId
    );
    db.prepare(`UPDATE payment_events SET transaction_id = ? WHERE id = ?`).run(transactionId, id);

    // 2. Try to auto-match against open invoices.
    matchResult = findInvoiceMatches({
      amount: parsed.amount,
      counterpartyName: parsed.counterpartyName,
      counterpartyPhone: parsed.counterpartyPhone,
    });

    const best = matchResult[0];
    if (best && best.score >= 0.8) {
      applyPaymentToInvoice(best.invoiceId, parsed.amount);
      db.prepare(`UPDATE payment_events SET matched_invoice_id = ? WHERE id = ?`).run(best.invoiceId, id);
    }
  }

  res.status(201).json({
    id,
    parsed,
    verificationStatus,
    transactionId,
    matchCandidates: matchResult,
  });
});

smsRouter.get("/", (req, res) => {
  const status = req.query.get("status");
  const c = branchClause(req, "p.branch_id");
  res.json(
    db.prepare(
      `SELECT p.*, b.code AS branch_code FROM payment_events p LEFT JOIN branches b ON b.id = p.branch_id
       WHERE 1=1${status ? " AND p.verification_status = ?" : ""}${c.sql} ORDER BY p.received_at DESC`
    ).all(...(status ? [status] : []), ...c.params)
  );
});

// Manually apply an (unparsed / unmatched) payment event to a specific invoice.
smsRouter.post("/:id/apply-to-invoice", (req, res) => {
  const { invoiceId } = req.body ?? {};
  const event = db.prepare(`SELECT * FROM payment_events WHERE id = ?`).get(req.params.id) as any;
  if (!event) return res.status(404).json({ error: "payment event not found" });
  if (!event.amount) return res.status(400).json({ error: "payment event has no parsed amount; edit it first" });

  applyPaymentToInvoice(invoiceId, event.amount);
  db.prepare(`UPDATE payment_events SET matched_invoice_id = ?, verification_status = 'verified' WHERE id = ?`)
    .run(invoiceId, req.params.id);
  res.json({ ok: true });
});

smsRouter.patch("/:id/reject", (req, res) => {
  db.prepare(`UPDATE payment_events SET verification_status = 'rejected' WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

function applyPaymentToInvoice(invoiceId: string, amount: number) {
  const inv = db.prepare(`SELECT * FROM invoices WHERE id = ?`).get(invoiceId) as any;
  if (!inv) return;
  const newPaid = round2(inv.amount_paid + amount);
  const status = newPaid >= inv.total_amount - 0.01 ? "paid" : "partially_paid";
  db.prepare(`UPDATE invoices SET amount_paid = ?, status = ? WHERE id = ?`).run(newPaid, status, invoiceId);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
