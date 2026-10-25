// Vanilla JS single-page app — no build step, no framework. Talks to the
// backend JSON API under /api/*.

const API = "/api";

// Selected branch ("all" or a branch id). Sent on every request as X-Branch-Id so the
// backend scopes lists/dashboards and attaches new records to that branch.
// localStorage can be unavailable (private mode), so every access is guarded.
let currentBranch = "all";
try { currentBranch = localStorage.getItem("branch") || "all"; } catch { /* in-memory only */ }

async function loadBranches() {
  const branches = (await api("/branches")).filter((b) => b.active);
  if (currentBranch !== "all" && !branches.some((b) => b.id === currentBranch)) currentBranch = "all";
  const sel = document.getElementById("branch-select");
  sel.innerHTML = `<option value="all">All branches</option>` + branches.map((b) => `<option value="${esc(b.id)}">${esc(b.code)} · ${esc(b.name)}</option>`).join("");
  sel.value = currentBranch;
  sel.onchange = () => {
    currentBranch = sel.value;
    try { localStorage.setItem("branch", currentBranch); } catch { /* ignore */ }
    navigate(location.hash.slice(1) || "dashboard");
  };
}

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    method: opts.method ?? "GET",
    headers: { "Content-Type": "application/json", "X-Branch-Id": currentBranch },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data;
}

function toast(msg, isError = false) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = "toast" + (isError ? " error" : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 3200);
}

function money(n) {
  const v = Number(n ?? 0);
  return (v < 0 ? "-" : "") + "ETB " + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function pill(text, kind) {
  return `<span class="pill pill-${kind}">${esc(text)}</span>`;
}

/**
 * Minimal CSV parser (handles quoted fields, escaped "" quotes, and commas
 * inside quotes — enough for a file exported from Excel/Google Sheets).
 * Returns an array of objects keyed by the header row.
 */
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { field += c; }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      pushField();
    } else if (c === "\n") {
      pushRow();
    } else if (c === "\r") {
      // skip; \n handles the line break
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) pushRow();

  const nonEmpty = rows.filter((r) => r.some((v) => v.trim() !== ""));
  if (nonEmpty.length < 2) return [];
  const header = nonEmpty[0].map((h) => h.trim());
  return nonEmpty.slice(1).map((r) => {
    const obj = {};
    header.forEach((h, idx) => { obj[h] = (r[idx] ?? "").trim(); });
    return obj;
  });
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const STATUS_PILL = {
  open: "warn", partially_paid: "warn", paid: "ok", overdue: "danger", cancelled: "muted",
  pending: "muted", verified: "ok", duplicate: "muted", unparsed: "danger", rejected: "muted",
  due: "warn", filed: "muted", confirmed: "ok", suggested: "warn", manual: "muted",
  draft: "warn", finalized: "ok",
};

// ---------------------------------------------------------------- Routing

const ROUTES = [
  { id: "dashboard", label: "Dashboard", render: renderDashboard },
  { id: "transactions", label: "Bookkeeping", render: renderTransactions },
  { id: "payments", label: "Payment Verification", render: renderPayments },
  { id: "invoices", label: "Invoices & Matching", render: renderInvoices },
  { id: "payroll", label: "Payroll", render: renderPayroll },
  { id: "tax", label: "Tax Compliance", render: renderTax },
  { id: "inventory", label: "Inventory", render: renderInventory },
  { id: "einvoices", label: "e-Invoicing", render: renderEInvoices },
  { id: "ai", label: "AI Insights", render: renderAI },
  { id: "branches", label: "Branches & Settings", render: renderBranches },
];

function renderNav(active) {
  const nav = document.getElementById("nav");
  nav.innerHTML = ROUTES.map(
    (r) => `<button class="nav-item${r.id === active ? " active" : ""}" data-route="${r.id}">${esc(r.label)}</button>`
  ).join("");
  nav.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => navigate(btn.dataset.route));
  });
}

async function navigate(routeId) {
  const route = ROUTES.find((r) => r.id === routeId) ?? ROUTES[0];
  location.hash = route.id;
  renderNav(route.id);
  document.getElementById("page-title").textContent = route.label;
  document.getElementById("page-actions").innerHTML = "";
  const view = document.getElementById("view");
  view.innerHTML = `<div class="empty">Loading…</div>`;
  try {
    await route.render(view);
  } catch (err) {
    view.innerHTML = `<div class="empty">Couldn't load this page: ${esc(err.message)}</div>`;
  }
}

