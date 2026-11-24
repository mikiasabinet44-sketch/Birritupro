// Sales: bills for restaurants / hotels / shops, the cash drawer, and the POS connection.
const SL = { tab: "bills", lines: [{}] };
const SL_METHODS = [["cash", "Cash"], ["telebirr", "Telebirr"], ["cbe", "CBE"], ["boa", "BOA"], ["card", "Card"]];
const SL_LABEL = Object.fromEntries(SL_METHODS);
const slMoney = (n) => money(n);
const slTime = (s) => (s ? String(s).slice(0, 16).replace("T", " ") : "");

async function renderSales(view) {
  document.getElementById("page-actions").innerHTML = "";
  const tabs = [["bills", "Bills"], ["drawer", "Cash drawer"], ["pos", "POS connection"]];
  view.innerHTML = `<div class="tabs" role="group" aria-label="Sales sections">${tabs.map(([id, l]) =>
    `<button type="button" class="tab-btn${SL.tab === id ? " active" : ""}" data-sltab="${id}" aria-pressed="${SL.tab === id}">${l}</button>`).join("")}</div><div id="sl-body"></div>`;
  view.querySelectorAll("[data-sltab]").forEach((b) => (b.onclick = () => { SL.tab = b.dataset.sltab; renderSales(view); }));
  const body = document.getElementById("sl-body");
  try {
    if (SL.tab === "drawer") await slDrawer(body, view);
    else if (SL.tab === "pos") await slPos(body);
    else await slBills(body, view);
  } catch (e) { body.innerHTML = `<div class="panel"><div class="empty">${esc(e.message)}</div></div>`; }
}

// ------------------------------------------------------------------ Bills

