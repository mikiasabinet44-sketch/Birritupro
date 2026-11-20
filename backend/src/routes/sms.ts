import { createRouter } from "../lib/httpRouter.js";
import db, { runInTransaction } from "../db/index.js";
import { parseSms, type Provider } from "../lib/smsParsers.js";
import { applyPaymentToInvoice, recordPayment } from "../lib/payments.js";
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
  let out!: ReturnType<typeof recordPayment>;
  runInTransaction(() => {
    out = recordPayment({
      provider: parsed.provider, parsed, rawText, sender: typeof sender === "string" ? sender : null,
      channel: "sms", branchId,
    });
  });

  res.status(201).json({
    id: out.id,
    parsed: out.parsed,
    verificationStatus: out.verificationStatus,
    transactionId: out.transactionId,
    matchCandidates: out.matchCandidates,
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
