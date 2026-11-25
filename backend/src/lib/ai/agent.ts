// The copilot's conversation layer. It needs no language-model key: it understands what was asked (topic, period, bank, branch),
// remembers the thread so follow-ups work ("and last month?"), asks when something is missing, and can DO things
// (record a payout, void a bill, mark an invoice paid) but only after the person confirms. Every number comes from the books.
import db, { runInTransaction, getHeadOfficeId } from "../../db/index.js";
import { round2, todayStr } from "../branch.js";
import { nanoid } from "../id.js";
import { HttpError } from "../httpRouter.js";
import { answerOffline, askAssistant, HELP, type AssistantReply } from "./assistant.js";
import { smartCategorize } from "./learner.js";
import { applyPaymentToInvoice } from "../payments.js";
import { voidBill, settleBill, drawerEvent, openShift, expectedCash, matchPaymentToBill, METHODS, type Method } from "../sales.js";
import { llmConfigured } from "./llm.js";

export interface Pending { kind: ActionKind; params: Record<string, any>; missing: string }
export interface ActionProposal { kind: ActionKind; params: Record<string, any>; title: string; details: string[] }
export interface Ctx { lastQ?: string; pending?: Pending; action?: ActionProposal }
export interface AgentReply extends AssistantReply { choices?: string[]; followUps?: string[]; action?: ActionProposal; context: Ctx; done?: boolean }
type ActionKind = "payout" | "expense" | "income" | "void_bill" | "bill_paid" | "invoice_paid" | "open_drawer" | "close_drawer";