async function slBills(el, view) {
  const [sum, bills, drawer, products] = await Promise.all([api("/sales/summary"), api("/sales"), api("/sales/drawer"), api("/inventory/products").catch(() => [])]);
  const open = bills.filter((b) => b.status === "open");
  const recent = bills.filter((b) => b.status !== "open").slice(0, 25);
  const cashToday = sum.byMethod.find((m) => m.method === "cash")?.total ?? 0;
  const otherToday = sum.byMethod.filter((m) => m.method !== "cash").reduce((s, m) => s + m.total, 0);
  const re = () => renderSales(view);

  const lineRow = (l, i) => `<div class="sl-line" data-i="${i}">
      <input class="sl-name" list="sl-products" placeholder="Item (type or pick)" value="${esc(l.description ?? "")}" aria-label="Item ${i + 1}">
      <input class="sl-qty" type="number" min="0.01" step="any" value="${l.qty ?? 1}" aria-label="Quantity">
      <input class="sl-price" type="number" min="0" step="any" placeholder="Price" value="${l.unitPrice ?? ""}" aria-label="Price each">
      <button type="button" class="btn btn-sm" data-rm="${i}" aria-label="Remove item ${i + 1}">&times;</button></div>`;

  el.innerHTML = `
    <div class="grid-cards">
      ${card("Sold today", `<span class="num">${slMoney(sum.total)}</span>`, `${sum.count} bill${sum.count === 1 ? "" : "s"} paid`)}
      ${card("Cash today", `<span class="num">${slMoney(cashToday)}</span>`, drawer.open ? "Drawer is open" : "Drawer is closed")}
      ${card("Bank & wallet", `<span class="num">${slMoney(otherToday)}</span>`, "Telebirr, CBE, BOA, card")}
      ${card("Open bills", `<span class="num">${slMoney(sum.open.total)}</span>`, `${sum.open.n} unpaid${sum.waiting.n ? ` · ${sum.waiting.n} waiting for a bank message` : ""}${sum.voids.n ? ` · ${sum.voids.n} voided today` : ""}`)}
    </div>
    <div class="panel"><div class="panel-head"><h3>New bill</h3><span class="small muted">Recorded for ${esc(drawer.branch)}</span></div>
      <div class="panel-body">
        <datalist id="sl-products">${products.map((p) => `<option value="${esc(p.name)}">`).join("")}</datalist>
        <div class="form-grid"><div><label>Table, room or name</label><input id="sl-table" placeholder="Table 4"></div>
          <div><label>Customer (optional)</label><input id="sl-cust" placeholder="Walk-in"></div></div>
        <div id="sl-lines">${SL.lines.map(lineRow).join("")}</div>
        <div class="flex" style="gap:10px;margin:8px 0 12px;flex-wrap:wrap;align-items:center">
          <button type="button" class="btn btn-sm" id="sl-add">+ Add item</button>
          <label class="flex small" style="gap:6px;align-items:center"><input type="checkbox" id="sl-incl" style="width:auto"> Prices already include 15% VAT</label>
          <b class="num" id="sl-total" style="margin-left:auto">${slMoney(0)}</b></div>
        <div class="flex" style="gap:8px;flex-wrap:wrap;align-items:center">
          <select id="sl-method" aria-label="How the customer pays">${SL_METHODS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select>
          <button type="button" class="btn btn-primary" id="sl-charge">Charge &amp; close</button>
          <button type="button" class="btn" id="sl-save">Save as open bill</button></div>
        <div class="muted small" style="margin-top:8px">Cash is booked at once. Telebirr, CBE and BOA wait for the real bank message and close the bill by themselves when it arrives.</div>
      </div></div>
    <div class="panel"><div class="panel-head"><h3>Open bills</h3><span class="small muted">Not paid yet</span></div>
      <div class="table-wrap">${table(["Bill", "Table", "Items", "Total", "Status", "Take payment"], open.map((b) => [
        `<b>${esc(b.number)}</b><div class="muted small">${esc(slTime(b.created_at))}${b.source === "pos" ? " · from POS" : ""}</div>`,
        esc(b.table_label ?? "—"),
        `<div class="an-wrap">${esc(b.lines.map((l) => `${l.qty}× ${l.description}`).join(", "))}</div>`,
        `<span class="num">${slMoney(b.total)}</span>`,
        b.payment_method && b.payment_method !== "cash" && b.payment_method !== "card" ? pill(`Waiting for ${SL_LABEL[b.payment_method]} message`, "warn") : pill("Unpaid", "muted"),
        `<div class="flex" style="gap:6px;flex-wrap:wrap">${SL_METHODS.map(([v, l]) => `<button class="btn btn-sm" data-pay="${b.id}" data-m="${v}">${l}</button>`).join("")}
          ${b.payment_method && !["cash", "card"].includes(b.payment_method) ? `<button class="btn btn-sm btn-primary" data-confirm="${b.id}" data-m="${b.payment_method}">I saw it arrive</button>` : ""}
          <button class="btn btn-sm btn-danger" data-void="${b.id}">Void</button></div>`,
      ]), "No open bills.")}</div></div>
    <div class="panel"><div class="panel-head"><h3>Recent bills</h3></div>
      <div class="table-wrap">${table(["Bill", "Table", "Total", "Paid with", "When", ""], recent.map((b) => [
        `<b>${esc(b.number)}</b>${b.source === "pos" ? `<div class="muted small">from POS</div>` : ""}`, esc(b.table_label ?? "—"),
        `<span class="num">${slMoney(b.total)}</span>`,
        b.status === "void" ? `${pill("Voided", "danger")}<div class="muted small">${esc(b.void_reason ?? "")}</div>` : esc(SL_LABEL[b.payment_method] ?? "—"),
        esc(slTime(b.paid_at ?? b.voided_at ?? b.created_at)),
        b.status === "paid" && b.payment_method === "cash" ? `<button class="btn btn-sm btn-danger" data-void="${b.id}">Void &amp; refund</button>` : "",
      ]), "No bills yet.")}</div></div>`;

  // ---- new bill form
  const readLines = () => [...el.querySelectorAll(".sl-line")].map((r) => ({
    description: r.querySelector(".sl-name").value.trim(), qty: Number(r.querySelector(".sl-qty").value) || 0, unitPrice: r.querySelector(".sl-price").value === "" ? undefined : Number(r.querySelector(".sl-price").value),
  }));
  const byName = new Map(products.map((p) => [p.name.toLowerCase(), p]));
  const retotal = () => {
    const incl = el.querySelector("#sl-incl").checked;
    let t = 0;
    for (const l of readLines()) {
      const p = byName.get(l.description.toLowerCase());
      const price = l.unitPrice ?? p?.sell_price ?? 0, rate = p ? p.vat_rate : 0.15;
      t += l.qty * price * (incl ? 1 : 1 + rate);
    }
    el.querySelector("#sl-total").textContent = slMoney(Math.round(t * 100) / 100);
  };
  el.querySelector("#sl-lines").addEventListener("input", (e) => {
    const row = e.target.closest(".sl-line");
    if (e.target.classList.contains("sl-name") && row) {
      const p = byName.get(e.target.value.toLowerCase());
      const pr = row.querySelector(".sl-price");
      if (p && pr.value === "") pr.value = p.sell_price;
    }
    retotal();
  });
  el.querySelector("#sl-incl").onchange = retotal;
  el.querySelector("#sl-add").onclick = () => { SL.lines = readLines(); SL.lines.push({}); re(); };
  el.querySelectorAll("[data-rm]").forEach((b) => (b.onclick = () => { SL.lines = readLines(); SL.lines.splice(Number(b.dataset.rm), 1); if (!SL.lines.length) SL.lines = [{}]; re(); }));
  const submit = async (payNow) => {
    const lines = readLines().filter((l) => l.description && l.qty > 0);
    if (!lines.length) return toast("Add at least one item with a quantity", true);
    const method = el.querySelector("#sl-method").value;
    try {
      const r = await api("/sales", { method: "POST", body: { table: el.querySelector("#sl-table").value, customerName: el.querySelector("#sl-cust").value, lines, pricesIncludeVat: el.querySelector("#sl-incl").checked, payNow, paymentMethod: method } });
      toast(r.status === "paid" ? `${r.number} paid · ${slMoney(r.total)}` : payNow ? `${r.number} saved. Waiting for the ${SL_LABEL[method]} message.` : `${r.number} saved as an open bill`);
      SL.lines = [{}];
      re();
    } catch (e) { toast(e.message, true); }
  };
  el.querySelector("#sl-charge").onclick = () => submit(true);
  el.querySelector("#sl-save").onclick = () => submit(false);
  retotal();

  // ---- pay / void
  el.querySelectorAll("[data-pay]").forEach((b) => (b.onclick = async () => {
    const m = b.dataset.m;
    try {
      const r = await api(`/sales/${b.dataset.pay}/pay`, { method: "POST", body: { method: m, waitForBank: !["cash", "card"].includes(m) } });
      toast(r.status === "paid" ? "Bill paid" : `Waiting for the ${SL_LABEL[m]} message`);
      re();
    } catch (e) { toast(e.message, true); }
  }));
  el.querySelectorAll("[data-confirm]").forEach((b) => (b.onclick = async () => {
    try { await api(`/sales/${b.dataset.confirm}/pay`, { method: "POST", body: { method: b.dataset.m } }); toast("Bill paid"); re(); } catch (e) { toast(e.message, true); }
  }));
  el.querySelectorAll("[data-void]").forEach((b) => (b.onclick = async () => {
    const reason = prompt("Why is this bill being voided? (kept for your records)");
    if (reason === null) return;
    try { await api(`/sales/${b.dataset.void}/void`, { method: "POST", body: { reason } }); toast("Bill voided"); re(); } catch (e) { toast(e.message, true); }
  }));
}

