import crypto from "node:crypto";
import db, { getSetting } from "../db/index.js";
import { nanoid } from "./id.js";
import { HttpError } from "./httpRouter.js";
import { round2 } from "./branch.js";

export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const ZERO_HASH = "0".repeat(64);

/** Deterministic JSON (sorted keys) so the same document always hashes identically. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

export interface EInvoicePayload {
  schema: "birritu-einvoice/1";
  docType: "invoice" | "credit_note";
  docNumber: string;
  issueDate: string;
  currency: "ETB";
  seller: { name: string; tin: string; address: string | null; vatRegNo: string | null; branchCode: string; branchName: string };
  buyer: { name: string; tin: string | null };
  lines: Array<{ n: number; sku: string | null; description: string; qty: number; unitPrice: number; vatRate: number; net: number; vat: number; total: number }>;
  totals: { net: number; vat: number; total: number };
  reference: { originalDocNumber: string; originalIrn: string | null; reason: string | null } | null;
}

function buildQr(p: EInvoicePayload, hash: string, irn: string | null): string {
  return ["ETINV", "1", p.seller.tin, p.docNumber, p.issueDate, p.totals.total.toFixed(2), p.totals.vat.toFixed(2), hash.slice(0, 16), irn ?? ""].join("|");
}

/**
 * Creates an immutable, hash-chained e-invoice document for an invoice (or a
 * credit note reversing a registered one). Call inside a DB transaction.
 * The document stays 'pending' until it is registered through an adapter.
 */
