import db from "../db/index.js";
import { nanoid } from "./id.js";
import { HttpError } from "./httpRouter.js";
import { round2, todayStr } from "./branch.js";
import { addMovement, applySaleStock, getProduct } from "./inventory.js";
import { smartCategorize } from "./ai/learner.js";

export const METHODS = ["cash", "telebirr", "cbe", "boa", "card"] as const;
export type Method = (typeof METHODS)[number];
const DIGITAL = new Set<string>(["telebirr", "cbe", "boa"]); // money we can see arriving in a bank / wallet message
const PROVIDER_OF: Record<string, Method> = { TELEBIRR: "telebirr", CBE: "cbe", BOA: "boa" };

export interface LineInput { productId?: string | null; sku?: string; description?: string; name?: string; qty: number; unitPrice?: number; vatRate?: number }
export interface BillInput {
  branchId: string; table?: string | null; customerName?: string | null; lines: LineInput[];
  pricesIncludeVat?: boolean; externalId?: string | null; source?: "app" | "pos"; reference?: string | null; date?: string;
}

const nowStr = () => new Date().toISOString().slice(0, 19).replace("T", " ");

function nextNumber(): string {
  const r = db.prepare(`SELECT number FROM bills ORDER BY CAST(SUBSTR(number, 6) AS INTEGER) DESC LIMIT 1`).get() as { number: string } | undefined;
  const n = r ? Number(r.number.slice(5)) + 1 : 1;
  return `BILL-${String(n).padStart(4, "0")}`;
}

export function openShift(branchId: string) {
  return db.prepare(`SELECT * FROM cash_shifts WHERE branch_id = ? AND status = 'open' ORDER BY opened_at DESC LIMIT 1`).get(branchId) as any | undefined;
}

/** Creates an unpaid bill. Call inside a DB transaction. */
export function createBill(inp: BillInput): { id: string; number: string; total: number; replayed: boolean } {
  if (inp.externalId) {
    const prior = db.prepare(`SELECT id, number, total FROM bills WHERE external_id = ?`).get(inp.externalId) as any;
    if (prior) return { id: prior.id, number: prior.number, total: prior.total, replayed: true };
  }
  if (!Array.isArray(inp.lines) || !inp.lines.length) throw new HttpError(400, "a bill needs at least one item");
  if (inp.lines.length > 200) throw new HttpError(400, "too many items on one bill");

  const resolved = inp.lines.map((l) => {
    const qty = Number(l.qty);
    if (!(qty > 0) || qty > 100000) throw new HttpError(400, "each item needs a quantity above 0");
    let product: ReturnType<typeof getProduct> | null = null;
    if (l.productId) product = getProduct(l.productId);
    else if (l.sku) {
      const p = db.prepare(`SELECT id FROM products WHERE sku = ? AND active = 1`).get(String(l.sku)) as { id: string } | undefined;
      if (p) product = getProduct(p.id);
    }
    const description = String(l.description ?? l.name ?? product?.name ?? "").trim().slice(0, 160);
    if (!description) throw new HttpError(400, "each item needs a name");
    const unitPrice = l.unitPrice === undefined || l.unitPrice === null ? product?.sell_price : Number(l.unitPrice);
    if (unitPrice === undefined || !Number.isFinite(unitPrice) || unitPrice < 0 || unitPrice > 1e9) throw new HttpError(400, `${description}: price is missing or invalid`);
    const vatRate = l.vatRate === undefined || l.vatRate === null ? (product?.vat_rate ?? 0.15) : Number(l.vatRate);
    if (!(vatRate >= 0 && vatRate < 1)) throw new HttpError(400, "vatRate must be between 0 and 1");
    return { productId: product?.id ?? null, description, qty, unitPrice, vatRate };
  });

  let subtotal = 0, vat = 0;
  for (const l of resolved) {
    const line = l.qty * l.unitPrice;
    if (inp.pricesIncludeVat) { const net = line / (1 + l.vatRate); subtotal += net; vat += line - net; }
    else { subtotal += line; vat += line * l.vatRate; }
  }
  subtotal = round2(subtotal); vat = round2(vat);
  const total = round2(subtotal + vat);

  const id = nanoid(), number = nextNumber();
  db.prepare(
    `INSERT INTO bills (id, number, branch_id, table_label, customer_name, status, subtotal, vat, total, prices_include_vat, reference, external_id, source)
     VALUES (?,?,?,?,?, 'open', ?,?,?,?,?,?,?)`
  ).run(id, number, inp.branchId, inp.table?.trim().slice(0, 40) || null, inp.customerName?.trim().slice(0, 80) || null, subtotal, vat, total, inp.pricesIncludeVat ? 1 : 0, inp.reference?.trim().slice(0, 80) || null, inp.externalId ?? null, inp.source ?? "app");
  const ins = db.prepare(`INSERT INTO bill_lines (id, bill_id, product_id, description, qty, unit_price, vat_rate) VALUES (?,?,?,?,?,?,?)`);
  for (const l of resolved) ins.run(nanoid(), id, l.productId, l.description, l.qty, l.unitPrice, l.vatRate);
  return { id, number, total, replayed: false };
}

