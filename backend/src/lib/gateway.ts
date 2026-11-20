import type { Scope } from "./apikeys.js";

/**
 * Public machine API. Everything an integration may call lives here, as an explicit allowlist:
 * a route that is not listed is not reachable with an API key, whatever the web UI can do.
 * `target` is the internal route it maps to. `unboundOnly` routes are refused for branch-bound keys.
 */
interface Entry { method: string; pattern: string; scope: Scope; target: string; unboundOnly?: boolean }

export const V1: Entry[] = [
  { method: "POST", pattern: "payments", scope: "payments:write", target: "_v1/payments" },
  { method: "GET", pattern: "payments", scope: "payments:read", target: "_v1/payments" },

  { method: "GET", pattern: "invoices", scope: "invoices:read", target: "invoices" },
  { method: "GET", pattern: "invoices/:id", scope: "invoices:read", target: "invoices/:id" },
  { method: "POST", pattern: "invoices", scope: "invoices:write", target: "invoices" },
  { method: "POST", pattern: "invoices/:id/cancel", scope: "invoices:write", target: "invoices/:id/cancel" },

  { method: "GET", pattern: "customers", scope: "customers:read", target: "customers" },
  { method: "POST", pattern: "customers", scope: "customers:write", target: "customers" },

  { method: "GET", pattern: "inventory/products", scope: "inventory:read", target: "inventory/products" },
  { method: "GET", pattern: "inventory/stock", scope: "inventory:read", target: "inventory/stock" },
  { method: "GET", pattern: "inventory/movements", scope: "inventory:read", target: "inventory/movements" },
  { method: "POST", pattern: "inventory/products", scope: "inventory:write", target: "inventory/products" },
  { method: "POST", pattern: "inventory/receive", scope: "inventory:write", target: "inventory/receive" },
  { method: "POST", pattern: "inventory/adjust", scope: "inventory:write", target: "inventory/adjust" },
  { method: "POST", pattern: "inventory/transfer", scope: "inventory:write", target: "inventory/transfer", unboundOnly: true },

  { method: "GET", pattern: "einvoices", scope: "einvoices:read", target: "einvoices" },
  { method: "GET", pattern: "einvoices/:id", scope: "einvoices:read", target: "einvoices/:id" },
  { method: "POST", pattern: "einvoices/from-invoice/:invoiceId", scope: "einvoices:write", target: "einvoices/from-invoice/:invoiceId" },

  { method: "GET", pattern: "tax/filings", scope: "reports:read", target: "tax/filings" },
  { method: "GET", pattern: "dashboard/summary", scope: "reports:read", target: "dashboard/summary" },
];

/** Matches `rest` (path after /api/v1) and returns the entry plus the internal path segments to dispatch to. */
export function resolveV1(method: string, rest: string[]): { entry: Entry; segments: string[] } | null {
  for (const entry of V1) {
    if (entry.method !== method) continue;
    const pat = entry.pattern.split("/");
    if (pat.length !== rest.length) continue;
    const params: Record<string, string> = {};
    if (!pat.every((p, i) => (p.startsWith(":") ? ((params[p.slice(1)] = rest[i]), true) : p === rest[i]))) continue;
    const segments = ["api", ...entry.target.split("/").map((t) => (t.startsWith(":") ? params[t.slice(1)] : t))];
    return { entry, segments };
  }
  return null;
}
