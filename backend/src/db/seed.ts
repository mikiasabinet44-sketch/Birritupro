import { nanoid } from "../lib/id.js";
import db, { getHeadOfficeId, runInTransaction, setSetting } from "./index.js";
import { calcVat } from "../lib/taxEngine.js";
import { applySaleStock, addMovement } from "../lib/inventory.js";
import { createEInvoiceDoc, getAdapter, qrFor, type EInvoicePayload } from "../lib/einvoice.js";
import { recordPayment } from "../lib/payments.js";

// Idempotent: if this looks like a DB that's already been seeded (or already
// has real customer data), do nothing. This lets `npm run seed` be safely
// called on every boot (e.g. in a deploy's start command) without creating
// duplicate demo rows each time the service restarts.
const alreadySeeded = (db.prepare(`SELECT COUNT(*) as c FROM customers`).get() as any).c > 0;
if (alreadySeeded) {
  console.log("Database already has data — skipping seed.");
  process.exit(0);
}

console.log("Seeding sample data (Sample Trading PLC: 3 branches, 14 staff, stock, invoices, payments)...");

const DAY = 86400000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
const now = new Date();
const Y = now.getUTCFullYear(), M = now.getUTCMonth();
const ymd = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
const lastMonth = (d: number) => ymd(Y, M - 1, d);              // a day of last month (for the "October" VAT story)
const lastPeriod = ymd(Y, M - 1, 1).slice(0, 7);
const periodBefore = ymd(Y, M - 2, 1).slice(0, 7);
const round2 = (n: number) => Math.round(n * 100) / 100;
let lcg = 42;
const rnd = () => (lcg = (lcg * 1664525 + 1013904223) % 4294967296) / 4294967296;
const between = (lo: number, hi: number) => Math.round(lo + rnd() * (hi - lo));

// ---- Company profile (sample values - replace under Settings) ----
setSetting("company_name", "Sample Trading PLC");
setSetting("company_tin", "[YOUR TIN]");
setSetting("company_address", "Bole, Addis Ababa");

// ---- Branches ----
const HO = getHeadOfficeId();
const insertBranch = db.prepare(`INSERT INTO branches (id, code, name, city) VALUES (?,?,?,?)`);
const BOLE = nanoid(), MEK = nanoid();
insertBranch.run(BOLE, "BOLE", "Bole Branch", "Addis Ababa");
insertBranch.run(MEK, "MEK", "Mekanisa Branch", "Addis Ababa");
const branches = [
  { id: HO, code: "HO", scale: 0.4 },
  { id: BOLE, code: "BOLE", scale: 1.0 },
  { id: MEK, code: "MEK", scale: 0.7 },
];

// ---- Chart of accounts ----
const accounts = [
  { code: "1000", name: "Cash & Bank", type: "asset" },
  { code: "1100", name: "Accounts Receivable", type: "asset" },
  { code: "1200", name: "Inventory", type: "asset" },
  { code: "4000", name: "Sales Revenue", type: "income" },
  { code: "5000", name: "Operating Expenses", type: "expense" },
  { code: "2000", name: "Tax Payable", type: "liability" },
];
const insertAccount = db.prepare(`INSERT OR IGNORE INTO accounts (id, code, name, type) VALUES (?,?,?,?)`);
for (const a of accounts) insertAccount.run(nanoid(), a.code, a.name, a.type);

// ---- Customers ----
const customers = [
  { key: "tigist", name: "Tigist Bakery", phone: "0911223344", tin: "0012345678" },
  { key: "yonas", name: "Yonas Hardware", phone: "0922334455", tin: "0098765432" },
  { key: "almaz", name: "Almaz Kebede", phone: "0933556677", tin: "0055566677" },
  { key: "hana", name: "Hana Furniture", phone: "0944667788", tin: "0066677788" },
  { key: "dawit", name: "Dawit Pharmacy", phone: "0955778899", tin: "0077788899" },
  { key: "selam", name: "Selam Trading PLC", phone: "0966889900", tin: "0088899900" },
];
const C: Record<string, string> = {};
const insertCustomer = db.prepare(`INSERT INTO customers (id, name, phone, email, tin) VALUES (?,?,?,?,?)`);
for (const c of customers) {
  const id = nanoid();
  C[c.key] = id;
  insertCustomer.run(id, c.name, c.phone, `${c.key}@example.com`, c.tin);
}

