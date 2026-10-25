// Pro modules: Inventory, e-Invoices, AI Insights, Branches & Settings.
// Loaded before app.js; relies on app.js helpers (api, esc, money, pill, table, card, toast,
// parseCsv, downloadText, STATUS_PILL) which are only called at runtime, after both files load.

const num = (v) => Number(v ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
const opt = (rows, val, label, selected) =>
  rows.map((r) => `<option value="${esc(r[val])}"${r[val] === selected ? " selected" : ""}>${esc(typeof label === "function" ? label(r) : r[label])}</option>`).join("");

function tabs(view, names, active, onChange) {
  const bar = document.createElement("div");
  bar.className = "tabs";
  bar.innerHTML = names.map(([id, label]) => `<button class="tab-btn${id === active ? " active" : ""}" data-tab="${id}">${esc(label)}</button>`).join("");
  bar.querySelectorAll(".tab-btn").forEach((b) => (b.onclick = () => onChange(b.dataset.tab)));
  view.prepend(bar);
}

// ================================================================ Inventory

async function renderInventory(view, tab = "stock") {
  const [stock, products, valuation, movements, branches] = await Promise.all([
    api("/inventory/stock"), api("/inventory/products"), api("/inventory/valuation"),
    api("/inventory/movements?limit=60"), api("/branches"),
  ]);
  const active = branches.filter((b) => b.active);
  const lowCount = stock.rows.filter((r) => r.total <= r.reorderLevel).length;

  document.getElementById("page-actions").innerHTML = `
    <button class="btn" id="dl-prod-template">Product CSV template</button>
    <button class="btn" id="import-prod">Import products CSV</button>
    <input type="file" id="prod-csv" accept=".csv" style="display:none" />`;

  const body = {
    stock: () => `
      <div class="grid-cards">
        ${card("Stock value (at cost)", money(valuation.total), "Scope: selected branch")}
        ${card("Products", products.length, "Active items")}
        ${card("At / below reorder level", lowCount, "Across all branches combined")}
      </div>
      <div class="panel"><div class="panel-head"><h3>Stock by branch</h3></div>
        ${table(["SKU", "Product", ...stock.branches.map((b) => b.code), "Total", "Reorder at"],
          stock.rows.map((r) => [
            esc(r.sku), esc(r.name),
            ...stock.branches.map((b) => `<span class="num">${num(r.perBranch[b.id])}</span>`),
            `<b class="num">${num(r.total)}</b> ${r.total <= r.reorderLevel ? pill("low", "danger") : ""}`,
            `<span class="num">${num(r.reorderLevel)}</span>`,
          ]), "No products yet — add one under Products.")}
      </div>`,
    products: () => `
      <div class="panel"><div class="panel-head"><h3>New product</h3></div><div class="panel-body">
        <form id="prod-form"><div class="form-grid">
          <div><label>SKU</label><input name="sku" required /></div>
          <div><label>Name</label><input name="name" required /></div>
          <div><label>Unit</label><input name="unit" value="pcs" /></div>
          <div><label>Cost price</label><input type="number" step="0.01" name="costPrice" required /></div>
          <div><label>Selling price (excl. VAT)</label><input type="number" step="0.01" name="sellPrice" required /></div>
          <div><label>VAT rate</label><select name="vatRate"><option value="0.15">15% standard</option><option value="0">0% / exempt</option></select></div>
          <div><label>Reorder level</label><input type="number" name="reorderLevel" value="10" /></div>
          <div><label>Supplier lead time (days)</label><input type="number" name="leadTimeDays" value="7" /></div>
          <div><label>Opening stock (selected branch)</label><input type="number" step="0.01" name="openingQty" value="0" /></div>
        </div><button class="btn btn-primary" type="submit">Add product</button></form>
      </div></div>
      <div class="panel"><div class="panel-head"><h3>Products</h3></div>
        ${table(["SKU", "Name", "Unit", "Cost", "Price", "VAT", "Reorder"],
          products.map((p) => [esc(p.sku), esc(p.name), esc(p.unit), `<span class="num">${money(p.cost_price)}</span>`, `<span class="num">${money(p.sell_price)}</span>`, `${Math.round(p.vat_rate * 100)}%`, `<span class="num">${num(p.reorder_level)}</span>`]))}
      </div>`,
    actions: () => `
      <div class="two-col">
        <div class="panel"><div class="panel-head"><h3>Receive stock (purchase)</h3></div><div class="panel-body">
          <form id="recv-form"><div class="form-grid">
            <div><label>Product</label><select name="productId">${opt(products, "id", (p) => `${p.sku} · ${p.name}`)}</select></div>
            <div><label>Into branch</label><select name="branchId">${opt(active, "id", "name")}</select></div>
            <div><label>Quantity</label><input type="number" step="0.01" name="qty" required /></div>
            <div><label>Unit cost</label><input type="number" step="0.01" name="unitCost" required /></div>
            <div><label>Supplier</label><input name="supplier" /></div>
            <div><label>Book as expense?</label><select name="recordExpense"><option value="true">Yes — add to ledger</option><option value="false">No</option></select></div>
          </div><button class="btn btn-primary" type="submit">Receive</button></form>
        </div></div>
        <div class="panel"><div class="panel-head"><h3>Transfer between branches</h3></div><div class="panel-body">
          <form id="xfer-form"><div class="form-grid">
            <div><label>Product</label><select name="productId">${opt(products, "id", (p) => `${p.sku} · ${p.name}`)}</select></div>
            <div><label>Quantity</label><input type="number" step="0.01" name="qty" required /></div>
            <div><label>From</label><select name="fromBranchId">${opt(active, "id", "name")}</select></div>
            <div><label>To</label><select name="toBranchId">${opt(active.slice().reverse(), "id", "name")}</select></div>
            <div><label>Note</label><input name="note" /></div>
          </div><button class="btn btn-primary" type="submit">Transfer</button></form>
        </div></div>
      </div>
      <div class="panel"><div class="panel-head"><h3>Stock count / adjustment</h3></div><div class="panel-body">
        <form id="adj-form"><div class="form-grid">
          <div><label>Product</label><select name="productId">${opt(products, "id", (p) => `${p.sku} · ${p.name}`)}</select></div>
          <div><label>Branch</label><select name="branchId">${opt(active, "id", "name")}</select></div>
          <div><label>Counted quantity</label><input type="number" step="0.01" name="countedQty" required /></div>
          <div><label>Reason</label><input name="reason" placeholder="e.g. damaged, recount" required /></div>
        </div><button class="btn btn-primary" type="submit">Set count</button></form>
      </div></div>`,
    movements: () => `
      <div class="panel"><div class="panel-head"><h3>Recent stock movements</h3></div>
        ${table(["Date", "Branch", "Product", "Type", "Qty", "Unit cost", "Note"],
          movements.map((m) => [esc(m.date), esc(m.branch_code), esc(m.product_name), pill(m.type.replace("_", " "), m.qty < 0 ? "warn" : "ok"),
            `<span class="num">${num(m.qty)}</span>`, `<span class="num">${m.unit_cost == null ? "—" : money(m.unit_cost)}</span>`, esc(m.note ?? "")]))}
      </div>`,
  };

  view.innerHTML = `<div id="inv-body">${body[tab]()}</div>`;
  tabs(view, [["stock", "Stock"], ["products", "Products"], ["actions", "Receive / transfer / count"], ["movements", "Movements"]], tab, (t) => renderInventory(view, t));

  const submit = (id, path, build, msg) => {
    const f = document.getElementById(id);
    if (!f) return;
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(f));
      try { await api(path, { method: "POST", body: build(fd) }); toast(msg); renderInventory(view, tab); }
      catch (err) { toast(err.message, true); }
    });
  };
  submit("prod-form", "/inventory/products", (f) => ({ ...f, costPrice: +f.costPrice, sellPrice: +f.sellPrice, vatRate: +f.vatRate, reorderLevel: +f.reorderLevel, leadTimeDays: +f.leadTimeDays, openingQty: +f.openingQty }), "Product added");
  submit("recv-form", "/inventory/receive", (f) => ({ ...f, qty: +f.qty, unitCost: +f.unitCost, recordExpense: f.recordExpense === "true" }), "Stock received");
  submit("xfer-form", "/inventory/transfer", (f) => ({ ...f, qty: +f.qty }), "Transfer recorded");
  submit("adj-form", "/inventory/adjust", (f) => ({ ...f, countedQty: +f.countedQty }), "Stock count saved");

  document.getElementById("dl-prod-template").onclick = () =>
    downloadText("product-import-template.csv", "sku,name,unit,costPrice,sellPrice,vatRate,reorderLevel,leadTimeDays,openingQty\nCEM-50,Cement 50kg bag,bag,900,1100,0.15,50,7,100\n");
  document.getElementById("import-prod").onclick = () => document.getElementById("prod-csv").click();
  document.getElementById("prod-csv").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const rows = parseCsv(await file.text());
      if (!rows.length) throw new Error("CSV has no data rows");
      const r = await api("/inventory/products/import", { method: "POST", body: { products: rows } });
      const errs = r.results.filter((x) => !x.ok).slice(0, 3).map((x) => `row ${x.row}: ${x.error}`).join("; ");
      toast(`Imported ${r.imported}${r.failed ? `, ${r.failed} failed (${errs})` : ""} — opening stock goes to the selected branch`, r.imported === 0);
      renderInventory(view, "products");
    } catch (err) { toast(err.message, true); }
  });
}

