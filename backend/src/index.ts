import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "./db/index.js"; // initializes the SQLite DB + schema on import

import { matchRoute, makeResponse, type Router } from "./lib/httpRouter.js";
import { accountsRouter } from "./routes/accounts.js";
import { customersRouter } from "./routes/customers.js";
import { transactionsRouter } from "./routes/transactions.js";
import { smsRouter } from "./routes/sms.js";
import { invoicesRouter } from "./routes/invoices.js";
import { payrollRouter } from "./routes/payroll.js";
import { taxRouter } from "./routes/tax.js";
import { dashboardRouter } from "./routes/dashboard.js";
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
  { prefix: ["api", "branches"], router: branchesRouter },
  { prefix: ["api", "inventory"], router: inventoryRouter },
  { prefix: ["api", "einvoices"], router: einvoicesRouter },
  { prefix: ["api", "settings"], router: settingsRouter },
  { prefix: ["api", "ai"], router: aiRouter },
];

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
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
  const segments = url.pathname.split("/").filter(Boolean);
  const method = (req.method ?? "GET").toUpperCase();

  // CORS (harmless even for same-origin; useful if the frontend is served separately in dev)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Webhook-Secret, X-Branch-Id");
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
    req.on("data", (c) => chunks.push(c));
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

      const appRes = makeResponse(res);
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
            header: (name: string) => req.headers[name.toLowerCase()] as string | undefined,
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
    if (serveStatic("/", res)) return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