// ------------------------------------------------------------------ Cash drawer

async function slDrawer(el, view) {
  const d = await api("/sales/drawer");
  const re = () => renderSales(view);
  const hist = table(["Closed", "Expected", "Counted", "Difference"], d.history.map((s) => [
    esc(slTime(s.closed_at)), `<span class="num">${slMoney(s.expected)}</span>`, `<span class="num">${slMoney(s.counted)}</span>`,
    Math.abs(s.variance) < 1 ? pill("Matches", "ok") : pill(`${s.variance < 0 ? "Short" : "Over"} ${slMoney(Math.abs(s.variance))}`, Math.abs(s.variance) >= 500 ? "danger" : "warn"),
  ]), "No closed drawers yet.");

  if (!d.open) {
    el.innerHTML = `<div class="panel"><div class="panel-head"><h3>Cash drawer · ${esc(d.branch)}</h3></div><div class="panel-body">
        <p class="muted">Open the drawer when the shift starts and count the cash already in it. Every cash bill is then added to what the drawer should hold, and at the end of the shift you count it and see any difference.</p>
        <form id="dr-open" class="flex" style="gap:8px;flex-wrap:wrap;align-items:flex-end">
          <div><label>Cash in the drawer now (ETB)</label><input type="number" min="0" step="any" name="float" value="0" required></div>
          <button class="btn btn-primary" type="submit">Open drawer</button></form></div></div>
      <div class="panel"><div class="panel-head"><h3>Past shifts</h3></div><div class="table-wrap">${hist}</div></div>`;
    el.querySelector("#dr-open").onsubmit = async (e) => {
      e.preventDefault();
      try { await api("/sales/drawer/open", { method: "POST", body: { float: Number(new FormData(e.target).get("float")) } }); toast("Drawer open"); re(); } catch (er) { toast(er.message, true); }
    };
    return;
  }
  const o = d.open;
  const out = o.events.filter((x) => x.amount < 0).reduce((s, x) => s + x.amount, 0);
  const inn = o.events.filter((x) => x.amount > 0).reduce((s, x) => s + x.amount, 0);
  el.innerHTML = `
    <div class="grid-cards">
      ${card("Opening cash", `<span class="num">${slMoney(o.opening_float)}</span>`, `Opened ${slTime(o.opened_at)}`)}
      ${card("Cash sales", `<span class="num">${slMoney(o.cashSales)}</span>`, `${o.cashSaleCount} bill${o.cashSaleCount === 1 ? "" : "s"}`)}
      ${card("Paid out / dropped", `<span class="num">${slMoney(Math.abs(out))}</span>`, inn ? `plus ${slMoney(inn)} added` : "Payouts, drops, refunds")}
      ${card("Should be in the drawer", `<span class="num">${slMoney(o.expected)}</span>`, "What the count should match")}
    </div>
    <div class="panel"><div class="panel-head"><h3>Cash out of the drawer</h3><span class="small muted">${esc(d.branch)}</span></div><div class="panel-body">
      <form id="dr-ev" class="form-grid">
        <div><label>What happened</label><select name="type"><option value="payout">Paid for something in cash</option><option value="drop">Moved cash to the safe / bank</option><option value="add">Added cash (change money)</option></select></div>
        <div><label>Amount (ETB)</label><input type="number" min="0.01" step="any" name="amount" required></div>
        <div style="grid-column:1/-1"><label>Note</label><input name="note" placeholder="e.g. Bought onions at the market"></div></form>
      <button class="btn" id="dr-add">Record</button>
      <div class="muted small" style="margin-top:8px">A cash payout is also added to Money in &amp; out as an expense, so you do not enter it twice.</div></div></div>
    <div class="panel"><div class="panel-head"><h3>This shift</h3></div><div class="table-wrap">${table(["Time", "What", "Note", "Amount"], o.events.map((x) => [
      esc(slTime(x.created_at)), esc({ payout: "Paid out", drop: "Moved to safe", refund: "Refund", add: "Cash added" }[x.type]), `<div class="an-wrap">${esc(x.note ?? "")}</div>`,
      `<span class="num" style="color:${x.amount < 0 ? "#B3402A" : "#0F5C4A"}">${slMoney(x.amount)}</span>`]), "Nothing taken out yet.")}</div></div>
    <div class="panel"><div class="panel-head"><h3>Close the drawer</h3></div><div class="panel-body">
      <p class="muted">Count all the cash in the drawer and type the total. The app compares it with ${slMoney(o.expected)}.</p>
      <form id="dr-close" class="flex" style="gap:8px;flex-wrap:wrap;align-items:flex-end">
        <div><label>Cash counted (ETB)</label><input type="number" min="0" step="any" name="counted" required></div>
        <div style="min-width:220px;flex:1"><label>Note (optional)</label><input name="note" placeholder="e.g. 50 birr note torn"></div>
        <button class="btn btn-primary" type="submit">Close drawer</button></form>
      <div id="dr-result"></div></div></div>
    <div class="panel"><div class="panel-head"><h3>Past shifts</h3></div><div class="table-wrap">${hist}</div></div>`;
  el.querySelector("#dr-add").onclick = async () => {
    const fd = new FormData(el.querySelector("#dr-ev"));
    try { await api("/sales/drawer/event", { method: "POST", body: { type: fd.get("type"), amount: Number(fd.get("amount")), note: fd.get("note") } }); toast("Recorded"); re(); } catch (e) { toast(e.message, true); }
  };
  el.querySelector("#dr-close").onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    if (!confirm("Close the drawer now? This ends the shift.")) return;
    try {
      const r = await api("/sales/drawer/close", { method: "POST", body: { counted: Number(fd.get("counted")), note: fd.get("note") } });
      const ok = Math.abs(r.variance) < 1;
      el.querySelector("#dr-result").innerHTML = `<div class="sl-result ${ok ? "sl-ok" : "sl-bad"}"><b>${ok ? "The cash matches." : r.variance < 0 ? `Short by ${slMoney(Math.abs(r.variance))}` : `Over by ${slMoney(r.variance)}`}</b>
        <div class="small">Expected ${slMoney(r.expected)} · counted ${slMoney(r.counted)}.${r.openBills ? ` ${r.openBills} bill${r.openBills === 1 ? " is" : "s are"} still open.` : ""}</div>
        <button class="btn btn-sm" id="dr-again" style="margin-top:8px">Done</button></div>`;
      el.querySelector("#dr-again").onclick = re;
    } catch (er) { toast(er.message, true); }
  };
}

// ------------------------------------------------------------------ POS connection

async function slPos(el) {
  const bills = (await api("/sales")).filter((b) => b.source === "pos").slice(0, 15);
  const base = location.origin;
  const sample = `curl -X POST ${base}/api/v1/sales \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "externalId": "POS-1042",
    "table": "Table 4",
    "paymentMethod": "cash",
    "items": [
      { "name": "Tibs", "qty": 2, "unitPrice": 300 },
      { "name": "Coffee", "qty": 3, "unitPrice": 40 }
    ]
  }'`;
  el.innerHTML = `
    <div class="panel"><div class="panel-head"><h3>Connect your till or POS</h3></div><div class="panel-body">
      <p>Any till, restaurant system or hotel front-desk system that can send a web request can report its sales here. Each bill it closes appears in Birritu as a sale. Nobody types it in again.</p>
      <ol class="sl-steps">
        <li><b>Make a key.</b> Open <a href="#branches" data-go="branches">Branches &amp; settings</a>, go to API access, and create a key with the <code>sales:write</code> permission. Pick a branch if the till belongs to one place.</li>
        <li><b>Send each closed bill</b> to <code>${esc(base)}/api/v1/sales</code> with the key in the Authorization header.</li>
        <li><b>Set <code>paymentMethod</code></b> to <code>cash</code>, <code>telebirr</code>, <code>cbe</code>, <code>boa</code>, <code>card</code> or <code>unpaid</code>.</li>
      </ol>
      <pre class="sl-code" tabindex="0">${esc(sample)}</pre>
      <button class="btn btn-sm" id="sl-copy">Copy example</button></div></div>
    <div class="panel"><div class="panel-head"><h3>What happens to each bill</h3></div><div class="panel-body">
      <ul class="sl-list">
        <li><b>Cash</b> is booked as income straight away and added to the cash drawer if one is open.</li>
        <li><b>Telebirr, CBE or BOA</b> waits for the real message from the bank or wallet. When a message arrives for the same amount, the bill closes by itself and the money is counted once. If the message came first, the bill closes the moment the POS sends it.</li>
        <li><b>Two bills with the same amount?</b> Put the bill number in the payment reference, or the app leaves them for you to close by hand.</li>
        <li><b>Sending the same <code>externalId</code> twice</b> changes nothing, so a retry never double-counts.</li>
        <li>Item names matching a product in Stock (by <code>sku</code>) also take that item out of stock.</li>
      </ul></div></div>
    <div class="panel"><div class="panel-head"><h3>Latest bills from POS</h3></div><div class="table-wrap">${table(["Bill", "POS id", "Total", "Status", "When"], bills.map((b) => [
      `<b>${esc(b.number)}</b>`, esc(b.external_id ?? ""), `<span class="num">${slMoney(b.total)}</span>`,
      b.status === "paid" ? pill(`Paid · ${SL_LABEL[b.payment_method] ?? ""}`, "ok") : b.status === "void" ? pill("Voided", "danger") : pill(b.payment_method ? "Waiting for bank message" : "Unpaid", "warn"), esc(slTime(b.created_at))]),
      "Nothing has come from a POS yet.")}</div></div>`;
  el.querySelector("#sl-copy").onclick = () => navigator.clipboard?.writeText(sample).then(() => toast("Example copied")).catch(() => {});
  el.querySelectorAll("[data-go]").forEach((a) => (a.onclick = (e) => { e.preventDefault(); navigate(a.dataset.go); }));
}
