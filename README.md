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
Push to GitHub → Render **New → Blueprint** → pick the repo (reads `render.yaml`). Optionally add `ANTHROPIC_API_KEY`, and set `ADMIN_TOKEN` to manage API keys in the service's Environment tab. Copy the generated `SMS_WEBHOOK_SECRET` into your SMS-forwarder app (`X-Webhook-Secret` header).

## Home: where the money comes from, and the copilot
- **Where your money comes from** (Home) shows money in and out per channel (CBE, Telebirr, BOA), each channel's share, top senders, last payment time and how many payments need review, plus everything entered by hand. It reads the parsed payment events, so it works the same for SMS and API payments. Endpoint: `GET /api/home/sources?period=YYYY-MM|all`.
- **Today** lists what needs attention (unmatched payments, overdue invoices, tax due soon, low stock, unusual items), each with a link to the right page. Endpoint: `GET /api/home/briefing`.
- **Ask Birritu** is a chat drawer on every page. It answers from your own records ("Who paid me today?", "Which channel brings in the most money?"). With `ANTHROPIC_API_KEY` set it uses Claude; without it, a built-in rule engine answers common questions. It only reads data and never changes the books on its own.

## Integration API (API keys instead of SMS)
Banks, payment providers, POS or ERP systems push data to `/api/v1/*` with a key made in **Branches & Settings → API access** (set `ADMIN_TOKEN` on the server first; the page asks for it). Keys are shown once, stored hashed, carry scopes (`payments:write`, `invoices:read`, `inventory:write`, `einvoices:read`, `reports:read`, …), can be locked to one branch, are rate-limited (120/min) and can be revoked.

```bash
curl -X POST $URL/api/v1/payments -H "Authorization: Bearer bk_..." -H "Content-Type: application/json" \
  -d '{"provider":"CBE","amount":1500,"direction":"credit","reference":"FT123","externalId":"bank-evt-98765","txnTime":"2026-10-25T10:30:00Z"}'
```
- `externalId` makes retries safe (same id → the earlier result is returned, `200` instead of `201`); `Idempotency-Key` does the same for other POST routes.
- Payments go through the same pipeline as SMS: duplicate guard → ledger → automatic invoice match. SMS ingestion remains as a backup channel.
- Keys can only reach the allow-listed routes (payments, invoices, customers, inventory, e-invoices, tax filings, dashboard summary). The browser UI's `/api/*` routes are not protected by keys.

## VAT
Net VAT payable = output VAT on sales − input VAT on purchases. Record input VAT by ticking "includes 15% VAT" on an expense, or via the VAT select when receiving stock. A negative result is shown as a credit and **not** carried forward to the next period automatically. Filed/paid filings are locked.

## What is real and what is not
- **e-Invoicing is a sandbox.** Documents are validated and numbered locally and "registered" with an `SBX-…` reference that has **no legal effect**. Connecting to the Ministry of Revenue's e-invoicing system needs their official API specification and credentials, which this build does not have; `EINVOICE_MODE=mor` is a placeholder for that adapter. Do not issue these to customers as legal tax invoices.
- **Tax rates/brackets** (`backend/src/lib/taxEngine.ts`) are a configurable starting point, not tax advice. Verify against current Ministry of Revenue rules before filing.
- **SMS parsers** are written from commonly seen message formats; providers change wording without notice. Anything unreadable is stored as *unparsed*, never guessed. Send `sender` (e.g. `CBE`) with each forwarded SMS for reliable provider detection.
- **AI**: offline mode answers one question type at a time from fixed patterns. With a key, Claude answers from a JSON summary of your books and is told to say when the data doesn't contain the answer; it can still be wrong, so treat it as a helper, not an auditor. Forecasts are statistical estimates.
- **Single-tenant, no login.** Anyone with the URL can use it. Add authentication before putting real data on the internet.
- **Free Render tier wipes the SQLite file** on every deploy/restart. Use a paid persistent disk or migrate to Postgres before keeping real books.
- Accounting is simplified single-entry-style ledger lines, not full double-entry with a trial balance.
