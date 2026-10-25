import { nanoid } from "../lib/id.js";
import db, { getHeadOfficeId, runInTransaction, setSetting } from "./index.js";
import { calcVat } from "../lib/taxEngine.js";
import { applySaleStock, addMovement } from "../lib/inventory.js";
import { createEInvoiceDoc, getAdapter, qrFor, type EInvoicePayload } from "../lib/einvoice.js";
import { nextInvoiceNumber } from "../lib/invoicing.js";

// Idempotent: if this looks like a DB that's already been seeded (or already
// has real customer data), do nothing. This lets `npm run seed` be safely
// called on every boot (e.g. in a deploy's start command) without creating
// duplicate demo rows each time the service restarts.
const alreadySeeded = (db.prepare(`SELECT COUNT(*) as c FROM customers`).get() as any).c > 0;
if (alreadySeeded) {
  console.log("Database already has data — skipping seed.");
  process.exit(0);
}

console.log("Seeding demo data (3 branches, products, stock, history)...");

const DAY = 86400000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
let lcg = 42;
const rnd = () => (lcg = (lcg * 1664525 + 1013904223) % 4294967296) / 4294967296;
const between = (lo: number, hi: number) => Math.round(lo + rnd() * (hi - lo));

// ---- Company profile (demo values - replace under Settings) ----
setSetting("company_name", "Birritu Trading PLC (demo)");
setSetting("company_tin", "0099887766");
setSetting("company_address", "Addis Ababa, Ethiopia");

// ---- Branches ----
const HO = getHeadOfficeId();
const insertBranch = db.prepare(`INSERT INTO branches (id, code, name, city) VALUES (?,?,?,?)`);
const BOLE = nanoid(), MEK = nanoid();
insertBranch.run(BOLE, "BOLE", "Bole Branch", "Addis Ababa");
insertBranch.run(MEK, "MEK", "Mekelle Branch", "Mekelle");
const branches = [
  { id: HO, code: "HO", scale: 1.0 },
  { id: BOLE, code: "BOLE", scale: 0.8 },
  { id: MEK, code: "MEK", scale: 0.5 },
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
  { name: "Abebe Kebede", phone: "0911223344", email: "abebe@example.com", tin: "0012345678" },
  { name: "Selam Trading PLC", phone: "0922334455", email: "selam@example.com", tin: "0098765432" },
  { name: "Tigist Hardware", phone: "0933556677", email: "tigist@example.com", tin: "0055566677" },
];
const custIds: string[] = [];
const insertCustomer = db.prepare(`INSERT INTO customers (id, name, phone, email, tin) VALUES (?,?,?,?,?)`);
for (const c of customers) {
  const id = nanoid();
  custIds.push(id);
  insertCustomer.run(id, c.name, c.phone, c.email, c.tin);
}

// ---- Employees (spread across branches) ----
const insertEmployee = db.prepare(
  `INSERT INTO employees (id, full_name, position, basic_salary, transport_allowance, other_allowance, tin, pension_number, phone, branch_id) VALUES (?,?,?,?,?,?,?,?,?,?)`
);
insertEmployee.run(nanoid(), "Hana Girma", "Accountant", 12000, 600, 500, "0011122233", "PEN-0001", "0933445566", HO);
insertEmployee.run(nanoid(), "Yonas Tesfaye", "Sales Officer", 8500, 600, 0, "0044455566", "PEN-0002", "0944556677", HO);
insertEmployee.run(nanoid(), "Marta Bekele", "Branch Manager", 15000, 800, 1000, "0077788899", "PEN-0003", "0955667788", BOLE);
insertEmployee.run(nanoid(), "Dawit Haile", "Storekeeper", 6500, 400, 0, null, null, "0966778899", MEK); // missing TIN/pension on purpose: the AI flags it

