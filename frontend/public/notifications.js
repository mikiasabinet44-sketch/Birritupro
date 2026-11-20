// Birritu notifications: a bell in the top bar that lists what needs the owner's attention
// (new payments, items to review, overdue invoices, low stock, tax, staff pay).
// The server builds the list (GET /api/home/notifications) with stable keys; this file remembers what was
// read, alerts for what is new (toast, plus a desktop alert if allowed) and polls while the app is open.
// Relies on helpers from app.js and copilot.js (api, esc, navigate, toast, timeAgo), resolved at call time.
// Honest limit: alerts only arrive while Birritu is open in a browser tab. Alerts when the app is closed
// would need push, SMS or Telegram, which this prototype does not do.

const NOTIF_TYPES = [
  { id: "payment", label: "Money received" },
  { id: "review", label: "Payments to review" },
  { id: "unread", label: "Unreadable messages" },
  { id: "invoice", label: "Invoices due or overdue" },
  { id: "stock", label: "Low stock" },
  { id: "tax", label: "Tax deadlines" },
  { id: "payroll", label: "Staff pay" },
];
const NOTIF_POLL_MS = 45000;
const Notif = { items: [], read: new Set(), seen: new Set(), muted: new Set(), firstLoad: true, timer: null, open: false, tab: "all" };

function notifLoad() {
  try {
    Notif.read = new Set(JSON.parse(localStorage.getItem("notif-read") ?? "[]"));
    Notif.seen = new Set(JSON.parse(localStorage.getItem("notif-seen") ?? "[]"));
    Notif.muted = new Set(JSON.parse(localStorage.getItem("notif-muted") ?? "[]"));
    Notif.firstLoad = localStorage.getItem("notif-seen") === null;
  } catch { /* storage unavailable: keep in-memory defaults */ }
}
function notifSave() {
  try {
    localStorage.setItem("notif-read", JSON.stringify([...Notif.read].slice(-500)));
    localStorage.setItem("notif-seen", JSON.stringify([...Notif.seen].slice(-800)));
    localStorage.setItem("notif-muted", JSON.stringify([...Notif.muted]));
  } catch { /* ignore */ }
}

function notifVisible() { return Notif.items.filter((n) => !Notif.muted.has(n.type)); }
function notifUnread() { return notifVisible().filter((n) => !Notif.read.has(n.key)); }

// Small counts on the sidebar menu, like the design: "Money in & out" shows new money received (until read),
// "Payment checks" shows payments needing a look, "Stock" shows how many items are low, and so on.
function notifNavBadges() {
  const vis = notifVisible();
  const n = (f) => vis.filter(f).length;
  const unreadPay = n((i) => i.type === "payment" && !Notif.read.has(i.key));
  const map = {
    transactions: unreadPay ? { text: String(unreadPay), label: `${unreadPay} new payments` } : null,
    payments: n((i) => i.type === "review" || i.type === "unread") ? { text: String(n((i) => i.type === "review" || i.type === "unread")), label: "payments to check" } : null,
    invoices: n((i) => i.type === "invoice") ? { text: String(n((i) => i.type === "invoice")), label: "invoices due or overdue" } : null,
    inventory: n((i) => i.type === "stock") ? { text: `${n((i) => i.type === "stock")} low`, label: "items low in stock", plain: true } : null,
    tax: n((i) => i.type === "tax") ? { text: String(n((i) => i.type === "tax")), label: "tax deadlines" } : null,
    payroll: n((i) => i.type === "payroll") ? { text: String(n((i) => i.type === "payroll")), label: "staff pay to approve" } : null,
  };
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.querySelector(".nav-badge")?.remove();
    const b = map[btn.dataset.route];
    if (!b) return;
    const el = document.createElement("span");
    el.className = "nav-badge" + (b.plain ? " nav-badge-plain" : "");
    el.textContent = b.text; el.title = b.label;
    el.setAttribute("aria-label", b.label);
    btn.appendChild(el);
  });
}

// Sidebar badges: how many open items each page has (not tied to read/unread, so they stay until fixed).
const NAV_BADGES = { transactions: ["payment"], payments: ["review", "unread"], invoices: ["invoice"], payroll: ["payroll"], tax: ["tax"], inventory: ["stock"] };
function notifNavBadges() {
  const vis = notifVisible();
  document.querySelectorAll("#nav .nav-item").forEach((el) => {
    el.querySelector(".badge")?.remove();
    const types = NAV_BADGES[el.dataset.route];
    if (!types) return;
    const items = vis.filter((n) => types.includes(n.type));
    if (!items.length) return;
    const b = document.createElement("span");
    b.className = "badge" + (items.some((n) => n.level === "urgent") ? " badge-urgent" : "");
    b.textContent = el.dataset.route === "inventory" ? `${items.length} low` : String(items.length);
    b.setAttribute("aria-label", `${b.textContent} need attention`);
    el.appendChild(b);
  });
}

