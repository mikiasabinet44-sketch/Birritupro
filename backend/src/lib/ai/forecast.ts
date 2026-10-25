import db from "../../db/index.js";
import { round2 } from "../branch.js";
import { calcPayroll } from "../taxEngine.js";

/**
 * Cash-flow forecast. Deliberately simple and explainable:
 *  - day-to-day inflow/outflow = exponentially-weighted average of recent weekly totals
 *    (payroll and tax payments excluded - they are scheduled separately);
 *  - payroll = the active roster's net pay on the 28th and PAYE + pension on the 10th of the next month;
 *  - tax = filings already computed and still due, on their due dates;
 *  - uncertainty band = historical volatility of weekly net cash flow, widening with the square root of time.
 * It is a planning aid, not a prediction guarantee, and says so when history is short.
 */

const DAY = 86400000;
function mondayOf(d: Date): Date {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (x.getUTCDay() + 6) % 7;
  return new Date(x.getTime() - dow * DAY);
}
const iso = (d: Date) => d.toISOString().slice(0, 10);

export function cashForecast(branchId: string | null, weeks = 8) {
  weeks = Math.min(Math.max(Math.round(weeks) || 8, 2), 26);
  const bw = branchId ? " AND branch_id = ?" : "";
  const bp = branchId ? [branchId] : [];
  const now = new Date();
  const thisMonday = mondayOf(now);

  const startingCash = round2((db.prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE 1=1${bw}`).get(...bp) as { s: number }).s);

  // ---- history: completed weeks only ----
  const histFrom = new Date(thisMonday.getTime() - 12 * 7 * DAY);
  const rows = db.prepare(
    `SELECT date, amount, source, category FROM transactions WHERE date >= ? AND date < ?${bw}`
  ).all(iso(histFrom), iso(thisMonday), ...bp) as any[];

  const weekly = new Map<string, { inflow: number; outflow: number }>();
  let firstWeek: string | null = null;
  for (const r of rows) {
    const key = iso(mondayOf(new Date(r.date)));
    if (!firstWeek || key < firstWeek) firstWeek = key;
    const w = weekly.get(key) ?? { inflow: 0, outflow: 0 };
    if (r.amount > 0) w.inflow += r.amount;
    else if (r.source !== "payroll" && r.category !== "Tax Payment") w.outflow += -r.amount;
    weekly.set(key, w);
  }
  const series: Array<{ inflow: number; outflow: number }> = [];
  if (firstWeek) {
    for (let t = new Date(firstWeek).getTime(); t < thisMonday.getTime(); t += 7 * DAY) {
      series.push(weekly.get(iso(new Date(t))) ?? { inflow: 0, outflow: 0 });
    }
  }
  const nHist = series.length;

  const ewma = (xs: number[], alpha = 0.35) => (xs.length ? xs.slice(1).reduce((lvl, v) => alpha * v + (1 - alpha) * lvl, xs[0]) : 0);
  const baseIn = ewma(series.map((s) => s.inflow));
  const baseOut = ewma(series.map((s) => s.outflow));
  const nets = series.map((s) => s.inflow - s.outflow);
  const mean = nets.length ? nets.reduce((a, b) => a + b, 0) / nets.length : 0;
  const std = nets.length > 1 ? Math.sqrt(nets.reduce((a, b) => a + (b - mean) ** 2, 0) / nets.length) : 0;

  // ---- scheduled payroll ----
  const emps = db.prepare(`SELECT * FROM employees WHERE active = 1${bw}`).all(...bp) as any[];
  let monthlyNet = 0, monthlyRemit = 0;
  for (const e of emps) {
    const p = calcPayroll({ basicSalary: e.basic_salary, taxableAllowance: e.other_allowance, nonTaxableAllowance: e.transport_allowance });
    monthlyNet += p.netPay;
    monthlyRemit += p.incomeTax + p.pensionEmployee + p.pensionEmployer;
  }
  const horizonEnd = new Date(thisMonday.getTime() + weeks * 7 * DAY);
  const scheduled: Array<{ date: string; kind: "payroll" | "tax"; amount: number; label: string }> = [];
  const today = iso(now);

  for (let m = 0; m < 8; m++) {
    const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + m, 1));
    const period = base.toISOString().slice(0, 7);
    const payDay = iso(new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), 28)));
    const finalized = db.prepare(`SELECT 1 FROM payroll_runs WHERE period = ? AND status = 'finalized'`).get(period);
    if (monthlyNet > 0 && payDay >= today && payDay < iso(horizonEnd) && !finalized) {
      scheduled.push({ date: payDay, kind: "payroll", amount: round2(monthlyNet), label: `Net salaries ${period}` });
    }
    // PAYE + pension for this month's payroll are remitted by the 10th of the next month.
    const remitDay = iso(new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 10)));
    const hasFiling = db.prepare(`SELECT 1 FROM tax_filings WHERE period = ? AND tax_type = 'income_tax_payroll'`).get(period);
    if (monthlyRemit > 0 && remitDay >= today && remitDay < iso(horizonEnd) && !hasFiling) {
      scheduled.push({ date: remitDay, kind: "tax", amount: round2(monthlyRemit), label: `PAYE + pension ${period}` });
    }
  }
  const filings = db.prepare(`SELECT period, tax_type, tax_amount, due_date FROM tax_filings WHERE status = 'due' AND tax_amount > 0 AND due_date IS NOT NULL`).all() as any[];
  for (const f of filings) {
    const date = f.due_date < today ? today : f.due_date; // overdue filings are assumed paid immediately
    if (date < iso(horizonEnd)) scheduled.push({ date, kind: "tax", amount: round2(f.tax_amount), label: `${f.tax_type.replace(/_/g, " ")} ${f.period}` });
  }

  // ---- project ----
  const out: Array<{ weekStart: string; expectedIn: number; expectedOut: number; payroll: number; taxes: number; net: number; closing: number; closingLow: number; closingHigh: number }> = [];
  let cash = startingCash;
  let firstNegative: string | null = null;
  for (let k = 0; k < weeks; k++) {
    const ws = new Date(thisMonday.getTime() + k * 7 * DAY);
    const wsIso = iso(ws), weIso = iso(new Date(ws.getTime() + 7 * DAY));
    const inWeek = scheduled.filter((s) => s.date >= wsIso && s.date < weIso);
    const payroll = round2(inWeek.filter((s) => s.kind === "payroll").reduce((a, s) => a + s.amount, 0));
    const taxes = round2(inWeek.filter((s) => s.kind === "tax").reduce((a, s) => a + s.amount, 0));
    const net = baseIn - baseOut - payroll - taxes;
    cash += net;
    const band = std * Math.sqrt(k + 1);
    const row = {
      weekStart: wsIso, expectedIn: round2(baseIn), expectedOut: round2(baseOut), payroll, taxes, net: round2(net),
      closing: round2(cash), closingLow: round2(cash - band), closingHigh: round2(cash + band),
    };
    if (!firstNegative && row.closing < 0) firstNegative = wsIso;
    out.push(row);
  }

  const recv = db.prepare(
    `SELECT COALESCE(SUM(total_amount - amount_paid),0) AS owed,
            COALESCE(SUM(CASE WHEN due_date < ? THEN total_amount - amount_paid END),0) AS overdue
     FROM invoices WHERE status IN ('open','partially_paid','overdue')${bw}`
  ).get(today, ...bp) as { owed: number; overdue: number };

  const notes: string[] = [];
  if (nHist < 4) notes.push(`Only ${nHist} completed week(s) of history - treat this forecast as a rough sketch until more transactions are recorded.`);
  notes.push("Starting cash is the ledger balance (sum of recorded transactions), not a bank statement balance.");
  notes.push("Outstanding invoices are shown as upside but not added to the projection, because collections are already reflected in the historical inflow average.");
  notes.push("VAT for the current month is not projected until it has been computed on the Tax page.");

  return {
    startingCash, weeks: out, firstNegativeWeek: firstNegative,
    confidence: nHist >= 8 ? "good" : nHist >= 4 ? "fair" : "low",
    basis: { weeksOfHistory: nHist, avgWeeklyInflow: round2(baseIn), avgWeeklyOutflow: round2(baseOut), weeklyNetVolatility: round2(std), monthlyNetPayroll: round2(monthlyNet), monthlyPayrollRemittances: round2(monthlyRemit) },
    receivables: { outstanding: round2(recv.owed), overdue: round2(recv.overdue) },
    notes,
  };
}
