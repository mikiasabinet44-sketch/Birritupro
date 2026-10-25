import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../../data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, "app.db");
export const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA foreign_keys = ON");

const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf-8");
db.exec(schema);

/** Adds a column to an existing table if it isn't there yet (idempotent in-place migration). */
export function ensureColumn(table: string, column: string, ddl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

// ---- Migrations: branch awareness on the original tables ----
const BRANCHED_TABLES = ["transactions", "invoices", "employees", "payment_events", "payroll_runs"];
for (const t of BRANCHED_TABLES) ensureColumn(t, "branch_id", "TEXT REFERENCES branches(id)");

/** Every installation has exactly one head office; it is the default branch for anything not explicitly assigned. */
export function getHeadOfficeId(): string {
  const row = db.prepare(`SELECT id FROM branches WHERE is_head_office = 1 ORDER BY created_at LIMIT 1`).get() as { id: string } | undefined;
  if (row) return row.id;
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO branches (id, code, name, is_head_office) VALUES (?, 'HO', 'Head Office', 1)`).run(id);
  return id;
}

const HO = getHeadOfficeId();
// Data created before branches existed belongs to the head office.
// (payroll_runs.branch_id stays NULL on purpose: NULL means "covers all branches".)
for (const t of ["transactions", "invoices", "employees", "payment_events"]) {
  db.prepare(`UPDATE ${t} SET branch_id = ? WHERE branch_id IS NULL`).run(HO);
}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_txn_branch_date ON transactions(branch_id, date);
  CREATE INDEX IF NOT EXISTS idx_inv_branch ON invoices(branch_id);
  CREATE INDEX IF NOT EXISTS idx_stock_product_branch ON stock_movements(product_id, branch_id);
  CREATE INDEX IF NOT EXISTS idx_einv_invoice ON einvoices(invoice_id);
`);

/** Runs fn inside a BEGIN/COMMIT block, rolling back on error (node:sqlite has no built-in .transaction() helper). */
export function runInTransaction<T>(fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function getSetting(key: string): string | null {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string) {
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

export default db;
