import db from "../db/index.js";
import { nanoid } from "./id.js";
import { findInvoiceMatches } from "./invoiceMatcher.js";
import { smartCategorize } from "./ai/learner.js";
import type { ParsedSms, Provider } from "./smsParsers.js";
import { round2 } from "./branch.js";
import { matchBillToPayment } from "./sales.js";

export interface RecordPaymentInput {
  provider: Provider;
  parsed: ParsedSms;
  rawText: string;            // SMS body, or a JSON rendering of the API payload (kept for audit)
  sender?: string | null;
  channel: "sms" | "api";
  externalId?: string | null; // idempotency handle supplied by an API caller
  branchId: string;
  date?: string;              // ledger date (YYYY-MM-DD); defaults to today
}

export interface RecordPaymentResult {
  id: string;
  parsed: ParsedSms;
  verificationStatus: string;
  transactionId: string | null;
  matchCandidates: ReturnType<typeof findInvoiceMatches>;
  appliedToInvoiceId: string | null;
  replayed: boolean;
}

/**
 * The single place a payment becomes books: stores the payment event, drops obvious duplicates,
 * posts a ledger transaction, and auto-applies it to an open invoice when the match is confident.
 * Used by both the SMS webhook and the API-key payments endpoint, so they behave identically.
 * Call inside a DB transaction.
 */
export function recordPayment(inp: RecordPaymentInput): RecordPaymentResult {
  const { parsed } = inp;

  if (inp.externalId) {
    const prior = db.prepare(`SELECT * FROM payment_events WHERE channel = ? AND external_id = ?`).get(inp.channel, inp.externalId) as any;
    if (prior) {
      return {
        id: prior.id, parsed, verificationStatus: prior.verification_status, transactionId: prior.transaction_id ?? null,
        matchCandidates: [], appliedToInvoiceId: prior.matched_invoice_id ?? null, replayed: true,
      };
    }
  }

  const id = nanoid();
  let verificationStatus = parsed.parsedOk ? "verified" : "unparsed";
  if (parsed.parsedOk && parsed.reference) {
    const dup = db.prepare(`SELECT id FROM payment_events WHERE provider = ? AND reference = ?`).get(parsed.provider, parsed.reference);
    if (dup) verificationStatus = "duplicate";
  }

  db.prepare(
    `INSERT INTO payment_events
      (id, provider, sender, raw_text, parsed_ok, amount, currency, counterparty_name, counterparty_phone,
       reference, balance_after, txn_time, direction, verification_status, branch_id, channel, external_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id, parsed.provider, inp.sender ?? null, inp.rawText, parsed.parsedOk ? 1 : 0, parsed.amount ?? null, parsed.currency ?? "ETB",
    parsed.counterpartyName ?? null, parsed.counterpartyPhone ?? null, parsed.reference ?? null, parsed.balanceAfter ?? null,
    parsed.txnTime ?? null, parsed.direction ?? "credit", verificationStatus, inp.branchId, inp.channel, inp.externalId ?? null
  );

  let transactionId: string | null = null;
  let matchCandidates: ReturnType<typeof findInvoiceMatches> = [];
  let appliedToInvoiceId: string | null = null;

  if (verificationStatus === "verified" && parsed.amount) {
    const signed = parsed.direction === "debit" ? -parsed.amount : parsed.amount;
    const cat = smartCategorize(
      `${parsed.direction === "debit" ? "payment sent to" : "payment received from"} ${parsed.counterpartyName ?? "unknown"} via ${parsed.provider}`,
      signed
    );
    transactionId = nanoid();
    // source 'sms_payment' = "created from a payment_events row" (the column's CHECK predates the API channel).
    db.prepare(
      `INSERT INTO transactions
        (id, date, description, amount, category, category_confidence, category_status, source, source_ref_id, branch_id)
       VALUES (?,?,?,?,?,?,?, 'sms_payment', ?, ?)`
    ).run(
      transactionId, inp.date ?? new Date().toISOString().slice(0, 10),
      `${parsed.provider} ${parsed.direction} of ${parsed.amount} ETB from ${parsed.counterpartyName ?? "unknown"} (ref ${parsed.reference ?? "n/a"})`,
      signed, cat.category, cat.confidence, "suggested", id, inp.branchId
    );
    db.prepare(`UPDATE payment_events SET transaction_id = ? WHERE id = ?`).run(transactionId, id);

    // Only money coming in can settle an invoice.
    if (parsed.direction !== "debit") {
      matchCandidates = findInvoiceMatches({ amount: parsed.amount, counterpartyName: parsed.counterpartyName, counterpartyPhone: parsed.counterpartyPhone });
      const best = matchCandidates[0];
      if (best && best.score >= 0.8) {
        applyPaymentToInvoice(best.invoiceId, parsed.amount);
        db.prepare(`UPDATE payment_events SET matched_invoice_id = ? WHERE id = ?`).run(best.invoiceId, id);
        appliedToInvoiceId = best.invoiceId;
      }
      // Not an invoice? It may be a customer paying a restaurant / shop bill by Telebirr or bank transfer.
      if (!appliedToInvoiceId) {
        matchBillToPayment({ amount: parsed.amount, provider: parsed.provider, rawText: inp.rawText, reference: parsed.reference, branchId: inp.branchId, transactionId, paymentEventId: id });
      }
    }
  }

  return { id, parsed, verificationStatus, transactionId, matchCandidates, appliedToInvoiceId, replayed: false };
}

export function applyPaymentToInvoice(invoiceId: string, amount: number) {
  const inv = db.prepare(`SELECT * FROM invoices WHERE id = ?`).get(invoiceId) as any;
  if (!inv) return;
  const newPaid = round2(inv.amount_paid + amount);
  const status = newPaid >= inv.total_amount - 0.01 ? "paid" : "partially_paid";
  db.prepare(`UPDATE invoices SET amount_paid = ?, status = ? WHERE id = ?`).run(newPaid, status, invoiceId);
}