// ================================================================ e-Invoices

const EI_PILL = { pending: "warn", registered: "ok", rejected: "danger", cancelled: "muted" };

async function renderEInvoices(view) {
  const [mode, chain, list] = await Promise.all([api("/einvoices/mode"), api("/einvoices/verify-chain"), api("/einvoices")]);
  view.innerHTML = `
    <div class="notice ${mode.mode === "sandbox" ? "notice-warn" : ""}"><b>${mode.mode === "sandbox" ? "Sandbox mode" : "MoR mode"}.</b> ${esc(mode.note)}</div>
    <div class="flex" style="margin-bottom:14px">
      ${chain.intact ? pill(`Integrity chain intact · ${chain.documents} document(s)`, "ok") : pill(`Chain broken: ${chain.problems.length} problem(s)`, "danger")}
      <span class="muted small">Issue an e-invoice from the Invoices page (button on each row).</span>
    </div>
    <div class="panel"><div class="panel-head"><h3>e-Invoice documents</h3></div>
      ${table(["Document", "Type", "Invoice", "Branch", "Buyer", "Total", "Status", "IRN", ""],
        list.map((e) => [
          esc(e.doc_number), e.doc_type === "credit_note" ? pill("credit note", "warn") : "invoice", esc(e.invoice_number), esc(e.branch_code ?? ""),
          esc(e.buyer ?? "—"), `<span class="num">${money(e.total)}</span>`, pill(e.status, EI_PILL[e.status] ?? "muted"), `<code>${esc(e.irn ?? "—")}</code>`,
          `<button class="btn btn-sm" data-view="${e.id}">View / print</button>
           ${e.status === "pending" || e.status === "rejected" ? `<button class="btn btn-sm btn-primary" data-reg="${e.id}">Register</button>` : ""}
           ${e.status === "registered" && e.doc_type === "invoice" ? `<button class="btn btn-sm btn-danger" data-credit="${e.id}">Credit note</button>` : ""}`,
        ]), "No e-invoices yet.")}
    </div>
    <div id="ei-detail"></div>`;

  view.querySelectorAll("[data-reg]").forEach((b) => (b.onclick = async () => {
    try { const r = await api(`/einvoices/${b.dataset.reg}/register`, { method: "POST" }); toast(`Registered · ${r.irn}`); renderEInvoices(view); }
    catch (err) { toast(err.message, true); }
  }));
  view.querySelectorAll("[data-credit]").forEach((b) => (b.onclick = async () => {
    const reason = prompt("Reason for the credit note (required):");
    if (!reason) return;
    try { await api(`/einvoices/${b.dataset.credit}/credit-note`, { method: "POST", body: { reason } }); toast("Credit note created — register it to complete the reversal"); renderEInvoices(view); }
    catch (err) { toast(err.message, true); }
  }));
  view.querySelectorAll("[data-view]").forEach((b) => (b.onclick = () => showEInvoice(b.dataset.view)));
}