const money = (n: number) => `ETB ${round2(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const METHOD_LABEL: Record<string, string> = { cash: "cash", telebirr: "Telebirr", cbe: "CBE", boa: "BOA", card: "card" };

const PERIOD_RE = /\b(today|yesterday|last month|this month|this year|year to date|ytd|last 90 days|last 30 days|quarter|last week|this week|past week)\b/g;
const PROV_RE = /\b(telebirr|cbe|boa|abyssinia|commercial bank)\b/g;
const TOPIC_RE = /spen|spent|expens|cost|sale|revenue|income|earn|profit|turnover|stock|inventory|reorder|payroll|salar|staff|employee|\btax|vat|owe|unpaid|outstanding|overdue|customer|e-?invoice|forecast|runway|anomal|unusual|cash|balance|who (paid|sent)|paid me|bill|till|drawer|branch|compare|how (many|much)|\\bleft\\b|remaining|on hand|in stock/;

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
function amountIn(s: string): number | null {
  const m = s.replace(/(inv|bill)[-\w#]*\d[\w-]*/gi, " ").match(/(\d[\d,]*(?:\.\d+)?)\s*(k\b)?/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, "")) * (m[2] ? 1000 : 1);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function methodIn(s: string): Method | null {
  const l = s.toLowerCase();
  if (/\bcash\b/.test(l)) return "cash";
  if (/telebirr/.test(l)) return "telebirr";
  if (/\bcbe\b|commercial/.test(l)) return "cbe";
  if (/\bboa\b|abyssinia/.test(l)) return "boa";
  if (/\bcard\b|\bpos\b/.test(l)) return "card";
  return null;
}
const noteAfter = (s: string) => clean((s.match(/\b(?:for|on|to buy|buying)\s+(.+?)(?:\s+(?:because|reason)\b.*)?$/i)?.[1] ?? "").replace(/^(the|a|an)\s+/i, "")).slice(0, 120);
const billNumber = (s: string) => { const m = s.match(/bill[\s#-]*0*(\d{1,6})\b/i); return m ? `BILL-${m[1].padStart(4, "0")}` : null; };

function reply(base: Partial<AgentReply> & { answer: string }, ctx: Ctx, scope = "all branches"): AgentReply {
  return { mode: "offline", scope, ...base, context: ctx } as AgentReply;
}

// ---------------------------------------------------------------- Actions

function findBill(number: string) {
  return db.prepare(`SELECT * FROM bills WHERE number = ?`).get(number) as any | undefined;
}
function recentBills(status: string[], limit = 5) {
  return db.prepare(`SELECT number, total, table_label, status FROM bills WHERE status IN (${status.map(() => "?").join(",")}) ORDER BY created_at DESC LIMIT ${limit}`).all(...status) as any[];
}

/** Turns a request into either a question for the missing piece, a confirmation card, or an error. */
function propose(kind: ActionKind, p: Record<string, any>, ctx: Ctx, branchId: string | null): AgentReply {
  const branch = branchId ?? getHeadOfficeId();
  const ask = (missing: string, text: string, choices?: string[]) => reply({ answer: text, choices }, { ...ctx, pending: { kind, params: p, missing }, action: undefined });
  const card = (title: string, details: string[], params = p) => reply({ answer: "Please check this before I do it:", action: { kind, params, title, details } }, { ...ctx, pending: undefined, action: { kind, params, title, details } });
  const fail = (text: string, choices?: string[]) => reply({ answer: text, choices }, { ...ctx, pending: undefined, action: undefined });

  switch (kind) {
    case "payout": {
      if (!p.amount) return ask("amount", "How much cash was paid out (in birr)?");
      if (!p.note) return ask("note", "What was it for? (for example: onions at the market)");
      if (!openShift(branch)) return fail("The cash drawer is not open, so I can't take cash out of it. Open it first (Sales & cash → Cash drawer), or tell me \"open the drawer with 1000\".", ["Open the drawer with 1000"]);
      return card("Record a cash payout", [`Amount: ${money(p.amount)}`, `For: ${p.note}`, "It leaves the cash drawer and is added to Money in & out as an expense."]);
    }
    case "expense":
    case "income": {
      if (!p.amount) return ask("amount", `How much was the ${kind} (in birr)?`);
      if (!p.note) return ask("note", `What was the ${kind} for?`);
      return card(kind === "expense" ? "Record an expense" : "Record income", [`Amount: ${money(p.amount)}`, `Description: ${p.note}`, `Goes into Money in & out as ${kind === "expense" ? "money out" : "money in"}, dated today.`]);
    }
    case "void_bill": {
      let b = p.number ? findBill(p.number) : null;
      if (!b) {
        const open = recentBills(["open", "paid"]);
        if (p.number) return fail(`I can't find ${p.number}.`, open.map((x) => `Void bill ${Number(x.number.slice(5))}`));
        if (!open.length) return fail("There are no bills to void.");
        return ask("number", "Which bill should I void?", open.map((x) => `Void bill ${Number(x.number.slice(5))} (${money(x.total)}${x.table_label ? ", " + x.table_label : ""})`));
      }
      if (b.status === "void") return fail(`${b.number} is already voided.`);
      if (b.status === "paid" && b.payment_method !== "cash") return fail(`${b.number} was paid through a bank or wallet, so it can't be voided here. Refund it in the bank app; the refund is then recorded as money out.`);
      if (!p.reason) return ask("reason", `Why is ${b.number} being voided? (it is kept for your records)`);
      return card(`Void ${b.number}`, [`Total: ${money(b.total)}${b.table_label ? " · " + b.table_label : ""}`, `Reason: ${p.reason}`, b.status === "paid" ? "The cash is refunded out of the drawer and the sale is reversed." : "The bill is closed without payment."], { ...p, number: b.number });
    }
    case "bill_paid": {
      const b = p.number ? findBill(p.number) : null;
      if (!b) {
        const open = recentBills(["open"]);
        if (!open.length) return fail(p.number ? `I can't find ${p.number}, and there are no open bills.` : "There are no open bills.");
        return ask("number", p.number ? `I can't find ${p.number}. Which bill?` : "Which bill was paid?", open.map((x) => `Bill ${Number(x.number.slice(5))} was paid${p.method ? " " + p.method : ""}`));
      }
      if (b.status !== "open") return fail(`${b.number} is already ${b.status === "paid" ? "paid" : "voided"}.`);
      if (!p.method) return ask("method", `How did the customer pay ${b.number} (${money(b.total)})?`, ["Cash", "Telebirr", "CBE", "BOA", "Card"].map((m) => `Bill ${Number(b.number.slice(5))} was paid ${m.toLowerCase()}`));
      const digital = ["telebirr", "cbe", "boa"].includes(p.method);
      return card(`Mark ${b.number} paid`, [`Total: ${money(b.total)}`, `Paid with: ${METHOD_LABEL[p.method]}`, digital ? "I will wait for the real bank message and close the bill when it arrives (or now, if it already did)." : "It is booked as income now."], { ...p, number: b.number });
    }
    case "invoice_paid": {
      let inv: any = p.invoice ? db.prepare(`SELECT i.*, c.name AS customer FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id WHERE UPPER(i.invoice_number) = UPPER(?)`).get(p.invoice) : null;
      if (!inv && p.customer) {
        const rows = db.prepare(`SELECT i.invoice_number, i.total_amount - i.amount_paid AS owed, c.name AS customer FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.status IN ('open','partially_paid','overdue') AND LOWER(c.name) LIKE ? ORDER BY i.due_date LIMIT 5`).all(`%${String(p.customer).toLowerCase()}%`) as any[];
        if (rows.length === 1) inv = db.prepare(`SELECT i.*, c.name AS customer FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id WHERE i.invoice_number = ?`).get(rows[0].invoice_number);
        else if (rows.length) return ask("invoice", "Which invoice?", rows.map((r) => `Invoice ${r.invoice_number} was paid`));
      }
      if (!inv) {
        const open = db.prepare(`SELECT i.invoice_number, i.total_amount - i.amount_paid AS owed, c.name AS customer FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id WHERE i.status IN ('open','partially_paid','overdue') ORDER BY i.due_date LIMIT 5`).all() as any[];
        if (!open.length) return fail("There are no open invoices.");
        return ask("invoice", p.invoice ? `I can't find invoice ${p.invoice}. Which one?` : "Which invoice was paid?", open.map((r) => `Invoice ${r.invoice_number} was paid (${r.customer ?? "customer"}, owes ${money(r.owed)})`));
      }
      if (["paid", "cancelled"].includes(inv.status)) return fail(`Invoice ${inv.invoice_number} is already ${inv.status}.`);
      const owed = round2(inv.total_amount - inv.amount_paid);
      const amount = p.amount ? Math.min(p.amount, owed + 0.001) : owed;
      if (p.amount && p.amount > owed + 0.01) return fail(`Invoice ${inv.invoice_number} only has ${money(owed)} left to pay, so ${money(p.amount)} is too much.`);
      if (p.method && p.method !== "cash") return fail(`For ${METHOD_LABEL[p.method]} payments the app closes the invoice itself when the bank message arrives, so you don't need to record it. I only record cash that was handed over.`);
      if (!p.method) return ask("method", `Was invoice ${inv.invoice_number} paid in cash?`, [`Invoice ${inv.invoice_number} was paid cash`]);
      return card(`Record a cash payment on ${inv.invoice_number}`, [`Customer: ${inv.customer ?? "—"}`, `Amount: ${money(amount)} of ${money(owed)} owed`, amount >= owed - 0.01 ? "The invoice becomes paid." : "The invoice becomes part-paid."], { ...p, invoice: inv.invoice_number, amount: round2(amount), method: "cash" });
    }
    case "open_drawer": {
      if (openShift(branch)) return fail("The cash drawer is already open.");
      if (p.amount === undefined) return ask("amount", "How much cash is in the drawer right now (in birr)?");
      return card("Open the cash drawer", [`Opening cash: ${money(p.amount)}`]);
    }
    case "close_drawer": {
      const s = openShift(branch);
      if (!s) return fail("The cash drawer is not open.");
      if (!p.amount && p.amount !== 0) return ask("amount", `Count the cash in the drawer. How much is there? (The system expects ${money(expectedCash(s.id))}.)`);
      return card("Close the cash drawer", [`Counted: ${money(p.amount)}`, `Expected: ${money(expectedCash(s.id))}`, "This ends the shift and records any difference."]);
    }
  }
}