// ---- Staff: 14 people, total basic pay 212,400 ----
const insertEmployee = db.prepare(
  `INSERT INTO employees (id, full_name, position, basic_salary, transport_allowance, other_allowance, tin, pension_number, phone, branch_id) VALUES (?,?,?,?,?,?,?,?,?,?)`
);
const staff: Array<[string, string, number, string, boolean]> = [
  ["Meron Alemu", "Branch manager", 25000, BOLE, true],
  ["Henok Bekele", "Accountant", 16000, HO, true],
  ["Lidya Tadesse", "Sales", 10000, BOLE, true],
  ["Samuel Girma", "Storekeeper", 7000, MEK, false], // no TIN/pension number on purpose: the AI flags it
  ["Bethlehem Haile", "Cashier", 4500, BOLE, true],
  ["Tsion Mulugeta", "Operations manager", 22000, HO, true],
  ["Abel Tadesse", "Senior accountant", 19500, HO, true],
  ["Selamawit Desta", "Purchasing officer", 18000, HO, true],
  ["Biruk Hailu", "Store supervisor", 17500, MEK, true],
  ["Rahel Assefa", "Sales lead", 16500, MEK, true],
  ["Kidus Worku", "Logistics coordinator", 15400, BOLE, true],
  ["Mahlet Kebede", "Customer service lead", 14000, BOLE, true],
  ["Yared Negash", "Warehouse lead", 13000, MEK, true],
  ["Eden Solomon", "Branch supervisor", 14000, MEK, true],
];
staff.forEach(([name, pos, basic, br, hasIds], i) => {
  insertEmployee.run(nanoid(), name, pos, basic, 0, 0, hasIds ? `00${(11122233 + i * 1111).toString().padStart(8, "0")}` : null,
    hasIds ? `PEN-${String(i + 1).padStart(4, "0")}` : null, `09${(33445566 + i * 111111).toString().padStart(8, "0")}`, br);
});

