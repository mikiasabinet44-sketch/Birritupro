// Birritu Analytics: a full picture of the business, drawn from the books.
// Data comes from GET /api/analytics (and /api/dashboard/summary for the "right now" cards).
// Charts are plain SVG/HTML, no libraries. Relies on helpers from app.js: api, esc, money, card, table, pill, navigate.

const AN = { range: "3" };
const AN_RANGES = [["1", "This month"], ["3", "3 months"], ["6", "6 months"], ["12", "12 months"], ["all", "All time"]];
const AN_C = { in: "#0F5C4A", out: "#E8A33D", ink: "#14201B", grid: "#E4E0D5", muted: "#5B6B63", CBE: "#7B3A9C", TELEBIRR: "#1F7A3D", BOA: "#F2C230", OTHER: "#6F6A58" };
const AN_TAX = { vat: "VAT", withholding: "Withholding tax", income_tax_payroll: "Staff income tax", pension: "Pension" };

function anShort(n) {
  const a = Math.abs(n);
  const f = (v) => v.toFixed(v >= 10 ? 0 : 1).replace(/\.0$/, "");
  return a >= 1e6 ? f(n / 1e6) + "M" : a >= 1e3 ? f(n / 1e3) + "k" : String(Math.round(n));
}
function anNiceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v))), f = v / p;
  return ([1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((s) => f <= s + 1e-9) ?? 10) * p;
}
function anDelta(change, goodWhenUp = true) {
  if (change === null || change === undefined) return `<span class="muted small">no earlier period to compare</span>`;
  const up = change >= 0, good = up === goodWhenUp;
  return `<span class="an-delta ${good ? "good" : "bad"}">${up ? "▲" : "▼"} ${Math.abs(change)}%</span> <span class="muted small">vs earlier period</span>`;
}