function getBill(id: string): any {
  const b = db.prepare(`SELECT * FROM bills WHERE id = ?`).get(id);
  if (!b) throw new HttpError(404, "bill not found");
  return b;
}

/**
 * Marks a bill paid. When `existingTransactionId` is given (a bank / wallet message already posted the
 * income) no second ledger entry is made, so the same money is never counted twice.
 */
export function settleBill(billId: string, method: Method, opts: { existingTransactionId?: string; paymentEventId?: string; reference?: string; date?: string } = {}) {
  const bill = getBill(billId);
  if (bill.status === "paid") return bill;
  if (bill.status === "void") throw new HttpError(409, "this bill was voided");
  if (!METHODS.includes(method)) throw new HttpError(400, `payment method must be one of ${METHODS.join(", ")}`);

  const lines = db.prepare(`SELECT product_id, qty FROM bill_lines WHERE bill_id = ?`).all(billId) as Array<{ product_id: string | null; qty: number }>;
  const date = opts.date ?? todayStr();
  applySaleStock(billId, bill.branch_id, date, lines.map((l) => ({ productId: l.product_id, qty: l.qty })));

  let transactionId = opts.existingTransactionId ?? null;
  if (transactionId) {
    db.prepare(`UPDATE transactions SET category = 'Sales Revenue', category_status = 'confirmed', category_confidence = 1,
                description = ?, source_ref_id = COALESCE(source_ref_id, ?) WHERE id = ?`)
      .run(`Sale · ${bill.table_label ? bill.table_label + " · " : ""}${bill.number} (${method})`, billId, transactionId);
  } else {
    transactionId = nanoid();
    db.prepare(
      `INSERT INTO transactions (id, date, description, amount, category, category_confidence, category_status, source, source_ref_id, branch_id)
       VALUES (?,?,?,?, 'Sales Revenue', 1, 'confirmed', 'manual', ?, ?)`
    ).run(transactionId, date, `Sale · ${bill.table_label ? bill.table_label + " · " : ""}${bill.number} (${method})`, bill.total, billId, bill.branch_id);
  }

  const shift = method === "cash" ? openShift(bill.branch_id) : null;
  db.prepare(
    `UPDATE bills SET status = 'paid', payment_method = ?, paid_at = ?, shift_id = ?, transaction_id = ?, payment_event_id = ?, reference = COALESCE(?, reference) WHERE id = ?`
  ).run(method, nowStr(), shift?.id ?? null, transactionId, opts.paymentEventId ?? null, opts.reference ?? null, billId);
  return getBill(billId);
}

/** Voids a bill. An unpaid bill just closes; a cash bill is refunded out of the drawer. Bank-paid bills must be refunded through the bank. */
export function voidBill(billId: string, reason: string) {
  const bill = getBill(billId);
  if (bill.status === "void") return bill;
  if (!reason || reason.trim().length < 3) throw new HttpError(400, "give a reason for voiding (it is kept for your records)");
  if (bill.status === "paid") {
    if (bill.payment_method !== "cash") throw new HttpError(409, "this bill was paid through a bank or wallet. Refund it there; the refund is recorded as money out.");
    const shift = openShift(bill.branch_id);
    db.prepare(
      `INSERT INTO transactions (id, date, description, amount, category, category_confidence, category_status, source, source_ref_id, branch_id)
       VALUES (?,?,?,?, 'Sales Revenue', 1, 'confirmed', 'manual', ?, ?)`
    ).run(nanoid(), todayStr(), `Sale · VOID ${bill.number} (cash refunded)`, -bill.total, billId, bill.branch_id);
    if (shift) db.prepare(`INSERT INTO cash_events (id, shift_id, type, amount, note) VALUES (?,?, 'refund', ?, ?)`).run(nanoid(), shift.id, -bill.total, `Void ${bill.number}: ${reason.trim().slice(0, 100)}`);
    const sales = db.prepare(`SELECT product_id, qty FROM bill_lines WHERE bill_id = ? AND product_id IS NOT NULL`).all(billId) as Array<{ product_id: string; qty: number }>;
    for (const s of sales) addMovement({ productId: s.product_id, branchId: bill.branch_id, type: "sale_return", qty: s.qty, refType: "bill", refId: billId, note: `void ${bill.number}` });
  }
  db.prepare(`UPDATE bills SET status = 'void', void_reason = ?, voided_at = ? WHERE id = ?`).run(reason.trim().slice(0, 200), nowStr(), billId);
  return getBill(billId);
}

