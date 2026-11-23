import { createRouter, HttpError } from "../lib/httpRouter.js";
import db from "../db/index.js";
import { branchOf, branchClause, branchName } from "../lib/branch.js";
import { reorderSuggestions } from "../lib/ai/reorder.js";
import { detectAnomalies } from "../lib/ai/anomalies.js";

export const homeRouter = createRouter();

const round2 = (n: number) => Math.round(n * 100) / 100;
const PROVIDERS: Array<{ code: string; label: string; account: string }> = [
  { code: "CBE", label: "Commercial Bank of Ethiopia", account: process.env.ACCOUNT_CBE ?? "1000599846321" },
  { code: "TELEBIRR", label: "Telebirr", account: process.env.ACCOUNT_TELEBIRR ?? "0926684050" },
  { code: "BOA", label: "Bank of Abyssinia", account: process.env.ACCOUNT_BOA ?? "170182057" },
];
const LABELS: Record<string, string> = { CBE: "CBE", TELEBIRR: "Telebirr", BOA: "BOA", UNKNOWN: "Unrecognised sender" };

/**
 * Where the money came from: money in and out per payment channel (CBE, Telebirr, BOA ...),
 * from the parsed payment messages / API payments, plus everything entered by hand.
 * ?period=YYYY-MM (default: this month) or ?period=all
 */
