# Birritu Books Pro — Ethiopian SME accounting

Everything in the base app, plus multi-branch, inventory, e-invoicing and advanced AI.

| Area | What it does |
|---|---|
| **Bookkeeping + AI categorisation** | Ledger with auto-suggested categories (rules **plus what the app learns from your confirmations**); you confirm every suggestion. |
| **Payment verification** | Webhook ingests CBE / Telebirr / BOA SMS, parses amount, payer, reference; duplicate guard; unparsed messages are kept for manual review. |
| **Invoice matching** | Verified payments auto-match open invoices by amount + payer phone/name (auto-apply at ≥ 0.8, otherwise suggested). |
| **Payroll** | Employees (CSV import), Ethiopian income-tax brackets, pension, payslips, per-branch staff. |
| **Tax compliance** | VAT, withholding, payroll tax and pension filings per period. |
| **Multi-branch** | Branches with codes; top-bar branch selector scopes every list/dashboard; new records attach to the selected branch; side-by-side branch performance; SMS can target a branch (`"branch":"BOLE"`). |
| **Inventory** | Products (CSV import), per-branch stock, purchases, stock counts, inter-branch transfers, stock valuation (quantity × the product's current cost price), itemised invoices that deduct stock (overselling is refused), cancellations/credit notes return stock. |
| **e-Invoicing** | Itemised tax invoices and credit notes with sequential numbers, hash-chained integrity check, scannable QR, printable view, JSON payload. **Sandbox only — see below.** |
| **Advanced AI** | Anomaly/duplicate detection, 8-week cash forecast with range, reorder & transfer suggestions, "Ask your books" chat. Works offline; uses **Claude** when `ANTHROPIC_API_KEY` is set. |

## Run locally
```bash
cd backend
npm install        # only installs tsx
npm run seed       # demo: 3 branches, products, stock, customers, history
npm run dev        # http://localhost:4000
```
Needs Node ≥ 22.22 (built-in `node:sqlite`).

## Deploy on Render
Push to GitHub → Render **New → Blueprint** → pick the repo (reads `render.yaml`). Optionally add `ANTHROPIC_API_KEY` in the service's Environment tab. Copy the generated `SMS_WEBHOOK_SECRET` into your SMS-forwarder app (`X-Webhook-Secret` header).

## What is real and what is not
- **e-Invoicing is a sandbox.** Documents are validated and numbered locally and "registered" with an `SBX-…` reference that has **no legal effect**. Connecting to the Ministry of Revenue's e-invoicing system needs their official API specification and credentials, which this build does not have; `EINVOICE_MODE=mor` is a placeholder for that adapter. Do not issue these to customers as legal tax invoices.
- **Tax rates/brackets** (`backend/src/lib/taxEngine.ts`) are a configurable starting point, not tax advice. Verify against current Ministry of Revenue rules before filing.
- **SMS parsers** are written from commonly seen message formats; providers change wording without notice. Anything unreadable is stored as *unparsed*, never guessed. Send `sender` (e.g. `CBE`) with each forwarded SMS for reliable provider detection.
- **AI**: offline mode answers one question type at a time from fixed patterns. With a key, Claude answers from a JSON summary of your books and is told to say when the data doesn't contain the answer; it can still be wrong, so treat it as a helper, not an auditor. Forecasts are statistical estimates.
- **Single-tenant, no login.** Anyone with the URL can use it. Add authentication before putting real data on the internet.
- **Free Render tier wipes the SQLite file** on every deploy/restart. Use a paid persistent disk or migrate to Postgres before keeping real books.
- Accounting is simplified single-entry-style ledger lines, not full double-entry with a trial balance.
