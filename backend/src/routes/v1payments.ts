import { createRouter, HttpError } from "../lib/httpRouter.js";
import db, { runInTransaction } from "../db/index.js";
import { writeBranch, branchClause } from "../lib/branch.js";
import { recordPayment } from "../lib/payments.js";
import type { ParsedSms, Provider } from "../lib/smsParsers.js";

// Reachable only through the /api/v1 gateway (API key + scope), never directly.
export const v1PaymentsRouter = createRouter();

const PROVIDERS: Provider[] = ["CBE", "TELEBIRR", "BOA"];

const str = (v: unknown, max = 200): string | undefined => {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw new HttpError(400, "text fields must be strings");
  return v.trim().slice(0, max) || undefined;
};
const money = (v: unknown, field: string, required: boolean): number | undefined => {
  if (v === undefined || v === null) { if (required) throw new HttpError(400, `${field} is required`); return undefined; }
  const n = Number(v);
  if (!Number.isFinite(n) || (field === "amount" && !(n > 0)) || Math.abs(n) > 1e10) throw new HttpError(400, `${field} must be a valid positive number`);
  return Math.round(n * 100) / 100;
};

/**
 * Normalised payment notification from a bank / payment provider / aggregator:
 *   { provider: "CBE"|"TELEBIRR"|"BOA", amount: 1725.00, direction?: "credit"|"debit", currency?: "ETB",
 *     counterpartyName?, counterpartyPhone?, reference?, balanceAfter?, txnTime? (ISO 8601),
 *     externalId? (your own unique id - makes retries safe), branch? }
 */
v1PaymentsRouter.post("/", (req, res) => {
  const b = req.body;
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new HttpError(400, "JSON object body required");

  const provider = String(b.provider ?? "").toUpperCase() as Provider;
  if (!PROVIDERS.includes(provider)) throw new HttpError(400, `provider must be one of ${PROVIDERS.join(", ")}`);
  const amount = money(b.amount, "amount", true)!;
  const currency = str(b.currency, 3)?.toUpperCase() ?? "ETB";
  if (currency !== "ETB") throw new HttpError(400, "only ETB payments are supported");
  const direction = b.direction === undefined ? "credit" : b.direction;
  if (direction !== "credit" && direction !== "debit") throw new HttpError(400, "direction must be 'credit' or 'debit'");
  const externalId = str(b.externalId, 120);

  let date: string | undefined;
  const txnTime = str(b.txnTime, 40);
  if (txnTime) {
    const t = new Date(txnTime);
    if (Number.isNaN(t.getTime())) throw new HttpError(400, "txnTime must be an ISO 8601 date-time");
    date = t.toISOString().slice(0, 10);
  }

  const parsed: ParsedSms = {
    provider, parsedOk: true, amount, currency, direction,
    counterpartyName: str(b.counterpartyName), counterpartyPhone: str(b.counterpartyPhone, 30),
    reference: str(b.reference, 80), balanceAfter: money(b.balanceAfter, "balanceAfter", false), txnTime,
  };
  const branchId = writeBranch(req, b.branch ?? b.branchId);

  let out!: ReturnType<typeof recordPayment>;
  runInTransaction(() => {
    out = recordPayment({ provider, parsed, rawText: JSON.stringify(parsed), channel: "api", externalId, branchId, date });
  });
  res.status(out.replayed ? 200 : 201).json({
    id: out.id, status: out.verificationStatus, replayed: out.replayed, transactionId: out.transactionId,
    appliedToInvoiceId: out.appliedToInvoiceId,
    suggestedInvoices: out.matchCandidates.slice(0, 3).map((m) => ({ invoiceNumber: m.invoiceNumber, score: m.score, reasons: m.reasons })),
  });
});

v1PaymentsRouter.get("/", (req, res) => {
  const status = req.query.get("status");
  const c = branchClause(req, "p.branch_id");
  const limit = Math.min(Number(req.query.get("limit") ?? 100) || 100, 500);
  res.json(
    db.prepare(
      `SELECT p.id, p.provider, p.channel, p.external_id, p.amount, p.direction, p.counterparty_name, p.counterparty_phone, p.reference,
              p.verification_status, p.matched_invoice_id, p.received_at, b.code AS branch_code
       FROM payment_events p LEFT JOIN branches b ON b.id = p.branch_id
       WHERE 1=1${status ? " AND p.verification_status = ?" : ""}${c.sql} ORDER BY p.received_at DESC LIMIT ${limit}`
    ).all(...(status ? [status] : []), ...c.params)
  );
});
