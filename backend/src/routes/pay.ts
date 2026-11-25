import { createRouter, HttpError } from "../lib/httpRouter.js";
import db, { getSetting, getHeadOfficeId, runInTransaction } from "../db/index.js";
import { PROVIDERS } from "../lib/accounts.js";
import { createBill, matchPaymentToBill, matchBillByReference, type Method } from "../lib/sales.js";

// PUBLIC endpoints behind the pay-by-QR page: a customer scans an item's QR code, sees what it costs and where to send the money.
// They expose only the item name and price, the business's own receiving accounts, and the customer's own bill.
export const payRouter = createRouter();

const hits = new Map<string, number[]>();
function limited(req: { raw: any }, max: number): boolean {
  const ip = String(req.raw.headers["x-forwarded-for"] ?? req.raw.socket?.remoteAddress ?? "?").split(",")[0].trim();
  const now = Date.now(), recent = (hits.get(ip) ?? []).filter((t) => now - t < 3600_000);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < 3600_000)) hits.delete(k);
  return recent.length > max;
}

const business = () => getSetting("company_name") || "Birritu";
const accounts = () => PROVIDERS.map((p) => ({ code: p.code, label: p.label, account: p.account }));
const METHOD_OF: Record<string, Method> = { CBE: "cbe", TELEBIRR: "telebirr", BOA: "boa" };

function product(id: string) {
  const p = db.prepare(`SELECT id, name, sell_price, vat_rate FROM products WHERE id = ? AND active = 1`).get(id) as any;
  if (!p) throw new HttpError(404, "this item is not available");
  return p;
}

payRouter.get("/item/:id", (req, res) => {
  if (limited(req, 300)) throw new HttpError(429, "too many requests, try again later");
  const p = product(req.params.id);
  res.json({ business: business(), id: p.id, name: p.name, price: Math.round(p.sell_price * (1 + p.vat_rate) * 100) / 100, accounts: accounts() });
});

payRouter.post("/item/:id/order", (req, res) => {
  if (limited(req, 30)) throw new HttpError(429, "too many requests, try again later");
  const p = product(req.params.id);
  const qty = Math.floor(Number(req.body?.qty ?? 1));
  if (!(qty >= 1 && qty <= 20)) throw new HttpError(400, "quantity must be between 1 and 20");
  if ((db.prepare(`SELECT COUNT(*) AS n FROM bills WHERE status = 'open' AND source = 'qr'`).get() as { n: number }).n > 500) throw new HttpError(429, "too many unpaid bills right now");
  const code = String(req.body?.branch ?? "").trim();
  const branch = code ? (db.prepare(`SELECT id FROM branches WHERE code = ?`).get(code) as { id: string } | undefined)?.id : undefined;
  let out: any;
  runInTransaction(() => {
    const b = createBill({ branchId: branch ?? getHeadOfficeId(), table: String(req.body?.table ?? "").slice(0, 40) || null, lines: [{ productId: p.id, qty }], source: "qr" });
    out = { id: b.id, number: b.number, total: b.total };
  });
  res.status(201).json({ ...out, business: business(), accounts: accounts() });
});

function publicBill(id: string) {
  const b = db.prepare(`SELECT id, number, total, status, payment_method, reference FROM bills WHERE id = ? AND source = 'qr'`).get(id) as any;
  if (!b) throw new HttpError(404, "bill not found");
  const items = db.prepare(`SELECT description, qty FROM bill_lines WHERE bill_id = ?`).all(id);
  return { id: b.id, number: b.number, total: b.total, status: b.status, method: b.payment_method, reference: b.reference, items, business: business(), accounts: accounts() };
}

payRouter.get("/bill/:id", (req, res) => {
  if (limited(req, 600)) throw new HttpError(429, "too many requests, try again later");
  res.json(publicBill(req.params.id));
});

/** The customer says they paid, optionally with the transaction number from their receipt. This never marks a bill paid by itself: only a real bank / wallet message does. */
payRouter.post("/bill/:id/claim", (req, res) => {
  if (limited(req, 60)) throw new HttpError(429, "too many requests, try again later");
  const b = publicBill(req.params.id);
  if (b.status !== "open") { res.json(b); return; }
  const ref = String(req.body?.reference ?? "").trim().toUpperCase();
  if (ref && !/^[A-Z0-9]{6,30}$/.test(ref)) throw new HttpError(400, "the transaction number should be letters and digits only, 6 to 30 characters");
  const method = METHOD_OF[String(req.body?.provider ?? "").toUpperCase()];
  runInTransaction(() => {
    if (ref) db.prepare(`UPDATE bills SET reference = ? WHERE id = ? AND status = 'open'`).run(ref, b.id);
    if (method) db.prepare(`UPDATE bills SET payment_method = ? WHERE id = ? AND status = 'open'`).run(method, b.id);
    if (!(ref && matchBillByReference(b.id)) && method) matchPaymentToBill(b.id, method);
  });
  res.json(publicBill(b.id));
});
