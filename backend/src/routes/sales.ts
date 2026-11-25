import { createRouter, HttpError } from "../lib/httpRouter.js";
import db, { runInTransaction, getSetting, setSetting } from "../db/index.js";
import { branchOf, branchClause, writeBranch, round2, todayStr } from "../lib/branch.js";
import { nanoid } from "../lib/id.js";
import { createBill, settleBill, voidBill, openShift, expectedCash, drawerEvent, matchPaymentToBill, METHODS, type Method } from "../lib/sales.js";

export const salesRouter = createRouter();

const lines = (id: string) => db.prepare(`SELECT id, product_id, description, qty, unit_price, vat_rate FROM bill_lines WHERE bill_id = ?`).all(id);

salesRouter.get("/", (req, res) => {
  const status = req.query.get("status");
  const c = branchClause(req, "b.branch_id");
  const rows = db.prepare(
    `SELECT b.*, br.code AS branch_code FROM bills b JOIN branches br ON br.id = b.branch_id
      WHERE 1=1${status ? " AND b.status = ?" : ""}${c.sql} ORDER BY b.created_at DESC LIMIT 200`
  ).all(...(status ? [status] : []), ...c.params) as any[];
  res.json(rows.map((r) => ({ ...r, lines: lines(r.id) })));
});

salesRouter.post("/", (req, res) => {
  const b = req.body ?? {};
  const branchId = writeBranch(req, b.branchId);
  const method = b.payNow ? (String(b.paymentMethod ?? "").toLowerCase() as Method) : null;
  if (method && !METHODS.includes(method)) throw new HttpError(400, `payment method must be one of ${METHODS.join(", ")}`);
  let out: any;
  runInTransaction(() => {
    const bill = createBill({ branchId, table: b.table, customerName: b.customerName, lines: b.lines, pricesIncludeVat: !!b.pricesIncludeVat, source: "app" });
    let status = "open";
    if (method === "cash") { settleBill(bill.id, "cash"); status = "paid"; }
    else if (method) {
      db.prepare(`UPDATE bills SET payment_method = ? WHERE id = ?`).run(method, bill.id);
      if (matchPaymentToBill(bill.id, method)) status = "paid";
    }
    out = { ...bill, status };
  });
  res.status(201).json(out);
});

// ---- How the business takes orders: this app's own bills, or an external POS / till that reports in ----
salesRouter.get("/mode", (_req, res) => { res.json({ mode: getSetting("sales_mode") === "pos" ? "pos" : "builtin" }); });
salesRouter.post("/mode", (req, res) => {
  const m = String(req.body?.mode ?? "");
  if (m !== "pos" && m !== "builtin") throw new HttpError(400, "mode must be builtin or pos");
  setSetting("sales_mode", m);
  res.json({ mode: m });
});