function execute(a: ActionProposal, branchId: string | null): string {
  const branch = branchId ?? getHeadOfficeId();
  const p = a.params;
  let out = "Done.";
  runInTransaction(() => {
    switch (a.kind) {
      case "payout": { drawerEvent(branch, "payout", Number(p.amount), String(p.note)); out = `Done. ${money(p.amount)} was taken out of the drawer for "${p.note}" and recorded as an expense.`; break; }
      case "expense":
      case "income": {
        const signed = a.kind === "expense" ? -Number(p.amount) : Number(p.amount);
        const cat = smartCategorize(String(p.note), signed);
        db.prepare(`INSERT INTO transactions (id, date, description, amount, category, category_confidence, category_status, source, branch_id) VALUES (?,?,?,?,?,?,?, 'manual', ?)`)
          .run(nanoid(), todayStr(), String(p.note), round2(signed), cat.category, cat.confidence, "suggested", branch);
        out = `Done. ${a.kind === "expense" ? "Expense" : "Income"} of ${money(p.amount)} recorded under ${cat.category}.`;
        break;
      }
      case "void_bill": { const b = findBill(p.number); if (!b) throw new HttpError(404, "bill not found"); voidBill(b.id, String(p.reason)); out = `Done. ${b.number} is voided.`; break; }
      case "bill_paid": {
        const b = findBill(p.number); if (!b) throw new HttpError(404, "bill not found");
        if (["telebirr", "cbe", "boa"].includes(p.method)) {
          db.prepare(`UPDATE bills SET payment_method = ? WHERE id = ? AND status = 'open'`).run(p.method, b.id);
          out = matchPaymentToBill(b.id, p.method) ? `Done. ${b.number} is paid. I matched it to the ${METHOD_LABEL[p.method]} message.` : `Okay. ${b.number} is now waiting for the ${METHOD_LABEL[p.method]} message and will close by itself when it arrives.`;
        } else { settleBill(b.id, p.method as Method); out = `Done. ${b.number} is paid (${METHOD_LABEL[p.method]}).`; }
        break;
      }
      case "invoice_paid": {
        const inv = db.prepare(`SELECT i.*, c.name AS customer FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id WHERE i.invoice_number = ?`).get(p.invoice) as any;
        if (!inv) throw new HttpError(404, "invoice not found");
        const owed = round2(inv.total_amount - inv.amount_paid);
        if (Number(p.amount) > owed + 0.01) throw new HttpError(409, `only ${money(owed)} is still owed on this invoice`);
        applyPaymentToInvoice(inv.id, Number(p.amount));
        db.prepare(`INSERT INTO transactions (id, date, description, amount, category, category_confidence, category_status, source, source_ref_id, branch_id) VALUES (?,?,?,?, 'Sales Revenue', 1, 'confirmed', 'manual', ?, ?)`)
          .run(nanoid(), todayStr(), `Cash payment on invoice ${inv.invoice_number}${inv.customer ? " · " + inv.customer : ""}`, round2(Number(p.amount)), inv.id, inv.branch_id ?? branch);
        out = `Done. ${money(p.amount)} recorded on invoice ${inv.invoice_number}.`;
        break;
      }
      case "open_drawer": {
        if (openShift(branch)) throw new HttpError(409, "the drawer is already open");
        db.prepare(`INSERT INTO cash_shifts (id, branch_id, opening_float) VALUES (?,?,?)`).run(nanoid(), branch, round2(Number(p.amount)));
        out = `Done. The drawer is open with ${money(p.amount)}.`; break;
      }
      case "close_drawer": {
        const s = openShift(branch); if (!s) throw new HttpError(409, "the drawer is not open");
        const expected = expectedCash(s.id), counted = round2(Number(p.amount)), variance = round2(counted - expected);
        db.prepare(`UPDATE cash_shifts SET status='closed', closed_at=datetime('now'), expected=?, counted=?, variance=? WHERE id=?`).run(expected, counted, variance, s.id);
        out = Math.abs(variance) < 1 ? `Done. The drawer is closed and the cash matches (${money(counted)}).` : `Done. The drawer is closed. It is ${variance < 0 ? "short" : "over"} by ${money(Math.abs(variance))}: expected ${money(expected)}, counted ${money(counted)}.`;
        break;
      }
    }
  });
  return out;
}

