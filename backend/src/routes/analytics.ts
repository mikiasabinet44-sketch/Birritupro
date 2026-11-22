import { createRouter } from "../lib/httpRouter.js";
import db from "../db/index.js";
import { branchOf, branchName, round2, todayStr } from "../lib/branch.js";
import { inventoryValuation } from "../lib/inventory.js";
import { reorderSuggestions } from "../lib/ai/reorder.js";
import { detectAnomalies } from "../lib/ai/anomalies.js";

export const analyticsRouter = createRouter();

const all = (sql: string, ...p: any[]) => db.prepare(sql).all(...p) as any[];
const one = (sql: string, ...p: any[]) => db.prepare(sql).get(...p) as any;
const fmt = (n: number) => `ETB ${Math.round(n).toLocaleString("en-US")}`;

/** First day (YYYY-MM-01) of the month `back` months before the month of `d`. */
function monthStart(d: Date, back: number): string {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1));
  return x.toISOString().slice(0, 10);
}
const monthKey = (iso: string) => iso.slice(0, 7);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (key: string) => MONTHS[parseInt(key.slice(5, 7), 10) - 1] ?? key;
const pctChange = (now: number, before: number) => (before === 0 ? null : Math.round(((now - before) / Math.abs(before)) * 1000) / 10);

/**
 * GET /api/analytics?range=1|3|6|12|all   (branch comes from the X-Branch-Id header like every other page)
 * Everything the Analytics page draws, computed from the books. Nothing here is estimated or invented.
 */