window.addEventListener("hashchange", () => navigate(location.hash.slice(1)));
loadBranches()
  .catch(() => {})
  .finally(() => navigate(location.hash.slice(1) || "dashboard"));

// --------------------------------------------------------------- Dashboard

async function renderDashboard(view) {
  const s = await api("/dashboard/summary");
  const [txns, sms, invoices] = await Promise.all([
    api("/transactions"), api("/sms"), api("/invoices"),
  ]);

  view.innerHTML = `
    <div class="grid-cards">
      ${card("Net position", money(s.net), `${money(s.income)} in · ${money(Math.abs(s.expense))} out`)}
      ${card("Awaiting review", s.pendingReview, "AI-suggested transactions to confirm")}
      ${card("Unparsed SMS", s.unparsedSms, "Needs manual entry/fix")}
      ${card("Open invoices", s.openInvoiceCount, `${money(s.openInvoiceOutstanding)} outstanding`)}
      ${card("Tax due", money(s.taxDue), "Across all pending filings")}
      ${card("Employees", s.employeeCount, "Active on payroll")}
      ${card("Inventory value", money(s.inventoryValue), `${s.reorderCount} item(s) to reorder`)}
      ${card("e-Invoices", `${s.einvoiceRegistered} registered`, `${s.einvoicePending} pending · ${s.einvoiceRejected} rejected`)}
      ${card("AI: needs attention", s.attention.high + s.attention.medium + s.attention.low, `${s.attention.high} high · ${s.attention.medium} medium — see AI Insights`)}
    </div>
    <div class="muted small" style="margin:-10px 0 16px">Showing: <b>${esc(s.scope)}</b> — change branch from the selector in the top bar.</div>

    <div class="two-col">
      <div class="panel">
        <div class="panel-head"><h3>Recent ledger activity</h3></div>
        ${table(
          ["Date", "Description", "Category", "Amount"],
          txns.slice(0, 8).map((t) => [
            t.date,
            esc(t.description),
            pill(t.category ?? "—", STATUS_PILL[t.category_status] ?? "muted"),
            `<span class="num">${money(t.amount)}</span>`,
          ])
        )}
      </div>
      <div class="panel">
        <div class="panel-head"><h3>Recent SMS payment events</h3></div>
        ${table(
          ["Provider", "Amount", "From", "Status"],
          sms.slice(0, 8).map((p) => [
            p.provider,
            p.amount ? money(p.amount) : "—",
            esc(p.counterparty_name ?? "—"),
            pill(p.verification_status, STATUS_PILL[p.verification_status] ?? "muted"),
          ])
        )}
      </div>
    </div>
  `;
}

function card(label, value, sub) {
  return `<div class="card"><div class="label">${esc(label)}</div><div class="value">${value}</div><div class="sub">${esc(sub)}</div></div>`;
}