// ---- Products & stock ----
const prod = (sku: string, name: string, unit: string, cost: number, sell: number, vat: number, reorder: number, lead: number) => {
  const id = nanoid();
  db.prepare(`INSERT INTO products (id, sku, name, unit, cost_price, sell_price, vat_rate, reorder_level, lead_time_days) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, sku, name, unit, cost, sell, vat, reorder, lead);
  return id;
};
const CEM = prod("CEM-50", "Cement, 50 kg", "bag", 900, 1100, 0.15, 50, 7);
const REB = prod("REB-12", "Rebar, 12 mm", "pcs", 700, 850, 0.15, 40, 10);
const PNT = prod("PNT-20", "Paint, white 20 L", "tin", 3300, 4200, 0.15, 10, 10);
const NAI = prod("NAI-1K", "Nails 1kg pack", "pack", 85, 120, 0.15, 100, 3);
const GLV = prod("GLV-01", "Safety gloves", "pair", 60, 90, 0.15, 30, 5);
const EXM = prod("EXM-01", "Exercise books (VAT-exempt)", "pcs", 40, 55, 0, 20, 5);

const bId = (code: string) => branches.find((b) => b.code === code)!.id;
type Plan = { product: string; branch: string; open: number; sales: Array<[number, number]> };
const weekly = (qty: number): Array<[number, number]> => [5, 12, 19, 26, 33, 40, 47, 54, 61, 68].map((d) => [d, qty] as [number, number]);
const plans: Plan[] = [
  // Left on the shelf after the invoice below: Cement at Bole 12 (sells about 30 a week), Rebar at Bole 40, Paint at Mekanisa 0.
  { product: CEM, branch: "HO", open: 450, sales: [[5, 10], [12, 8], [20, 12], [28, 9]] },
  { product: CEM, branch: "BOLE", open: 322, sales: weekly(30) },
  { product: CEM, branch: "MEK", open: 80, sales: [[10, 6], [25, 5]] },
  { product: REB, branch: "HO", open: 300, sales: [[3, 12], [9, 10], [18, 14]] },
  { product: REB, branch: "BOLE", open: 350, sales: [[4, 29], [11, 29], [18, 29], [25, 29], [32, 29], [39, 29], [46, 29], [53, 29], [60, 29], [67, 29]] },
  { product: REB, branch: "MEK", open: 60, sales: [] },
  { product: PNT, branch: "HO", open: 40, sales: [[6, 4], [14, 3], [22, 5]] },
  { product: PNT, branch: "MEK", open: 25, sales: [[20, 10], [35, 8], [50, 7]] },
  { product: PNT, branch: "BOLE", open: 30, sales: [[9, 4], [30, 5]] },
  { product: NAI, branch: "HO", open: 900, sales: [[1, 60], [4, 55], [7, 70], [10, 50], [13, 65], [17, 45], [21, 60], [25, 40]] },
  { product: NAI, branch: "BOLE", open: 300, sales: [[5, 20], [15, 25]] },
  { product: NAI, branch: "MEK", open: 220, sales: [[8, 20]] },
  { product: GLV, branch: "HO", open: 120, sales: [[8, 10], [20, 12]] },
  { product: GLV, branch: "BOLE", open: 80, sales: [[9, 6]] },
  { product: GLV, branch: "MEK", open: 60, sales: [[12, 5]] },
  { product: EXM, branch: "HO", open: 100, sales: [[7, 15], [19, 10]] },
  { product: EXM, branch: "BOLE", open: 70, sales: [[11, 8]] },
  { product: EXM, branch: "MEK", open: 60, sales: [[14, 6]] },
];
const costOf = (id: string) => (db.prepare(`SELECT cost_price FROM products WHERE id = ?`).get(id) as { cost_price: number }).cost_price;
for (const p of plans) {
  addMovement({ productId: p.product, branchId: bId(p.branch), type: "purchase", qty: p.open, unitCost: costOf(p.product), date: daysAgo(70), refType: "demo", note: "opening stock (sample)" });
  for (const [d, q] of p.sales) addMovement({ productId: p.product, branchId: bId(p.branch), type: "sale", qty: -q, unitCost: costOf(p.product), date: daysAgo(d), refType: "demo" });
}

// ---- Invoices ----
const insertInvoice = db.prepare(
  `INSERT INTO invoices (id, invoice_number, customer_id, issue_date, due_date, amount, vat_amount, total_amount, branch_id) VALUES (?,?,?,?,?,?,?,?,?)`
);
/** An invoice for a round total that already includes 15% VAT (no stock lines). */
function simpleInvoice(number: string, customer: string, branch: string, issued: string, due: string, total: number, opts: { net?: number; paid?: boolean } = {}) {
  const net = opts.net ?? round2(total / 1.15);
  const vat = round2(total - net);
  const id = nanoid();
  insertInvoice.run(id, number, C[customer], issued, due, net, vat, round2(net + vat), bId(branch));
  if (opts.paid) db.prepare(`UPDATE invoices SET status = 'paid', amount_paid = ? WHERE id = ?`).run(round2(net + vat), id);
  return { id, net, vat };
}

type L = { productId: string; qty: number };
function itemisedInvoice(opts: { number: string; branch: string; customer: string; issued: number; due: number; lines: L[] }) {
  const branchId = bId(opts.branch);
  const id = nanoid();
  const rows = opts.lines.map((l) => {
    const p = db.prepare(`SELECT * FROM products WHERE id = ?`).get(l.productId) as any;
    const net = round2(l.qty * p.sell_price);
    const vat = round2(net * p.vat_rate);
    return { ...l, p, net, vat, total: net + vat };
  });
  const net = rows.reduce((s, r) => s + r.net, 0), vat = rows.reduce((s, r) => s + r.vat, 0), total = net + vat;
  runInTransaction(() => {
    insertInvoice.run(id, opts.number, C[opts.customer], daysAgo(opts.issued), daysAgo(opts.due), net, vat, total, branchId);
    for (const r of rows) {
      db.prepare(`INSERT INTO invoice_lines (id, invoice_id, product_id, description, qty, unit_price, vat_rate, net, vat, total) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(nanoid(), id, r.productId, r.p.name, r.qty, r.p.sell_price, r.p.vat_rate, r.net, r.vat, r.total);
    }
    applySaleStock(id, branchId, daysAgo(opts.issued), opts.lines.map((l) => ({ productId: l.productId, qty: l.qty })));
  });
  return { id, branchId, total };
}