homeRouter.get("/sources", (req, res) => {
  const requested = req.query.get("period");
  const period = requested ?? new Date().toISOString().slice(0, 7);
  if (period !== "all" && !/^\d{4}-\d{2}$/.test(period)) throw new HttpError(400, "period must be YYYY-MM or 'all'");

  const bc = branchClause(req);
  const pw = period === "all" ? "" : " AND substr(received_at,1,7) = ?";
  const pp = period === "all" ? [] : [period];

  const rows = db.prepare(
    `SELECT provider,
            COALESCE(SUM(CASE WHEN direction = 'debit' THEN 0 ELSE amount END), 0) AS inflow,
            COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount ELSE 0 END), 0) AS outflow,
            COUNT(*) AS n,
            COALESCE(SUM(verification_status = 'verified'), 0) AS verified,
            COALESCE(SUM(verification_status = 'pending'), 0) AS needs_review,
            MAX(received_at) AS last_at
     FROM payment_events
     WHERE parsed_ok = 1 AND amount IS NOT NULL
       AND verification_status NOT IN ('duplicate','rejected','unparsed')${pw}${bc.sql}
     GROUP BY provider`
  ).all(...pp, ...bc.params) as any[];
  const byProvider = new Map(rows.map((r) => [r.provider, r]));

  const payers = db.prepare(
    `SELECT COALESCE(NULLIF(TRIM(counterparty_name), ''), 'Unnamed sender') AS name, SUM(amount) AS total
     FROM payment_events
     WHERE provider = ? AND parsed_ok = 1 AND amount IS NOT NULL AND direction != 'debit'
       AND verification_status NOT IN ('duplicate','rejected','unparsed')${pw}${bc.sql}
     GROUP BY name ORDER BY total DESC LIMIT 3`
  );

  const tw = period === "all" ? "" : " AND substr(date,1,7) = ?";
  const other = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS inflow, COUNT(*) AS n FROM transactions
     WHERE amount > 0 AND source != 'sms_payment'${tw}${bc.sql}`
  ).get(...pp, ...bc.params) as any;

  const codes = [...PROVIDERS.map((p) => p.code), ...[...byProvider.keys()].filter((k) => !PROVIDERS.some((p) => p.code === k))];
  const sources = codes.map((code) => {
    const r = byProvider.get(code);
    return {
      provider: code,
      account: PROVIDERS.find((p) => p.code === code)?.account ?? "",
      label: LABELS[code] ?? code,
      fullName: PROVIDERS.find((p) => p.code === code)?.label ?? LABELS[code] ?? code,
      inflow: round2(r?.inflow ?? 0),
      outflow: round2(r?.outflow ?? 0),
      count: r?.n ?? 0,
      verified: r?.verified ?? 0,
      needsReview: r?.needs_review ?? 0,
      lastAt: r?.last_at ?? null,
      topPayers: r ? (payers.all(code, ...pp, ...bc.params) as any[]).map((p) => ({ name: p.name, amount: round2(p.total) })) : [],
    };
  });

  const otherIn = round2(other.inflow);
  const totalIn = round2(sources.reduce((s, x) => s + x.inflow, 0) + otherIn);
  const share = (v: number) => (totalIn > 0 ? Math.round((v / totalIn) * 1000) / 10 : 0);

  res.json({
    scope: branchName(branchOf(req)),
    period,
    totalIn,
    sources: sources.map((s) => ({ ...s, sharePct: share(s.inflow) })),
    other: { label: "Cash, invoices & other entries", inflow: otherIn, count: other.n, sharePct: share(otherIn) },
  });
});

/**
 * A short "today" briefing for the copilot. Every item says what it found and where to go next.
 * It only reads data: nothing here changes the books.
 */
homeRouter.get("/briefing", (req, res) => {
  const b = branchOf(req);
  const bc = branchClause(req);
  const today = new Date().toISOString().slice(0, 10);
  const items: Array<{ kind: string; level: "info" | "attention" | "urgent"; text: string; route?: string; ask?: string }> = [];
  const etb = (n: number) => `ETB ${round2(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  // Money received today, by channel
  const todayRows = db.prepare(
    `SELECT provider, COALESCE(SUM(amount),0) AS total, COUNT(*) AS n FROM payment_events
     WHERE parsed_ok = 1 AND amount IS NOT NULL AND direction != 'debit' AND substr(received_at,1,10) = ?
       AND verification_status NOT IN ('duplicate','rejected','unparsed')${bc.sql}
     GROUP BY provider ORDER BY total DESC`
  ).all(today, ...bc.params) as any[];
  if (todayRows.length) {
    const sum = todayRows.reduce((s, r) => s + r.total, 0);
    const parts = todayRows.map((r) => `${etb(r.total)} via ${LABELS[r.provider] ?? r.provider}`).join(", ");
    items.push({ kind: "money", level: "info", text: `Money in today: ${etb(sum)} (${parts}).`, ask: "Who paid me today?" });
  } else {
    items.push({ kind: "money", level: "info", text: "No payments have arrived today yet.", route: "payments" });
  }

  const review = db.prepare(
    `SELECT COUNT(*) AS c FROM payment_events WHERE verification_status = 'pending' AND parsed_ok = 1${bc.sql}`
  ).get(...bc.params) as any;
  const unread = db.prepare(`SELECT COUNT(*) AS c FROM payment_events WHERE verification_status = 'unparsed'${bc.sql}`).get(...bc.params) as any;
  if (review.c > 0) items.push({ kind: "payments", level: "attention", text: `${review.c} payment${review.c === 1 ? "" : "s"} could not be matched to an invoice and need a look.`, route: "payments" });
  if (unread.c > 0) items.push({ kind: "payments", level: "attention", text: `${unread.c} message${unread.c === 1 ? "" : "s"} could not be read automatically. Enter ${unread.c === 1 ? "it" : "them"} by hand.`, route: "payments" });

  const suggested = db.prepare(`SELECT COUNT(*) AS c FROM transactions WHERE category_status = 'suggested'${bc.sql}`).get(...bc.params) as any;
  if (suggested.c > 0) items.push({ kind: "categories", level: "info", text: `${suggested.c} entr${suggested.c === 1 ? "y has" : "ies have"} a suggested category waiting for your OK.`, route: "transactions" });

  const overdue = db.prepare(
    `SELECT COUNT(*) AS c, COALESCE(SUM(total_amount - amount_paid),0) AS owed FROM invoices
     WHERE status IN ('open','partially_paid','overdue') AND due_date IS NOT NULL AND due_date < ?${bc.sql}`
  ).get(today, ...bc.params) as any;
  if (overdue.c > 0) items.push({ kind: "invoices", level: "urgent", text: `${overdue.c} invoice${overdue.c === 1 ? " is" : "s are"} past due, ${etb(overdue.owed)} still unpaid.`, route: "invoices", ask: "Who owes me money?" });

  const tax = db.prepare(
    `SELECT tax_type, tax_amount, due_date FROM tax_filings WHERE status = 'due' AND tax_amount > 0 AND due_date IS NOT NULL ORDER BY due_date LIMIT 3`
  ).all() as any[];
  for (const t of tax) {
    const days = Math.round((new Date(t.due_date).getTime() - new Date(today).getTime()) / 86400000);
    if (days <= 10) {
      items.push({ kind: "tax", level: days < 0 ? "urgent" : "attention", text: `${String(t.tax_type).replace(/_/g, " ")} of ${etb(t.tax_amount)} is ${days < 0 ? `${-days} day(s) overdue` : days === 0 ? "due today" : `due in ${days} day(s)`}.`, route: "tax" });
    }
  }

  const reorder = reorderSuggestions(b).suggestions.length;
  if (reorder > 0) items.push({ kind: "stock", level: "attention", text: `${reorder} product${reorder === 1 ? "" : "s"} should be reordered soon.`, route: "inventory", ask: "What should I reorder?" });

  const high = detectAnomalies(b).filter((i) => i.severity === "high" && !/overdue/i.test(`${i.kind} ${i.title}`)).slice(0, 2);
  for (const h of high) items.push({ kind: "unusual", level: "urgent", text: h.title, route: "ai" });

  const rank = { urgent: 0, attention: 1, info: 2 } as const;
  items.sort((a, c) => rank[a.level] - rank[c.level]);
  const needs = items.filter((i) => i.level !== "info").length;

  res.json({
    scope: branchName(b),
    date: today,
    headline: needs === 0 ? "Nothing needs your attention right now." : `${needs} thing${needs === 1 ? "" : "s"} need${needs === 1 ? "s" : ""} your attention.`,
    items,
  });
});

/**
 * Notifications: everything the owner should hear about, newest first.
 * Each item has a stable `key` (the same event always has the same key), so the app can remember
 * what was read and only alert for what is new. Read-only: nothing here changes the books.
 * type: payment | review | unread | invoice | stock | tax | payroll
 */
homeRouter.get("/notifications", (req, res) => {
  const bc = branchClause(req);
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const dayDiff = (d: string) => Math.round((new Date(d).getTime() - new Date(today).getTime()) / 86400000);
  const etb = (n: number) => `ETB ${round2(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  type Level = "info" | "attention" | "urgent";
  const items: Array<{ key: string; type: string; level: Level; title: string; text: string; route: string; at: string }> = [];

  // Payments received in the last 3 days
  for (const p of db.prepare(
    `SELECT id, provider, amount, direction, counterparty_name, received_at, verification_status FROM payment_events
     WHERE parsed_ok = 1 AND amount IS NOT NULL AND direction != 'debit'
       AND verification_status NOT IN ('duplicate','rejected','unparsed') AND received_at >= datetime('now','-3 days')${bc.sql}
     ORDER BY received_at DESC LIMIT 25`
  ).all(...bc.params) as any[]) {
    const who = (p.counterparty_name ?? "").trim() || "an unnamed sender";
    items.push({ key: `pay:${p.id}`, type: "payment", level: "info", title: "Money received", text: `${etb(p.amount)} from ${who} via ${LABELS[p.provider] ?? p.provider}.`, route: "payments", at: p.received_at });
  }

  // Payments that need a look, and messages that could not be read
  for (const p of db.prepare(
    `SELECT id, provider, amount, counterparty_name, received_at FROM payment_events
     WHERE verification_status = 'pending' AND parsed_ok = 1${bc.sql} ORDER BY received_at DESC LIMIT 25`
  ).all(...bc.params) as any[]) {
    items.push({ key: `review:${p.id}`, type: "review", level: "attention", title: "Payment needs a look", text: `${etb(p.amount ?? 0)} via ${LABELS[p.provider] ?? p.provider} could not be matched to one invoice.`, route: "payments", at: p.received_at });
  }
  for (const p of db.prepare(
    `SELECT id, provider, received_at FROM payment_events WHERE verification_status = 'unparsed'${bc.sql} ORDER BY received_at DESC LIMIT 15`
  ).all(...bc.params) as any[]) {
    items.push({ key: `unread:${p.id}`, type: "unread", level: "attention", title: "Message could not be read", text: `A ${LABELS[p.provider] ?? p.provider} message needs to be entered by hand.`, route: "payments", at: p.received_at });
  }

  // Invoices: overdue, and due within 3 days
  const ic = branchClause(req, "invoices.branch_id");
  for (const i of db.prepare(
    `SELECT invoices.id, invoice_number, due_date, total_amount - amount_paid AS owed, COALESCE(customers.name,'a customer') AS customer
     FROM invoices LEFT JOIN customers ON customers.id = invoices.customer_id
     WHERE status IN ('open','partially_paid','overdue') AND due_date IS NOT NULL AND due_date <= date('now','+3 days')${ic.sql}
     ORDER BY due_date LIMIT 30`
  ).all(...ic.params) as any[]) {
    const d = dayDiff(i.due_date);
    if (d < 0) items.push({ key: `inv:${i.id}:overdue`, type: "invoice", level: "urgent", title: "Invoice overdue", text: `${i.invoice_number} from ${i.customer} is ${-d} day${d === -1 ? "" : "s"} overdue. ${etb(i.owed)} still unpaid.`, route: "invoices", at: i.due_date });
    else items.push({ key: `inv:${i.id}:soon`, type: "invoice", level: "attention", title: "Invoice due soon", text: `${i.invoice_number} from ${i.customer} is due ${d === 0 ? "today" : `in ${d} day${d === 1 ? "" : "s"}`}. ${etb(i.owed)} outstanding.`, route: "invoices", at: i.due_date });
  }

  // Stock
  for (const s of reorderSuggestions(branchOf(req)).suggestions.slice(0, 20)) {
    items.push({ key: `stock:${s.productId}:${s.branchId}:${s.urgency}`, type: "stock", level: s.urgency === "urgent" ? "urgent" : "attention", title: s.onHand <= 0 ? "Out of stock" : "Running low", text: `${s.name} at ${s.branchName}: ${s.onHand} ${s.unit} left${s.daysOfCover != null ? (Math.round(s.daysOfCover) < 1 ? ", less than a day of cover" : `, about ${Math.round(s.daysOfCover)} day${Math.round(s.daysOfCover) === 1 ? "" : "s"} of cover`) : ""}. Suggested order: ${s.suggestedQty}.`, route: "inventory", at: today });
  }

  // Tax filings due within 10 days (or already late)
  for (const t of db.prepare(
    `SELECT id, tax_type, tax_amount, due_date FROM tax_filings WHERE status = 'due' AND tax_amount > 0 AND due_date IS NOT NULL ORDER BY due_date LIMIT 10`
  ).all() as any[]) {
    const d = dayDiff(t.due_date);
    if (d > 10) continue;
    const bucket = d < 0 ? "late" : d <= 3 ? "3d" : "10d";
    const name = String(t.tax_type).replace(/_/g, " ");
    items.push({ key: `tax:${t.id}:${bucket}`, type: "tax", level: d < 0 ? "urgent" : d <= 3 ? "urgent" : "attention", title: d < 0 ? "Tax is late" : "Tax due soon", text: `${name} of ${etb(t.tax_amount)} is ${d < 0 ? `${-d} day${d === -1 ? "" : "s"} overdue` : d === 0 ? "due today" : `due in ${d} day${d === 1 ? "" : "s"}`}.`, route: "tax", at: t.due_date });
  }

  // Staff pay: a draft run waiting for approval, or this month's run not started near month end
  const period = today.slice(0, 7);
  for (const r of db.prepare(`SELECT id, period FROM payroll_runs WHERE status = 'draft' ORDER BY period DESC LIMIT 3`).all() as any[]) {
    items.push({ key: `payroll:${r.id}:draft`, type: "payroll", level: "attention", title: "Staff pay waiting for approval", text: `The ${r.period} pay run is ready to check and approve.`, route: "payroll", at: today });
  }
  const staff = (db.prepare(`SELECT COUNT(*) AS c FROM employees WHERE active = 1${bc.sql}`).get(...bc.params) as any).c;
  const hasRun = db.prepare(`SELECT 1 FROM payroll_runs WHERE period = ?`).get(period);
  const dom = now.getUTCDate();
  if (staff > 0 && !hasRun && dom >= 25) {
    items.push({ key: `payroll:${period}:start`, type: "payroll", level: dom >= 28 ? "urgent" : "attention", title: "Staff pay is coming up", text: `The ${period} pay run for ${staff} staff hasn't been started yet.`, route: "payroll", at: today });
  }

  const rank = { urgent: 0, attention: 1, info: 2 } as const;
  items.sort((a, b) => rank[a.level] - rank[b.level] || (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  res.json({ scope: branchName(branchOf(req)), generatedAt: now.toISOString(), count: items.length, items });
});

/**
 * Everything that went through one bank / wallet: money in, money out and each payment, newest first.
 * ?provider=CBE|TELEBIRR|BOA  ?period=YYYY-MM|all (default: all)
 */
homeRouter.get("/provider", (req, res) => {
  const code = String(req.query.get("provider") ?? "").toUpperCase();
  const info = PROVIDERS.find((p) => p.code === code);
  if (!info) throw new HttpError(400, "provider must be CBE, TELEBIRR or BOA");
  const bc = branchClause(req);
  const rows = db.prepare(
    `SELECT id, amount, direction, counterparty_name, reference, balance_after, received_at, verification_status, matched_invoice_id
     FROM payment_events
     WHERE provider = ? AND parsed_ok = 1 AND amount IS NOT NULL AND verification_status NOT IN ('duplicate','rejected','unparsed')${bc.sql}
     ORDER BY received_at DESC, created_at DESC LIMIT 500`
  ).all(code, ...bc.params) as any[];
  const month = new Date().toISOString().slice(0, 7);
  const sum = (f: (r: any) => boolean) => round2(rows.filter(f).reduce((t, r) => t + r.amount, 0));
  const isIn = (r: any) => r.direction !== "debit";
  const withBal = rows.find((r) => r.balance_after !== null);
  res.json({
    provider: code, label: LABELS[code], fullName: info.label, account: info.account,
    scope: branchName(branchOf(req)),
    balance: withBal ? round2(withBal.balance_after) : null,
    count: rows.length,
    lastAt: rows[0]?.received_at ?? null,
    inMonth: sum((r) => isIn(r) && r.received_at.slice(0, 7) === month),
    outMonth: sum((r) => !isIn(r) && r.received_at.slice(0, 7) === month),
    inAll: sum(isIn), outAll: sum((r) => !isIn(r)),
    items: rows.map((r) => ({
      id: r.id, at: r.received_at, amount: isIn(r) ? r.amount : -r.amount, name: r.counterparty_name || "Unnamed",
      reference: r.reference, status: r.verification_status, invoice: !!r.matched_invoice_id,
    })),
  });
});
