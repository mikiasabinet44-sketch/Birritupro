// Birritu copilot and Home panels.
//  - sourcesPanelHtml / bindSources : "Where your money comes from" (CBE, Telebirr, BOA, other entries)
//  - todayPanelHtml / askBarHtml    : the "Today" briefing and a quick ask box for the Home page
//  - the copilot drawer             : a chat available on every page; reads the books, never changes them.
// Relies on helpers from app.js (api, esc, money, table, navigate), resolved at call time.

const SRC_COLORS = { CBE: "src-cbe", TELEBIRR: "src-tele", BOA: "src-boa", OTHER: "src-other" };
const SUGGESTIONS = ["Who paid me today?", "Which channel brings in the most money?", "Who owes me money?", "What needs my attention?", "What should I reorder?"];

function timeAgo(s) {
  if (!s) return "";
  const t = new Date(String(s).replace(" ", "T") + (String(s).includes("Z") || String(s).includes("+") ? "" : "Z")).getTime();
  if (!Number.isFinite(t)) return "";
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

// ------------------------------------------------------------------ Home: where the money comes from

function sourcesBodyHtml(src) {
  const periodLabel = src.period === "all" ? "all time" : new Date(src.period + "-01T00:00:00Z").toLocaleString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  const segs = [
    ...src.sources.filter((s) => s.inflow > 0).map((s) => ({ key: s.provider, label: s.label, v: s.inflow, pct: s.sharePct })),
    ...(src.other.inflow > 0 ? [{ key: "OTHER", label: "Cash, invoices & other", v: src.other.inflow, pct: src.other.sharePct }] : []),
  ];
  const barLabel = segs.map((s) => `${s.label} ${s.pct}%`).join(", ");

  const bar = src.totalIn > 0
    ? `<div class="src-bar" role="img" aria-label="Share of money in: ${esc(barLabel)}">${segs.map((s) => `<span class="${SRC_COLORS[s.key] ?? "src-other"}" style="flex:${Math.max(s.v, 0.0001)}"></span>`).join("")}</div>
       <ul class="src-legend">${segs.map((s) => `<li><span class="src-dot ${SRC_COLORS[s.key] ?? "src-other"}" aria-hidden="true"></span>${esc(s.label)} <b>${s.pct}%</b></li>`).join("")}</ul>`
    : `<div class="empty">No money has come in for ${esc(periodLabel)} yet.</div>`;

  const cards = src.sources.map((s) => {
    const cls = SRC_COLORS[s.provider] ?? "src-other";
    const empty = s.count === 0;
    return `<div class="src-card">
      <div class="src-head"><span class="src-badge ${cls}" aria-hidden="true">${esc(s.provider === "TELEBIRR" ? "Tb" : s.label.slice(0, 3))}</span>
        <div style="min-width:0"><div class="src-name">${esc(s.label)}</div>${s.fullName !== s.label ? `<div class="muted small">${esc(s.fullName)}</div>` : ""}</div></div>
      ${empty
        ? `<div class="src-amount muted">No payments</div><div class="muted small">Nothing received through ${esc(s.label)} for ${esc(periodLabel)}.</div>`
        : `<div class="src-amount">${money(s.inflow)}</div>
           <div class="muted small">money in · ${s.count} payment${s.count === 1 ? "" : "s"} · ${s.sharePct}% of all money in</div>
           ${s.outflow > 0 ? `<div class="small" style="margin-top:6px">Paid out: <b>${money(s.outflow)}</b></div>` : ""}
           ${s.topPayers.length ? `<div class="small" style="margin-top:6px"><span class="muted">Top senders:</span> ${s.topPayers.map((p) => esc(p.name)).join(", ")}</div>` : ""}
           <div class="src-foot"><span class="muted small">Last ${esc(timeAgo(s.lastAt))}</span>${s.needsReview > 0 ? ` <span class="pill pill-warn">${s.needsReview} to review</span>` : ""}</div>`}
    </div>`;
  }).join("");

  const o = src.other;
  const otherCard = `<div class="src-card">
      <div class="src-head"><span class="src-badge src-other" aria-hidden="true">+</span>
        <div style="min-width:0"><div class="src-name">Other entries</div><div class="muted small">${esc(o.label)}</div></div></div>
      ${o.count === 0 ? `<div class="src-amount muted">None</div>` : `<div class="src-amount">${money(o.inflow)}</div>
        <div class="muted small">money in · ${o.count} entr${o.count === 1 ? "y" : "ies"} · ${o.sharePct}% of all money in</div>`}
    </div>`;

  return `<div class="src-total"><span class="src-total-num">${money(src.totalIn)}</span><span class="muted"> came in · ${esc(periodLabel)} · ${esc(src.scope)}</span></div>
    ${bar}<div class="src-grid">${cards}${otherCard}</div>`;
}

function sourcesPanelHtml(src) {
  return `<section class="panel" id="sources-panel" aria-labelledby="sources-title">
    <div class="panel-head"><h3 id="sources-title">Where your money comes from</h3>
      <div class="tabs" role="group" aria-label="Period" style="margin:0">
        <button type="button" class="tab-btn active" data-period="month" aria-pressed="true">This month</button>
        <button type="button" class="tab-btn" data-period="all" aria-pressed="false">All time</button></div></div>
    <div class="panel-body" id="sources-body">${sourcesBodyHtml(src)}</div></section>`;
}

function bindSources(root) {
  root.querySelectorAll("#sources-panel [data-period]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      root.querySelectorAll("#sources-panel [data-period]").forEach((b) => {
        const on = b === btn;
        b.classList.toggle("active", on);
        b.setAttribute("aria-pressed", String(on));
      });
      const body = root.querySelector("#sources-body");
      body.setAttribute("aria-busy", "true");
      try {
        const period = btn.dataset.period === "all" ? "all" : new Date().toISOString().slice(0, 7);
        body.innerHTML = sourcesBodyHtml(await api(`/home/sources?period=${period}`));
      } catch (err) { body.innerHTML = `<div class="empty">Couldn't load: ${esc(err.message)}</div>`; }
      body.removeAttribute("aria-busy");
    });
  });
}