// This month: INV-0041 (itemised, e-invoiced below) and the invoices that are still open.
const inv41 = itemisedInvoice({ number: "INV-0041", branch: "BOLE", customer: "tigist", issued: 3, due: -9, lines: [{ productId: CEM, qty: 10 }, { productId: REB, qty: 20 }] });
simpleInvoice("INV-0047", "dawit", "BOLE", daysAgo(10), daysAgo(-7), 750);
simpleInvoice("INV-0048", "selam", "BOLE", daysAgo(9), daysAgo(-12), 8200);
simpleInvoice("INV-0049", "almaz", "MEK", daysAgo(7), daysAgo(-8), 5750);
simpleInvoice("INV-0050", "dawit", "MEK", daysAgo(5), daysAgo(-15), 4000);
simpleInvoice("INV-0051", "yonas", "BOLE", daysAgo(2), daysAgo(-20), 2800);

// Last month ("October"): together these make VAT base 142,000 and output VAT 21,300. Three are overdue (38,400).
const oct = [
  { n: "INV-0044", c: "tigist", b: "BOLE", day: 3, due: daysAgo(1), total: 750, paid: false },      // overdue
  { n: "INV-0043", c: "hana", b: "BOLE", day: 4, due: lastMonth(25), total: 21950, paid: false },    // overdue
  { n: "INV-0045", c: "yonas", b: "MEK", day: 5, due: lastMonth(28), total: 15700, paid: false },    // overdue
  { n: "INV-0036", c: "selam", b: "BOLE", day: 8, due: lastMonth(30), total: 38000, paid: false },   // settled by CBE below
  { n: "INV-0038", c: "tigist", b: "BOLE", day: 10, due: lastMonth(30), total: 26500, paid: false }, // settled by Telebirr below
  { n: "INV-0039", c: "almaz", b: "MEK", day: 12, due: lastMonth(30), total: 12800, paid: false },   // settled by CBE below
  { n: "INV-0040", c: "dawit", b: "MEK", day: 15, due: lastMonth(30), total: 15450, paid: false },   // settled by BOA below
  { n: "INV-0042", c: "yonas", b: "BOLE", day: 17, due: lastMonth(30), total: 4500, paid: false },   // settled by Telebirr below
  { n: "INV-0035", c: "hana", b: "MEK", day: 20, due: lastMonth(30), total: 27650, paid: true },     // paid in cash
];
let netSoFar = 0, vatSoFar = 0;
oct.forEach((o, i) => {
  const last = i === oct.length - 1;
  const net = last ? round2(142000 - netSoFar) : round2(o.total / 1.15);
  const total = last ? round2(net + (21300 - vatSoFar)) : o.total;
  simpleInvoice(o.n, o.c, o.b, lastMonth(o.day), o.due, total, { net, paid: o.paid });
  netSoFar += net; vatSoFar += round2(total - net);
});

