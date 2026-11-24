import { createRouter, HttpError } from "../lib/httpRouter.js";
import db, { runInTransaction } from "../db/index.js";
import { writeBranch } from "../lib/branch.js";
import { createBill, settleBill, voidBill, matchPaymentToBill, METHODS, type Method } from "../lib/sales.js";

// Reachable only through the /api/v1 gateway (API key + scope), never directly.
export const v1SalesRouter = createRouter();

/**
 * A till / POS reports a closed bill:
 *   { externalId: "POS-1042", table?: "Table 4", customerName?, branch?: "BOLE", time?: ISO,
 *     paymentMethod: "cash" | "telebirr" | "cbe" | "boa" | "card" | "unpaid", reference?,
 *     pricesIncludeVat?: true, items: [{ sku?, name, qty, unitPrice, vatRate? }] }
 * Cash is booked at once. Telebirr / CBE / BOA bills wait for the real bank message and close by themselves when it arrives
 * (or are closed now if it already did). Sending the same externalId again changes nothing.
 */
v1SalesRouter.post("/", (req, res) => {
  const b = req.body;
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new HttpError(400, "JSON object body required");
  const externalId = typeof b.externalId === "string" ? b.externalId.trim().slice(0, 120) : "";
  if (!externalId) throw new HttpError(400, "externalId (your own bill id) is required so retries are safe");
  const method = String(b.paymentMethod ?? "unpaid").toLowerCase();
  if (method !== "unpaid" && !METHODS.includes(method as Method)) throw new HttpError(400, `paymentMethod must be unpaid or one of ${METHODS.join(", ")}`);
  const branchId = writeBranch(req, b.branch ?? b.branchId);

  let out: any;
  runInTransaction(() => {
    const bill = createBill({
      branchId, table: b.table, customerName: b.customerName, lines: Array.isArray(b.items) ? b.items : b.lines,
      pricesIncludeVat: !!b.pricesIncludeVat, externalId, source: "pos", reference: b.reference,
    });
    if (bill.replayed) { out = { id: bill.id, number: bill.number, total: bill.total, replayed: true, status: (db.prepare(`SELECT status FROM bills WHERE id = ?`).get(bill.id) as any).status }; return; }
    let status = "open";
    if (method === "cash") { settleBill(bill.id, "cash"); status = "paid"; }
    else if (method !== "unpaid") {
      db.prepare(`UPDATE bills SET payment_method = ? WHERE id = ?`).run(method, bill.id);
      if (matchPaymentToBill(bill.id, method as Method)) status = "paid";
    }
    out = { id: bill.id, number: bill.number, total: bill.total, status, replayed: false };
  });
  res.status(out.replayed ? 200 : 201).json(out);
});

v1SalesRouter.get("/", (req, res) => {
  const rows = db.prepare(`SELECT id, number, external_id, table_label, status, payment_method, total, created_at, paid_at FROM bills ORDER BY created_at DESC LIMIT 100`).all();
  res.json(rows);
});

v1SalesRouter.post("/:id/void", (req, res) => {
  const bill = db.prepare(`SELECT id FROM bills WHERE id = ? OR external_id = ?`).get(req.params.id, req.params.id) as { id: string } | undefined;
  if (!bill) throw new HttpError(404, "bill not found");
  let out: any;
  runInTransaction(() => { out = voidBill(bill.id, String(req.body?.reason ?? "")); });
  res.json({ status: out.status });
});