async function showEInvoice(id) {
  const e = await api(`/einvoices/${id}`);
  const p = e.payload;
  const el = document.getElementById("ei-detail");
  el.innerHTML = `
    <div class="panel print-area">
      <div class="panel-head"><h3>${p.docType === "credit_note" ? "Credit note" : "Tax invoice"} ${esc(p.docNumber)}</h3>
        <button class="btn btn-sm no-print" onclick="window.print()">Print</button></div>
      <div class="panel-body">
        <div class="two-col">
          <div><b>${esc(p.seller.name)}</b><br>TIN ${esc(p.seller.tin)}${p.seller.vatRegNo ? ` · VAT reg ${esc(p.seller.vatRegNo)}` : ""}<br>${esc(p.seller.address ?? "")}<br>Branch: ${esc(p.seller.branchName)} (${esc(p.seller.branchCode)})</div>
          <div><b>Bill to:</b> ${esc(p.buyer.name)}${p.buyer.tin ? `<br>TIN ${esc(p.buyer.tin)}` : ""}<br>Date: ${esc(p.issueDate)}
            ${p.reference ? `<br>Credits ${esc(p.reference.originalDocNumber)}${p.reference.reason ? ` — ${esc(p.reference.reason)}` : ""}` : ""}</div>
        </div>
        ${table(["#", "Item", "Qty", "Unit price", "VAT %", "Net", "VAT", "Total"],
          p.lines.map((l) => [l.n, esc(l.description), num(l.qty), `<span class="num">${money(l.unitPrice)}</span>`, `${Math.round(l.vatRate * 100)}%`, `<span class="num">${money(l.net)}</span>`, `<span class="num">${money(l.vat)}</span>`, `<span class="num">${money(l.total)}</span>`]))}
        <div class="flex-between" style="margin-top:14px;align-items:flex-start">
          <div><div id="ei-qr" style="line-height:0"></div>
            <div class="muted small">Status: ${esc(e.status)}${e.irn ? ` · IRN ${esc(e.irn)}` : ""}${e.registration_mode === "sandbox" ? " · SANDBOX (no legal effect)" : ""}</div></div>
          <table style="max-width:260px"><tbody>
            <tr><td>Net</td><td class="num">${money(p.totals.net)}</td></tr>
            <tr><td>VAT</td><td class="num">${money(p.totals.vat)}</td></tr>
            <tr><td><b>Total</b></td><td class="num"><b>${money(p.totals.total)}</b></td></tr></tbody></table>
        </div>
      </div>
    </div>`;
  const box = document.getElementById("ei-qr");
  try { box.innerHTML = qrSvg(e.qr_data, 3); }
  catch { box.innerHTML = `<code class="small">${esc(e.qr_data)}</code>`; }
  el.scrollIntoView({ behavior: "smooth" });
}