// ---- Products & stock ----
const prod = (sku: string, name: string, unit: string, cost: number, sell: number, vat: number, reorder: number, lead: number) => {
  const id = nanoid();
  db.prepare(`INSERT INTO products (id, sku, name, unit, cost_price, sell_price, vat_rate, reorder_level, lead_time_days) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, sku, name, unit, cost, sell, vat, reorder, lead);
  return id;
};
const CEM = prod("CEM-50", "Cement 50kg bag", "bag", 900, 1100, 0.15, 50, 7);
const REB = prod("REB-12", "Rebar 12mm", "pcs", 780, 950, 0.15, 40, 10);
const PNT = prod("PNT-20", "Paint 20L", "tin", 3300, 4200, 0.15, 10, 10);
const NAI = prod("NAI-1K", "Nails 1kg pack", "pack", 85, 120, 0.15, 100, 3);
const GLV = prod("GLV-01", "Safety gloves", "pair", 60, 90, 0.15, 30, 5);
const EXM = prod("EXM-01", "Demo VAT-exempt item", "pcs", 40, 55, 0, 20, 5);

const bId = (code: string) => branches.find((b) => b.code === code)!.id;
type Plan = { product: string; branch: string; open: number; sales: Array<[number, number]> };
const plans: Plan[] = [
  // Cement: Bole sells fast and is about to run out while Head Office is overstocked -> reorder + transfer suggestion
  { product: CEM, branch: "HO", open: 450, sales: [[5, 10], [12, 8], [20, 12], [28, 9]] },
  { product: CEM, branch: "BOLE", open: 160, sales: [[2, 18], [4, 15], [8, 20], [11, 16], [15, 18], [19, 14], [23, 17], [27, 16]] },
  { product: CEM, branch: "MEK", open: 80, sales: [[10, 6], [25, 5]] },
  { product: REB, branch: "HO", open: 300, sales: [[3, 12], [9, 10], [18, 14]] },
  { product: REB, branch: "BOLE", open: 100, sales: [[6, 9], [16, 7]] },
  { product: REB, branch: "MEK", open: 60, sales: [] },                       // nothing sold: slow-moving
  { product: PNT, branch: "HO", open: 40, sales: [[6, 4], [14, 3], [22, 5]] },
  { product: PNT, branch: "MEK", open: 25, sales: [] },                       // slow-moving
  { product: NAI, branch: "HO", open: 500, sales: [[1, 60], [4, 55], [7, 70], [10, 50], [13, 65], [17, 45], [21, 60], [25, 40]] },
  { product: NAI, branch: "BOLE", open: 300, sales: [[5, 20], [15, 25]] },
  { product: GLV, branch: "HO", open: 120, sales: [[8, 10], [20, 12]] },
  { product: GLV, branch: "BOLE", open: 80, sales: [[9, 6]] },
  { product: EXM, branch: "HO", open: 100, sales: [[7, 15], [19, 10]] },
];
const costOf = (id: string) => (db.prepare(`SELECT cost_price FROM products WHERE id = ?`).get(id) as { cost_price: number }).cost_price;
for (const p of plans) {
  addMovement({ productId: p.product, branchId: bId(p.branch), type: "purchase", qty: p.open, unitCost: costOf(p.product), date: daysAgo(70), refType: "demo", note: "opening stock (demo)" });
  for (const [d, q] of p.sales) addMovement({ productId: p.product, branchId: bId(p.branch), type: "sale", qty: -q, unitCost: costOf(p.product), date: daysAgo(d), refType: "demo" });
}

// ---- Ledger history (about 10 weeks) so the forecast and anomaly checks have something to learn from ----
const insTxn = db.prepare(
  `INSERT INTO transactions (id, date, description, amount, category, category_confidence, category_status, source, branch_id) VALUES (?,?,?,?,?,?,?, 'manual', ?)`
);
const txn = (date: string, branch: string, description: string, amount: number, category: string, status = "confirmed", conf = 1) =>
  insTxn.run(nanoid(), date, description, amount, category, conf, status, branch);

for (let d = 70; d >= 1; d--) {
  const date = daysAgo(d);
  const dow = new Date(date).getUTCDay(); // 0 Sun
  const dom = Number(date.slice(8, 10));
  for (const b of branches) {
    if ([1, 3, 5].includes(dow)) txn(date, b.id, `Customer payment - ${customers[between(0, 2)].name}`, between(4500, 9500) * b.scale, "Sales Revenue");
    if (dow === 2) txn(date, b.id, `Supplier payment - ${["Addis Hardware Wholesale", "Habesha Building Supplies", "Awash Paints"][between(0, 2)]}`, -between(2000, 5500) * b.scale, "Supplies & Inventory");
    if (dow === 4) txn(date, b.id, "Fuel purchase for delivery van", -between(300, 900), "Transport & Fuel");
    if (dom === 1) txn(date, b.id, `${b.code} shop rent`, -({ HO: 8000, BOLE: 5000, MEK: 4000 } as any)[b.code], "Rent");
    if (dom === 5) txn(date, b.id, "EEU electricity bill", -between(900, 1500) * b.scale, "Utilities");
  }
}
// Planted for the AI to find: an outlier fuel bill, a double-entered supplier payment, and two low-confidence suggestions to review.
txn(daysAgo(6), MEK, "Fuel purchase for delivery van", -9800, "Transport & Fuel");
txn(daysAgo(4), BOLE, "Supplier payment - Addis Paint Supplies", -5400, "Supplies & Inventory");
txn(daysAgo(3), BOLE, "Supplier payment - Addis Paint Supplies", -5400, "Supplies & Inventory");
txn(daysAgo(2), HO, "Misc purchase - market", -1250, "Other Expense", "suggested", 0.3);
txn(daysAgo(1), BOLE, "Payment ref 7731 abc", 2300, "Other Income", "suggested", 0.3);
// today's two original demo entries
txn(daysAgo(0), HO, "Office rent payment", -8000, "Rent");
txn(daysAgo(0), HO, "Fuel purchase for delivery van", -600, "Transport & Fuel");

// ---- Invoices ----
const today = daysAgo(0);
const insertInvoice = db.prepare(
  `INSERT INTO invoices (id, invoice_number, customer_id, issue_date, due_date, amount, vat_amount, total_amount, branch_id) VALUES (?,?,?,?,?,?,?,?,?)`
);
// two simple (amount-only) invoices, used by the SMS matching examples
insertInvoice.run(nanoid(), "INV-1001", custIds[0], today, today, 1500, calcVat(1500), 1500 + calcVat(1500), HO);
insertInvoice.run(nanoid(), "INV-1002", custIds[1], today, today, 4000, calcVat(4000), 4000 + calcVat(4000), HO);

type L = { productId: string; qty: number };
function itemisedInvoice(opts: { branch: string; customer: string; issued: number; due: number; lines: L[]; paid?: boolean }) {
  const branchId = bId(opts.branch);
  const id = nanoid();
  const rows = opts.lines.map((l) => {
    const p = db.prepare(`SELECT * FROM products WHERE id = ?`).get(l.productId) as any;
    const net = Math.round(l.qty * p.sell_price * 100) / 100;
    const vat = Math.round(net * p.vat_rate * 100) / 100;
    return { ...l, p, net, vat, total: net + vat };
  });
  const net = rows.reduce((s, r) => s + r.net, 0), vat = rows.reduce((s, r) => s + r.vat, 0), total = net + vat;
  runInTransaction(() => {
    insertInvoice.run(id, nextInvoiceNumber(branchId), opts.customer, daysAgo(opts.issued), daysAgo(opts.due), net, vat, total, branchId);
    for (const r of rows) {
      db.prepare(`INSERT INTO invoice_lines (id, invoice_id, product_id, description, qty, unit_price, vat_rate, net, vat, total) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(nanoid(), id, r.productId, r.p.name, r.qty, r.p.sell_price, r.p.vat_rate, r.net, r.vat, r.total);
    }
    applySaleStock(id, branchId, daysAgo(opts.issued), opts.lines.map((l) => ({ productId: l.productId, qty: l.qty })));
    if (opts.paid) db.prepare(`UPDATE invoices SET status = 'paid', amount_paid = ? WHERE id = ?`).run(total, id);
  });
  return { id, branchId, total };
}

