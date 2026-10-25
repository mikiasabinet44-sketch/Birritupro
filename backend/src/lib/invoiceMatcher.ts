import db from "../db/index.js";

export interface MatchCandidate {
  invoiceId: string;
  invoiceNumber: string;
  score: number;
  reasons: string[];
}

interface InvoiceRow {
  id: string;
  invoice_number: string;
  customer_id: string | null;
  total_amount: number;
  amount_paid: number;
  status: string;
}

interface CustomerRow {
  id: string;
  name: string;
  phone: string | null;
}

/**
 * Finds the best open invoice(s) for a verified payment event, using:
 *  - exact / near-exact amount match (highest weight)
 *  - counterparty phone matching a known customer's phone
 *  - counterparty name fuzzy-matching a known customer's name
 * Returns candidates sorted best-first; caller decides whether to
 * auto-apply (score >= 0.8) or leave for manual review.
 */
export function findInvoiceMatches(payment: {
  amount: number;
  counterpartyName?: string | null;
  counterpartyPhone?: string | null;
}): MatchCandidate[] {
  const openInvoices = db
    .prepare(`SELECT id, invoice_number, customer_id, total_amount, amount_paid, status
               FROM invoices WHERE status IN ('open','partially_paid','overdue')`)
    .all() as InvoiceRow[];

  const customers = db.prepare(`SELECT id, name, phone FROM customers`).all() as CustomerRow[];
  const customerById = new Map(customers.map((c) => [c.id, c]));

  const candidates: MatchCandidate[] = [];

  for (const inv of openInvoices) {
    const remaining = round2(inv.total_amount - inv.amount_paid);
    if (remaining <= 0) continue;

    let score = 0;
    const reasons: string[] = [];

    const amountDiff = Math.abs(remaining - payment.amount);
    if (amountDiff < 0.01) {
      score += 0.6;
      reasons.push("exact amount match");
    } else if (amountDiff / remaining < 0.02) {
      score += 0.45;
      reasons.push("amount within 2%");
    }

    const cust = inv.customer_id ? customerById.get(inv.customer_id) : undefined;
    if (cust) {
      if (payment.counterpartyPhone && cust.phone && normalizePhone(cust.phone) === normalizePhone(payment.counterpartyPhone)) {
        score += 0.35;
        reasons.push("phone matches customer record");
      }
      if (payment.counterpartyName && cust.name && fuzzyNameMatch(cust.name, payment.counterpartyName)) {
        score += 0.25;
        reasons.push("payer name matches customer record");
      }
    }

    if (score > 0) {
      candidates.push({ invoiceId: inv.id, invoiceNumber: inv.invoice_number, score: Math.min(score, 1), reasons });
    }
  }

  return candidates.sort((a, b) => b.score - a.score);
}

function normalizePhone(p: string): string {
  const digits = p.replace(/\D/g, "");
  return digits.length === 9 ? "251" + digits : digits.replace(/^0/, "251");
}

function fuzzyNameMatch(a: string, b: string): boolean {
  const na = a.toLowerCase().replace(/[^a-z\s]/g, "").trim();
  const nb = b.toLowerCase().replace(/[^a-z\s]/g, "").trim();
  if (!na || !nb) return false;
  if (na === nb) return true;
  const wordsA = new Set(na.split(/\s+/));
  const wordsB = nb.split(/\s+/);
  const overlap = wordsB.filter((w) => wordsA.has(w)).length;
  return overlap >= Math.min(2, wordsB.length);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