function notifLevelPill(level) {
  return level === "urgent" ? `<span class="pill pill-danger">Urgent</span>` : level === "attention" ? `<span class="pill pill-warn">Check</span>` : `<span class="pill pill-muted">Info</span>`;
}

function notifTime(n) {
  if (!["payment", "review", "unread"].includes(n.type)) return "";
  try { return typeof timeAgo === "function" ? timeAgo(n.at) : ""; } catch { return ""; }
}

function buildNotifications() {
  const right = document.querySelector(".topbar-right");
  if (!right || document.getElementById("notif-btn")) return;
  const btn = document.createElement("button");
  btn.type = "button"; btn.id = "notif-btn"; btn.className = "notif-btn";
  btn.setAttribute("aria-haspopup", "dialog"); btn.setAttribute("aria-expanded", "false"); btn.setAttribute("aria-controls", "notif-panel");
  btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9a6 6 0 0 1 12 0c0 5 2 6.5 2 6.5H4S6 14 6 9z"/><path d="M10 19a2 2 0 0 0 4 0"/></svg><span id="notif-count" class="notif-count" hidden></span>`;
  right.prepend(btn);

  const panel = document.createElement("div");
  panel.id = "notif-panel"; panel.className = "notif-panel"; panel.hidden = true;
  panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", "Notifications");
  panel.innerHTML = `
    <div class="notif-head"><div class="notif-title">Notifications</div>
      <div class="flex"><button type="button" class="btn btn-sm" id="notif-readall">Mark all read</button><button type="button" class="btn btn-sm" id="notif-close" aria-label="Close notifications">Close</button></div></div>
    <div class="tabs notif-tabs" role="tablist"><button type="button" class="tab-btn active" role="tab" data-tab="all">All</button><button type="button" class="tab-btn" role="tab" data-tab="unread">Unread</button></div>
    <div class="notif-list" id="notif-list"></div>
    <details class="notif-settings"><summary>Alert settings</summary>
      <div class="notif-settings-body" id="notif-settings-body"></div></details>`;
  document.body.appendChild(panel);

  btn.addEventListener("click", () => (Notif.open ? notifClose() : notifOpen()));
  panel.querySelector("#notif-close").addEventListener("click", notifClose);
  panel.querySelector("#notif-readall").addEventListener("click", () => { notifVisible().forEach((n) => Notif.read.add(n.key)); notifSave(); notifRender(); });
  panel.addEventListener("keydown", (e) => { if (e.key === "Escape") { notifClose(); btn.focus(); } });
  panel.querySelectorAll("[data-tab]").forEach((t) => t.addEventListener("click", () => {
    Notif.tab = t.dataset.tab;
    panel.querySelectorAll("[data-tab]").forEach((x) => { const on = x === t; x.classList.toggle("active", on); x.setAttribute("aria-selected", String(on)); });
    notifRender();
  }));
  panel.querySelector("#notif-list").addEventListener("click", (e) => {
    const go = e.target.closest("[data-nopen]");
    const mark = e.target.closest("[data-nread]");
    if (go) { Notif.read.add(go.dataset.key); notifSave(); notifClose(); navigate(go.dataset.nopen); notifRender(); }
    else if (mark) { Notif.read.add(mark.dataset.key); notifSave(); notifRender(); }
  });
  panel.querySelector("#notif-settings-body").addEventListener("change", (e) => {
    const c = e.target.closest("[data-mute]");
    if (c) { c.checked ? Notif.muted.delete(c.dataset.mute) : Notif.muted.add(c.dataset.mute); notifSave(); notifRender(); return; }
  });
  panel.querySelector("#notif-settings-body").addEventListener("click", async (e) => {
    if (e.target.closest("#notif-desktop")) {
      if (!("Notification" in window)) { toast("This browser can't show desktop alerts.", true); return; }
      const r = await Notification.requestPermission();
      toast(r === "granted" ? "Desktop alerts are on." : "Desktop alerts were not allowed.", r !== "granted");
      notifRender();
    }
  });
  document.addEventListener("click", (e) => {
    if (Notif.open && e.target.isConnected && !panel.contains(e.target) && !btn.contains(e.target)) notifClose();
  });
  const sel = document.getElementById("branch-select");
  if (sel) sel.addEventListener("change", () => { Notif.firstLoad = true; notifPoll(); });
}