// A large unpaid invoice that is well past due (the AI flags it).
itemisedInvoice({ branch: "HO", customer: custIds[2], issued: 55, due: 40, lines: [{ productId: CEM, qty: 20 }] });

// A paid, e-invoiced, registered invoice at the Bole branch with its payment SMS and ledger entry.
const paid = itemisedInvoice({ branch: "BOLE", customer: custIds[1], issued: 3, due: -27, lines: [{ productId: REB, qty: 10 }, { productId: GLV, qty: 12 }], paid: true });
const txnId = nanoid(), evId = nanoid();
db.prepare(
  `INSERT INTO transactions (id, date, description, amount, category, category_confidence, category_status, source, source_ref_id, branch_id) VALUES (?,?,?,?,?,?,?, 'sms_payment', ?, ?)`
).run(txnId, daysAgo(2), `TELEBIRR credit of ${paid.total} ETB from Selam Trading PLC (ref CFH7Q2L9X1)`, paid.total, "Sales Revenue", 0.68, "confirmed", evId, BOLE);
db.prepare(
  `INSERT INTO payment_events (id, provider, sender, raw_text, parsed_ok, amount, currency, counterparty_name, counterparty_phone, reference, balance_after, txn_time, direction, verification_status, matched_invoice_id, transaction_id, branch_id)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
).run(evId, "TELEBIRR", "telebirr", `You have received ETB ${paid.total} from Selam Trading PLC(251922334455). Your current balance is ETB 18,400.00. Transaction No. CFH7Q2L9X1 at ${daysAgo(2)} 11:20:05`,
  1, paid.total, "ETB", "Selam Trading PLC", "251922334455", "CFH7Q2L9X1", 18400, `${daysAgo(2)} 11:20:05`, "credit", "verified", paid.id, txnId, BOLE);

let docId = "", chain = "", payloadJson = "";
runInTransaction(() => { const d = createEInvoiceDoc(paid.id, "invoice"); docId = d.id; chain = d.chainHash; });
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
  rawText: `Dear Customer, your Account 1*****1234 has been Credited with ETB 1,500.00 from ABEBE KEBEDE on ${today.split("-").reverse().join("/")}. Your Current Balance is ETB 25,430.55. Ref No: FT24296ABCDE`,
  sender: "CBE",
}, null, 2));