// ---- Payments through the real pipeline (CBE, Telebirr, BOA) ----
const pay = (p: { provider: "CBE" | "TELEBIRR" | "BOA"; amount: number; name?: string; ref: string; ago: number; branch: string; direction?: "credit" | "debit"; unreadable?: boolean }) => {
  const date = daysAgo(p.ago);
  const parsed = p.unreadable
    ? { provider: p.provider, parsedOk: false }
    : { provider: p.provider, parsedOk: true, amount: p.amount, currency: "ETB", counterpartyName: p.name, reference: p.ref, txnTime: `${date} 10:${String(10 + p.ago).slice(-2)}:00`, direction: p.direction ?? "credit" };
  const rawText = p.unreadable
    ? `Sample ${p.provider} message the app could not read (ref ${p.ref}).`
    : `Sample ${p.provider} message: ${p.direction === "debit" ? "sent" : "received"} ETB ${p.amount.toFixed(2)}${p.name ? ` ${p.direction === "debit" ? "to" : "from"} ${p.name}` : ""}. Ref ${p.ref}.`;
  const r = recordPayment({ provider: p.provider, parsed: parsed as any, rawText, sender: p.provider.toLowerCase(), channel: "sms", branchId: bId(p.branch), date });
  // Payments that matched an invoice (or are money out) are already sorted; the rest stay for review.
  if (!p.unreadable && !r.appliedToInvoiceId && p.direction !== "debit" && r.verificationStatus === "verified") {
    db.prepare(`UPDATE payment_events SET verification_status = 'pending' WHERE id = ?`).run(r.id); // left for the owner to match
  }
  if (r.transactionId && (r.appliedToInvoiceId || p.direction === "debit")) {
    db.prepare(`UPDATE transactions SET category_status = 'confirmed', category = ? WHERE id = ?`).run(p.direction === "debit" ? "Supplies & Inventory" : "Sales Revenue", r.transactionId);
  }
  return r;
};
runInTransaction(() => {
  pay({ provider: "CBE", amount: 38000, name: "Selam Trading PLC", ref: "FT26310A1B2", ago: 6, branch: "BOLE" });
  pay({ provider: "TELEBIRR", amount: 26500, name: "Tigist Bakery", ref: "DKP2B77", ago: 4, branch: "BOLE" });
  pay({ provider: "BOA", amount: 15450, name: "Dawit Pharmacy", ref: "BOA26311Q", ago: 3, branch: "MEK" });
  pay({ provider: "CBE", amount: 12800, name: "Almaz Kebede", ref: "FT26317Z0Q", ago: 0, branch: "MEK" });
  pay({ provider: "TELEBIRR", amount: 4500, name: "Yonas Hardware", ref: "DKP3A91", ago: 0, branch: "BOLE" });
  pay({ provider: "CBE", amount: 9600, name: "Hana Furniture", ref: "FT26318K2P", ago: 0, branch: "BOLE" });      // no invoice for this amount: review
  pay({ provider: "BOA", amount: 750, ref: "UI0001", ago: 0, branch: "BOLE" });                                    // no payer name, fits two invoices: review
  pay({ provider: "CBE", amount: 3200, name: "Cement supplier", ref: "FT26316M8T", ago: 1, branch: "BOLE", direction: "debit" });
  pay({ provider: "TELEBIRR", amount: 1200, name: "Yonas Hardware", ref: "DKP3A91", ago: 1, branch: "BOLE" });     // same reference twice: blocked as a duplicate
  pay({ provider: "TELEBIRR", amount: 0, ref: "UNREAD1", ago: 2, branch: "BOLE", unreadable: true });
  pay({ provider: "CBE", amount: 0, ref: "UNREAD2", ago: 3, branch: "MEK", unreadable: true });
});

// ---- Ledger history (about 10 weeks): scaled so totals match the sample books ----
const insTxn = db.prepare(
  `INSERT INTO transactions (id, date, description, amount, category, category_confidence, category_status, source, branch_id, input_vat) VALUES (?,?,?,?,?,?,?, 'manual', ?, ?)`
);
const txn = (date: string, branch: string, description: string, amount: number, category: string, status = "confirmed", conf = 1, inputVat = 0) =>
  insTxn.run(nanoid(), date, description, amount, category, conf, status, branch, inputVat);

