import db from "../db/index.js";
import { nanoid } from "./id.js";
import { HttpError } from "./httpRouter.js";
import { round2, todayStr } from "./branch.js";
import { categorizeTransaction } from "./categorizer.js";

export interface ProductRow {
  id: string; sku: string; name: string; unit: string; cost_price: number; sell_price: number;
  vat_rate: number; reorder_level: number; lead_time_days: number; active: number;
}

export function getProduct(id: string): ProductRow {
  if (!id || typeof id !== "string") throw new HttpError(400, "productId is required");
  const p = db.prepare(`SELECT * FROM products WHERE id = ?`).get(id) as ProductRow | undefined;
  if (!p) throw new HttpError(404, "product not found");
  return p;
}

/** Stock on hand = sum of the signed movements. branchId null = across all branches. */
export function stockOnHand(productId: string, branchId: string | null): number {
  const row = branchId
    ? db.prepare(`SELECT COALESCE(SUM(qty),0) AS q FROM stock_movements WHERE product_id = ? AND branch_id = ?`).get(productId, branchId)
    : db.prepare(`SELECT COALESCE(SUM(qty),0) AS q FROM stock_movements WHERE product_id = ?`).get(productId);
  return round2((row as { q: number }).q);
}

function branchLabel(branchId: string): string {
  return (db.prepare(`SELECT name FROM branches WHERE id = ?`).get(branchId) as { name: string } | undefined)?.name ?? branchId;
}

