// Mobile app shell: on phones the sidebar is replaced by a bottom tab bar (Home, Money, Invoices, Stock, More).
// The tabs are built from the sidebar's own buttons, so labels, icons, badges and the active page always match.
// Also registers the service worker so Birritu can be installed from the browser menu ("Add to Home screen").
const TAB_MAIN = ["dashboard", "transactions", "invoices", "inventory"];
const TAB_LABELS = { dashboard: "Home", transactions: "Money", invoices: "Invoices", inventory: "Stock" };

function buildTabbar() {
  const nav = document.getElementById("nav");
  if (!nav || document.getElementById("tabbar")) return;
  const bar = document.createElement("nav");
  bar.id = "tabbar"; bar.className = "tabbar"; bar.setAttribute("aria-label", "Main");
  document.body.appendChild(bar);
  const sheet = document.createElement("div");
  sheet.id = "more-sheet"; sheet.className = "more-sheet"; sheet.hidden = true;
  sheet.setAttribute("role", "dialog"); sheet.setAttribute("aria-label", "More pages");
  document.body.appendChild(sheet);

  const items = () => [...nav.querySelectorAll(".nav-item")];
  const closeSheet = () => { sheet.hidden = true; document.getElementById("tab-more")?.setAttribute("aria-expanded", "false"); };
  const openSheet = () => { sheet.hidden = false; document.getElementById("tab-more")?.setAttribute("aria-expanded", "true"); sheet.querySelector("button")?.focus(); };

  function sync() {
    const all = items();
    const badgeOf = (el) => el.querySelector(".badge, .nav-badge")?.textContent ?? "";
    const tab = (el) => {
      const r = el.dataset.route, on = el.classList.contains("active");
      const b = badgeOf(el);
      return `<button type="button" class="tab${on ? " active" : ""}" data-go="${r}"${on ? ' aria-current="page"' : ""}>${el.querySelector("svg")?.outerHTML ?? ""}<span>${esc(TAB_LABELS[r] ?? el.textContent.trim())}</span>${b ? `<i class="tab-badge">${esc(b.replace(" low", ""))}</i>` : ""}</button>`;
    };
    const main = TAB_MAIN.map((id) => all.find((e) => e.dataset.route === id)).filter(Boolean);
    const rest = all.filter((e) => !TAB_MAIN.includes(e.dataset.route));
    const moreActive = rest.some((e) => e.classList.contains("active"));
    const moreCount = rest.reduce((n, e) => n + (parseInt(badgeOf(e), 10) || 0), 0);
    bar.innerHTML = main.map(tab).join("") +
      `<button type="button" class="tab${moreActive ? " active" : ""}" id="tab-more" aria-haspopup="dialog" aria-expanded="${!sheet.hidden}"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/></svg><span>More</span>${moreCount ? `<i class="tab-badge">${moreCount}</i>` : ""}</button>`;
    sheet.innerHTML = `<div class="more-grab" aria-hidden="true"></div>` + rest.map((e) => {
      const b = badgeOf(e);
      return `<button type="button" class="more-item${e.classList.contains("active") ? " active" : ""}" data-go="${e.dataset.route}">${e.querySelector("svg")?.outerHTML ?? ""}<span>${esc(e.textContent.replace(b, "").trim())}</span>${b ? `<i class="tab-badge">${esc(b)}</i>` : ""}</button>`;
    }).join("");
  }

  bar.addEventListener("click", (e) => {
    const go = e.target.closest("[data-go]"), more = e.target.closest("#tab-more");
    if (go) { closeSheet(); navigate(go.dataset.go); window.scrollTo(0, 0); }
    else if (more) { sheet.hidden ? openSheet() : closeSheet(); }
  });
  sheet.addEventListener("click", (e) => { const go = e.target.closest("[data-go]"); if (go) { closeSheet(); navigate(go.dataset.go); window.scrollTo(0, 0); } });
  document.addEventListener("click", (e) => { if (!sheet.hidden && !sheet.contains(e.target) && !bar.contains(e.target)) closeSheet(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !sheet.hidden) { closeSheet(); document.getElementById("tab-more")?.focus(); } });
  new MutationObserver(sync).observe(nav, { childList: true, subtree: true, characterData: true });
  sync();
}

// The original sidebar, unchanged, as a slide-out menu on phones (opened from the menu button in the top bar).
function buildDrawer() {
  const top = document.querySelector(".topbar"), side = document.querySelector(".sidebar");
  if (!top || !side || document.getElementById("menu-btn")) return;
  const btn = document.createElement("button");
  btn.type = "button"; btn.id = "menu-btn"; btn.className = "menu-btn"; btn.setAttribute("aria-label", "Open menu"); btn.setAttribute("aria-expanded", "false"); btn.setAttribute("aria-controls", "nav");
  btn.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>`;
  top.prepend(btn);
  const scrim = document.createElement("div"); scrim.className = "nav-scrim"; document.body.appendChild(scrim);
  const set = (open) => { document.body.classList.toggle("nav-open", open); btn.setAttribute("aria-expanded", String(open)); btn.setAttribute("aria-label", open ? "Close menu" : "Open menu"); };
  btn.addEventListener("click", () => set(!document.body.classList.contains("nav-open")));
  scrim.addEventListener("click", () => set(false));
  side.addEventListener("click", (e) => { if (e.target.closest(".nav-item")) set(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && document.body.classList.contains("nav-open")) { set(false); btn.focus(); } });
  window.matchMedia("(min-width: 861px)").addEventListener("change", (m) => { if (m.matches) set(false); });
}

window.addEventListener("load", () => {
  buildTabbar(); buildDrawer();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
});
