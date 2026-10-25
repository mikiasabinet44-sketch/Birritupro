import db, { getHeadOfficeId } from "../db/index.js";
import { HttpError, type AppRequest } from "./httpRouter.js";

/**
 * Branch scoping. The frontend sends the selected branch on every request as
 * the X-Branch-Id header ('all' or absent = every branch). Accepts either the
 * branch id or its short code, so SMS forwarders can simply send "BOLE".
 */
export function branchOf(req: AppRequest, explicit?: string | null): string | null {
  const v = explicit ?? req.header("x-branch-id") ?? req.query.get("branch");
  if (!v || v === "all") return null;
  const row = db.prepare(`SELECT id FROM branches WHERE (id = ? OR code = ?) AND active = 1`).get(v, v) as { id: string } | undefined;
  if (!row) throw new HttpError(400, `unknown or inactive branch '${v}'`);
  return row.id;
}

/** Branch to attach new records to: explicit > selected > head office. */
export function writeBranch(req: AppRequest, explicit?: string | null): string {
  return branchOf(req, explicit) ?? getHeadOfficeId();
}

/** SQL fragment restricting a query to the selected branch, e.g. `WHERE 1=1${clause.sql}`. */
export function branchClause(req: AppRequest, column = "branch_id"): { sql: string; params: string[] } {
  const b = branchOf(req);
  return b ? { sql: ` AND ${column} = ?`, params: [b] } : { sql: "", params: [] };
}

export function branchName(id: string | null): string {
  if (!id) return "All branches";
  const row = db.prepare(`SELECT name FROM branches WHERE id = ?`).get(id) as { name: string } | undefined;
  return row?.name ?? "Unknown branch";
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
export const todayStr = () => new Date().toISOString().slice(0, 10);
