-- ========================================================================
-- Core bookkeeping
-- ========================================================================

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('asset','liability','equity','income','expense')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,              -- used to match mobile-money SMS senders
  email TEXT,
  tin TEXT,                -- Ethiopian Taxpayer Identification Number
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Simple ledger of bookkeeping transactions (one row = one economic event,
-- posted to a debit account and a credit account - simplified double entry).
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  description TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'ETB',
  debit_account_id TEXT REFERENCES accounts(id),
  credit_account_id TEXT REFERENCES accounts(id),
  category TEXT,                     -- AI-suggested or user-confirmed category
  category_confidence REAL,          -- 0..1, set by the auto-categorizer
  category_status TEXT NOT NULL DEFAULT 'suggested' CHECK (category_status IN ('suggested','confirmed','manual')),
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','sms_payment','payroll','invoice')),
  source_ref_id TEXT,                -- links back to payment_events / invoices / payroll_runs
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ========================================================================
-- Payment verification (SMS ingestion from CBE / Telebirr / BOA)
-- ========================================================================

CREATE TABLE IF NOT EXISTS payment_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('CBE','TELEBIRR','BOA','UNKNOWN')),
  sender TEXT,                                 -- raw SMS sender ID/address, if the forwarder supplied one
  raw_text TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  parsed_ok INTEGER NOT NULL DEFAULT 0,       -- 1 if parser extracted the fields
  amount REAL,
  currency TEXT DEFAULT 'ETB',
  counterparty_name TEXT,
  counterparty_phone TEXT,
  reference TEXT,                              -- bank/telebirr transaction ref
  balance_after REAL,
  txn_time TEXT,                                -- time reported inside the SMS itself
  direction TEXT CHECK (direction IN ('credit','debit')) DEFAULT 'credit',
  verification_status TEXT NOT NULL DEFAULT 'pending' CHECK (
    verification_status IN ('pending','verified','duplicate','unparsed','rejected')
  ),
  matched_invoice_id TEXT,
  transaction_id TEXT,                          -- link to the ledger transaction it created
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ========================================================================
-- Invoices + matching
-- ========================================================================

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  invoice_number TEXT NOT NULL UNIQUE,
  customer_id TEXT REFERENCES customers(id),
  issue_date TEXT NOT NULL,
  due_date TEXT,
  amount REAL NOT NULL,
  vat_amount REAL NOT NULL DEFAULT 0,
  total_amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','partially_paid','paid','overdue','cancelled')),
  amount_paid REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ========================================================================
-- Payroll
-- ========================================================================

CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  position TEXT,
  basic_salary REAL NOT NULL,
  transport_allowance REAL NOT NULL DEFAULT 0,
  other_allowance REAL NOT NULL DEFAULT 0,
  tin TEXT,
  pension_number TEXT,
  phone TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payroll_runs (
  id TEXT PRIMARY KEY,
  period TEXT NOT NULL,              -- e.g. '2026-10'
  run_date TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','finalized')),
  total_gross REAL NOT NULL DEFAULT 0,
  total_income_tax REAL NOT NULL DEFAULT 0,
  total_pension_employee REAL NOT NULL DEFAULT 0,
  total_pension_employer REAL NOT NULL DEFAULT 0,
  total_net REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payslips (
  id TEXT PRIMARY KEY,
  payroll_run_id TEXT NOT NULL REFERENCES payroll_runs(id),
  employee_id TEXT NOT NULL REFERENCES employees(id),
  basic_salary REAL NOT NULL,
  taxable_allowance REAL NOT NULL DEFAULT 0,
  non_taxable_allowance REAL NOT NULL DEFAULT 0,
  gross_salary REAL NOT NULL,
  income_tax REAL NOT NULL,
  pension_employee REAL NOT NULL,
  pension_employer REAL NOT NULL,
  other_deductions REAL NOT NULL DEFAULT 0,
  net_pay REAL NOT NULL
);

-- ========================================================================
-- Tax compliance
-- ========================================================================

-- Tax obligations generated per period (VAT, withholding, employee income tax, pension)
CREATE TABLE IF NOT EXISTS tax_filings (
  id TEXT PRIMARY KEY,
  period TEXT NOT NULL,             -- e.g. '2026-10'
  tax_type TEXT NOT NULL CHECK (tax_type IN ('vat','withholding','income_tax_payroll','pension')),
  base_amount REAL NOT NULL,
  tax_amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'due' CHECK (status IN ('due','filed','paid')),
  due_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(period, tax_type)
);

-- ========================================================================
-- PRO: company settings, multi-branch, inventory, e-invoicing, AI memory
-- (branch_id columns on the older tables above are added by the migration
--  helper in db/index.ts so databases created before this version upgrade
--  in place.)
-- ========================================================================

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS branches (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,         -- short code used in invoice numbers and SMS webhook routing, e.g. 'HO', 'BOLE'
  name TEXT NOT NULL,
  city TEXT,
  address TEXT,
  phone TEXT,
  is_head_office INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'pcs',
  cost_price REAL NOT NULL DEFAULT 0,          -- weighted-average cost, updated on every purchase
  sell_price REAL NOT NULL DEFAULT 0,
  vat_rate REAL NOT NULL DEFAULT 0.15,         -- 0 for VAT-exempt goods
  reorder_level REAL NOT NULL DEFAULT 0,
  lead_time_days INTEGER NOT NULL DEFAULT 7,   -- supplier lead time, used by the AI reorder suggestions
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Stock on hand is always derived as SUM(qty) from this ledger (never stored),
-- so it cannot drift out of sync with the movements that explain it.
CREATE TABLE IF NOT EXISTS stock_movements (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  branch_id TEXT NOT NULL REFERENCES branches(id),
  type TEXT NOT NULL CHECK (type IN ('purchase','sale','sale_return','adjustment','transfer_in','transfer_out')),
  qty REAL NOT NULL,                 -- signed: + adds stock, - removes it
  unit_cost REAL,
  date TEXT NOT NULL,
  ref_type TEXT,                     -- 'invoice' | 'transfer' | 'demo' ...
  ref_id TEXT,
  transfer_id TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  product_id TEXT REFERENCES products(id),     -- NULL for service / free-text lines (no stock effect)
  description TEXT NOT NULL,
  qty REAL NOT NULL,
  unit_price REAL NOT NULL,
  vat_rate REAL NOT NULL,
  net REAL NOT NULL,
  vat REAL NOT NULL,
  total REAL NOT NULL
);

-- E-invoice documents. Payload is immutable once created; each document is
-- chained to the previous one by hash so tampering is detectable.
CREATE TABLE IF NOT EXISTS einvoices (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  branch_id TEXT REFERENCES branches(id),
  doc_type TEXT NOT NULL CHECK (doc_type IN ('invoice','credit_note')),
  seq INTEGER NOT NULL UNIQUE,
  doc_number TEXT NOT NULL UNIQUE,
  related_einvoice_id TEXT,                    -- credit note -> the invoice it reverses
  reason TEXT,
  payload TEXT NOT NULL,                       -- canonical JSON
  payload_hash TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  chain_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','registered','rejected','cancelled')),
  irn TEXT,                                    -- Invoice Registration Number assigned on registration
  registration_mode TEXT,                      -- 'sandbox' | 'mor'
  submission_log TEXT,
  qr_data TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  registered_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- What the categorizer has learned from human confirmations.
CREATE TABLE IF NOT EXISTS category_memory (
  token TEXT NOT NULL,
  category TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (token, category)
);