// ================================================================ AI Insights

const SEV = { high: "danger", medium: "warn", low: "muted" };

async function renderAI(view) {
  const [status, insights, forecast, reorder] = await Promise.all([
    api("/ai/status"), api("/ai/insights"), api("/ai/forecast"), api("/ai/reorder"),
  ]);
  const maxClose = Math.max(...forecast.weeks.map((w) => w.closingHigh ?? w.closing), 1);
  const minClose = Math.min(...forecast.weeks.map((w) => w.closingLow ?? w.closing), 0);
  const bar = (w) => {
    const h = (v) => Math.max(2, ((v - minClose) / (maxClose - minClose || 1)) * 90);
    return `<div style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center" title="${esc(w.weekStart)}: ${money(w.closing)}">
      <div style="width:70%;height:${h(w.closing)}px;background:var(--primary);border-radius:3px 3px 0 0"></div>
      <div class="muted" style="font-size:10px;margin-top:3px">${esc(w.weekStart.slice(5))}</div></div>`;
  };

  view.innerHTML = `
    <div class="notice ${status.llmEnabled ? "" : "notice-warn"}">
      ${status.llmEnabled
        ? `<b>Claude is connected</b> (${esc(status.model)}). Questions send a compact summary of your figures — not raw SMS text or bank references — to Anthropic.`
        : `<b>Offline mode.</b> No <code>ANTHROPIC_API_KEY</code> is set, so answers come from built-in rules and statistics. Add the key on your host to enable Claude for chat and low-confidence categorisation.`}
      · The app has learned ${status.learnedWordCategoryPairs} word→category pair(s) from your confirmations.
    </div>

    <div class="panel"><div class="panel-head"><h3>Ask your books</h3></div><div class="panel-body">
      <form id="ask-form" class="flex"><input id="ask-q" style="flex:1" maxlength="500" placeholder="e.g. Which branch earned most this month? What VAT do I owe? Who owes me money?" required />
        <button class="btn btn-primary" type="submit">Ask</button></form>
      <div id="ask-answer" style="margin-top:12px"></div>
    </div></div>

    <div class="two-col">
      <div class="panel"><div class="panel-head"><h3>Needs attention (${insights.count})</h3>
          <button class="btn btn-sm" id="recat">Re-check low-confidence categories</button></div>
        ${insights.items.length ? `<div class="panel-body" style="display:grid;gap:10px">${insights.items.map((i) =>
          `<div>${pill(i.severity, SEV[i.severity])} <b>${esc(i.title)}</b><div class="muted small">${esc(i.detail)}</div></div>`).join("")}</div>`
          : `<div class="empty">Nothing unusual found.</div>`}
      </div>
      <div class="panel"><div class="panel-head"><h3>Cash forecast · next ${forecast.weeks.length} weeks</h3></div><div class="panel-body">
        <div style="display:flex;gap:4px;height:110px;align-items:flex-end">${forecast.weeks.map(bar).join("")}</div>
        <div class="muted small" style="margin-top:8px">Starting cash ${money(forecast.startingCash)}. Bars = projected closing balance; hover for amounts. Projection from your own history plus known payroll and tax dates — an estimate, not a guarantee.</div>
      </div>
      </div>
    </div>

    <div class="panel"><div class="panel-head"><h3>Week-by-week forecast</h3></div>
        ${table(["Week", "In", "Out", "Payroll", "Taxes", "Closing (range)"], forecast.weeks.map((w) => [esc(w.weekStart), `<span class="num">${money(w.expectedIn)}</span>`, `<span class="num">${money(w.expectedOut)}</span>`, `<span class="num">${money(w.payroll)}</span>`, `<span class="num">${money(w.taxes)}</span>`, `<span class="num">${money(w.closing)}</span> <span class="muted small">(${money(w.closingLow)} – ${money(w.closingHigh)})</span>`]))}
    </div>

    <div class="panel"><div class="panel-head"><h3>Reorder suggestions</h3></div>
      ${table(["Product", "Branch", "On hand", "Sells/day", "Days cover", "Lead time", "Suggest", "Est. cost", "Urgency"],
        reorder.suggestions.map((s) => [esc(s.name), esc(s.branchName), num(s.onHand), num(s.dailySales), num(s.daysOfCover), `${s.leadTimeDays}d`, `<b>${num(s.suggestedQty)}</b> ${esc(s.unit)}`, `<span class="num">${money(s.estimatedCost)}</span>`, pill(s.urgency, s.urgency === "urgent" ? "danger" : "warn")]),
        "Stock levels look healthy.")}
    </div>`;

  document.getElementById("ask-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const out = document.getElementById("ask-answer");
    out.textContent = "Thinking…";
    try {
      const r = await api("/ai/ask", { method: "POST", body: { question: document.getElementById("ask-q").value } });
      const t = r.table && r.table.rows?.length
        ? `<div style="margin-top:10px;overflow-x:auto">${table(r.table.columns, r.table.rows.map((row) => row.map((c) => esc(c))))}</div>` : "";
      out.innerHTML = `${esc(r.answer)}${t}${r.note ? `<div class="muted small">${esc(r.note)}</div>` : ""}<div class="muted small" style="margin-top:6px">${r.mode === "llm" ? "Answered by Claude" : "Answered offline"} · scope: ${esc(r.scope ?? "")}</div>`;
    } catch (err) { out.textContent = err.message; }
  });
  document.getElementById("recat").onclick = async () => {
    try {
      const r = await api("/ai/recategorize", { method: "POST" });
      toast(`Checked ${r.examined}: ${r.updatedByLearning} updated from your history, ${r.updatedByLlm} by Claude${r.warning ? ` (${r.warning})` : ""}`);
    } catch (err) { toast(err.message, true); }
  };
}