/**
 * A bank / wallet message just arrived: if it settles exactly one waiting bill, close that bill with it.
 * A bill number written in the message (or reference) wins when several bills have the same amount.
 */
export function matchBillToPayment(p: { amount: number; provider: string; rawText: string; reference?: string | null; branchId: string; transactionId: string; paymentEventId: string }): string | null {
  const method = PROVIDER_OF[p.provider.toUpperCase()];
  const open = db.prepare(
    `SELECT * FROM bills WHERE status = 'open' AND ABS(total - ?) < 0.01 AND created_at >= datetime('now','-2 days')
       AND (payment_method IS NULL OR payment_method = ?) ORDER BY created_at ASC`
  ).all(p.amount, method ?? "") as any[];
  if (!open.length) return null;
  const text = `${p.rawText} ${p.reference ?? ""}`.toUpperCase();
  const byNumber = open.filter((b) => text.includes(b.number) || (b.reference && text.includes(String(b.reference).toUpperCase())));
  let pick: any | undefined;
  if (byNumber.length === 1) pick = byNumber[0];
  else {
    const sameBranch = open.filter((b) => b.branch_id === p.branchId);
    const waiting = sameBranch.filter((b) => b.payment_method === method);
    if (waiting.length === 1) pick = waiting[0];
    else if (sameBranch.length === 1) pick = sameBranch[0];
  }
  if (!pick) return null;
  settleBill(pick.id, method ?? "card", { existingTransactionId: p.transactionId, paymentEventId: p.paymentEventId });
  db.prepare(`UPDATE payment_events SET bill_id = ? WHERE id = ?`).run(pick.id, p.paymentEventId);
  return pick.id;
}

/** A bill was just created and is waiting on a bank / wallet message that may already have arrived. */
export function matchPaymentToBill(billId: string, method: Method): boolean {
  if (!DIGITAL.has(method)) return false;
  const bill = getBill(billId);
  const provider = method.toUpperCase();
  const ev = db.prepare(
    `SELECT id, transaction_id FROM payment_events
      WHERE verification_status = 'verified' AND direction = 'credit' AND provider = ? AND ABS(amount - ?) < 0.01
        AND bill_id IS NULL AND matched_invoice_id IS NULL AND transaction_id IS NOT NULL AND created_at >= datetime('now','-1 day')
      ORDER BY created_at DESC LIMIT 2`
  ).all(provider, bill.total) as Array<{ id: string; transaction_id: string }>;
  if (ev.length !== 1) return false; // none, or ambiguous: leave it for a person
  settleBill(billId, method, { existingTransactionId: ev[0].transaction_id, paymentEventId: ev[0].id });
  db.prepare(`UPDATE payment_events SET bill_id = ? WHERE id = ?`).run(billId, ev[0].id);
  return true;
}

// ------------------------------------------------------------------ Cash drawer

export function expectedCash(shiftId: string): number {
  const s = db.prepare(`SELECT opening_float FROM cash_shifts WHERE id = ?`).get(shiftId) as { opening_float: number };
  const sales = (db.prepare(`SELECT COALESCE(SUM(total),0) AS t FROM bills WHERE shift_id = ? AND paid_at IS NOT NULL AND payment_method = 'cash'`).get(shiftId) as { t: number }).t; // voided bills still took the cash in; the refund is a separate drawer event
  const ev = (db.prepare(`SELECT COALESCE(SUM(amount),0) AS t FROM cash_events WHERE shift_id = ?`).get(shiftId) as { t: number }).t;
  return round2(s.opening_float + sales + ev);
}

