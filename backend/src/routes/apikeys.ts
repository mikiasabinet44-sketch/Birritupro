import { createRouter, HttpError } from "../lib/httpRouter.js";
import db from "../db/index.js";
import { SCOPES, createApiKey, requireAdmin, type Scope } from "../lib/apikeys.js";

export const apiKeysRouter = createRouter();

apiKeysRouter.get("/scopes", (_req, res) => res.json(SCOPES));

apiKeysRouter.get("/", (req, res) => {
  requireAdmin(req);
  const rows = db.prepare(
    `SELECT k.id, k.name, k.prefix, k.scopes, k.active, k.last_used_at, k.created_at, b.code AS branch_code
     FROM api_keys k LEFT JOIN branches b ON b.id = k.branch_id ORDER BY k.created_at DESC`
  ).all() as any[];
  res.json(rows.map((r) => ({ ...r, scopes: JSON.parse(r.scopes) })));
});

apiKeysRouter.post("/", (req, res) => {
  requireAdmin(req);
  const name = String(req.body?.name ?? "").trim();
  if (!name || name.length > 80) throw new HttpError(400, "name is required (max 80 characters)");
  const scopes: Scope[] = Array.isArray(req.body?.scopes) ? req.body.scopes : [];
  if (!scopes.length) throw new HttpError(400, "choose at least one scope");
  const bad = scopes.filter((s) => !(SCOPES as readonly string[]).includes(s));
  if (bad.length) throw new HttpError(400, `unknown scope(s): ${bad.join(", ")}`);

  let branchId: string | null = null;
  const b = req.body?.branch;
  if (b && b !== "all") {
    const row = db.prepare(`SELECT id FROM branches WHERE (id = ? OR code = ?) AND active = 1`).get(b, b) as { id: string } | undefined;
    if (!row) throw new HttpError(400, `unknown or inactive branch '${b}'`);
    branchId = row.id;
  }
  const created = createApiKey(name, [...new Set(scopes)], branchId);
  res.status(201).json({
    id: created.id, key: created.secret, prefix: created.prefix,
    note: "Copy this key now. It is stored only as a hash and cannot be shown again.",
  });
});

apiKeysRouter.post("/:id/revoke", (req, res) => {
  requireAdmin(req);
  const r = db.prepare(`UPDATE api_keys SET active = 0 WHERE id = ?`).run(req.params.id);
  if (!r.changes) throw new HttpError(404, "key not found");
  res.json({ ok: true });
});
