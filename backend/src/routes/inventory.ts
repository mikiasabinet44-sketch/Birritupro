import { createRouter, HttpError } from "../lib/httpRouter.js";
import { nanoid } from "../lib/id.js";
import db, { runInTransaction } from "../db/index.js";
import { branchOf, branchClause, writeBranch, round2 } from "../lib/branch.js";
import { addMovement, adjustStock, getProduct, inventoryValuation, receiveStock, stockOnHand, transferStock } from "../lib/inventory.js";

export const inventoryRouter = createRouter();

function parseProduct(row: any) {
  const sku = String(row.sku ?? "").trim();
  const name = String(row.name ?? "").trim();
  if (!sku) throw new Error("missing sku");
  if (!name) throw new Error("missing name");
  const num = (v: any, d: number) => (v === undefined || v === null || v === "" ? d : Number(v));
  const costPrice = num(row.costPrice ?? row.cost_price, 0);
  const sellPrice = num(row.sellPrice ?? row.sell_price, 0);
  const vatRate = num(row.vatRate ?? row.vat_rate, 0.15);
  const reorderLevel = num(row.reorderLevel ?? row.reorder_level, 0);
  const leadTimeDays = num(row.leadTimeDays ?? row.lead_time_days, 7);
  const openingQty = num(row.openingQty ?? row.opening_qty, 0);
  for (const [k, v] of Object.entries({ costPrice, sellPrice, reorderLevel, leadTimeDays, openingQty })) {
    if (!Number.isFinite(v) || v < 0) throw new Error(`invalid ${k}`);
  }
  if (!Number.isFinite(vatRate) || vatRate < 0 || vatRate > 1) throw new Error("vatRate must be between 0 and 1 (e.g. 0.15)");
  return { sku, name, unit: String(row.unit ?? "pcs").trim() || "pcs", costPrice, sellPrice, vatRate, reorderLevel, leadTimeDays, openingQty };
}