/** Spots a request to change something, and pulls out what was said. */
function parseAction(ql: string, q: string): { kind: ActionKind; params: Record<string, any> } | null {
  const reason = clean(q.match(/(?:because|reason(?: is|:)?|since)\s+(.+)$/i)?.[1] ?? "");
  if (/\b(open|start)\b.*\b(drawer|till|shift)\b/.test(ql)) return { kind: "open_drawer", params: amountIn(q) !== null ? { amount: amountIn(q) } : /\bwith (nothing|zero|0)\b/.test(ql) ? { amount: 0 } : {} };
  if (/\b(close|end|count)\b.*\b(drawer|till|shift)\b/.test(ql)) return { kind: "close_drawer", params: amountIn(q) !== null ? { amount: amountIn(q) } : {} };
  if (/\b(void|cancel|delete|remove)\b/.test(ql) && /\bbill\b/.test(ql)) return { kind: "void_bill", params: { number: billNumber(q), reason } };
  if (/\bbill\b/.test(ql) && /\b(paid|settled|pay)\b/.test(ql) && !/\bhow many|who\b/.test(ql)) return { kind: "bill_paid", params: { number: billNumber(q), method: methodIn(q) } };
  if (/\binvoice\b|\binv-/.test(ql) && /\b(paid|received|payment|settled|collected)\b/.test(ql) && !/\b(who|which|how many|unpaid|outstanding|owe)\b/.test(ql)) {
    const num = q.match(/\b(inv[-\w]*\d[\w-]*)/i)?.[1] ?? null;
    const cust = !num ? clean(q.match(/\b(?:invoice|payment)\s+(?:for|from|of)\s+([A-Za-z][\w .'-]{1,40}?)(?:\s+(?:was|is|has|paid|received)\b|$)/i)?.[1] ?? "") : "";
    return { kind: "invoice_paid", params: { invoice: num, customer: cust || null, amount: amountIn(q) && !/\b(was|is) paid\b.*$/.test(ql) ? amountIn(q) : amountIn(q), method: methodIn(q) } };
  }
  const amt = amountIn(q);
  if (/\b(record|add|log|enter|write)\b.*\b(expense|cost)\b/.test(ql) || /\bexpense of\b/.test(ql)) return { kind: "expense", params: { amount: amt, note: noteAfter(q) } };
  if (/\b(record|add|log|enter)\b.*\b(income|sale|payment received)\b/.test(ql)) return { kind: "income", params: { amount: amt, note: noteAfter(q) } };
  if (/\b(cash )?pay ?out\b/.test(ql) || (/\b(cash|till|drawer)\b/.test(ql) && /\b(paid|pay|took|take|spent|spend|bought|buy|withdrew)\b/.test(ql) && amt !== null && !/\bhow much|who\b/.test(ql))) return { kind: "payout", params: { amount: amt, note: noteAfter(q) } };
  return null;
}

// ---------------------------------------------------------------- Questions about sales / stock / overview

function answerSales(scope: string, b: string | null): AgentReply | null {
  const bw = b ? " AND branch_id = ?" : "";
  const bp = b ? [b] : [];
  const day = todayStr();
  const rows = db.prepare(`SELECT payment_method AS m, COUNT(*) AS n, COALESCE(SUM(total),0) AS t FROM bills WHERE status='paid' AND paid_at LIKE ?${bw} GROUP BY payment_method ORDER BY t DESC`).all(`${day}%`, ...bp) as any[];
  const open = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS t FROM bills WHERE status='open'${bw}`).get(...bp) as any;
  const voids = db.prepare(`SELECT COUNT(*) AS n FROM bills WHERE status='void' AND voided_at LIKE ?${bw}`).get(`${day}%`, ...bp) as any;
  const total = rows.reduce((s, r) => s + r.t, 0), count = rows.reduce((s, r) => s + r.n, 0);
  const shift = openShift(b ?? getHeadOfficeId());
  const drawer = shift ? ` The drawer is open and should hold ${money(expectedCash(shift.id))}.` : " The cash drawer is closed.";
  const head = count ? `Today ${scope} sold ${money(total)} across ${count} bill${count === 1 ? "" : "s"}.` : `No bills have been paid today for ${scope}.`;
  return reply({ answer: `${head} ${open.n} bill${open.n === 1 ? " is" : "s are"} still open (${money(open.t)})${voids.n ? `, ${voids.n} voided` : ""}.${drawer}`,
    table: rows.length ? { columns: ["Paid with", "Bills", "Amount"], rows: rows.map((r) => [METHOD_LABEL[r.m] ?? r.m, r.n, money(r.t)]) } : undefined,
    followUps: ["Who paid me today", "Show open bills", "Open the drawer"].filter((x) => !(shift && x === "Open the drawer")) }, {}, scope);
}

const STOP = new Set(["pack", "white", "black", "pcs", "the", "and", "with", "for", "large", "small", "big"]);
/** Products whose name shares a word with the question (best match first). */
function productsIn(ql: string): any[] {
  const words = new Set(ql.split(/[^a-z0-9]+/).filter(Boolean));
  const products = db.prepare(`SELECT id, name, unit FROM products WHERE active = 1`).all() as any[];
  const scored = products.map((p) => {
    const toks = String(p.name).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t));
    const exact = ql.includes(String(p.name).toLowerCase());
    return { p, score: exact ? 100 : toks.filter((t) => words.has(t) || words.has(t.replace(/s$/, "")) || words.has(t + "s")).length };
  }).filter((x) => x.score > 0);
  const best = Math.max(0, ...scored.map((x) => x.score));
  return scored.filter((x) => x.score === best).map((x) => x.p);
}

function answerProductStock(ql: string, scope: string): AgentReply | null {
  const hit = productsIn(ql);
  if (!hit.length) return null;
  const rows = hit.flatMap((p) => db.prepare(`SELECT br.name AS branch, COALESCE(SUM(m.qty),0) AS q FROM branches br LEFT JOIN stock_movements m ON m.branch_id = br.id AND m.product_id = ? WHERE br.active = 1 GROUP BY br.id`).all(p.id).map((r: any) => [p.name, r.branch, `${round2(r.q)} ${p.unit}`]));
  const total = hit.length === 1 ? ` ${hit[0].name}: ${round2(rows.reduce((s, r) => s + parseFloat(String(r[2])), 0))} ${hit[0].unit} in total.` : "";
  return reply({ answer: `Here is the stock on hand.${total}`, table: { columns: ["Item", "Branch", "On hand"], rows }, followUps: ["What should I reorder?"] }, {}, scope);
}

function overview(b: string | null, scope: string): AgentReply {
  const bw = b ? " AND branch_id = ?" : "";
  const bp = b ? [b] : [];
  const month = todayStr().slice(0, 7);
  const t = db.prepare(`SELECT COALESCE(SUM(CASE WHEN amount>0 THEN amount END),0) AS i, COALESCE(SUM(CASE WHEN amount<0 THEN -amount END),0) AS e FROM transactions WHERE date LIKE ?${bw}`).get(`${month}%`, ...bp) as any;
  const owed = db.prepare(`SELECT COALESCE(SUM(total_amount - amount_paid),0) AS o FROM invoices WHERE status IN ('open','partially_paid','overdue')${bw}`).get(...bp) as any;
  const bal = (db.prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE 1=1${bw}`).get(...bp) as any).s;
  return reply({ answer: `Here is ${scope} this month: ${money(t.i)} came in and ${money(t.e)} went out, so ${money(t.i - t.e)} is left over. Your books show ${money(bal)} in total, and customers still owe you ${money(owed.o)}.`,
    followUps: ["Anything unusual?", "What should I reorder?", "Who owes me money?", "Sales today"] }, {}, scope);
}

// ---------------------------------------------------------------- Follow-up suggestions

function followUpsFor(q: string): string[] {
  if (/spen|expens|cost/.test(q)) return ["And last month?", "Compare branches", "Anything unusual?"];
  if (/sale|revenue|income|earn|profit/.test(q)) return ["And last month?", "Only Telebirr", "What was spent?"];
  if (/owe|unpaid|outstanding|overdue/.test(q)) return ["Who paid me today?", "Top customers"];
  if (/stock|reorder|inventory/.test(q)) return ["Show payroll", "Anything unusual?"];
  if (/tax|vat/.test(q)) return ["What was spent this month?", "Cash forecast"];
  if (/telebirr|cbe|boa|who paid/.test(q)) return ["Who paid me today?", "Only CBE", "Only Telebirr"];
  return ["How is the business doing?", "Who owes me money?"];
}

function findBranchWord(ql: string): boolean {
  const bs = db.prepare(`SELECT code, name FROM branches WHERE active = 1`).all() as any[];
  return bs.some((b) => [b.code.toLowerCase(), ...String(b.name).toLowerCase().replace(/\b(branch|office|head)\b/g, " ").split(/\s+/).filter((w) => w.length >= 3)].some((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(ql)));
}

// ---------------------------------------------------------------- Entry point

export async function converse(question: string, ctx: Ctx, branchId: string | null): Promise<AgentReply> {
  const q = clean(question);
  const ql = q.toLowerCase();
  const keep = (c: Ctx = {}): Ctx => ({ lastQ: ctx.lastQ, ...c });
  const scopeName = branchId ? ((db.prepare(`SELECT name FROM branches WHERE id = ?`).get(branchId) as any)?.name ?? "this branch") : "all branches";

  // 1. The person is answering a question I just asked.
  if (ctx.pending && (parseAction(ql, q) || (TOPIC_RE.test(ql) && ql.split(" ").length > 3 && !/^(void|cancel)\b/.test(ql) && ctx.pending.missing !== "reason" && ctx.pending.missing !== "note"))) ctx = { ...ctx, pending: undefined };
  if (ctx.pending) {
    if (/^(cancel|never ?mind|stop|forget it|no)\b/.test(ql)) return reply({ answer: "Okay, I've cancelled that.", done: true }, keep(), scopeName);
    const p = { ...ctx.pending.params };
    const slot = ctx.pending.missing;
    if (slot === "amount") { const a = amountIn(q) ?? (/^(0|zero|nothing)$/.test(ql) ? 0 : null); if (a === null) return reply({ answer: "I need a number, for example 150." }, { ...ctx }, scopeName); p.amount = a; }
    else if (slot === "note" || slot === "reason") p[slot] = q.slice(0, 160);
    else if (slot === "number") { const n = billNumber(q) ?? (q.match(/^\D*(\d{1,6})\D*$/) ? `BILL-${q.replace(/\D/g, "").padStart(4, "0")}` : null); if (!n) return reply({ answer: "Which bill number?" }, { ...ctx }, scopeName); p.number = n; p.method = p.method ?? methodIn(q); }
    else if (slot === "method") { const m = methodIn(q) ?? (ctx.pending.kind === "invoice_paid" && /^(yes|y|yeah|yep|yup|sure|ok|okay)\b/.test(ql) ? "cash" : null); if (!m) return reply({ answer: "Cash, Telebirr, CBE, BOA or card?", choices: ["Cash", "Telebirr", "CBE", "BOA", "Card"] }, { ...ctx }, scopeName); p.method = m; }
    else if (slot === "invoice") { const inv = q.match(/\b(inv[-\w]*\d[\w-]*)/i)?.[1]; if (!inv) return reply({ answer: "Which invoice number?" }, { ...ctx }, scopeName); p.invoice = inv; p.customer = null; p.method = p.method ?? methodIn(q); }
    return propose(ctx.pending.kind, p, keep(), branchId);
  }

  if (!ctx.pending && !ctx.action && /^(cancel|never ?mind|forget it|stop)\b/.test(ql) && q.length < 25) return reply({ answer: "Okay. There's nothing pending." }, keep(), scopeName);

  // 2. Waiting for a yes / no on something I proposed.
  if (ctx.action) {
    if (/^(yes|y|yep|yeah|confirm|ok|okay|do it|go ahead|sure|please do|proceed)\b/.test(ql)) {
      try { return reply({ answer: execute(ctx.action, branchId), done: true, followUps: ["How is the business doing?"] }, keep(), scopeName); }
      catch (e: any) { return reply({ answer: `I couldn't do that: ${e.message}`, done: true }, keep(), scopeName); }
    }
    if (/^(no|n|cancel|stop|don'?t|never ?mind)\b/.test(ql)) return reply({ answer: "Okay, I won't do it.", done: true }, keep(), scopeName);
    // anything else: drop the proposal and treat it as a new message
  }

  // 3. Small talk and help.
  if (/^(hi|hello|hey|selam|good (morning|afternoon|evening)|hola)\b/.test(ql) && q.length < 40) return reply({ answer: "Hello! I can answer questions about your money, sales, stock, tax and staff, and I can record things for you. What would you like to know?", choices: ["How is the business doing?", "Sales today", "Who owes me money?", "What should I reorder?"] }, keep(), scopeName);
  if (/^(thanks|thank you|thx|great|perfect|awesome|nice|good)\b/.test(ql) && q.length < 30) return reply({ answer: "You're welcome! Anything else?", followUps: ["How is the business doing?"] }, keep(), scopeName);
  if (/what can you do|^help\b|how do (i|you) use|capabilit/.test(ql)) return reply({
    answer: "I answer from your own books, and I can record things after you confirm. For example:\n• Ask: \"how much did Telebirr bring in this week?\", \"who owes me money?\", \"how many Tibs are left?\"\n• Follow up: \"and last month?\", \"only CBE\"\n• Do: \"record a 150 birr cash payout for onions\", \"void bill 12\", \"invoice INV-2026-0003 was paid in cash\", \"open the drawer with 1000\"",
    choices: ["How is the business doing?", "Record a 150 birr cash payout for onions", "Sales today"] }, keep(), scopeName);

  // 4. Something to do.
  const act = parseAction(ql, q);
  if (act) return propose(act.kind, act.params, keep(), branchId);

  // 5. A question. A short message with no topic of its own continues the last one.
  const hasPeriod = new RegExp(PERIOD_RE.source).test(ql), hasProv = new RegExp(PROV_RE.source).test(ql);
  const productMentioned = productsIn(ql).length > 0;
  const connector = /^(and|what about|how about|also|only|just|same|now|then)\b/.test(ql);
  const looksFollowUp = !!ctx.lastQ && !productMentioned && !TOPIC_RE.test(ql) && ql.split(" ").length <= 8 && (connector || hasPeriod || hasProv || !!findBranchWord(ql));
  let effective = q;
  if (looksFollowUp) {
    let base = ctx.lastQ!.toLowerCase();
    if (hasPeriod) base = base.replace(PERIOD_RE, " ");
    if (hasProv) base = base.replace(PROV_RE, " ");
    effective = clean(`${base} ${ql.replace(/^(and|what about|how about|also|only|just|same|now|then)\s+/, "")}`);
  } else if (hasProv && !hasPeriod && !TOPIC_RE.test(ql) && !/\b(who|list)\b/.test(ql)) {
    const name = ql.match(PROV_RE)![0].replace(/commercial bank/, "CBE").replace(/abyssinia/, "BOA");
    return reply({ answer: `What would you like to know about ${name}?`, choices: [`${name} today`, `${name} this month`, `Who paid me via ${name}`] }, keep(), scopeName);
  }
  const el = effective.toLowerCase();
  const asked = !branchId ? null : branchId;

  let out: AgentReply | null = null;
  if (/how('?s| is| are) (the )?(business|shop|restaurant|hotel|we|things)|overview|summary|snapshot|how are we doing|state of/.test(el)) out = overview(asked, scopeName);
  else if (/\b(bills?|till|drawer|pos|qr)\b/.test(el) && !/\binvoice/.test(el)) out = answerSales(scopeName, asked);
  else if (/(how (many|much)|left|remaining|on hand|in stock|do we have)/.test(el)) out = answerProductStock(el, scopeName);
  if (out) return { ...out, context: keep({ lastQ: effective }), followUps: (out.followUps ?? followUpsFor(el)) };

  // 6. Everything else: the built-in rules, or a language model when a key exists.
  const r = llmConfigured() ? await askAssistant(effective, branchId) : answerOffline(effective, branchId);
  if (r.table?.columns?.[0] === "Example questions") {
    return reply({ answer: "I'm not sure I understood that. Do you mean one of these?", choices: HELP.slice(0, 5) }, keep(), r.scope);
  }
  return { ...r, context: keep({ lastQ: effective }), followUps: followUpsFor(el).filter((f) => !(/last month/.test(f.toLowerCase()) && /last month/.test(el))) };
}