// ================================================================ Branches & Settings

async function renderBranches(view) {
  const [perf, branches, settings] = await Promise.all([api("/branches/performance"), api("/branches"), api("/settings")]);
  view.innerHTML = `
    <div class="panel"><div class="panel-head"><h3>Branch performance · ${esc(perf.month)}</h3></div>
      ${table(["Branch", "Income", "Expense", "Net", "Invoiced", "Receivables", "Staff", "Payroll cost / mo", "Stock value"],
        perf.branches.map((b) => [`<b>${esc(b.code)}</b> ${esc(b.name)}${b.isHeadOffice ? " " + pill("HQ", "muted") : ""}`,
          `<span class="num">${money(b.income)}</span>`, `<span class="num">${money(b.expense)}</span>`, `<span class="num">${money(b.net)}</span>`,
          `<span class="num">${money(b.invoicedThisMonth)}</span>`, `<span class="num">${money(b.outstandingReceivables)}</span>`, b.employees,
          `<span class="num">${money(b.monthlyPayrollCost)}</span>`, `<span class="num">${money(b.stockValue)}</span>`]))}
    </div>
    <div class="two-col">
      <div class="panel"><div class="panel-head"><h3>Add a branch</h3></div><div class="panel-body">
        <form id="branch-form"><div class="form-grid">
          <div><label>Code (2–10, e.g. HAW)</label><input name="code" required maxlength="10" /></div>
          <div><label>Name</label><input name="name" required /></div>
          <div><label>City</label><input name="city" /></div>
          <div><label>Phone</label><input name="phone" /></div>
        </div><button class="btn btn-primary" type="submit">Add branch</button></form>
        <div class="muted small" style="margin-top:8px">Active: ${branches.filter((b) => b.active).map((b) => esc(b.code)).join(", ")}. Tip: SMS forwarders can send <code>"branch": "CODE"</code> to book a payment to a branch.</div>
      </div></div>
      <div class="panel"><div class="panel-head"><h3>Company profile (used on e-invoices)</h3></div><div class="panel-body">
        <form id="settings-form"><div class="form-grid">
          <div><label>Company name</label><input name="company_name" value="${esc(settings.company_name ?? "")}" /></div>
          <div><label>TIN (10 digits)</label><input name="company_tin" value="${esc(settings.company_tin ?? "")}" pattern="\\d{10}" /></div>
          <div><label>VAT registration no.</label><input name="company_vat_reg_no" value="${esc(settings.company_vat_reg_no ?? "")}" /></div>
          <div><label>Address</label><input name="company_address" value="${esc(settings.company_address ?? "")}" /></div>
          <div><label>Phone</label><input name="company_phone" value="${esc(settings.company_phone ?? "")}" /></div>
        </div><button class="btn btn-primary" type="submit">Save</button></form>
      </div></div>
    </div>`;

  document.getElementById("branch-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try { await api("/branches", { method: "POST", body: Object.fromEntries(new FormData(e.target)) }); toast("Branch added"); await loadBranches(); renderBranches(view); }
    catch (err) { toast(err.message, true); }
  });
  document.getElementById("settings-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try { await api("/settings", { method: "PATCH", body: Object.fromEntries(new FormData(e.target)) }); toast("Company profile saved"); }
    catch (err) { toast(err.message, true); }
  });
}