function insertProduct(p: ReturnType<typeof parseProduct>, branchId: string): string {
  if (db.prepare(`SELECT 1 FROM products WHERE sku = ?`).get(p.sku)) throw new Error(`sku ${p.sku} already exists`);
  const id = nanoid();
  db.prepare(
    `INSERT INTO products (id, sku, name, unit, cost_price, sell_price, vat_rate, reorder_level, lead_time_days) VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(id, p.sku, p.name, p.unit, p.costPrice, p.sellPrice, p.vatRate, p.reorderLevel, p.leadTimeDays);
  if (p.openingQty > 0) addMovement({ productId: id, branchId, type: "adjustment", qty: p.openingQty, unitCost: p.costPrice, note: "opening stock" });
  return id;
}

inventoryRouter.get("/products", (req, res) => {
  const b = branchOf(req);
  const rows = db.prepare(`SELECT * FROM products WHERE active = 1 ORDER BY name`).all() as any[];
  res.json(rows.map((p) => ({ ...p, on_hand: stockOnHand(p.id, b), on_hand_all: stockOnHand(p.id, null) })));
});

inventoryRouter.post("/products", (req, res) => {
  const branchId = writeBranch(req, req.body?.branchId);
  let p;
  try { p = parseProduct(req.body ?? {}); } catch (e: any) { throw new HttpError(400, e.message); }
  let id = "";
  try { runInTransaction(() => { id = insertProduct(p, branchId); }); } catch (e: any) { throw new HttpError(e.status ?? 409, e.message); }
  res.status(201).json({ id });
});

/** Bulk import, e.g. from a CSV of the business's existing item list. openingQty is booked into the selected branch. */
inventoryRouter.post("/products/import", (req, res) => {
  const { products } = req.body ?? {};
  if (!Array.isArray(products) || products.length === 0) throw new HttpError(400, "products array is required");
  const branchId = writeBranch(req, req.body?.branchId);
  const results: Array<{ row: number; ok: boolean; id?: string; error?: string }> = [];
  products.forEach((row: any, i: number) => {
    try {
      const p = parseProduct(row);
      let id = "";
      runInTransaction(() => { id = insertProduct(p, branchId); });
      results.push({ row: i + 1, ok: true, id });
    } catch (e: any) {
      results.push({ row: i + 1, ok: false, error: e.message });
    }
  });
  const imported = results.filter((r) => r.ok).length;
  res.status(imported > 0 ? 201 : 400).json({ imported, failed: results.length - imported, results });
});

inventoryRouter.patch("/products/:id", (req, res) => {
  const p = getProduct(req.params.id);
  const b = req.body ?? {};
  const pick = (k: string, d: number) => (b[k] === undefined ? d : Number(b[k]));
  const next = {
    name: b.name ?? p.name, unit: b.unit ?? p.unit,
    sell: pick("sellPrice", p.sell_price), vat: pick("vatRate", p.vat_rate),
    reorder: pick("reorderLevel", p.reorder_level), lead: pick("leadTimeDays", p.lead_time_days),
    active: b.active === undefined ? p.active : b.active ? 1 : 0,
  };
  if ([next.sell, next.vat, next.reorder, next.lead].some((v) => !Number.isFinite(v) || v < 0) || next.vat > 1) throw new HttpError(400, "invalid numeric field");
  db.prepare(`UPDATE products SET name=?, unit=?, sell_price=?, vat_rate=?, reorder_level=?, lead_time_days=?, active=? WHERE id=?`)
    .run(next.name, next.unit, next.sell, next.vat, next.reorder, next.lead, next.active, p.id);
  res.json({ ok: true });
});

/** Product x branch stock matrix. */
inventoryRouter.get("/stock", (_req, res) => {
  const branches = db.prepare(`SELECT id, code, name FROM branches WHERE active = 1 ORDER BY is_head_office DESC, name`).all() as any[];
  const products = db.prepare(`SELECT * FROM products WHERE active = 1 ORDER BY name`).all() as any[];
  const rows = products.map((p) => {
    const perBranch: Record<string, number> = {};
    for (const b of branches) perBranch[b.id] = stockOnHand(p.id, b.id);
    const total = round2(Object.values(perBranch).reduce((s, q) => s + q, 0));
    return { productId: p.id, sku: p.sku, name: p.name, unit: p.unit, reorderLevel: p.reorder_level, costPrice: p.cost_price, perBranch, total };
  });
  res.json({ branches, rows });
});

inventoryRouter.post("/receive", (req, res) => {
  const b = req.body ?? {};
  const branchId = writeBranch(req, b.branchId);
  let out;
  runInTransaction(() => {
    out = receiveStock({ productId: b.productId, branchId, qty: Number(b.qty), unitCost: Number(b.unitCost), date: b.date, supplier: b.supplier, recordExpense: b.recordExpense });
  });
  res.status(201).json(out);
});

inventoryRouter.post("/adjust", (req, res) => {
  const b = req.body ?? {};
  const branchId = writeBranch(req, b.branchId);
  let out;
  runInTransaction(() => { out = adjustStock({ productId: b.productId, branchId, countedQty: Number(b.countedQty), reason: b.reason, date: b.date }); });
  res.status(201).json(out);
});

inventoryRouter.post("/transfer", (req, res) => {
  const b = req.body ?? {};
  const from = branchOf(req, b.fromBranchId);
  const to = branchOf(req, b.toBranchId);
  if (!from || !to) throw new HttpError(400, "fromBranchId and toBranchId are required");
  let out;
  runInTransaction(() => { out = transferStock({ productId: b.productId, fromBranchId: from, toBranchId: to, qty: Number(b.qty), date: b.date, note: b.note }); });
  res.status(201).json(out);
});

inventoryRouter.get("/movements", (req, res) => {
  const c = branchClause(req, "m.branch_id");
  const productId = req.query.get("productId");
  const limit = Math.min(Number(req.query.get("limit") ?? 100) || 100, 500);
  res.json(
    db.prepare(
      `SELECT m.*, p.sku, p.name AS product_name, b.code AS branch_code FROM stock_movements m
       JOIN products p ON p.id = m.product_id JOIN branches b ON b.id = m.branch_id
       WHERE 1=1${c.sql}${productId ? " AND m.product_id = ?" : ""}
       ORDER BY m.date DESC, m.created_at DESC LIMIT ${limit}`
    ).all(...c.params, ...(productId ? [productId] : []))
  );
});

inventoryRouter.get("/valuation", (req, res) => {
  res.json(inventoryValuation(branchOf(req)));
});