// ------------------------------------------------------------------ Home: today + ask bar

function levelPill(level) {
  return level === "urgent" ? `<span class="pill pill-danger">Urgent</span>` : level === "attention" ? `<span class="pill pill-warn">Check</span>` : "";
}

function todayPanelHtml(brief) {
  const rows = brief.items.map((it, i) => `<li class="brief-item">
      <div class="brief-text">${levelPill(it.level)} ${esc(it.text)}</div>
      <div class="brief-actions">${it.route ? `<button type="button" class="btn btn-sm" data-go="${esc(it.route)}">Open</button>` : ""}${it.ask ? `<button type="button" class="btn btn-sm" data-ask="${esc(it.ask)}">Ask Birritu</button>` : ""}</div></li>`).join("");
  return `<section class="panel" aria-labelledby="today-title">
    <div class="panel-head"><h3 id="today-title">Today</h3><span class="muted small">${esc(brief.headline)}</span></div>
    <ul class="brief-list">${rows || `<li class="empty">Nothing to show yet.</li>`}</ul></section>`;
}

function askBarHtml() {
  return `<section class="panel" aria-labelledby="askbar-title">
    <div class="panel-head"><h3 id="askbar-title">Ask Birritu</h3><span class="muted small">Answers come from your own records</span></div>
    <div class="panel-body">
      <form id="home-ask" class="flex"><label for="home-ask-q" class="sr-only">Your question</label>
        <input id="home-ask-q" style="flex:1" maxlength="500" placeholder="Who paid me today?" autocomplete="off" required />
        <button class="btn btn-primary" type="submit">Ask</button></form>
      <div class="chips" style="margin-top:12px">${SUGGESTIONS.slice(0, 4).map((q) => `<button type="button" class="chip" data-ask="${esc(q)}">${esc(q)}</button>`).join("")}</div>
    </div></section>`;
}

function bindHomeCopilot(root) {
  root.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => navigate(b.dataset.go)));
  root.querySelectorAll("[data-ask]").forEach((b) => b.addEventListener("click", () => openCopilot(b.dataset.ask)));
  const f = root.querySelector("#home-ask");
  if (f) f.addEventListener("submit", (e) => { e.preventDefault(); const i = f.querySelector("input"); const q = i.value.trim(); i.value = ""; if (q) openCopilot(q); });
}

// ------------------------------------------------------------------ The copilot drawer

const Copilot = { log: [], briefing: null, built: false };
try { Copilot.log = JSON.parse(sessionStorage.getItem("copilot-log") ?? "[]"); } catch { Copilot.log = []; }
function saveLog() { try { sessionStorage.setItem("copilot-log", JSON.stringify(Copilot.log.slice(-30))); } catch { /* ignore */ } }

function buildCopilot() {
  if (Copilot.built) return;
  Copilot.built = true;
  const launch = document.createElement("button");
  launch.type = "button"; launch.id = "copilot-launch"; launch.className = "copilot-launch";
  launch.setAttribute("aria-controls", "copilot-panel"); launch.setAttribute("aria-expanded", "false");
  launch.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z"/></svg><span>Ask Birritu</span>`;
  const panel = document.createElement("aside");
  panel.id = "copilot-panel"; panel.className = "copilot"; panel.hidden = true;
  panel.setAttribute("aria-label", "Birritu copilot");
  panel.innerHTML = `
    <div class="copilot-head"><div><div class="copilot-title">Ask Birritu</div><div class="muted small" id="copilot-scope">Your books, in plain words</div></div>
      <div class="flex"><button type="button" class="btn btn-sm" id="copilot-clear">Clear</button><button type="button" class="btn btn-sm" id="copilot-close" aria-label="Close copilot">Close</button></div></div>
    <div class="copilot-log" id="copilot-log" aria-live="polite"></div>
    <form class="copilot-form" id="copilot-form"><label for="copilot-q" class="sr-only">Ask a question</label>
      <input id="copilot-q" maxlength="500" placeholder="Ask about payments, invoices, tax, stock" autocomplete="off" required />
      <button class="btn btn-primary" type="submit">Send</button></form>
    <div class="copilot-note muted small">Birritu reads your books and suggests next steps. It never changes anything by itself.</div>`;
  document.body.append(launch, panel);

  launch.addEventListener("click", () => (panel.hidden ? openCopilot() : closeCopilot()));
  panel.querySelector("#copilot-close").addEventListener("click", closeCopilot);
  panel.addEventListener("keydown", (e) => { if (e.key === "Escape") closeCopilot(); });
  panel.querySelector("#copilot-clear").addEventListener("click", () => { Copilot.log = []; saveLog(); renderCopilotLog(); });
  panel.querySelector("#copilot-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const i = document.getElementById("copilot-q"); const q = i.value.trim(); i.value = "";
    if (q) askCopilot(q);
  });
  panel.querySelector("#copilot-log").addEventListener("click", (e) => {
    const go = e.target.closest("[data-go]"); if (go) { navigate(go.dataset.go); if (window.innerWidth < 860) closeCopilot(); return; }
    const ask = e.target.closest("[data-ask]"); if (ask) askCopilot(ask.dataset.ask);
  });
  const sel = document.getElementById("branch-select");
  if (sel) sel.addEventListener("change", () => { Copilot.briefing = null; if (!panel.hidden) { loadBriefing(); } });
}