function notifOpen() {
  const panel = document.getElementById("notif-panel"), btn = document.getElementById("notif-btn");
  if (!panel) return;
  Notif.open = true; panel.hidden = false; btn.setAttribute("aria-expanded", "true");
  notifRender(); notifPoll();
  panel.querySelector("#notif-close").focus();
}
function notifClose() {
  const panel = document.getElementById("notif-panel"), btn = document.getElementById("notif-btn");
  if (!panel) return;
  Notif.open = false; panel.hidden = true; btn.setAttribute("aria-expanded", "false");
}

function notifRender() {
  notifNavBadges();
  const unread = notifUnread().length;
  const badge = document.getElementById("notif-count"), btn = document.getElementById("notif-btn");
  if (badge) { badge.hidden = unread === 0; badge.textContent = unread > 99 ? "99+" : String(unread); }
  if (btn) btn.setAttribute("aria-label", unread ? `Notifications, ${unread} unread` : "Notifications, none unread");

  notifNavBadges();
  const list = document.getElementById("notif-list");
  if (list) {
    const rows = (Notif.tab === "unread" ? notifUnread() : notifVisible());
    list.innerHTML = rows.length ? rows.map((n) => {
      const isRead = Notif.read.has(n.key);
      return `<div class="notif-item${isRead ? " is-read" : ""}">
        <div class="notif-item-top">${notifLevelPill(n.level)}<span class="notif-item-title">${esc(n.title)}</span><span class="muted small notif-time">${esc(notifTime(n))}</span></div>
        <div class="notif-item-text">${esc(n.text)}</div>
        <div class="notif-item-actions"><button type="button" class="btn btn-sm" data-nopen="${esc(n.route)}" data-key="${esc(n.key)}">Open</button>${isRead ? "" : `<button type="button" class="btn btn-sm" data-nread="1" data-key="${esc(n.key)}">Mark read</button>`}</div></div>`;
    }).join("") : `<div class="empty">${Notif.tab === "unread" ? "You're all caught up." : "Nothing to show right now."}</div>`;
  }

  const sb = document.getElementById("notif-settings-body");
  if (sb) {
    const perm = "Notification" in window ? Notification.permission : "unsupported";
    sb.innerHTML = `<div class="small muted" style="margin-bottom:8px">Choose what you want to hear about.</div>` +
      NOTIF_TYPES.map((t) => `<label class="notif-check"><input type="checkbox" data-mute="${t.id}" ${Notif.muted.has(t.id) ? "" : "checked"}> ${esc(t.label)}</label>`).join("") +
      `<div class="notif-desktop">${perm === "granted" ? `<span class="pill pill-ok">✓ Desktop alerts on</span>` : perm === "denied" ? `<span class="small muted">Desktop alerts are blocked in your browser settings.</span>` : perm === "unsupported" ? `<span class="small muted">Desktop alerts aren't supported in this browser.</span>` : `<button type="button" class="btn btn-sm" id="notif-desktop">Turn on desktop alerts</button>`}
      <div class="small muted" style="margin-top:6px">Alerts only arrive while Birritu is open in a browser tab.</div></div>`;
  }
}

function notifAlertNew(fresh) {
  if (!fresh.length) return;
  const top = fresh[0];
  const msg = fresh.length === 1 ? `${top.title}: ${top.text}` : `${fresh.length} new notifications. Latest: ${top.title}`;
  const hidden = document.hidden;
  if (!hidden) toast(msg.length > 160 ? msg.slice(0, 157) + "..." : msg);
  if (hidden && "Notification" in window && Notification.permission === "granted") {
    try {
      const n = new Notification(fresh.length === 1 ? top.title : `${fresh.length} new notifications`, { body: fresh.length === 1 ? top.text : top.title + ": " + top.text, tag: "birritu-alert" });
      n.onclick = () => { window.focus(); navigate(top.route); n.close(); };
    } catch { /* some browsers only allow this from a service worker */ }
  }
}

async function notifPoll() {
  try {
    const d = await api("/home/notifications");
    Notif.items = d.items ?? [];
    const visible = notifVisible();
    if (Notif.firstLoad) {
      // First time (or after switching branch): do not shout about things that already existed.
      visible.forEach((n) => Notif.seen.add(n.key));
      Notif.firstLoad = false;
    } else {
      const fresh = visible.filter((n) => !Notif.seen.has(n.key) && !Notif.read.has(n.key));
      visible.forEach((n) => Notif.seen.add(n.key));
      notifAlertNew(fresh);
    }
    notifSave(); notifRender();
  } catch { /* offline or server restarting: try again on the next tick */ }
}

function startNotifications() {
  notifLoad(); buildNotifications(); notifRender(); notifPoll();
  clearInterval(Notif.timer); Notif.timer = setInterval(notifPoll, NOTIF_POLL_MS);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) notifPoll(); });
}
window.addEventListener("load", startNotifications);
