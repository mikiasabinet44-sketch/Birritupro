import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "./db/index.js"; // initializes the SQLite DB + schema on import

import crypto from "node:crypto";
import { matchRoute, makeResponse, type Router } from "./lib/httpRouter.js";
import db from "./db/index.js";
import { authenticateKey, extractKey, rateLimited } from "./lib/apikeys.js";
import { resolveV1 } from "./lib/gateway.js";
import { apiKeysRouter } from "./routes/apikeys.js";
import { v1PaymentsRouter } from "./routes/v1payments.js";
import { accountsRouter } from "./routes/accounts.js";
import { customersRouter } from "./routes/customers.js";
import { transactionsRouter } from "./routes/transactions.js";
import { smsRouter } from "./routes/sms.js";
import { invoicesRouter } from "./routes/invoices.js";
import { payrollRouter } from "./routes/payroll.js";
import { taxRouter } from "./routes/tax.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { homeRouter } from "./routes/home.js";
import { branchesRouter } from "./routes/branches.js";
import { inventoryRouter } from "./routes/inventory.js";
import { einvoicesRouter } from "./routes/einvoices.js";
import { settingsRouter } from "./routes/settings.js";
import { aiRouter } from "./routes/ai.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, "../../frontend/public");

const mounts: Array<{ prefix: string[]; router: Router }> = [
  { prefix: ["api", "accounts"], router: accountsRouter },
  { prefix: ["api", "customers"], router: customersRouter },
  { prefix: ["api", "transactions"], router: transactionsRouter },
  { prefix: ["api", "sms"], router: smsRouter },
  { prefix: ["api", "invoices"], router: invoicesRouter },
  { prefix: ["api", "payroll"], router: payrollRouter },
  { prefix: ["api", "tax"], router: taxRouter },
  { prefix: ["api", "dashboard"], router: dashboardRouter },
  { prefix: ["api", "home"], router: homeRouter },
  { prefix: ["api", "branches"], router: branchesRouter },
  { prefix: ["api", "inventory"], router: inventoryRouter },
  { prefix: ["api", "einvoices"], router: einvoicesRouter },
  { prefix: ["api", "settings"], router: settingsRouter },
  { prefix: ["api", "ai"], router: aiRouter },
  { prefix: ["api", "keys"], router: apiKeysRouter },
  { prefix: ["api", "_v1", "payments"], router: v1PaymentsRouter }, // internal: only reachable via the /api/v1 gateway
];

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
};