// ---- Vertical grouped bars: labels along the bottom, one bar per series per label.
function anBars({ labels, series, height = 230, label }) {
  const W = 640, H = height, L = 46, R = 8, T = 10, B = 26;
  const max = anNiceMax(Math.max(1, ...series.flatMap((s) => s.values)));
  const iw = W - L - R, ih = H - T - B, gw = iw / labels.length;
  const bw = Math.min(26, (gw * 0.7) / series.length);
  const y = (v) => T + ih - (v / max) * ih;
  let g = "";
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i, yy = y(v);
    g += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" stroke="${AN_C.grid}" stroke-width="1"/><text x="${L - 6}" y="${yy + 4}" text-anchor="end" font-size="11" fill="${AN_C.muted}">${anShort(v)}</text>`;
  }
  labels.forEach((lb, i) => {
    const cx = L + gw * i + gw / 2;
    series.forEach((s, k) => {
      const x = cx - (bw * series.length) / 2 + bw * k, v = s.values[i];
      g += `<rect x="${x}" y="${y(v)}" width="${bw - 2}" height="${Math.max(0, T + ih - y(v))}" rx="3" fill="${s.color}"><title>${esc(lb)} · ${esc(s.name)}: ${esc(money(v))}</title></rect>`;
    });
    g += `<text x="${cx}" y="${H - 8}" text-anchor="middle" font-size="12" fill="${AN_C.muted}">${esc(lb)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}" style="width:100%;height:auto;display:block">${g}</svg>`;
}

// ---- Line chart over dates (money in as an area, money out as a line).
function anLines({ labels, series, height = 210, label }) {
  const W = 640, H = height, L = 46, R = 10, T = 10, B = 26;
  const max = anNiceMax(Math.max(1, ...series.flatMap((s) => s.values)));
  const iw = W - L - R, ih = H - T - B, step = iw / Math.max(1, labels.length - 1);
  const x = (i) => L + step * i, y = (v) => T + ih - (v / max) * ih;
  let g = "";
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i, yy = y(v);
    g += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" stroke="${AN_C.grid}"/><text x="${L - 6}" y="${yy + 4}" text-anchor="end" font-size="11" fill="${AN_C.muted}">${anShort(v)}</text>`;
  }
  series.forEach((s) => {
    const pts = s.values.map((v, i) => `${x(i)},${y(v)}`);
    if (s.area) g += `<path d="M${x(0)},${y(0)} L${pts.join(" L")} L${x(s.values.length - 1)},${y(0)} Z" fill="${s.color}" opacity=".12"/>`;
    g += `<polyline points="${pts.join(" ")}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  });
  [0, Math.floor((labels.length - 1) / 2), labels.length - 1].forEach((i) => {
    g += `<text x="${x(i)}" y="${H - 8}" text-anchor="${i === 0 ? "start" : i === labels.length - 1 ? "end" : "middle"}" font-size="12" fill="${AN_C.muted}">${esc(labels[i].slice(5).replace("-", "/"))}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}" style="width:100%;height:auto;display:block">${g}</svg>`;
}

// ---- Horizontal bars as HTML rows (readable on phones, easy to scan).
function anHBars(rows, { color = AN_C.in, empty = "Nothing to show yet.", valueFmt = money, sub } = {}) {
  const live = rows.filter((r) => r.value > 0);
  if (!live.length) return `<div class="empty">${esc(empty)}</div>`;
  const max = Math.max(...live.map((r) => r.value));
  return `<ul class="an-hbars">${live.map((r) => `<li>
      <div class="an-hrow"><span class="an-hname">${esc(r.name)}</span><span class="an-hval">${esc(valueFmt(r.value))}</span></div>
      <div class="an-htrack" aria-hidden="true"><span style="width:${Math.max(2, (r.value / max) * 100)}%;background:${r.color ?? color}"></span></div>
      ${sub && sub(r) ? `<div class="muted small">${esc(sub(r))}</div>` : ""}</li>`).join("")}</ul>`;
}

// Plain number for compact tables (the column heading says ETB).
const anNum = (n) => money(n).replace(/^ETB\s*/, "").replace(/^(-?)ETB\s*/, "$1");

function anLegend(items) {
  return `<ul class="src-legend" style="margin:0 0 10px">${items.map((i) => `<li><span class="src-dot" style="background:${i.color}" aria-hidden="true"></span>${esc(i.label)}</li>`).join("")}</ul>`;
}
function anTile(label, value, sub) { return card(label, value, sub ?? ""); }
function anTileHtml(label, valueHtml, subHtml) { return `<div class="card"><div class="label">${esc(label)}</div><div class="value">${valueHtml}</div><div class="sub">${subHtml}</div></div>`; }
function anPanel(title, body, note) { return `<section class="panel"><div class="panel-head"><h3>${esc(title)}</h3>${note ? `<span class="muted small">${esc(note)}</span>` : ""}</div><div class="panel-body">${body}</div></section>`; }
function anSection(title, sub) { return `<div class="an-section"><h2>${esc(title)}</h2>${sub ? `<p class="muted">${esc(sub)}</p>` : ""}</div>`; }

async function renderAnalytics(view) {
  const [s, a] = await Promise.all([api("/dashboard/summary"), api(`/analytics?range=${AN.range}`)]);
  const t = a.totals, rangeLabel = AN_RANGES.find((r) => r[0] === String(a.range))?.[1] ?? "This period";
  const periodText = a.range === "all" ? "all time" : a.range === 1 ? "this month" : `the last ${a.range} months`;

  const firstData = a.monthly.findIndex((m) => m.income || m.expense);
  const months_ = firstData > 0 ? a.monthly.slice(Math.min(firstData, Math.max(0, a.monthly.length - 3))) : a.monthly;

  const tabs = `<div class="tabs" role="group" aria-label="Time range">${AN_RANGES.map(([id, label]) => `<button type="button" class="tab-btn${String(a.range) === id ? " active" : ""}" data-range="${id}" aria-pressed="${String(a.range) === id}">${esc(label)}</button>`).join("")}</div>`;

  // ---------- Right now (the nine cards that used to sit on Home)
  const rightNow = `
    ${anSection("Right now", `Showing: ${a.scope}. Change branch from the selector in the top bar.`)}
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
    </div>`;

  // ---------- Dashboard headline
  const headline = `
    ${anSection("Dashboard", `How the business did over ${periodText}.`)}
    <div class="grid-cards">
      ${anTileHtml("Money in", `<span style="color:${AN_C.in}">${esc(money(t.income))}</span>`, anDelta(t.incomeChange, true))}
      ${anTileHtml("Money out", esc(money(t.expense)), anDelta(t.expenseChange, false))}
      ${anTileHtml("Profit", `<span style="color:${t.profit >= 0 ? AN_C.in : "#B3402A"}">${esc(money(t.profit))}</span>`, `<span class="muted small">money in minus money out</span>`)}
      ${anTileHtml("Profit margin", t.margin === null ? "—" : `${t.margin}%`, `<span class="muted small">${t.transactions} entries · average money in ${esc(money(t.avgIncome))}</span>`)}
    </div>`;

  // ---------- What stands out
  const lvl = { good: ["ok", "Good"], watch: ["warn", "Watch"], info: ["muted", "Note"] };
  const sev = { high: "danger", medium: "warn", low: "muted" };
  const findings = anPanel("What stands out", a.findings.length
    ? `<ul class="an-find">${a.findings.map((f) => `<li>${pill(lvl[f.level][1], lvl[f.level][0])}<span>${esc(f.text)}</span></li>`).join("")}</ul>`
    : `<div class="empty">Add some entries and findings will appear here.</div>`, "Worked out from your numbers")
    + (a.alerts.length ? anPanel("Things to double-check", `<ul class="an-find">${a.alerts.map((i) => `<li>${pill(i.severity, sev[i.severity] ?? "muted")}<span><b>${esc(i.title)}</b><br><span class="muted small">${esc(i.detail)}</span></span></li>`).join("")}</ul>`, "From the AI checks") : "");

  // ---------- Money over time
  const money_ = `
    ${anSection("Money over time")}
    <div class="two-col an-even">
      ${anPanel("Money in and out by month", anLegend([{ label: "Money in", color: AN_C.in }, { label: "Money out", color: AN_C.out }]) +
        anBars({ labels: months_.map((m) => m.label), series: [{ name: "Money in", color: AN_C.in, values: months_.map((m) => m.income) }, { name: "Money out", color: AN_C.out, values: months_.map((m) => m.expense) }], label: "Money in and money out for each month" }) +
        `<div class="table-wrap" style="margin-top:8px">${table(["Month", "In (ETB)", "Out (ETB)", "Net (ETB)"], a.monthly.filter((m) => m.income || m.expense).map((m) => [esc(m.label), `<span class="num">${anNum(m.income)}</span>`, `<span class="num">${anNum(m.expense)}</span>`, `<span class="num" style="color:${m.net >= 0 ? AN_C.in : "#B3402A"}">${anNum(m.net)}</span>`]), "No entries in these months.")}</div>`)}
      ${anPanel("Last 30 days", anLegend([{ label: "Money in", color: AN_C.in }, { label: "Money out", color: AN_C.out }]) +
        anLines({ labels: a.daily.map((d) => d.date), series: [{ name: "Money in", color: AN_C.in, area: true, values: a.daily.map((d) => d.income) }, { name: "Money out", color: AN_C.out, values: a.daily.map((d) => d.expense) }], label: "Money in and money out for each of the last 30 days" }) +
        `<div class="muted small" style="margin-top:6px">In: ${esc(money(a.daily.reduce((x, d) => x + d.income, 0)))} · Out: ${esc(money(a.daily.reduce((x, d) => x + d.expense, 0)))}</div>`)}
    </div>
    <div class="two-col an-even">
      ${anPanel("Money in by weekday", anBars({ labels: a.weekday.map((w) => w.name), series: [{ name: "Money in", color: AN_C.in, values: a.weekday.map((w) => w.income) }], height: 190, label: "Money in for each day of the week" }), "Which days earn most")}
      ${anPanel("Biggest movements", `<div class="table-wrap">${table(["Date", "What", "ETB"], a.biggest.map((b) => [esc(b.date), `<div class="an-wrap">${esc(b.description)}<div class="muted small">${esc(b.category)}</div></div>`, `<span class="num" style="color:${b.amount >= 0 ? AN_C.in : "#B3402A"}">${anNum(b.amount)}</span>`]), "No entries yet.")}</div>`, "Largest single entries")}
    </div>`;

  // ---------- Where money comes from and goes
  const chTotal = a.channels.reduce((x, c) => x + c.value, 0);
  const flows = `
    ${anSection("Where the money comes from and goes")}
    <div class="two-col an-even">
      ${anPanel("Money in by channel", chTotal > 0
        ? `<div class="src-bar" role="img" aria-label="Share of money in: ${esc(a.channels.map((c) => `${c.label} ${Math.round((c.value / chTotal) * 100)}%`).join(", "))}">${a.channels.filter((c) => c.value > 0).map((c) => `<span style="flex:${c.value};background:${AN_C[c.key]}"></span>`).join("")}</div>` +
          anHBars(a.channels.map((c) => ({ name: c.label, value: c.value, color: AN_C[c.key] })), { sub: (r) => { const c = a.channels.find((x) => x.label === r.name); return `${Math.round((c.value / chTotal) * 100)}% of money in · ${c.count} entr${c.count === 1 ? "y" : "ies"}`; } })
        : `<div class="empty">No money in for this period.</div>`)}
      ${anPanel("Where money goes", anHBars(a.expenseCats, { color: AN_C.out, empty: "No spending in this period.", sub: (r) => `${r.count} entr${r.count === 1 ? "y" : "ies"} · ${t.expense ? Math.round((r.value / t.expense) * 100) : 0}% of money out` }), "Spending by category")}
    </div>
    ${anPanel("What you earn from", anHBars(a.incomeCats, { color: AN_C.in, empty: "No income in this period.", sub: (r) => `${r.count} entr${r.count === 1 ? "y" : "ies"}` }), "Income by category")}`;

  // ---------- Customers & invoices
  const iv = a.invoices;
  const owedTotal = iv.ageing.reduce((x, r) => x + r.value, 0);
  const invoices = `
    ${anSection("Customers and invoices", "Who owes you and how fast you get paid.")}
    <div class="grid-cards">
      ${anTile("Invoiced", money(iv.billed), `${iv.count} invoice${iv.count === 1 ? "" : "s"} in this period`)}
      ${anTile("Collected", money(iv.paid), iv.collectionRate === null ? "—" : `${iv.collectionRate}% of what you invoiced`)}
      ${anTile("Still owed to you", money(iv.outstanding), "All open invoices")}
      ${anTile("Customers", a.customers.total, "On your books")}
    </div>
    <div class="two-col an-even">
      ${anPanel("Who owes you, by how late", owedTotal > 0 ? anHBars(iv.ageing.map((r, i) => ({ name: r.label, value: r.value, color: i === 0 ? AN_C.in : i === 1 ? AN_C.out : "#C2402F" })), { sub: (r) => { const x = iv.ageing.find((q) => q.label === r.name); return `${x.count} invoice${x.count === 1 ? "" : "s"}`; } }) : `<div class="empty">Nobody owes you anything right now.</div>`, "Open invoices")}
      ${anPanel("Top customers", `<div class="table-wrap">${table(["Customer", "Invoices", "Billed (ETB)", "Owed (ETB)"], a.customers.top.map((c) => [`<div class="an-wrap">${esc(c.name)}</div>`, `<span class="num">${c.invoices}</span>`, `<span class="num">${anNum(c.billed)}</span>`, `<span class="num" style="color:${c.owed > 0 ? "#8A4B00" : AN_C.in}">${anNum(c.owed)}</span>`]), "No invoices in this period.")}</div>`, "By amount invoiced")}
    </div>`;

  // ---------- Stock
  const st = a.stock;
  const stock = `
    ${anSection("Stock", "What you hold, what is selling and what to reorder.")}
    <div class="grid-cards">
      ${anTile("Stock value", money(st.value), `${st.itemCount} products`)}
      ${anTile("To reorder", s.reorderCount, "Running low soon")}
      ${anTile("Out of stock", st.outOfStock, "Products with none left")}
      ${anTile("Slow sellers", st.slow.length, st.slow.length ? `${money(st.slow.reduce((x, r) => x + r.tiedUp, 0))} tied up` : "Nothing stuck")}
    </div>
    <div class="two-col an-even">
      ${anPanel("Reorder soon", `<div class="table-wrap">${table(["Product", "Left", "Cover", "Order"], st.lowStock.map((r) => [`<div class="an-wrap">${esc(r.name)}<div class="muted small">${esc(r.branch)}</div></div>`, `<span class="num">${r.onHand}</span>`, r.daysOfCover === null ? "—" : `${pill(Math.round(r.daysOfCover) + " days", r.urgency === "urgent" ? "danger" : "warn")}`, `<span class="num">${r.suggestedQty} ${esc(r.unit)}</span>`]), "Nothing needs reordering.")}</div>`, "Based on how fast each sells")}
      ${anPanel("Best sellers, last 30 days", anHBars(st.sellers.map((r) => ({ name: r.name, value: r.units })), { valueFmt: (v) => v.toLocaleString("en-US") + " sold", empty: "No sales in the last 30 days.", sub: (r) => { const x = st.sellers.find((q) => q.name === r.name); return `About ${money(x.revenue)} of sales`; } }))}
    </div>
    <div class="two-col an-even">
      ${anPanel("Most money held in stock", anHBars(st.topValue.map((r) => ({ name: r.name, value: r.value })), { color: "#3B6E8F", empty: "No stock yet.", sub: (r) => { const x = st.topValue.find((q) => q.name === r.name); return `${x.qty} on hand`; } }))}
      ${anPanel("Slow sellers", `<div class="table-wrap">${table(["Product", "On hand", "Tied up (ETB)", "Last sold"], st.slow.map((r) => [`<div class="an-wrap">${esc(r.name)}<div class="muted small">${esc(r.branch)}</div></div>`, `<span class="num">${r.onHand}</span>`, `<span class="num">${anNum(r.tiedUp)}</span>`, r.daysSinceLastSale === null ? "Never" : `${r.daysSinceLastSale} days ago`]), "No slow sellers.")}</div>`)}
    </div>`;

  // ---------- Staff pay
  const p = a.payroll;
  const payroll = `
    ${anSection("Staff pay")}
    <div class="grid-cards">
      ${anTile("Staff", p.staff, "Active on payroll")}
      ${anTile("Monthly pay bill", money(p.monthlyGross), "Salaries and allowances")}
      ${anTile("Average basic salary", money(p.avgBasic), "Per person")}
      ${anTile("Share of money in", p.payrollShareOfIncome === null ? "—" : p.payrollShareOfIncome + "%", "Pay bill compared with money in")}
    </div>
    <div class="two-col an-even">
      ${anPanel("Pay runs", p.runs.length ? anBars({ labels: p.runs.map((r) => r.label), series: [{ name: "Gross pay", color: AN_C.in, values: p.runs.map((r) => r.gross) }, { name: "Take home", color: "#6FB59F", values: p.runs.map((r) => r.net) }], height: 200, label: "Gross pay and take-home pay for each pay run" }) : `<div class="empty">No pay runs yet. Run your first one on the Staff pay page.</div>`)}
      ${anPanel("Pay bill by branch", `<div class="table-wrap">${table(["Branch", "Staff", "Monthly pay (ETB)"], p.byBranch.map((r) => [esc(r.name), `<span class="num">${r.staff}</span>`, `<span class="num">${anNum(r.gross)}</span>`]), "No staff yet.")}</div>`)}
    </div>`;

  // ---------- Taxes
  const tx = a.tax;
  const days = (d) => (d === null ? "" : d < 0 ? `${Math.abs(d)} days late` : d === 0 ? "today" : `in ${d} days`);
  const taxes = `
    ${anSection("Taxes")}
    <div class="grid-cards">
      ${anTile("Waiting to be filed", money(tx.due), "All pending filings")}
      ${anTile("Already filed or paid", money(tx.settled), "Recent filings")}
    </div>
    <div class="two-col an-even">
      ${anPanel("By type", anHBars(tx.byType.map((r) => ({ name: AN_TAX[r.type] ?? r.type, value: r.value })), { color: "#8A6A2F", empty: "No tax figures yet." }))}
      ${anPanel("Filings", `<div class="table-wrap">${table(["Tax", "Period", "ETB", "Due"], tx.filings.map((f) => [esc(AN_TAX[f.type] ?? f.type), esc(f.period), `<span class="num">${anNum(f.amount)}</span>`, f.status === "due" ? pill(days(f.daysLeft) || "due", f.daysLeft !== null && f.daysLeft < 0 ? "danger" : "warn") : pill(f.status, "ok")]), "No filings yet.")}</div>`)}
    </div>`;

  // ---------- Branches
  const branches = a.branches.length > 1 ? `
    ${anSection("Branches side by side", `Same period (${periodText}), every branch.`)}
    ${anPanel("Branch comparison (amounts in ETB)", `<div class="table-wrap">${table(["Branch", "Money in", "Money out", "Net", "Owed to you", "Stock value"], a.branches.map((b) => [`<b>${esc(b.name)}</b>`, `<span class="num">${anNum(b.income)}</span>`, `<span class="num">${anNum(b.expense)}</span>`, `<span class="num" style="color:${b.net >= 0 ? AN_C.in : "#B3402A"}">${anNum(b.net)}</span>`, `<span class="num">${anNum(b.owed)}</span>`, `<span class="num">${anNum(b.stockValue)}</span>`]))}</div>`)}` : "";

  view.innerHTML = `
    <div class="an-top"><div><div class="muted small">Showing <b>${esc(rangeLabel)}</b> · ${esc(a.scope)}</div></div>${tabs}</div>
    ${rightNow}
    ${headline}
    ${findings}
    ${money_}
    ${flows}
    ${invoices}
    ${stock}
    ${payroll}
    ${taxes}
    ${branches}
    <div class="muted small" style="margin:8px 2px 0">Every figure here comes from your own entries. Nothing is estimated except the reorder advice, which uses how fast each product has been selling.</div>`;

  view.querySelectorAll("[data-range]").forEach((b) => b.addEventListener("click", () => {
    if (AN.range === b.dataset.range) return;
    AN.range = b.dataset.range; renderAnalytics(view).catch((e) => { view.innerHTML = `<div class="empty">Couldn't load analytics: ${esc(e.message)}</div>`; });
  }));
}