const paymentsIn = (db.prepare(`SELECT COALESCE(SUM(amount),0) AS v FROM transactions WHERE amount > 0`).get() as any).v as number;
const paymentsOut = (db.prepare(`SELECT COALESCE(SUM(amount),0) AS v FROM transactions WHERE amount < 0`).get() as any).v as number;
const TARGET_IN = 486250, TARGET_OUT = 327900; // money in / out in the design

// Fixed entries (not scaled)
const fixedIn = 27650 + 2300;
const supplierTrio: Array<[number, number, number]> = [[8, 20000, 2608.7], [15, 15000, 1956.52], [22, 14680, 1914.78]]; // input VAT 6,480.00
type Row = { date: string; branch: string; desc: string; amt: number; cat: string };
const cash: Row[] = [], vary: Row[] = [], fixedOut: Row[] = [];
for (let d = 70; d >= 1; d--) {
  const date = daysAgo(d);
  const dow = new Date(date).getUTCDay();
  const dom = Number(date.slice(8, 10));
  for (const b of branches) {
    if ([1, 4].includes(dow)) cash.push({ date, branch: b.id, desc: `Customer payment - ${customers[between(0, 5)].name}`, amt: between(2000, 4500) * b.scale, cat: "Sales Revenue" });
    if (dow === 2) vary.push({ date, branch: b.id, desc: `Supplier payment - ${["Addis Hardware Wholesale", "Habesha Building Supplies", "Awash Paints"][between(0, 2)]}`, amt: -between(2000, 5500) * b.scale, cat: "Supplies & Inventory" });
    if (dow === 4) vary.push({ date, branch: b.id, desc: "Fuel purchase for delivery van", amt: -between(300, 900), cat: "Transport & Fuel" });
    if (dom === 1) fixedOut.push({ date, branch: b.id, desc: `${b.code} shop rent`, amt: -({ HO: 8000, BOLE: 18000, MEK: 12000 } as any)[b.code], cat: "Rent" });
    if (dom === 5) fixedOut.push({ date, branch: b.id, desc: "EEU electricity bill", amt: -({ HO: 900, BOLE: 1400, MEK: 1100 } as any)[b.code], cat: "Utilities" });
  }
}
// Planted for the AI to find: an outlier fuel bill, rent paid twice, and low-confidence suggestions to review.
const planted: Row[] = [
  { date: daysAgo(6), branch: MEK, desc: "Fuel purchase for delivery van", amt: -9800, cat: "Transport & Fuel" },
  { date: daysAgo(4), branch: BOLE, desc: "Rent payment - Bole shop", amt: -18000, cat: "Rent" },
  { date: daysAgo(3), branch: BOLE, desc: "Rent payment - Bole shop", amt: -18000, cat: "Rent" },
];
const suggestedOut = { date: daysAgo(2), branch: HO, desc: "Misc purchase - market", amt: -1250 };
const sumAmt = (rows: Row[]) => rows.reduce((s, r) => s + r.amt, 0);

const trioGross = supplierTrio.reduce((t, x) => t + x[1], 0);
const inRoom = TARGET_IN - paymentsIn - fixedIn;                         // what the scaled cash sales must add up to
const fixedAbs = -(sumAmt(fixedOut) + sumAmt(planted) + suggestedOut.amt) + trioGross;
const varyAbs = TARGET_OUT + paymentsOut - fixedAbs;                      // paymentsOut is negative (the 3,200 bank payment)
const fIn = inRoom / sumAmt(cash);
const scaleOut = varyAbs / -sumAmt(vary);
if (!(fIn > 0.2 && fIn < 5 && scaleOut > 0.2 && scaleOut < 5)) console.warn("seed totals are far from the sample books", { fIn, scaleOut });