// ---- Cash drawer ----
function drawerView(branchId: string) {
  const s = openShift(branchId);
  const history = db.prepare(`SELECT * FROM cash_shifts WHERE branch_id = ? AND status = 'closed' ORDER BY closed_at DESC LIMIT 14`).all(branchId);
  if (!s) return { open: null, history };
  const sales = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS t FROM bills WHERE shift_id = ? AND paid_at IS NOT NULL AND payment_method = 'cash'`).get(s.id) as { n: number; t: number };
  const events = db.prepare(`SELECT * FROM cash_events WHERE shift_id = ? ORDER BY created_at DESC`).all(s.id);
  return { open: { ...s, cashSales: round2(sales.t), cashSaleCount: sales.n, events, expected: expectedCash(s.id) }, history };
}

salesRouter.get("/drawer", (req, res) => {
  const branchId = writeBranch(req);
  const br = db.prepare(`SELECT name FROM branches WHERE id = ?`).get(branchId) as { name: string };
  res.json({ branch: br.name, branchId, ...drawerView(branchId) });
});

salesRouter.post("/drawer/open", (req, res) => {
  const branchId = writeBranch(req);
  const fl = Number(req.body?.float ?? 0);
  if (!Number.isFinite(fl) || fl < 0 || fl > 1e9) throw new HttpError(400, "opening cash must be 0 or more");
  if (openShift(branchId)) throw new HttpError(409, "the drawer is already open");
  const id = nanoid();
  db.prepare(`INSERT INTO cash_shifts (id, branch_id, opening_float) VALUES (?,?,?)`).run(id, branchId, round2(fl));
  res.status(201).json({ id });
});

salesRouter.post("/drawer/event", (req, res) => {
  const branchId = writeBranch(req);
  const t = String(req.body?.type ?? "");
  if (!["payout", "drop", "add"].includes(t)) throw new HttpError(400, "type must be payout, drop or add");
  let out: any;
  runInTransaction(() => { out = drawerEvent(branchId, t as any, Number(req.body?.amount), String(req.body?.note ?? "")); });
  res.status(201).json(out);
});

salesRouter.post("/drawer/close", (req, res) => {
  const branchId = writeBranch(req);
  const s = openShift(branchId);
  if (!s) throw new HttpError(409, "the drawer is not open");
  const counted = Number(req.body?.counted);
  if (!Number.isFinite(counted) || counted < 0 || counted > 1e10) throw new HttpError(400, "type the cash you counted");
  const open = db.prepare(`SELECT COUNT(*) AS n FROM bills WHERE status = 'open' AND branch_id = ?`).get(branchId) as { n: number };
  const expected = expectedCash(s.id);
  const variance = round2(counted - expected);
  db.prepare(`UPDATE cash_shifts SET status = 'closed', closed_at = datetime('now'), expected = ?, counted = ?, variance = ?, note = ? WHERE id = ?`)
    .run(expected, round2(counted), variance, String(req.body?.note ?? "").trim().slice(0, 200) || null, s.id);
  res.json({ expected, counted: round2(counted), variance, openBills: open.n });
});

// ---- Summary & alerts for the Sales page ----
salesRouter.get("/summary", (req, res) => {
  const branch = branchOf(req);
  const bw = branch ? " AND branch_id = ?" : "";
  const bp = branch ? [branch] : [];
  const day = req.query.get("date") ?? todayStr();
  const byMethod = db.prepare(
    `SELECT payment_method AS method, COUNT(*) AS n, COALESCE(SUM(total),0) AS total FROM bills WHERE status = 'paid' AND paid_at LIKE ?${bw} GROUP BY payment_method`
  ).all(`${day}%`, ...bp) as any[];
  const open = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS total FROM bills WHERE status = 'open'${bw}`).get(...bp) as any;
  const waiting = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS total FROM bills WHERE status = 'open' AND payment_method IS NOT NULL AND payment_method != 'cash'${bw}`).get(...bp) as any;
  const voids = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS total FROM bills WHERE status = 'void' AND voided_at LIKE ?${bw}`).get(`${day}%`, ...bp) as any;
  const total = round2(byMethod.reduce((s, r) => s + r.total, 0));
  const count = byMethod.reduce((s, r) => s + r.n, 0);
  res.json({ date: day, total, count, byMethod: byMethod.map((r) => ({ ...r, total: round2(r.total) })), open: { n: open.n, total: round2(open.total) }, waiting: { n: waiting.n, total: round2(waiting.total) }, voids: { n: voids.n, total: round2(voids.total) } });
});

salesRouter.get("/:id", (req, res) => {
  const b = db.prepare(`SELECT * FROM bills WHERE id = ?`).get(req.params.id) as any;
  if (!b) throw new HttpError(404, "bill not found");
  res.json({ ...b, lines: lines(b.id) });
});

salesRouter.post("/:id/pay", (req, res) => {
  const method = String(req.body?.method ?? "").toLowerCase() as Method;
  if (!METHODS.includes(method)) throw new HttpError(400, `payment method must be one of ${METHODS.join(", ")}`);
  const bill = db.prepare(`SELECT * FROM bills WHERE id = ?`).get(req.params.id) as any;
  if (!bill) throw new HttpError(404, "bill not found");
  let out: any;
  runInTransaction(() => {
    if (req.body?.waitForBank && method !== "cash" && method !== "card") {
      // Customer says they paid by Telebirr / bank: wait for the real message to arrive and close the bill by itself.
      db.prepare(`UPDATE bills SET payment_method = ? WHERE id = ? AND status = 'open'`).run(method, bill.id);
      out = matchPaymentToBill(bill.id, method) ? { status: "paid", matched: true } : { status: "open", waiting: true };
    } else {
      out = { status: settleBill(bill.id, method, { reference: req.body?.reference ? String(req.body.reference).slice(0, 80) : undefined }).status };
    }
  });
  res.json(out);
});

salesRouter.post("/:id/void", (req, res) => {
  let out: any;
  runInTransaction(() => { out = voidBill(req.params.id, String(req.body?.reason ?? "")); });
  res.json({ status: out.status });
});