function serveStatic(urlPath: string, res: http.ServerResponse): boolean {
  let rel = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = path.join(FRONTEND_DIR, rel);
  if (!filePath.startsWith(FRONTEND_DIR)) return false; // path traversal guard
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return false;
  const ext = path.extname(filePath);
  res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  let segments = url.pathname.split("/").filter(Boolean);
  const method = (req.method ?? "GET").toUpperCase();

  // CORS (harmless even for same-origin; useful if the frontend is served separately in dev)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Webhook-Secret, X-Branch-Id, Authorization, X-API-Key, Idempotency-Key, X-Admin-Token");
  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (segments[0] === "api" && segments[1] === "health" && segments.length === 2) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const json = (status: number, body: unknown, extra: Record<string, string> = {}) => {
    res.writeHead(status, { "Content-Type": "application/json", ...extra });
    res.end(JSON.stringify(body));
  };

  // The internal payments router must never be reachable directly.
  if (segments[0] === "api" && segments[1] === "_v1") { json(404, { error: "not found" }); return; }

  // ---- Public machine API: /api/v1/* (API key, scopes, branch binding, idempotency) ----
  let apiKey: ReturnType<typeof authenticateKey> = null;
  const headerOverride: Record<string, string> = {};
  if (segments[0] === "api" && segments[1] === "v1") {
    apiKey = authenticateKey(extractKey({ header: (n) => req.headers[n.toLowerCase()] as string | undefined }));
    if (!apiKey) { req.resume(); json(401, { error: "missing or invalid API key (send Authorization: Bearer <key>)" }, { "WWW-Authenticate": "Bearer" }); return; }
    if (rateLimited(apiKey.id)) { req.resume(); json(429, { error: "rate limit exceeded (120 requests/minute per key)" }, { "Retry-After": "60" }); return; }
    const hit = resolveV1(method, segments.slice(2));
    if (!hit) { req.resume(); json(404, { error: "not available through the API" }); return; }
    if (!apiKey.scopes.includes(hit.entry.scope)) { req.resume(); json(403, { error: `this key lacks the '${hit.entry.scope}' scope` }); return; }
    if (apiKey.branch_id && hit.entry.unboundOnly) { req.resume(); json(403, { error: "branch-bound keys cannot perform this operation" }); return; }
    if (apiKey.branch_id) headerOverride["x-branch-id"] = apiKey.branch_id;
    segments = hit.segments;
  }

  const mount = mounts.find((m) => m.prefix.every((p, i) => segments[i] === p));
  if (mount) {
    const rest = segments.slice(mount.prefix.length);
    const match = matchRoute(mount.router, method, rest);
    if (!match) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 2_000_000) { json(413, { error: "request body too large" }); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      let body: any = undefined;
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid JSON body" }));
          return;
        }
      }

      // Branch-bound keys can only ever act on their own branch, whatever the body says.
      if (apiKey?.branch_id && body && typeof body === "object" && !Array.isArray(body)) {
        delete body.branch; delete body.branchCode;
        body.branchId = apiKey.branch_id;
      }

      const appRes = makeResponse(res);

      // Idempotency-Key: a retried POST gets the original response instead of running twice.
      const idem = apiKey && method === "POST" ? (req.headers["idempotency-key"] as string | undefined) : undefined;
      if (idem) {
        if (idem.length > 128) { json(400, { error: "Idempotency-Key is too long (max 128 characters)" }); return; }
        const sig = crypto.createHash("sha256").update(`${method} ${url.pathname} ${raw}`).digest("hex");
        const prior = db.prepare(`SELECT request_sig, status, response FROM idempotency_keys WHERE key_id = ? AND idem_key = ?`).get(apiKey!.id, idem) as any;
        if (prior) {
          if (prior.request_sig !== sig) { json(422, { error: "this Idempotency-Key was already used with a different request" }); return; }
          json(prior.status, JSON.parse(prior.response), { "Idempotent-Replay": "true" });
          return;
        }
        let code = 200;
        const origStatus = appRes.status.bind(appRes), origJson = appRes.json.bind(appRes);
        appRes.status = (c: number) => { code = c; return origStatus(c); };
        appRes.json = (b: unknown) => {
          if (code >= 200 && code < 300) {
            db.prepare(`INSERT OR IGNORE INTO idempotency_keys (key_id, idem_key, request_sig, status, response) VALUES (?,?,?,?,?)`)
              .run(apiKey!.id, idem, sig, code, JSON.stringify(b));
          }
          origJson(b);
        };
      }
      const fail = (err: any) => {
        const status = typeof err?.status === "number" ? err.status : 500;
        if (status >= 500) console.error(err);
        if (!res.headersSent) appRes.status(status).json({ error: err?.message ?? "internal error" });
      };
      try {
        // Handlers may be async (e.g. e-invoice registration, LLM calls); catch rejections too.
        const out = match.handler(
          {
            method,
            params: match.params,
            query: url.searchParams,
            body,
            raw: req,
            header: (name: string) => headerOverride[name.toLowerCase()] ?? (req.headers[name.toLowerCase()] as string | undefined),
          },
          appRes
        );
        if (out && typeof (out as Promise<void>).catch === "function") (out as Promise<void>).catch(fail);
      } catch (err: any) {
        fail(err);
      }
    });
    return;
  }

  // Not an API route: try serving the frontend as static files (SPA fallback to index.html).
  if (method === "GET") {
    if (serveStatic(url.pathname, res)) return;
    // A missing file (has an extension) is a real 404; only page-like paths fall back to the app.
    if (!path.extname(url.pathname) && serveStatic("/", res)) return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
