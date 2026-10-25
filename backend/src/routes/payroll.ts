import { createRouter, HttpError } from "../lib/httpRouter.js";
import { nanoid } from "../lib/id.js";
import db, { runInTransaction } from "../db/index.js";
import { calcPayroll } from "../lib/taxEngine.js";
import { branchClause, branchOf, writeBranch, round2 } from "../lib/branch.js";

export const payrollRouter = createRouter();

// -------- Employees --------
payrollRouter.get("/employees", (req, res) => {
  const c = branchClause(req, "e.branch_id");
  res.json(
    db.prepare(
      `SELECT e.*, b.code AS branch_code FROM employees e LEFT JOIN branches b ON b.id = e.branch_id
       WHERE e.active = 1${c.sql} ORDER BY e.full_name`
    ).all(...c.params)
  );
});

payrollRouter.post("/employees", (req, res) => {
  const { fullName, position, basicSalary, transportAllowance = 0, otherAllowance = 0, tin, pensionNumber, phone } = req.body ?? {};
  if (!fullName || basicSalary === undefined) return res.status(400).json({ error: "fullName and basicSalary are required" });
  const branchId = writeBranch(req, req.body?.branchId);
  const id = nanoid();
  db.prepare(
    `INSERT INTO employees (id, full_name, position, basic_salary, transport_allowance, other_allowance, tin, pension_number, phone, branch_id)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(id, fullName, position ?? null, basicSalary, transportAllowance, otherAllowance, tin ?? null, pensionNumber ?? null, phone ?? null, branchId);
  res.status(201).json({ id, branchId });
});

/**
 * Bulk import employees, e.g. from a CSV/Excel roster parsed client-side
 * (see frontend) or pushed programmatically. Body: { employees: [...] },
 * same fields as POST /employees. Each row is validated and inserted
 * independently so one bad row doesn't block the rest of the import.
 * All rows go to the selected branch (or the head office when none is selected);
 * a row may override it with a branchCode column.
 */
payrollRouter.post("/employees/import", (req, res) => {
  const { employees } = req.body ?? {};
  if (!Array.isArray(employees) || employees.length === 0) {
    return res.status(400).json({ error: "employees array is required" });
  }
  const defaultBranch = writeBranch(req, req.body?.branchId);

  const insert = db.prepare(
    `INSERT INTO employees (id, full_name, position, basic_salary, transport_allowance, other_allowance, tin, pension_number, phone, branch_id)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  );

  const results: Array<{ row: number; ok: boolean; id?: string; error?: string }> = [];

  runInTransaction(() => {
    employees.forEach((row: any, i: number) => {
      try {
        const fullName = String(row.fullName ?? row.full_name ?? "").trim();
        const basicSalary = Number(row.basicSalary ?? row.basic_salary);
        if (!fullName) throw new Error("missing fullName");
        if (!Number.isFinite(basicSalary) || basicSalary <= 0) throw new Error("missing/invalid basicSalary");

        let branchId = defaultBranch;
        if (row.branchCode) {
          const b = db.prepare(`SELECT id FROM branches WHERE code = ? AND active = 1`).get(String(row.branchCode).trim().toUpperCase()) as { id: string } | undefined;
          if (!b) throw new Error(`unknown branchCode '${row.branchCode}'`);
          branchId = b.id;
        }

        const id = nanoid();
        const pension = row.pensionNumber ?? row.pension_number;
        insert.run(
          id,
          fullName,
          row.position ? String(row.position).trim() : null,
          basicSalary,
          Number(row.transportAllowance ?? row.transport_allowance ?? 0) || 0,
          Number(row.otherAllowance ?? row.other_allowance ?? 0) || 0,
          row.tin ? String(row.tin).trim() : null,
          pension ? String(pension).trim() : null,
          row.phone ? String(row.phone).trim() : null,
          branchId
        );
        results.push({ row: i + 1, ok: true, id });
      } catch (err: any) {
        results.push({ row: i + 1, ok: false, error: err?.message ?? "invalid row" });
      }
    });
  });

  const imported = results.filter((r) => r.ok).length;
  res.status(imported > 0 ? 201 : 400).json({ imported, failed: results.length - imported, results });
});

payrollRouter.delete("/employees/:id", (req, res) => {
  db.prepare(`UPDATE employees SET active = 0 WHERE id = ?`).run(req.params.id);
  res.status(204).end();
});

// -------- Payroll runs --------
// A branch view shows that branch's own runs plus any all-branch runs (branch_id NULL).
payrollRouter.get("/runs", (req, res) => {
  const b = branchOf(req);
  res.json(
    db.prepare(
      `SELECT r.*, br.code AS branch_code FROM payroll_runs r LEFT JOIN branches br ON br.id = r.branch_id
       WHERE 1=1${b ? " AND (r.branch_id = ? OR r.branch_id IS NULL)" : ""} ORDER BY r.run_date DESC, r.period DESC`
    ).all(...(b ? [b] : []))
  );
});

payrollRouter.get("/runs/:id/payslips", (req, res) => {
  res.json(
    db.prepare(
      `SELECT payslips.*, employees.full_name, employees.position, branches.code AS branch_code
       FROM payslips JOIN employees ON employees.id = payslips.employee_id LEFT JOIN branches ON branches.id = employees.branch_id
       WHERE payroll_run_id = ?`
    ).all(req.params.id)
  );
});

