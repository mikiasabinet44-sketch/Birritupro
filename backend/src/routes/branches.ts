import { createRouter, HttpError } from "../lib/httpRouter.js";
import { nanoid } from "../lib/id.js";
import db from "../db/index.js";
import { round2 } from "../lib/branch.js";
import { inventoryValuation } from "../lib/inventory.js";

export const branchesRouter = createRouter();

branchesRouter.get("/", (_req, res) => {
  res.json(db.prepare(`SELECT * FROM branches ORDER BY is_head_office DESC, name`).all());
});

branchesRouter.post("/", (req, res) => {
  const { code, name, city, address, phone } = req.body ?? {};
  const c = String(code ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9_-]{2,10}$/.test(c)) throw new HttpError(400, "code must be 2-10 characters: letters, digits, - or _");
  if (!name || !String(name).trim()) throw new HttpError(400, "name is required");
  if (db.prepare(`SELECT 1 FROM branches WHERE code = ?`).get(c)) throw new HttpError(409, `branch code ${c} is already used`);
  const id = nanoid();
  db.prepare(`INSERT INTO branches (id, code, name, city, address, phone) VALUES (?,?,?,?,?,?)`)
    .run(id, c, String(name).trim(), city ?? null, address ?? null, phone ?? null);
  res.status(201).json({ id, code: c });
});

branchesRouter.patch("/:id", (req, res) => {
  const b = db.prepare(`SELECT * FROM branches WHERE id = ?`).get(req.params.id) as any;
  if (!b) throw new HttpError(404, "branch not found");
  const { name, city, address, phone, active } = req.body ?? {};
  if (active === false && b.is_head_office) throw new HttpError(400, "the head office cannot be deactivated");
  db.prepare(`UPDATE branches SET name = ?, city = ?, address = ?, phone = ?, active = ? WHERE id = ?`).run(
    name ?? b.name, city ?? b.city, address ?? b.address, phone ?? b.phone, active === undefined ? b.active : active ? 1 : 0, b.id
  );
  res.json({ ok: true });
});

/** Side-by-side performance of every active branch (ignores the selected-branch filter on purpose). */
branchesRouter.get("/performance", (_req, res) => {
  const month = new Date().toISOString().slice(0, 7);
  const branches = db.prepare(`SELECT * FROM branches WHERE active = 1 ORDER BY is_head_office DESC, name`).all() as any[];
  const out = branches.map((b) => {
    const t = db.prepare(
      `SELECT COALESCE(SUM(CASE WHEN amount > 0 THEN amount END),0) AS income, COALESCE(SUM(CASE WHEN amount < 0 THEN -amount END),0) AS expense
       FROM transactions WHERE branch_id = ? AND date LIKE ?`
    ).get(b.id, `${month}%`) as any;
    const inv = db.prepare(
      `SELECT COALESCE(SUM(total_amount),0) AS invoiced, COALESCE(SUM(CASE WHEN status IN ('open','partially_paid','overdue') THEN total_amount - amount_paid END),0) AS outstanding
       FROM invoices WHERE branch_id = ? AND status != 'cancelled' AND issue_date LIKE ?`
    ).get(b.id, `${month}%`) as any;
    const outstandingAll = db.prepare(
      `SELECT COALESCE(SUM(total_amount - amount_paid),0) AS v FROM invoices WHERE branch_id = ? AND status IN ('open','partially_paid','overdue')`
    ).get(b.id) as any;
    const emp = db.prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(basic_salary + transport_allowance + other_allowance),0) AS cost FROM employees WHERE branch_id = ? AND active = 1`).get(b.id) as any;
    return {
      id: b.id, code: b.code, name: b.name, city: b.city, isHeadOffice: !!b.is_head_office,
      income: round2(t.income), expense: round2(t.expense), net: round2(t.income - t.expense),
      invoicedThisMonth: round2(inv.invoiced), outstandingReceivables: round2(outstandingAll.v),
      employees: emp.c, monthlyPayrollCost: round2(emp.cost),
      stockValue: inventoryValuation(b.id).total,
    };
  });
  res.json({ month, branches: out });
});
