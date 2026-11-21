// Birritu service worker: keeps the app shell available when the connection drops.
// Network first (so you always get the latest version and live numbers); the saved copy is only a fallback.
// API calls are never cached, so money figures are never stale.
const CACHE = "birritu-shell-v1";
const SHELL = ["/", "/styles.css", "/app.js", "/pro.js", "/copilot.js", "/notifications.js", "/mobile.js", "/qr.js"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {})); self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin || u.pathname.startsWith("/api/")) return;
  e.respondWith(fetch(e.request).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); } return r; }).catch(() => caches.match(e.request).then((m) => m || caches.match("/"))));
});