export function drawerEvent(branchId: string, type: "payout" | "drop" | "add", amount: number, note: string) {
  const shift = openShift(branchId);
  if (!shift) throw new HttpError(409, "open the drawer first");
  if (!(amount > 0) || amount > 1e9) throw new HttpError(400, "amount must be above 0");
  if (type === "payout" && note.trim().length < 3) throw new HttpError(400, "say what the cash was paid out for");
  let transactionId: string | null = null;
  if (type === "payout") {
    const desc = `Paid in cash from the till: ${note.trim().slice(0, 120)}`;
    const cat = smartCategorize(desc, -amount);
    transactionId = nanoid();
    db.prepare(
      `INSERT INTO transactions (id, date, description, amount, category, category_confidence, category_status, source, source_ref_id, branch_id)
       VALUES (?,?,?,?,?,?,?, 'manual', ?, ?)`
    ).run(transactionId, todayStr(), desc, -amount, cat.category, cat.confidence, "suggested", shift.id, branchId);
  }
  const signed = type === "add" ? amount : -amount;
  db.prepare(`INSERT INTO cash_events (id, shift_id, type, amount, note, transaction_id) VALUES (?,?,?,?,?,?)`).run(nanoid(), shift.id, type, round2(signed), note.trim().slice(0, 160) || null, transactionId);
  return { expected: expectedCash(shift.id) };
}

// ------------------------------------------------------------------ Alerts

export interface SalesInsight { severity: "high" | "medium" | "low"; kind: string; title: string; detail: string }
const etb = (n: number) => `ETB ${round2(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function salesInsights(branchId: string | null): SalesInsight[] {
  const out: SalesInsight[] = [];
  const bw = branchId ? " AND branch_id = ?" : "";
  const bp = branchId ? [branchId] : [];

  // Cash drawer differences in the last 14 days.
  const shifts = db.prepare(
    `SELECT s.*, b.name AS branch FROM cash_shifts s JOIN branches b ON b.id = s.branch_id
      WHERE s.status = 'closed' AND ABS(s.variance) >= 1 AND s.closed_at >= datetime('now','-14 days')${branchId ? " AND s.branch_id = ?" : ""} ORDER BY s.closed_at DESC LIMIT 5`
  ).all(...bp) as any[];
  for (const s of shifts) {
    out.push({
      severity: Math.abs(s.variance) >= 500 ? "high" : "medium", kind: "cash_variance",
      title: `Cash drawer ${s.variance < 0 ? "short" : "over"} by ${etb(Math.abs(s.variance))}`,
      detail: `${s.branch}, closed ${String(s.closed_at).slice(0, 16)}: the system expected ${etb(s.expected)}, the count was ${etb(s.counted)}.`,
    });
  }

  // Many voids today.
  const v = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS t FROM bills WHERE status = 'void' AND voided_at >= date('now')${bw}`).get(...bp) as { n: number; t: number };
  const all = (db.prepare(`SELECT COUNT(*) AS n FROM bills WHERE created_at >= date('now')${bw}`).get(...bp) as { n: number }).n;
  if (v.n >= 3 && v.n / Math.max(all, 1) >= 0.15) {
    out.push({ severity: "medium", kind: "many_voids", title: `${v.n} bills voided today`, detail: `${etb(v.t)} of today's bills were cancelled (${Math.round((v.n / all) * 100)}% of all bills). Check the reasons on the Sales page.` });
  }

  // Bills left unpaid for hours, or waiting on a bank message.
  const stale = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS t FROM bills WHERE status = 'open' AND created_at < datetime('now','-4 hours')${bw}`).get(...bp) as { n: number; t: number };
  if (stale.n > 0) {
    out.push({ severity: "low", kind: "stale_bills", title: `${stale.n} bill${stale.n === 1 ? "" : "s"} still unpaid after 4 hours`, detail: `${etb(stale.t)} is on open bills. Collect it or void the bill.` });
  }

  // An open drawer from a previous day.
  const old = db.prepare(`SELECT COUNT(*) AS n FROM cash_shifts WHERE status = 'open' AND opened_at < datetime('now','-20 hours')${bw}`).get(...bp) as { n: number };
  if (old.n > 0) out.push({ severity: "low", kind: "drawer_open", title: "A cash drawer was left open overnight", detail: "Count the cash and close the drawer so the day's difference can be checked." });
  return out;
}