// Runs payroll for the given period over the active employees of the selected branch
// (or of every branch when "All branches" is selected), calculating Ethiopian income
// tax + pension per employee and generating a payslip for each.
payrollRouter.post("/runs", (req, res) => {
  const { period } = req.body ?? {};
  if (!period) return res.status(400).json({ error: "period (e.g. '2026-10') is required" });
  const branchId = branchOf(req); // null = all branches

  // One employee must never be paid twice for a period: an all-branch run conflicts with any run, and a branch run with the same branch or an all-branch run.
  const existing = db.prepare(
    `SELECT id FROM payroll_runs WHERE period = ? AND (branch_id IS NULL OR ? IS NULL OR branch_id = ?)`
  ).get(period, branchId, branchId);
  if (existing) return res.status(409).json({ error: "a payroll run covering these employees already exists for this period" });

  const employees = db.prepare(`SELECT * FROM employees WHERE active = 1${branchId ? " AND branch_id = ?" : ""}`).all(...(branchId ? [branchId] : [])) as any[];
  if (employees.length === 0) throw new HttpError(400, "there are no active employees to pay in this selection");
  const runId = nanoid();

  let totalGross = 0, totalTax = 0, totalPensionE = 0, totalPensionR = 0, totalNet = 0;

  const insertPayslip = db.prepare(
    `INSERT INTO payslips
      (id, payroll_run_id, employee_id, basic_salary, taxable_allowance, non_taxable_allowance,
       gross_salary, income_tax, pension_employee, pension_employer, other_deductions, net_pay)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  );

  runInTransaction(() => {
    db.prepare(`INSERT INTO payroll_runs (id, period, status, branch_id) VALUES (?, ?, 'draft', ?)`).run(runId, period, branchId);

    for (const emp of employees) {
      const result = calcPayroll({
        basicSalary: emp.basic_salary,
        taxableAllowance: emp.other_allowance,
        nonTaxableAllowance: emp.transport_allowance,
      });
      insertPayslip.run(
        nanoid(), runId, emp.id, emp.basic_salary, emp.other_allowance, emp.transport_allowance,
        result.grossSalary, result.incomeTax, result.pensionEmployee, result.pensionEmployer, 0, result.netPay
      );
      totalGross += result.grossSalary;
      totalTax += result.incomeTax;
      totalPensionE += result.pensionEmployee;
      totalPensionR += result.pensionEmployer;
      totalNet += result.netPay;
    }

    db.prepare(
      `UPDATE payroll_runs SET total_gross=?, total_income_tax=?, total_pension_employee=?, total_pension_employer=?, total_net=?
       WHERE id = ?`
    ).run(round2(totalGross), round2(totalTax), round2(totalPensionE), round2(totalPensionR), round2(totalNet), runId);
  });

  res.status(201).json({ id: runId, period, employeeCount: employees.length, totalNet: round2(totalNet) });
});

// Finalize a run: posts net salaries to the ledger (one entry per branch so each branch's
// books carry their own payroll cost) and (re)builds the company-wide payroll tax filings
// for the period from ALL finalized runs, so branch runs add up instead of overwriting each other.
payrollRouter.post("/runs/:id/finalize", (req, res) => {
  const run = db.prepare(`SELECT * FROM payroll_runs WHERE id = ?`).get(req.params.id) as any;
  if (!run) return res.status(404).json({ error: "run not found" });
  if (run.status === "finalized") return res.status(409).json({ error: "already finalized" });

  runInTransaction(() => {
    db.prepare(`UPDATE payroll_runs SET status = 'finalized' WHERE id = ?`).run(run.id);

    const groups = db.prepare(
      `SELECT e.branch_id AS branch_id, b.code AS code, SUM(p.net_pay) AS net
       FROM payslips p JOIN employees e ON e.id = p.employee_id LEFT JOIN branches b ON b.id = e.branch_id
       WHERE p.payroll_run_id = ? GROUP BY e.branch_id`
    ).all(run.id) as Array<{ branch_id: string | null; code: string | null; net: number }>;
    const date = new Date().toISOString().slice(0, 10);
    for (const g of groups) {
      db.prepare(
        `INSERT INTO transactions (id, date, description, amount, category, category_confidence, category_status, source, source_ref_id, branch_id)
         VALUES (?,?,?,?,?,?,?, 'payroll', ?, ?)`
      ).run(nanoid(), date, `Payroll ${run.period}: net salaries${groups.length > 1 && g.code ? ` (${g.code})` : ""}`, -round2(g.net), "Salaries & Wages", 1, "confirmed", run.id, g.branch_id);
    }

    const agg = db.prepare(
      `SELECT COALESCE(SUM(total_gross),0) AS gross, COALESCE(SUM(total_income_tax),0) AS tax,
              COALESCE(SUM(total_pension_employee + total_pension_employer),0) AS pension
       FROM payroll_runs WHERE period = ? AND status = 'finalized'`
    ).get(run.period) as { gross: number; tax: number; pension: number };
    upsertTaxFiling(run.period, "income_tax_payroll", round2(agg.gross), round2(agg.tax));
    upsertTaxFiling(run.period, "pension", round2(agg.gross), round2(agg.pension));
  });

  res.json({ ok: true });
});

function upsertTaxFiling(period: string, taxType: string, base: number, tax: number) {
  const existing = db.prepare(`SELECT id FROM tax_filings WHERE period = ? AND tax_type = ?`).get(period, taxType) as any;
  if (existing) {
    db.prepare(`UPDATE tax_filings SET base_amount = ?, tax_amount = ? WHERE id = ?`).run(base, tax, existing.id);
  } else {
    db.prepare(
      `INSERT INTO tax_filings (id, period, tax_type, base_amount, tax_amount, due_date) VALUES (?,?,?,?,?,?)`
    ).run(nanoid(), period, taxType, base, tax, nextMonthDeadline(period));
  }
}

function nextMonthDeadline(period: string): string {
  const [y, m] = period.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 10)); // 10th of the following month, typical PAYE/VAT deadline
  return d.toISOString().slice(0, 10);
}