function table(headers, rows, emptyMsg = "Nothing here yet.") {
  if (!rows.length) return `<div class="empty">${esc(emptyMsg)}</div>`;
  return `<table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

// ----------------------------------------------------------- Transactions

async function renderTransactions(view) {
  document.getElementById("page-actions").innerHTML = `<button class="btn btn-primary" id="add-txn">+ Add transaction</button>`;

  const txns = await api("/transactions");

  view.innerHTML = `
    <div class="panel" id="add-txn-panel" style="display:none">
      <div class="panel-head"><h3>New transaction</h3></div>
      <div class="panel-body">
        <form id="txn-form">
          <div class="form-grid">
            <div><label>Date</label><input type="date" name="date" value="${new Date().toISOString().slice(0,10)}" required /></div>
            <div><label>Amount (ETB, +income / -expense)</label><input type="number" step="0.01" name="amount" required /></div>
            <div style="grid-column:1/-1"><label>Description</label><input type="text" name="description" placeholder="e.g. Paid electricity bill" required /></div>
          </div>
          <button class="btn btn-primary" type="submit">Save — AI will suggest a category</button>
        </form>
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><h3>Ledger</h3><span class="small muted">AI-categorized; confirm suggestions below</span></div>
      <div id="txn-table"></div>
    </div>
  `;

  document.getElementById("add-txn").onclick = () => {
    const p = document.getElementById("add-txn-panel");
    p.style.display = p.style.display === "none" ? "block" : "none";
  };

  document.getElementById("txn-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api("/transactions", { method: "POST", body: {
        date: fd.get("date"), amount: Number(fd.get("amount")), description: fd.get("description"),
      }});
      toast("Transaction added");
      renderTransactions(view);
    } catch (err) { toast(err.message, true); }
  });

  renderTxnTable(txns);

  function renderTxnTable(rows) {
    const el = document.getElementById("txn-table");
    if (!rows.length) { el.innerHTML = `<div class="empty">No transactions yet.</div>`; return; }
    el.innerHTML = `<table><thead><tr><th>Date</th><th>Description</th><th>Source</th><th>Category</th><th class="num">Amount</th><th></th></tr></thead>
      <tbody>${rows.map((t) => `
        <tr>
          <td>${esc(t.date)}</td>
          <td>${esc(t.description)}</td>
          <td>${pill(t.source, "muted")}</td>
          <td>${pill(t.category ?? "Uncategorized", STATUS_PILL[t.category_status] ?? "muted")}
            ${t.category_status === "suggested" ? `<span class="small muted"> (${Math.round((t.category_confidence ?? 0) * 100)}% confident)</span>` : ""}
          </td>
          <td class="num">${money(t.amount)}</td>
          <td>${t.category_status === "suggested" ? `<button class="btn btn-sm confirm-btn" data-id="${t.id}" data-cat="${esc(t.category)}">Confirm</button>` : ""}</td>
        </tr>`).join("")}
      </tbody></table>`;
    el.querySelectorAll(".confirm-btn").forEach((btn) => {
      btn.onclick = async () => {
        try {
          await api(`/transactions/${btn.dataset.id}/category`, { method: "PATCH", body: { category: btn.dataset.cat } });
          toast("Category confirmed");
          renderTransactions(view);
        } catch (err) { toast(err.message, true); }
      };
    });
  }
}

// --------------------------------------------------------------- Payments

async function renderPayments(view) {
  document.getElementById("page-actions").innerHTML = `<button class="btn btn-primary" id="simulate-sms">+ Simulate incoming SMS</button>`;

  const [events, invoices] = await Promise.all([api("/sms"), api("/invoices")]);
  const openInvoices = invoices.filter((i) => i.status !== "paid" && i.status !== "cancelled");

  view.innerHTML = `
    <div class="panel" id="sms-panel" style="display:none">
      <div class="panel-head"><h3>Ingest an SMS payment notification</h3></div>
      <div class="panel-body">
        <p class="small muted mt-0">
          In production, point your Android SMS-forwarding app's webhook at
          <code>POST /api/sms/ingest</code> with <code>{"rawText": "..."}</code> for every
          incoming text from CBE / Telebirr / BOA. This form simulates that call for testing.
        </p>
        <form id="sms-form">
          <div class="form-grid">
            <div><label>Provider (optional — auto-detected if omitted)</label>
              <select name="provider"><option value="">Auto-detect</option><option>CBE</option><option>TELEBIRR</option><option>BOA</option></select>
            </div>
          </div>
          <label>Raw SMS text</label>
          <textarea name="rawText" required placeholder="Dear Customer, your Account 1*****1234 has been Credited with ETB 1,500.00 from ABEBE KEBEDE on 23/10/2026. Your Current Balance is ETB 25,430.55. Ref No: FT24296ABCDE"></textarea>
          <div style="margin-top:12px"><button class="btn btn-primary" type="submit">Ingest &amp; verify</button></div>
        </form>
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><h3>Payment events</h3><span class="small muted">Parsed, verified, and auto-matched to invoices</span></div>
      <div id="sms-table"></div>
    </div>
  `;

  document.getElementById("simulate-sms").onclick = () => {
    const p = document.getElementById("sms-panel");
    p.style.display = p.style.display === "none" ? "block" : "none";
  };

  document.getElementById("sms-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const result = await api("/sms/ingest", { method: "POST", body: {
        rawText: fd.get("rawText"), provider: fd.get("provider") || undefined,
      }});
      toast(result.verificationStatus === "verified" ? "Payment verified & posted" : "SMS could not be fully parsed — review it below");
      renderPayments(view);
    } catch (err) { toast(err.message, true); }
  });

  renderSmsTable(events);

  function renderSmsTable(rows) {
    const el = document.getElementById("sms-table");
    if (!rows.length) { el.innerHTML = `<div class="empty">No SMS payment events yet.</div>`; return; }
    el.innerHTML = `<table><thead><tr><th>Received</th><th>Provider</th><th>Amount</th><th>From</th><th>Ref</th><th>Status</th><th>Match</th><th></th></tr></thead>
      <tbody>${rows.map((p) => `
        <tr>
          <td>${esc((p.received_at ?? "").slice(0,16))}</td>
          <td>${pill(p.provider, "muted")}</td>
          <td class="num">${p.amount ? money(p.amount) : "—"}</td>
          <td>${esc(p.counterparty_name ?? "—")}</td>
          <td class="small muted">${esc(p.reference ?? "—")}</td>
          <td>${pill(p.verification_status, STATUS_PILL[p.verification_status] ?? "muted")}</td>
          <td>${p.matched_invoice_id ? pill("matched", "ok") : (p.verification_status === "verified" ? applySelect(p.id, openInvoices) : "—")}</td>
          <td>${p.verification_status === "pending" || p.verification_status === "unparsed" ? `<button class="btn btn-sm btn-danger reject-btn" data-id="${p.id}">Reject</button>` : ""}</td>
        </tr>`).join("")}
      </tbody></table>`;

    el.querySelectorAll(".reject-btn").forEach((btn) => {
      btn.onclick = async () => {
        await api(`/sms/${btn.dataset.id}/reject`, { method: "PATCH" });
        toast("Marked rejected");
        renderPayments(view);
      };
    });
    el.querySelectorAll(".apply-select").forEach((sel) => {
      sel.onchange = async () => {
        if (!sel.value) return;
        try {
          await api(`/sms/${sel.dataset.id}/apply-to-invoice`, { method: "POST", body: { invoiceId: sel.value } });
          toast("Applied to invoice");
          renderPayments(view);
        } catch (err) { toast(err.message, true); }
      };
    });
  }

  function applySelect(paymentId, invoices) {
    if (!invoices.length) return `<span class="small muted">no open invoices</span>`;
    return `<select class="apply-select small" data-id="${paymentId}">
      <option value="">Apply to invoice…</option>
      ${invoices.map((i) => `<option value="${i.id}">${esc(i.invoice_number)} (${money(i.total_amount - i.amount_paid)} due)</option>`).join("")}
    </select>`;
  }
}

// -------------------------------------------------------------- Invoices

async function renderInvoices(view) {
  document.getElementById("page-actions").innerHTML = `<button class="btn btn-primary" id="add-invoice">+ New invoice</button>`;

  const [invoices, customers, products] = await Promise.all([api("/invoices"), api("/customers"), api("/inventory/products")]);
  const branchNote = currentBranch === "all" ? "Head office (no branch selected)" : "the selected branch";

  view.innerHTML = `
    <div class="panel" id="invoice-panel" style="display:none">
      <div class="panel-head"><h3>New invoice</h3></div>
      <div class="panel-body two-col">
        <form id="invoice-form">
          <div class="form-grid">
            <div><label>Invoice # (blank = auto)</label><input name="invoiceNumber" placeholder="auto" /></div>
            <div><label>Customer</label>
              <select name="customerId">
                <option value="">— none —</option>
                ${customers.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}
              </select>
            </div>
            <div><label>Issue date</label><input type="date" name="issueDate" value="${new Date().toISOString().slice(0,10)}" required /></div>
            <div><label>Due date</label><input type="date" name="dueDate" /></div>
            <div><label>Type</label><select name="mode" id="inv-mode"><option value="items">Products (deducts stock)</option><option value="simple">Simple amount</option></select></div>
            <div><label>Include VAT?</label><select name="includeVat"><option value="true">Yes (per-product rate)</option><option value="false">No</option></select></div>
          </div>
          <div id="inv-simple" style="display:none" class="form-grid"><div><label>Amount (excl. VAT)</label><input type="number" step="0.01" name="amount" /></div></div>
          <div id="inv-items">
            <div id="inv-lines"></div>
            <button type="button" class="btn btn-sm" id="add-line">+ Add line</button>
          </div>
          <div class="muted small" style="margin:8px 0">Booked to ${esc(branchNote)}. Stock is taken from that branch.</div>
          <button class="btn btn-primary" type="submit">Create invoice</button>
        </form>
        <div>
          <h3 class="small" style="margin-bottom:8px">Quick-add customer</h3>
          <form id="customer-form">
            <div class="form-grid">
              <div><label>Name</label><input name="name" required /></div>
              <div><label>Phone (for SMS matching)</label><input name="phone" placeholder="0911223344" /></div>
              <div><label>TIN (for e-invoices)</label><input name="tin" placeholder="10 digits" /></div>
            </div>
            <button class="btn btn-sm" type="submit">Add customer</button>
          </form>
        </div>
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><h3>Invoices</h3></div>
      <div id="invoice-table"></div>
    </div>
  `;

  const addLine = () => {
    const row = document.createElement("div");
    row.className = "flex line-row";
    row.style.marginBottom = "6px";
    row.innerHTML = `
      <select class="l-prod" style="flex:2"><option value="">— product —</option>${products.map((p) => `<option value="${p.id}" data-price="${p.sell_price}">${esc(p.sku)} · ${esc(p.name)} (${Number(p.on_hand)} in stock)</option>`).join("")}</select>
      <input class="l-qty" type="number" step="0.01" min="0" placeholder="Qty" style="width:90px" />
      <input class="l-price" type="number" step="0.01" min="0" placeholder="Unit price" style="width:120px" />
      <button type="button" class="btn btn-sm btn-danger l-del">✕</button>`;
    row.querySelector(".l-prod").onchange = (e) => {
      const price = e.target.selectedOptions[0]?.dataset.price;
      if (price) row.querySelector(".l-price").value = price;
    };
    row.querySelector(".l-del").onclick = () => row.remove();
    document.getElementById("inv-lines").appendChild(row);
  };
  addLine();
  document.getElementById("add-line").onclick = addLine;

  const modeSel = document.getElementById("inv-mode");
  modeSel.onchange = () => {
    document.getElementById("inv-items").style.display = modeSel.value === "items" ? "block" : "none";
    document.getElementById("inv-simple").style.display = modeSel.value === "simple" ? "grid" : "none";
  };

  document.getElementById("add-invoice").onclick = () => {
    const p = document.getElementById("invoice-panel");
    p.style.display = p.style.display === "none" ? "block" : "none";
  };

  document.getElementById("invoice-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = {
      invoiceNumber: fd.get("invoiceNumber") || undefined,
      customerId: fd.get("customerId") || undefined,
      issueDate: fd.get("issueDate"),
      dueDate: fd.get("dueDate") || undefined,
      includeVat: fd.get("includeVat") === "true",
    };
    if (fd.get("mode") === "items") {
      body.lines = [...document.querySelectorAll(".line-row")]
        .map((r) => ({ productId: r.querySelector(".l-prod").value, qty: Number(r.querySelector(".l-qty").value), unitPrice: r.querySelector(".l-price").value === "" ? undefined : Number(r.querySelector(".l-price").value) }))
        .filter((l) => l.productId || l.qty);
      if (!body.lines.length) return toast("Add at least one product line", true);
      if (body.lines.some((l) => !l.productId)) return toast("Choose a product on every line", true);
    } else {
      body.amount = Number(fd.get("amount"));
    }
    try {
      const r = await api("/invoices", { method: "POST", body });
      toast(`Invoice ${r.invoiceNumber} created`);
      renderInvoices(view);
    } catch (err) { toast(err.message, true); }
  });

  document.getElementById("customer-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api("/customers", { method: "POST", body: { name: fd.get("name"), phone: fd.get("phone") || undefined, tin: fd.get("tin") || undefined } });
      toast("Customer added");
      renderInvoices(view);
    } catch (err) { toast(err.message, true); }
  });

  const el = document.getElementById("invoice-table");
  if (!invoices.length) { el.innerHTML = `<div class="empty">No invoices yet.</div>`; return; }
  el.innerHTML = `<table><thead><tr><th>Invoice</th><th>Branch</th><th>Customer</th><th>Issued</th><th class="num">Total</th><th class="num">Paid</th><th>Status</th><th>e-Invoice</th><th></th></tr></thead>
    <tbody>${invoices.map((i) => `
      <tr>
        <td>${esc(i.invoice_number)}</td>
        <td>${esc(i.branch_code ?? "")}</td>
        <td>${esc(i.customer_name ?? "—")}</td>
        <td>${esc(i.issue_date)}</td>
        <td class="num">${money(i.total_amount)}</td>
        <td class="num">${money(i.amount_paid)}</td>
        <td>${pill(i.status.replace("_", " "), STATUS_PILL[i.status] ?? "muted")}</td>
        <td>${i.einvoice_status ? pill(i.einvoice_status, EI_PILL[i.einvoice_status] ?? "muted") : (i.status === "cancelled" ? "—" : `<button class="btn btn-sm" data-issue="${i.id}">Issue e-invoice</button>`)}</td>
        <td>${i.status !== "cancelled" && i.status !== "paid" && !i.einvoice_status ? `<button class="btn btn-sm btn-danger" data-cancel="${i.id}">Cancel</button>` : ""}</td>
      </tr>`).join("")}
    </tbody></table>`;

  el.querySelectorAll("[data-issue]").forEach((b) => (b.onclick = async () => {
    try { const r = await api(`/einvoices/from-invoice/${b.dataset.issue}`, { method: "POST" }); toast(`Issued ${r.docNumber} — register it under e-Invoicing`); renderInvoices(view); }
    catch (err) { toast(err.message, true); }
  }));
  el.querySelectorAll("[data-cancel]").forEach((b) => (b.onclick = async () => {
    if (!confirm("Cancel this invoice? Any stock it took is returned.")) return;
    try { await api(`/invoices/${b.dataset.cancel}/cancel`, { method: "POST" }); toast("Invoice cancelled"); renderInvoices(view); }
    catch (err) { toast(err.message, true); }
  }));
}

// --------------------------------------------------------------- Payroll

async function renderPayroll(view, initialTab = "employees") {
  document.getElementById("page-actions").innerHTML = `
    <button class="btn" id="dl-emp-template">Download CSV template</button>
    <button class="btn" id="import-emp">Import CSV</button>
    <input type="file" id="emp-csv-input" accept=".csv" style="display:none" />
    <button class="btn btn-primary" id="add-emp">+ Add employee</button>
  `;

  const [employees, runs] = await Promise.all([api("/payroll/employees"), api("/payroll/runs")]);

  view.innerHTML = `
    <div class="tabs">
      <button class="tab-btn${initialTab === "employees" ? " active" : ""}" data-tab="employees">Employees</button>
      <button class="tab-btn${initialTab === "runs" ? " active" : ""}" data-tab="runs">Payroll runs</button>
    </div>
    <div id="employees-tab" style="display:${initialTab === "employees" ? "block" : "none"}">
      <div class="panel" id="emp-panel" style="display:none">
        <div class="panel-head"><h3>New employee</h3></div>
        <div class="panel-body">
          <form id="emp-form">
            <div class="form-grid">
              <div><label>Full name</label><input name="fullName" required /></div>
              <div><label>Position</label><input name="position" /></div>
              <div><label>Basic salary (ETB/mo)</label><input type="number" step="0.01" name="basicSalary" required /></div>
              <div><label>Transport allowance (non-taxable)</label><input type="number" step="0.01" name="transportAllowance" value="0" /></div>
              <div><label>Other allowance (taxable)</label><input type="number" step="0.01" name="otherAllowance" value="0" /></div>
              <div><label>Phone</label><input name="phone" /></div>
            </div>
            <button class="btn btn-primary" type="submit">Add employee</button>
          </form>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><h3>Employees</h3></div>
        ${table(
          ["Name", "Position", "Basic salary", "Transport", "Other allowance"],
          employees.map((e) => [esc(e.full_name), esc(e.position ?? "—"), `<span class="num">${money(e.basic_salary)}</span>`, `<span class="num">${money(e.transport_allowance)}</span>`, `<span class="num">${money(e.other_allowance)}</span>`]),
          "No employees yet."
        )}
      </div>
    </div>
    <div id="runs-tab" style="display:${initialTab === "runs" ? "block" : "none"}">
      <div class="panel">
        <div class="panel-head">
          <h3>Run payroll</h3>
        </div>
        <div class="panel-body">
          <form id="run-form" class="flex">
            <div style="max-width:200px"><label>Period</label><input type="month" name="period" value="${new Date().toISOString().slice(0,7)}" required /></div>
            <button class="btn btn-primary" type="submit" style="margin-top:20px">Run payroll</button>
          </form>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><h3>Payroll runs</h3></div>
        <div id="runs-table"></div>
      </div>
      <div class="panel" id="payslip-panel" style="display:none">
        <div class="panel-head"><h3 id="payslip-title">Payslips</h3></div>
        <div id="payslip-table"></div>
      </div>
    </div>
  `;

  view.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.onclick = () => {
      view.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById("employees-tab").style.display = btn.dataset.tab === "employees" ? "block" : "none";
      document.getElementById("runs-tab").style.display = btn.dataset.tab === "runs" ? "block" : "none";
    };
  });

  document.getElementById("add-emp").onclick = () => {
    const p = document.getElementById("emp-panel");
    p.style.display = p.style.display === "none" ? "block" : "none";
  };

  document.getElementById("dl-emp-template").onclick = () => {
    const header = "fullName,position,basicSalary,transportAllowance,otherAllowance,tin,pensionNumber,phone";
    const example = "Abebe Kebede,Accountant,12000,600,500,0011122233,PEN-001,0911223344";
    downloadText("employee-import-template.csv", header + "\n" + example + "\n");
  };

  document.getElementById("import-emp").onclick = () => {
    document.getElementById("emp-csv-input").click();
  };

  document.getElementById("emp-csv-input").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file later
    if (!file) return;
    try {
      const text = await file.text();
      const rows = parseCsv(text);
      if (rows.length === 0) throw new Error("CSV has no data rows");
      const result = await api("/payroll/employees/import", { method: "POST", body: { employees: rows } });
      if (result.failed > 0) {
        const firstErrors = result.results.filter((r) => !r.ok).slice(0, 3).map((r) => `row ${r.row}: ${r.error}`).join("; ");
        toast(`Imported ${result.imported}, ${result.failed} failed (${firstErrors})`, result.imported === 0);
      } else {
        toast(`Imported ${result.imported} employee(s)`);
      }
      renderPayroll(view);
    } catch (err) { toast(err.message, true); }
  });

  document.getElementById("emp-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api("/payroll/employees", { method: "POST", body: {
        fullName: fd.get("fullName"), position: fd.get("position") || undefined,
        basicSalary: Number(fd.get("basicSalary")),
        transportAllowance: Number(fd.get("transportAllowance") || 0),
        otherAllowance: Number(fd.get("otherAllowance") || 0),
        phone: fd.get("phone") || undefined,
      }});
      toast("Employee added");
      renderPayroll(view);
    } catch (err) { toast(err.message, true); }
  });

  document.getElementById("run-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api("/payroll/runs", { method: "POST", body: { period: fd.get("period") } });
      toast("Payroll run created");
      renderPayroll(view);
    } catch (err) { toast(err.message, true); }
  });

  renderRunsTable(runs);

  function renderRunsTable(rows) {
    const el = document.getElementById("runs-table");
    if (!rows.length) { el.innerHTML = `<div class="empty">No payroll runs yet.</div>`; return; }
    el.innerHTML = `<table><thead><tr><th>Period</th><th class="num">Gross</th><th class="num">Income tax</th><th class="num">Pension (emp+er)</th><th class="num">Net pay</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows.map((r) => `
        <tr>
          <td>${esc(r.period)}</td>
          <td class="num">${money(r.total_gross)}</td>
          <td class="num">${money(r.total_income_tax)}</td>
          <td class="num">${money(r.total_pension_employee + r.total_pension_employer)}</td>
          <td class="num">${money(r.total_net)}</td>
          <td>${pill(r.status, STATUS_PILL[r.status] ?? "muted")}</td>
          <td class="flex">
            <button class="btn btn-sm view-payslips" data-id="${r.id}" data-period="${esc(r.period)}">Payslips</button>
            ${r.status === "draft" ? `<button class="btn btn-sm btn-primary finalize-run" data-id="${r.id}">Finalize</button>` : ""}
          </td>
        </tr>`).join("")}
      </tbody></table>`;

    el.querySelectorAll(".finalize-run").forEach((btn) => {
      btn.onclick = async () => {
        try {
          await api(`/payroll/runs/${btn.dataset.id}/finalize`, { method: "POST" });
          toast("Run finalized — posted to ledger & tax filings");
          renderPayroll(view);
        } catch (err) { toast(err.message, true); }
      };
    });
    el.querySelectorAll(".view-payslips").forEach((btn) => {
      btn.onclick = async () => {
        const slips = await api(`/payroll/runs/${btn.dataset.id}/payslips`);
        document.getElementById("payslip-panel").style.display = "block";
        document.getElementById("payslip-title").textContent = `Payslips — ${btn.dataset.period}`;
        document.getElementById("payslip-table").innerHTML = table(
          ["Employee", "Basic", "Gross", "Income tax", "Pension (emp)", "Net pay"],
          slips.map((s) => [esc(s.full_name), money(s.basic_salary), money(s.gross_salary), money(s.income_tax), money(s.pension_employee), `<b>${money(s.net_pay)}</b>`])
        );
      };
    });
  }
}

// ------------------------------------------------------------------- Tax

async function renderTax(view) {
  document.getElementById("page-actions").innerHTML = "";
  const filings = await api("/tax/filings");
  const rates = await api("/tax/rates");

  view.innerHTML = `
    <div class="grid-cards">
      ${card("VAT rate", (+(rates.vatRate * 100).toFixed(2)) + "%", "Standard output VAT")}
      ${card("Withholding rate", (+(rates.withholdingRate * 100).toFixed(2)) + "%", "On qualifying purchases")}
      ${card("Pension — employee", (+(rates.pensionEmployeeRate * 100).toFixed(2)) + "%", "Of basic salary")}
      ${card("Pension — employer", (+(rates.pensionEmployerRate * 100).toFixed(2)) + "%", "Of basic salary")}
    </div>
    <div class="panel">
      <div class="panel-head">
        <h3>Compute VAT &amp; withholding for a period</h3>
      </div>
      <div class="panel-body">
        <form id="compute-form" class="flex">
          <div style="max-width:200px"><label>Period</label><input type="month" name="period" value="${new Date().toISOString().slice(0,7)}" required /></div>
          <button class="btn btn-primary" type="submit" style="margin-top:20px">Compute</button>
        </form>
        <p class="small muted">Pulls VAT from invoices issued that month, and withholding from recorded "Supplies &amp; Inventory" expenses. Payroll income tax &amp; pension are added automatically when a payroll run is finalized.</p>
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><h3>Tax filings</h3></div>
      <div id="filings-table"></div>
    </div>
  `;

  document.getElementById("compute-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api(`/tax/compute/${fd.get("period")}`, { method: "POST" });
      toast("Computed");
      renderTax(view);
    } catch (err) { toast(err.message, true); }
  });

  renderFilings(filings);

  function renderFilings(rows) {
    const el = document.getElementById("filings-table");
    if (!rows.length) { el.innerHTML = `<div class="empty">No tax filings yet.</div>`; return; }
    el.innerHTML = `<table><thead><tr><th>Period</th><th>Type</th><th class="num">Base</th><th class="num">Tax</th><th>Due date</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows.map((f) => `
        <tr>
          <td>${esc(f.period)}</td>
          <td>${pill(f.tax_type.replace(/_/g, " "), "muted")}</td>
          <td class="num">${money(f.base_amount)}</td>
          <td class="num">${money(f.tax_amount)}</td>
          <td>${esc(f.due_date ?? "—")}</td>
          <td>${pill(f.status, STATUS_PILL[f.status] ?? "muted")}</td>
          <td>${f.status !== "paid" ? `<select class="status-select small" data-id="${f.id}">
              <option value="">Update…</option>
              <option value="filed">Mark filed</option>
              <option value="paid">Mark paid</option>
            </select>` : ""}</td>
        </tr>`).join("")}
      </tbody></table>`;
    el.querySelectorAll(".status-select").forEach((sel) => {
      sel.onchange = async () => {
        if (!sel.value) return;
        await api(`/tax/filings/${sel.dataset.id}/status`, { method: "PATCH", body: { status: sel.value } });
        toast("Updated");
        renderTax(view);
      };
    });
  }
}