runInTransaction(() => {
  let used = 0;
  cash.forEach((r, i) => {
    const amt = i === cash.length - 1 ? Math.round(inRoom - used) : Math.round(r.amt * fIn);
    used += amt;
    txn(r.date, r.branch, r.desc, amt, r.cat);
  });
  txn(lastMonth(25), bId("MEK"), "Customer payment - Hana Furniture (INV-0035, cash)", 27650, "Sales Revenue");
  txn(daysAgo(1), BOLE, "Payment ref 7731 abc", 2300, "Other Income", "suggested", 0.3);
  let usedAbs = 0;
  vary.forEach((r, i) => {
    const abs = i === vary.length - 1 ? Math.round(varyAbs - usedAbs) : Math.round(-r.amt * scaleOut);
    usedAbs += abs;
    txn(r.date, r.branch, r.desc, -abs, r.cat);
  });
  for (const r of fixedOut) txn(r.date, r.branch, r.desc, r.amt, r.cat);
  for (const r of planted) txn(r.date, r.branch, r.desc, r.amt, r.cat);
  txn(suggestedOut.date, suggestedOut.branch, suggestedOut.desc, suggestedOut.amt, "Other Expense", "suggested", 0.3);
  for (const [day, gross, ivat] of supplierTrio) txn(lastMonth(day), bId("HO"), `Supplier payment (VAT invoice) - ${["Addis Hardware Wholesale", "Habesha Building Supplies", "Awash Paints"][day % 3]}`, -gross, "Supplies & Inventory", "confirmed", 1, ivat);
});

// ---- Tax filings: last month's VAT is ready to review; staff tax and pension due; earlier ones done ----
const insFiling = db.prepare(`INSERT INTO tax_filings (id, period, tax_type, base_amount, tax_amount, status, due_date, detail) VALUES (?,?,?,?,?,?,?,?)`);
const dueSoon = daysAgo(-6);
insFiling.run(nanoid(), lastPeriod, "vat", 142000, 14820, "due", dueSoon, JSON.stringify({ outputVat: 21300, inputVat: 6480, netVat: 14820, creditCarriedForward: 0 }));
insFiling.run(nanoid(), lastPeriod, "income_tax_payroll", 212400, 21460, "due", dueSoon, null);
insFiling.run(nanoid(), lastPeriod, "pension", 212400, 30330, "due", dueSoon, null);
insFiling.run(nanoid(), lastPeriod, "withholding", 43200, 2840, "paid", daysAgo(9), null);
insFiling.run(nanoid(), periodBefore, "vat", 79400, 11905, "filed", daysAgo(31), JSON.stringify({ netVat: 11905 }));

// ---- e-invoice for INV-0041 (test mode) ----
let docId = "", chain = "", payloadJson = "";
runInTransaction(() => { const d = createEInvoiceDoc(inv41.id, "invoice"); docId = d.id; chain = d.chainHash; });
const row = db.prepare(`SELECT payload FROM einvoices WHERE id = ?`).get(docId) as { payload: string };
payloadJson = row.payload;
const payload = JSON.parse(payloadJson) as EInvoicePayload;
const reg = await getAdapter().register({ docNumber: payload.docNumber, payload, chainHash: chain });
if (reg.ok) {
  db.prepare(`UPDATE einvoices SET status = 'registered', irn = ?, registration_mode = ?, registered_at = ?, qr_data = ? WHERE id = ?`)
    .run(reg.irn, reg.mode, new Date().toISOString(), qrFor(payload, chain, reg.irn ?? null), docId);
}

console.log("Seed complete. Sample CBE/Telebirr/BOA SMS text you can POST to /api/sms/ingest (add \"branch\": \"BOLE\" to book it to that branch):");
console.log(JSON.stringify({
  rawText: `Dear Customer, your Account 1*****1234 has been Credited with ETB 1,500.00 from ALMAZ KEBEDE on ${daysAgo(0).split("-").reverse().join("/")}. Your Current Balance is ETB 25,430.55. Ref No: FT24296ABCDE`,
  sender: "CBE",
}, null, 2));