export function createEInvoiceDoc(invoiceId: string, docType: "invoice" | "credit_note", opts: { reason?: string; relatedId?: string } = {}) {
  const inv = db.prepare(`SELECT * FROM invoices WHERE id = ?`).get(invoiceId) as any;
  if (!inv) throw new HttpError(404, "invoice not found");

  const sellerName = getSetting("company_name");
  const sellerTin = getSetting("company_tin");
  if (!sellerName || !sellerTin) {
    throw new HttpError(422, "Set your company name and 10-digit TIN under Settings before issuing e-invoices");
  }

  if (docType === "invoice") {
    if (inv.status === "cancelled") throw new HttpError(409, "cannot issue an e-invoice for a cancelled invoice");
    const live = db.prepare(`SELECT doc_number, status FROM einvoices WHERE invoice_id = ? AND doc_type = 'invoice' AND status IN ('pending','registered')`).get(invoiceId) as any;
    if (live) throw new HttpError(409, `this invoice already has e-invoice ${live.doc_number} (${live.status})`);
  }

  const branch = db.prepare(`SELECT code, name FROM branches WHERE id = ?`).get(inv.branch_id) as { code: string; name: string };
  const customer = inv.customer_id ? (db.prepare(`SELECT name, tin FROM customers WHERE id = ?`).get(inv.customer_id) as any) : null;
  const rawLines = db.prepare(
    `SELECT l.*, p.sku FROM invoice_lines l LEFT JOIN products p ON p.id = l.product_id WHERE l.invoice_id = ?`
  ).all(invoiceId) as any[];

  // Invoices created without line items (simple amount form) become a single generic line.
  const lines = rawLines.length
    ? rawLines.map((l, i) => ({ n: i + 1, sku: l.sku ?? null, description: l.description, qty: l.qty, unitPrice: l.unit_price, vatRate: l.vat_rate, net: l.net, vat: l.vat, total: l.total }))
    : [{ n: 1, sku: null, description: "Goods / services", qty: 1, unitPrice: inv.amount, vatRate: inv.amount > 0 ? round2(inv.vat_amount / inv.amount) : 0, net: inv.amount, vat: inv.vat_amount, total: inv.total_amount }];

  let reference: EInvoicePayload["reference"] = null;
  if (docType === "credit_note") {
    const orig = db.prepare(`SELECT * FROM einvoices WHERE id = ?`).get(opts.relatedId) as any;
    reference = { originalDocNumber: orig.doc_number, originalIrn: orig.irn ?? null, reason: opts.reason ?? null };
  }

  const typeCount = (db.prepare(`SELECT COUNT(*) AS c FROM einvoices WHERE doc_type = ?`).get(docType) as { c: number }).c + 1;
  const docNumber = `${docType === "invoice" ? "EI" : "CN"}-${String(typeCount).padStart(6, "0")}`;
  const issueDate = new Date().toISOString().slice(0, 10);

  const payload: EInvoicePayload = {
    schema: "birritu-einvoice/1", docType, docNumber, issueDate, currency: "ETB",
    seller: { name: sellerName, tin: sellerTin, address: getSetting("company_address"), vatRegNo: getSetting("company_vat_reg_no"), branchCode: branch.code, branchName: branch.name },
    buyer: { name: customer?.name ?? "Walk-in customer", tin: customer?.tin ?? null },
    lines,
    totals: { net: round2(lines.reduce((s, l) => s + l.net, 0)), vat: round2(lines.reduce((s, l) => s + l.vat, 0)), total: round2(lines.reduce((s, l) => s + l.total, 0)) },
    reference,
  };

  const last = db.prepare(`SELECT seq, chain_hash FROM einvoices ORDER BY seq DESC LIMIT 1`).get() as { seq: number; chain_hash: string } | undefined;
  const seq = (last?.seq ?? 0) + 1;
  const prevHash = last?.chain_hash ?? ZERO_HASH;
  const payloadJson = canonicalJson(payload);
  const payloadHash = sha256(payloadJson);
  const chainHash = sha256(prevHash + payloadHash);

  const id = nanoid();
  db.prepare(
    `INSERT INTO einvoices (id, invoice_id, branch_id, doc_type, seq, doc_number, related_einvoice_id, reason, payload, payload_hash, prev_hash, chain_hash, qr_data, issued_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(id, invoiceId, inv.branch_id, docType, seq, docNumber, opts.relatedId ?? null, opts.reason ?? null, payloadJson, payloadHash, prevHash, chainHash, buildQr(payload, chainHash, null), new Date().toISOString());

  return { id, docNumber, seq, chainHash };
}

/** Recomputes every hash in order; any edited payload or deleted/reordered row shows up as a break. */
export function verifyChain() {
  const docs = db.prepare(`SELECT seq, doc_number, payload, payload_hash, prev_hash, chain_hash FROM einvoices ORDER BY seq`).all() as any[];
  const problems: Array<{ seq: number; docNumber: string; problem: string }> = [];
  let prev = ZERO_HASH;
  for (const d of docs) {
    if (d.prev_hash !== prev) problems.push({ seq: d.seq, docNumber: d.doc_number, problem: "previous-hash link is broken (a document was removed, reordered or altered before it)" });
    if (sha256(d.payload) !== d.payload_hash) problems.push({ seq: d.seq, docNumber: d.doc_number, problem: "payload does not match its stored hash (document content was altered)" });
    if (sha256(d.prev_hash + d.payload_hash) !== d.chain_hash) problems.push({ seq: d.seq, docNumber: d.doc_number, problem: "chain hash mismatch" });
    prev = d.chain_hash;
  }
  return { documents: docs.length, intact: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// Registration adapters
// ---------------------------------------------------------------------------

export interface RegistrationResult { ok: boolean; irn?: string; errors?: string[]; mode: "sandbox" | "mor" }
export interface EInvoiceAdapter {
  mode: "sandbox" | "mor";
  register(doc: { docNumber: string; payload: EInvoicePayload; chainHash: string }): Promise<RegistrationResult>;
}

/**
 * Local sandbox: performs the validation a clearance platform would (well-formed
 * seller/buyer, consistent arithmetic) and issues a clearly-labelled SBX- number.
 * An SBX- number has NO legal effect - it only exercises the workflow.
 */
const sandboxAdapter: EInvoiceAdapter = {
  mode: "sandbox",
  async register({ payload, chainHash }) {
    const errors: string[] = [];
    if (!/^\d{10}$/.test(payload.seller.tin)) errors.push("seller TIN must be 10 digits");
    if (payload.buyer.tin && !/^\d{10}$/.test(payload.buyer.tin)) errors.push("buyer TIN must be 10 digits when provided");
    if (payload.lines.length === 0) errors.push("document has no lines");
    for (const l of payload.lines) {
      if (!(l.qty > 0)) errors.push(`line ${l.n}: qty must be positive`);
      if (Math.abs(round2(l.net + l.vat) - l.total) > 0.01) errors.push(`line ${l.n}: net + VAT does not equal line total`);
    }
    const sum = (k: "net" | "vat" | "total") => round2(payload.lines.reduce((s, l) => s + l[k], 0));
    if (Math.abs(sum("total") - payload.totals.total) > 0.01) errors.push("document total does not equal the sum of its lines");
    if (errors.length) return { ok: false, errors, mode: "sandbox" };
    return { ok: true, irn: `SBX-${sha256(chainHash).slice(0, 20).toUpperCase()}`, mode: "sandbox" };
  },
};

/**
 * Placeholder for the Ministry of Revenue Electronic Invoice Registration System.
 * The registration API (endpoints, auth, message format) is not publicly documented
 * in the material available when this was built, so this deliberately fails loudly
 * instead of pretending to register anything. Implement register() against the
 * official spec + credentials, then run with EINVOICE_MODE=mor.
 */
const morAdapter: EInvoiceAdapter = {
  mode: "mor",
  async register() {
    return {
      ok: false, mode: "mor",
      errors: ["MoR integration is not implemented yet: it needs the official Electronic Invoice Registration System API specification and taxpayer credentials. Use EINVOICE_MODE=sandbox until then."],
    };
  },
};

export function getAdapter(): EInvoiceAdapter {
  return process.env.EINVOICE_MODE === "mor" ? morAdapter : sandboxAdapter;
}

export function qrFor(payload: EInvoicePayload, chainHash: string, irn: string | null) {
  return buildQr(payload, chainHash, irn);
}
