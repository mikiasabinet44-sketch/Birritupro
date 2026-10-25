import { createRouter, HttpError } from "../lib/httpRouter.js";
import { getSetting, setSetting } from "../db/index.js";

export const settingsRouter = createRouter();

// Company profile. The e-invoice seller block is built from these, so company_name and company_tin are required before issuing e-invoices.
const KEYS = ["company_name", "company_tin", "company_address", "company_vat_reg_no", "company_phone"] as const;

settingsRouter.get("/", (_req, res) => {
  const out: Record<string, string | null> = {};
  for (const k of KEYS) out[k] = getSetting(k);
  res.json(out);
});

settingsRouter.patch("/", (req, res) => {
  const body = req.body ?? {};
  if (body.company_tin !== undefined && body.company_tin !== "" && !/^\d{10}$/.test(String(body.company_tin).trim())) {
    throw new HttpError(400, "company_tin must be a 10-digit Ethiopian TIN");
  }
  for (const k of KEYS) {
    if (body[k] !== undefined) setSetting(k, String(body[k]).trim());
  }
  res.json({ ok: true });
});