export function addMovement(m: {
  productId: string; branchId: string; type: "purchase" | "sale" | "sale_return" | "adjustment" | "transfer_in" | "transfer_out";
  qty: number; unitCost?: number | null; date?: string; refType?: string; refId?: string; transferId?: string; note?: string;
}): string {
  const id = nanoid();
  db.prepare(
    `INSERT INTO stock_movements (id, product_id, branch_id, type, qty, unit_cost, date, ref_type, ref_id, transfer_id, note)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(id, m.productId, m.branchId, m.type, m.qty, m.unitCost ?? null, m.date ?? todayStr(), m.refType ?? null, m.refId ?? null, m.transferId ?? null, m.note ?? null);
  return id;
}

function assertAvailable(product: ProductRow, branchId: string, needed: number) {
  const have = stockOnHand(product.id, branchId);
  if (have < needed) {
    throw new HttpError(409, `Insufficient stock for ${product.name} at ${branchLabel(branchId)}: have ${have}, need ${needed}`);
  }
}

/**
 * Receive purchased stock. Updates the product's weighted-average cost across
 * all branches and records the purchase as an expense in the ledger
 * (cash-basis, consistent with the rest of this app's simplified ledger).
 */
export function receiveStock(input: { productId: string; branchId: string; qty: number; unitCost: number; date?: string; supplier?: string; recordExpense?: boolean }) {
  if (!(input.qty > 0)) throw new HttpError(400, "qty must be > 0");
  if (!(input.unitCost >= 0)) throw new HttpError(400, "unitCost must be >= 0");
  const product = getProduct(input.productId);
  const onHandAll = Math.max(0, stockOnHand(product.id, null));
  const newCost = round2((onHandAll * product.cost_price + input.qty * input.unitCost) / (onHandAll + input.qty));
  const date = input.date ?? todayStr();

  const movementId = addMovement({ productId: product.id, branchId: input.branchId, type: "purchase", qty: input.qty, unitCost: input.unitCost, date, refType: "purchase", note: input.supplier });
  db.prepare(`UPDATE products SET cost_price = ? WHERE id = ?`).run(newCost, product.id);

  let transactionId: string | null = null;
  if (input.recordExpense !== false && input.unitCost > 0) {
    const total = round2(input.qty * input.unitCost);
    const description = `Stock purchase: ${input.qty} ${product.unit} ${product.name}${input.supplier ? ` from ${input.supplier}` : ""}`;
    transactionId = nanoid();
    const cat = categorizeTransaction(description, -total);
    db.prepare(
      `INSERT INTO transactions (id, date, description, amount, category, category_confidence, category_status, source, source_ref_id, branch_id)
       VALUES (?,?,?,?,?,?,?, 'manual', ?, ?)`
    ).run(transactionId, date, description, -total, "Supplies & Inventory", Math.max(cat.confidence, 0.9), "confirmed", movementId, input.branchId);
  }
  return { movementId, newAverageCost: newCost, transactionId };
}

export function adjustStock(input: { productId: string; branchId: string; countedQty: number; reason?: string; date?: string }) {
  if (!(input.countedQty >= 0)) throw new HttpError(400, "countedQty must be >= 0");
  const product = getProduct(input.productId);
  const have = stockOnHand(product.id, input.branchId);
  const delta = round2(input.countedQty - have);
  if (delta === 0) return { delta: 0, movementId: null };
  const movementId = addMovement({ productId: product.id, branchId: input.branchId, type: "adjustment", qty: delta, unitCost: product.cost_price, date: input.date, note: input.reason ?? "stock count" });
  return { delta, movementId };
}

export function transferStock(input: { productId: string; fromBranchId: string; toBranchId: string; qty: number; date?: string; note?: string }) {
  if (input.fromBranchId === input.toBranchId) throw new HttpError(400, "source and destination branch must differ");
  if (!(input.qty > 0)) throw new HttpError(400, "qty must be > 0");
  const product = getProduct(input.productId);
  assertAvailable(product, input.fromBranchId, input.qty);
  const transferId = nanoid();
  addMovement({ productId: product.id, branchId: input.fromBranchId, type: "transfer_out", qty: -input.qty, unitCost: product.cost_price, date: input.date, refType: "transfer", refId: transferId, transferId, note: input.note });
  addMovement({ productId: product.id, branchId: input.toBranchId, type: "transfer_in", qty: input.qty, unitCost: product.cost_price, date: input.date, refType: "transfer", refId: transferId, transferId, note: input.note });
  return { transferId };
}

/** Validates availability for every product line, then writes the sale movements. Call inside a DB transaction. */
export function applySaleStock(invoiceId: string, branchId: string, date: string, lines: Array<{ productId: string | null; qty: number }>) {
  // Aggregate by product first so two lines of the same product can't each pass the check but jointly oversell.
  const need = new Map<string, number>();
  for (const l of lines) if (l.productId) need.set(l.productId, (need.get(l.productId) ?? 0) + l.qty);
  for (const [pid, qty] of need) assertAvailable(getProduct(pid), branchId, qty);
  for (const [pid, qty] of need) {
    const p = getProduct(pid);
    addMovement({ productId: pid, branchId, type: "sale", qty: -qty, unitCost: p.cost_price, date, refType: "invoice", refId: invoiceId });
  }
}

/** Returns the stock of a cancelled / credited invoice to the branch it was sold from. */
export function reverseInvoiceStock(invoiceId: string) {
  const sales = db.prepare(`SELECT * FROM stock_movements WHERE ref_type = 'invoice' AND ref_id = ? AND type = 'sale'`).all(invoiceId) as any[];
  const alreadyReturned = db.prepare(`SELECT COUNT(*) AS c FROM stock_movements WHERE ref_type = 'invoice' AND ref_id = ? AND type = 'sale_return'`).get(invoiceId) as { c: number };
  if (alreadyReturned.c > 0) return 0; // idempotent
  for (const s of sales) {
    addMovement({ productId: s.product_id, branchId: s.branch_id, type: "sale_return", qty: Math.abs(s.qty), unitCost: s.unit_cost, refType: "invoice", refId: invoiceId, note: "invoice cancelled / credited" });
  }
  return sales.length;
}

export function inventoryValuation(branchId: string | null) {
  const rows = db.prepare(
    `SELECT p.id, p.sku, p.name, p.cost_price, COALESCE(SUM(m.qty),0) AS qty
     FROM products p LEFT JOIN stock_movements m ON m.product_id = p.id ${branchId ? "AND m.branch_id = ?" : ""}
     WHERE p.active = 1 GROUP BY p.id`
  ).all(...(branchId ? [branchId] : [])) as Array<{ id: string; sku: string; name: string; cost_price: number; qty: number }>;
  const items = rows.map((r) => ({ ...r, qty: round2(r.qty), value: round2(Math.max(0, r.qty) * r.cost_price) }));
  return { total: round2(items.reduce((s, i) => s + i.value, 0)), items };
}