analyticsRouter.get("/", (req, res) => {
  const b = branchOf(req);
  const bw = b ? " AND branch_id = ?" : "";
  const bp = b ? [b] : [];
  const rangeParam = req.query.get("range") ?? "6";
  const months = rangeParam === "all" ? 0 : Math.min(Math.max(parseInt(rangeParam, 10) || 6, 1), 24);

  const now = new Date();
  const today = todayStr();
  const start = months === 0 ? "0000-01-01" : monthStart(now, months - 1);
  const prevStart = months === 0 ? null : monthStart(now, 2 * months - 1);
  const prevEnd = months === 0 ? null : start; // exclusive

  const sums = (from: string, to: string | null) => {
    const r = one(
      `SELECT COALESCE(SUM(CASE WHEN amount>0 THEN amount END),0) AS inc, COALESCE(SUM(CASE WHEN amount<0 THEN amount END),0) AS exp, COUNT(*) AS n
       FROM transactions WHERE date >= ?${to ? " AND date < ?" : ""}${bw}`,
      from, ...(to ? [to] : []), ...bp
    );
    return { income: round2(r.inc), expense: round2(Math.abs(r.exp)), count: r.n as number };
  };
  const cur = sums(start, null);
  const prev = prevStart ? sums(prevStart, prevEnd) : null;
  const profit = round2(cur.income - cur.expense);
  const margin = cur.income > 0 ? Math.round((profit / cur.income) * 1000) / 10 : null;

  // ---- monthly series (always at least 6 points so the chart has a shape)
  const seriesLen = months === 0 ? 12 : Math.max(months, 6);
  const seriesStart = monthStart(now, seriesLen - 1);
  const byMonth = new Map<string, { income: number; expense: number }>();
  for (const r of all(
    `SELECT substr(date,1,7) AS m, COALESCE(SUM(CASE WHEN amount>0 THEN amount END),0) AS inc, COALESCE(SUM(CASE WHEN amount<0 THEN -amount END),0) AS exp
     FROM transactions WHERE date >= ?${bw} GROUP BY m`, seriesStart, ...bp)) byMonth.set(r.m, { income: round2(r.inc), expense: round2(r.exp) });
  const monthly = Array.from({ length: seriesLen }, (_, i) => {
    const key = monthKey(monthStart(now, seriesLen - 1 - i));
    const v = byMonth.get(key) ?? { income: 0, expense: 0 };
    return { key, label: monthLabel(key), income: v.income, expense: v.expense, net: round2(v.income - v.expense) };
  });

  // ---- last 30 days, day by day
  const d30 = monthStartDays(30);
  const byDay = new Map<string, { income: number; expense: number }>();
  for (const r of all(
    `SELECT date AS d, COALESCE(SUM(CASE WHEN amount>0 THEN amount END),0) AS inc, COALESCE(SUM(CASE WHEN amount<0 THEN -amount END),0) AS exp
     FROM transactions WHERE date >= ?${bw} GROUP BY date`, d30[0], ...bp)) byDay.set(r.d, { income: round2(r.inc), expense: round2(r.exp) });
  const daily = d30.map((d) => ({ date: d, income: byDay.get(d)?.income ?? 0, expense: byDay.get(d)?.expense ?? 0 }));

  // ---- weekday pattern (money in)
  const wk = all(
    `SELECT CAST(strftime('%w', date) AS INTEGER) AS w, COALESCE(SUM(amount),0) AS inc, COUNT(*) AS n FROM transactions WHERE amount>0 AND date >= ?${bw} GROUP BY w`, start, ...bp);
  const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const weekday = weekdayNames.map((name, w) => ({ name, income: round2(wk.find((r) => r.w === w)?.inc ?? 0), count: wk.find((r) => r.w === w)?.n ?? 0 }));

  // ---- categories
  const catRows = (sign: "pos" | "neg") => all(
    `SELECT COALESCE(category,'Uncategorised') AS name, COALESCE(SUM(ABS(amount)),0) AS v, COUNT(*) AS n
     FROM transactions WHERE amount ${sign === "pos" ? ">" : "<"} 0 AND date >= ?${bw} GROUP BY name ORDER BY v DESC`, start, ...bp
  ).map((r) => ({ name: r.name as string, value: round2(r.v), count: r.n as number }));
  const trim = (rows: Array<{ name: string; value: number; count: number }>, keep = 7) => {
    if (rows.length <= keep) return rows;
    const rest = rows.slice(keep);
    return [...rows.slice(0, keep), { name: "Everything else", value: round2(rest.reduce((s, r) => s + r.value, 0)), count: rest.reduce((s, r) => s + r.count, 0) }];
  };
  const expenseCats = trim(catRows("neg"));
  const incomeCats = trim(catRows("pos"));

  // ---- where the money came in (payment channels)
  const prov = all(
    `SELECT provider AS p, COALESCE(SUM(amount),0) AS v, COUNT(*) AS n FROM payment_events
     WHERE parsed_ok = 1 AND direction = 'credit' AND verification_status NOT IN ('duplicate','rejected','unparsed') AND substr(received_at,1,10) >= ?${bw} GROUP BY p`, start, ...bp);
  const channelsTotal = prov.reduce((s, r) => s + r.v, 0);
  const channels = [
    ...["CBE", "TELEBIRR", "BOA"].map((p) => ({ key: p, label: p === "TELEBIRR" ? "Telebirr" : p, value: round2(prov.find((r) => r.p === p)?.v ?? 0), count: prov.find((r) => r.p === p)?.n ?? 0 })),
    { key: "OTHER", label: "Cash, invoices & other", value: round2(Math.max(0, cur.income - channelsTotal)), count: Math.max(0, cur.count - prov.reduce((s, r) => s + r.n, 0)) },
  ];

  // ---- invoices & customers
  const inv = one(
    `SELECT COUNT(*) AS n, COALESCE(SUM(total_amount),0) AS billed, COALESCE(SUM(amount_paid),0) AS paid FROM invoices WHERE issue_date >= ? AND status != 'cancelled'${bw}`, start, ...bp);
  const statusRows = all(`SELECT status AS s, COUNT(*) AS n, COALESCE(SUM(total_amount - amount_paid),0) AS owed FROM invoices WHERE issue_date >= ?${bw} GROUP BY s`, start, ...bp);
  const openRows = all(
    `SELECT i.invoice_number AS num, c.name AS customer, i.total_amount - i.amount_paid AS owed, i.due_date AS due, i.issue_date AS issued
     FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id WHERE i.status IN ('open','partially_paid','overdue')${bw.replace("branch_id", "i.branch_id")}`, ...bp);
  const ageing = [
    { label: "Not yet due", from: -Infinity, to: 0, value: 0, count: 0 },
    { label: "1–30 days late", from: 1, to: 30, value: 0, count: 0 },
    { label: "31–60 days late", from: 31, to: 60, value: 0, count: 0 },
    { label: "Over 60 days late", from: 61, to: Infinity, value: 0, count: 0 },
  ];
  for (const r of openRows) {
    const due = r.due ?? r.issued;
    const late = Math.floor((Date.parse(today) - Date.parse(due)) / 86400000);
    const bucket = ageing.find((a) => late >= a.from && late <= a.to) ?? ageing[0];
    bucket.value = round2(bucket.value + r.owed); bucket.count++;
  }
  const topCustomers = all(
    `SELECT COALESCE(c.name,'No customer') AS name, COUNT(*) AS n, COALESCE(SUM(i.total_amount),0) AS billed, COALESCE(SUM(i.amount_paid),0) AS paid
     FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id WHERE i.issue_date >= ? AND i.status != 'cancelled'${bw.replace("branch_id", "i.branch_id")}
     GROUP BY name ORDER BY billed DESC LIMIT 6`, start, ...bp
  ).map((r) => ({ name: r.name, invoices: r.n, billed: round2(r.billed), paid: round2(r.paid), owed: round2(r.billed - r.paid) }));
  const customerCount = one(`SELECT COUNT(*) AS c FROM customers`).c as number;

  // ---- stock
  const val = inventoryValuation(b);
  const topValue = [...val.items].sort((a, c) => c.value - a.value).slice(0, 6).map((i) => ({ name: i.name, qty: i.qty, value: i.value }));
  const ro = reorderSuggestions(b);
  const lowStock = ro.suggestions.slice(0, 6).map((s) => ({ name: s.name, branch: s.branchName, onHand: s.onHand, daysOfCover: s.daysOfCover, urgency: s.urgency, suggestedQty: s.suggestedQty, estimatedCost: s.estimatedCost, unit: s.unit }));
  const slow = ro.slowMoving.slice(0, 4).map((s) => ({ name: s.name, branch: s.branchName, onHand: s.onHand, tiedUp: s.tiedUpValue, daysSinceLastSale: s.daysSinceLastSale }));
  const sellers = all(
    `SELECT p.name AS name, -SUM(m.qty) AS units, -SUM(m.qty) * p.sell_price AS revenue FROM stock_movements m JOIN products p ON p.id = m.product_id
     WHERE m.type = 'sale' AND m.date >= date('now','-30 days')${b ? " AND m.branch_id = ?" : ""} GROUP BY p.id ORDER BY units DESC LIMIT 6`, ...bp
  ).map((r) => ({ name: r.name, units: round2(r.units), revenue: round2(r.revenue) }));
  const stock = {
    value: val.total, itemCount: val.items.length, outOfStock: val.items.filter((i) => i.qty <= 0).length,
    topValue, lowStock, slow, sellers,
  };

  // ---- staff pay
  const runs = all(`SELECT period, status, total_gross AS gross, total_income_tax AS tax, total_pension_employee AS pe, total_pension_employer AS pr, total_net AS net FROM payroll_runs ORDER BY period DESC LIMIT 6`).reverse();
  const emp = one(`SELECT COUNT(*) AS n, COALESCE(SUM(basic_salary + transport_allowance + other_allowance),0) AS gross, COALESCE(AVG(basic_salary),0) AS avgBasic FROM employees WHERE active = 1${bw}`, ...bp);
  const empBranches = all(
    `SELECT COALESCE(br.name,'No branch') AS name, COUNT(*) AS n, COALESCE(SUM(e.basic_salary + e.transport_allowance + e.other_allowance),0) AS gross
     FROM employees e LEFT JOIN branches br ON br.id = e.branch_id WHERE e.active = 1${bw.replace("branch_id", "e.branch_id")} GROUP BY name ORDER BY gross DESC`, ...bp
  ).map((r) => ({ name: r.name, staff: r.n, gross: round2(r.gross) }));
  const payroll = {
    staff: emp.n as number, monthlyGross: round2(emp.gross), avgBasic: round2(emp.avgBasic),
    employerPension: round2(runs.length ? runs[runs.length - 1].pr : 0),
    payrollShareOfIncome: cur.income > 0 && months > 0 ? Math.round((emp.gross * months / cur.income) * 1000) / 10 : null,
    runs: runs.map((r) => ({ period: r.period, label: monthLabel(r.period), status: r.status, gross: round2(r.gross), net: round2(r.net), tax: round2(r.tax), pension: round2(r.pe + r.pr) })),
    byBranch: empBranches,
  };

  // ---- taxes
  const filings = all(`SELECT tax_type AS type, period, tax_amount AS amount, status, due_date AS due FROM tax_filings ORDER BY due_date DESC, tax_type LIMIT 30`).map((f) => ({
    ...f, amount: round2(f.amount), daysLeft: f.due ? Math.ceil((Date.parse(f.due) - Date.parse(today)) / 86400000) : null,
  }));
  const taxDue = round2(filings.filter((f) => f.status === "due").reduce((s, f) => s + Math.max(0, f.amount), 0));
  const taxPaidYtd = round2(filings.filter((f) => f.status !== "due").reduce((s, f) => s + Math.max(0, f.amount), 0));
  const taxByType = Object.entries(filings.reduce<Record<string, number>>((m, f) => { m[f.type] = (m[f.type] ?? 0) + Math.max(0, f.amount); return m; }, {})).map(([type, value]) => ({ type, value: round2(value) }));

  // ---- branches side by side
  const branchRows = all(`SELECT id, name, is_head_office AS ho FROM branches WHERE active = 1 ORDER BY is_head_office DESC, name`).map((br) => {
    const t = one(`SELECT COALESCE(SUM(CASE WHEN amount>0 THEN amount END),0) AS inc, COALESCE(SUM(CASE WHEN amount<0 THEN -amount END),0) AS exp FROM transactions WHERE date >= ? AND branch_id = ?`, start, br.id);
    const o = one(`SELECT COALESCE(SUM(total_amount - amount_paid),0) AS v FROM invoices WHERE status IN ('open','partially_paid','overdue') AND branch_id = ?`, br.id);
    return { name: br.name as string, income: round2(t.inc), expense: round2(t.exp), net: round2(t.inc - t.exp), owed: round2(o.v), stockValue: inventoryValuation(br.id).total };
  });

  // ---- biggest single movements
  const biggest = all(`SELECT date, description, amount, COALESCE(category,'Uncategorised') AS category FROM transactions WHERE date >= ?${bw} ORDER BY ABS(amount) DESC LIMIT 6`, start, ...bp)
    .map((t) => ({ date: t.date, description: t.description, amount: round2(t.amount), category: t.category }));

  // ---- findings: plain sentences built only from the numbers above
  const findings: Array<{ level: "good" | "watch" | "info"; text: string }> = [];
  const inChange = prev ? pctChange(cur.income, prev.income) : null;
  if (inChange !== null) findings.push({ level: inChange >= 0 ? "good" : "watch", text: `Money in is ${inChange >= 0 ? "up" : "down"} ${Math.abs(inChange)}% compared with the previous ${months === 1 ? "month" : months + " months"} (${fmt(cur.income)} vs ${fmt(prev!.income)}).` });
  const exChange = prev ? pctChange(cur.expense, prev.expense) : null;
  if (exChange !== null) findings.push({ level: exChange <= 0 ? "good" : "watch", text: `Money out is ${exChange >= 0 ? "up" : "down"} ${Math.abs(exChange)}% (${fmt(cur.expense)} vs ${fmt(prev!.expense)}).` });
  if (margin !== null) findings.push({ level: margin >= 15 ? "good" : margin >= 0 ? "info" : "watch", text: `Profit margin is ${margin}%: you keep about ETB ${Math.max(0, Math.round(margin))} of every 100 that comes in.` });
  const topExp = expenseCats[0];
  if (topExp && cur.expense > 0) findings.push({ level: "info", text: `${topExp.name} is your biggest cost: ${fmt(topExp.value)}, ${Math.round((topExp.value / cur.expense) * 100)}% of everything you spent.` });
  const bestDay = [...weekday].sort((a, c) => c.income - a.income)[0];
  if (bestDay && bestDay.income > 0) findings.push({ level: "info", text: `${bestDay.name} is your strongest day for money in (${fmt(bestDay.income)} over this period).` });
  const topCust = topCustomers[0];
  if (topCust && inv.billed > 0) {
    const share = Math.round((topCust.billed / inv.billed) * 100);
    findings.push({ level: share >= 40 ? "watch" : "info", text: `${topCust.name} is your largest customer, ${share}% of what you invoiced.${share >= 40 ? " Relying on one customer is risky." : ""}` });
  }
  const late = ageing.slice(1).reduce((s, a) => s + a.value, 0);
  if (late > 0) findings.push({ level: "watch", text: `${fmt(late)} of invoices are past their due date. Chasing them is the quickest way to improve cash.` });
  if (inv.billed > 0) findings.push({ level: inv.paid / inv.billed >= 0.7 ? "good" : "watch", text: `You have collected ${Math.round((inv.paid / inv.billed) * 100)}% of what you invoiced in this period.` });
  if (lowStock.length) findings.push({ level: "watch", text: `${ro.suggestions.length} product${ro.suggestions.length === 1 ? "" : "s"} should be reordered soon, starting with ${lowStock[0].name}.` });
  if (slow.length) findings.push({ level: "info", text: `${fmt(slow.reduce((s, x) => s + x.tiedUp, 0))} of stock is sitting in slow sellers such as ${slow[0].name}.` });
  if (taxDue > 0) findings.push({ level: "watch", text: `${fmt(taxDue)} of tax is waiting to be filed.` });
  const alerts = detectAnomalies(b).slice(0, 5).map((i) => ({ severity: i.severity, title: i.title, detail: i.detail }));

  res.json({
    scope: branchName(b), range: months === 0 ? "all" : months, from: months === 0 ? null : start, to: today,
    totals: {
      income: cur.income, expense: cur.expense, profit, margin, transactions: cur.count,
      avgIncome: cur.count ? round2(cur.income / Math.max(1, cur.count)) : 0,
      incomeChange: inChange, expenseChange: exChange, previousIncome: prev?.income ?? null, previousExpense: prev?.expense ?? null,
    },
    monthly, daily, weekday, expenseCats, incomeCats, channels,
    invoices: {
      count: inv.n, billed: round2(inv.billed), paid: round2(inv.paid), collectionRate: inv.billed > 0 ? Math.round((inv.paid / inv.billed) * 1000) / 10 : null,
      outstanding: round2(openRows.reduce((s, r) => s + r.owed, 0)), byStatus: statusRows.map((r) => ({ status: r.s, count: r.n, owed: round2(r.owed) })), ageing: ageing.map(({ label, value, count }) => ({ label, value, count })),
    },
    customers: { total: customerCount, top: topCustomers },
    stock, payroll,
    tax: { due: taxDue, settled: taxPaidYtd, byType: taxByType, filings: filings.slice(0, 10) },
    branches: branchRows, biggest, findings, alerts,
  });
});

function monthStartDays(n: number): string[] {
  const out: string[] = [];
  const t = Date.parse(todayStr());
  for (let i = n - 1; i >= 0; i--) out.push(new Date(t - i * 86400000).toISOString().slice(0, 10));
  return out;
}