async function loadBriefing() {
  try { Copilot.briefing = await api("/home/briefing"); } catch { Copilot.briefing = null; }
  const scope = document.getElementById("copilot-scope");
  if (scope && Copilot.briefing) scope.textContent = `Looking at: ${Copilot.briefing.scope}`;
  renderCopilotLog();
}

function briefingHtml() {
  const b = Copilot.briefing;
  if (!b) return `<div class="msg msg-bot"><div class="bubble">Hello! Ask me anything about your money, invoices, tax or stock.</div></div>`;
  const items = b.items.slice(0, 5).map((it) => `<li>${levelPill(it.level)} ${esc(it.text)}
      ${it.route ? ` <button type="button" class="link-btn" data-go="${esc(it.route)}">Open</button>` : ""}</li>`).join("");
  return `<div class="msg msg-bot"><div class="bubble"><b>${esc(b.headline)}</b><ul class="brief-mini">${items}</ul></div></div>`;
}

function renderCopilotLog() {
  const log = document.getElementById("copilot-log");
  if (!log) return;
  const msgs = Copilot.log.map((m) => {
    if (m.role === "user") return `<div class="msg msg-user"><div class="bubble">${esc(m.text)}</div></div>`;
    const t = m.table && m.table.rows && m.table.rows.length
      ? `<div class="bubble-table">${table(m.table.columns, m.table.rows.map((row) => row.map((c) => esc(c))))}</div>` : "";
    const meta = m.pending ? "" : `<div class="muted small bubble-meta">${m.mode === "llm" ? "Answered by Claude" : m.mode === "offline" ? "Answered from your records" : ""}${m.scope ? ` · ${esc(m.scope)}` : ""}</div>`;
    return `<div class="msg msg-bot"><div class="bubble">${m.pending ? `<span class="muted">Thinking…</span>` : esc(m.text)}${t}${m.note ? `<div class="muted small">${esc(m.note)}</div>` : ""}${meta}</div></div>`;
  }).join("");
  const chips = Copilot.log.length === 0
    ? `<div class="chips">${SUGGESTIONS.map((q) => `<button type="button" class="chip" data-ask="${esc(q)}">${esc(q)}</button>`).join("")}</div>` : "";
  log.innerHTML = briefingHtml() + chips + msgs;
  log.scrollTop = log.scrollHeight;
}

async function askCopilot(q) {
  buildCopilot();
  Copilot.log.push({ role: "user", text: q });
  const pending = { role: "bot", pending: true, text: "" };
  Copilot.log.push(pending);
  renderCopilotLog();
  try {
    const r = await api("/ai/ask", { method: "POST", body: { question: q } });
    Object.assign(pending, { pending: false, text: r.answer, table: r.table, mode: r.mode, scope: r.scope, note: r.note });
  } catch (err) {
    Object.assign(pending, { pending: false, text: `Sorry, I couldn't answer that: ${err.message}` });
  }
  saveLog();
  renderCopilotLog();
}

function openCopilot(question) {
  buildCopilot();
  const panel = document.getElementById("copilot-panel");
  const launch = document.getElementById("copilot-launch");
  panel.hidden = false;
  launch.setAttribute("aria-expanded", "true");
  launch.classList.add("is-open");
  if (!Copilot.briefing) loadBriefing(); else renderCopilotLog();
  if (question) askCopilot(question); else document.getElementById("copilot-q").focus();
}

function closeCopilot() {
  const panel = document.getElementById("copilot-panel");
  const launch = document.getElementById("copilot-launch");
  if (!panel) return;
  panel.hidden = true;
  launch.setAttribute("aria-expanded", "false");
  launch.classList.remove("is-open");
  launch.focus();
}

document.addEventListener("DOMContentLoaded", buildCopilot);
if (document.readyState !== "loading") buildCopilot();
