import crypto from "node:crypto";
import db from "../db/index.js";
import { HttpError, type AppRequest } from "./httpRouter.js";

export const SCOPES = [
  "payments:read", "payments:write",
  "invoices:read", "invoices:write",
  "customers:read", "customers:write",
  "inventory:read", "inventory:write",
  "einvoices:read", "einvoices:write",
  "reports:read",
] as const;
export type Scope = (typeof SCOPES)[number];

export interface ApiKeyRow {
  id: string; name: string; prefix: string; scopes: Scope[]; branch_id: string | null; active: number;
}

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** Creates a key. The full secret is returned once and only its hash is stored. */
export function createApiKey(name: string, scopes: Scope[], branchId: string | null) {
  const secret = "bk_" + crypto.randomBytes(32).toString("base64url");
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO api_keys (id, name, prefix, key_hash, scopes, branch_id) VALUES (?,?,?,?,?,?)`)
    .run(id, name, secret.slice(0, 11), sha256(secret), JSON.stringify(scopes), branchId);
  return { id, secret, prefix: secret.slice(0, 11) };
}

export function extractKey(req: Pick<AppRequest, "header">): string | null {
  const auth = req.header("authorization");
  if (auth && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, "").trim();
  return req.header("x-api-key")?.trim() || null;
}

const touched = new Map<string, number>();

/** Looks up an active key by its secret. Returns null for unknown / revoked keys. */
export function authenticateKey(secret: string | null): ApiKeyRow | null {
  if (!secret || secret.length < 20 || secret.length > 200) return null;
  const row = db.prepare(`SELECT * FROM api_keys WHERE key_hash = ? AND active = 1`).get(sha256(secret)) as any;
  if (!row) return null;
  const now = Date.now();
  if (now - (touched.get(row.id) ?? 0) > 60_000) { // don't write to the DB on every request
    touched.set(row.id, now);
    db.prepare(`UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?`).run(row.id);
  }
  return { id: row.id, name: row.name, prefix: row.prefix, scopes: JSON.parse(row.scopes), branch_id: row.branch_id, active: row.active };
}

// Simple fixed-window limiter per key: protects the server from a runaway integration.
const windows = new Map<string, { start: number; count: number }>();
export function rateLimited(keyId: string, limit = 120, windowMs = 60_000): boolean {
  const now = Date.now();
  const w = windows.get(keyId);
  if (!w || now - w.start >= windowMs) { windows.set(keyId, { start: now, count: 1 }); return false; }
  w.count++;
  return w.count > limit;
}

/**
 * Key management is a privileged operation and this app has no user login yet, so it is gated:
 *  - with ADMIN_TOKEN set, callers must send it as X-Admin-Token;
 *  - without it, management only works for direct localhost requests (never through a proxy such as Render's).
 */
export function requireAdmin(req: AppRequest) {
  const token = process.env.ADMIN_TOKEN;
  if (token) {
    const given = req.header("x-admin-token") ?? "";
    const a = Buffer.from(given), b = Buffer.from(token);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(401, "admin token required (X-Admin-Token)");
    return;
  }
  const addr = req.raw.socket.remoteAddress ?? "";
  const local = addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
  if (!local || req.header("x-forwarded-for")) {
    throw new HttpError(403, "API key management is disabled on this server: set the ADMIN_TOKEN environment variable to enable it");
  }
}
