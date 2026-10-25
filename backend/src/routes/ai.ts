import { createRouter, HttpError } from "../lib/httpRouter.js";
import db from "../db/index.js";
import { branchOf } from "../lib/branch.js";
import { DEFAULT_RULES } from "../lib/categorizer.js";
import { detectAnomalies } from "../lib/ai/anomalies.js";
import { cashForecast } from "../lib/ai/forecast.js";
import { reorderSuggestions } from "../lib/ai/reorder.js";
import { askAssistant } from "../lib/ai/assistant.js";
import { smartCategorize } from "../lib/ai/learner.js";
import { extractJson, llmComplete, llmConfigured, llmModel } from "../lib/ai/llm.js";

export const aiRouter = createRouter();

aiRouter.get("/status", (_req, res) => {
  const learned = (db.prepare(`SELECT COUNT(*) AS c FROM category_memory`).get() as { c: number }).c;
  res.json({ llmEnabled: llmConfigured(), model: llmConfigured() ? llmModel() : null, learnedWordCategoryPairs: learned });
});

aiRouter.get("/insights", (req, res) => {
  const items = detectAnomalies(branchOf(req));
  res.json({ count: items.length, items });
});

aiRouter.get("/forecast", (req, res) => {
  res.json(cashForecast(branchOf(req), Number(req.query.get("weeks") ?? 8)));
});

aiRouter.get("/reorder", (req, res) => {
  res.json(reorderSuggestions(branchOf(req)));
});

aiRouter.post("/ask", async (req, res) => {
  const question = String(req.body?.question ?? "").trim();
  if (!question) throw new HttpError(400, "question is required");
  if (question.length > 500) throw new HttpError(400, "question is too long (max 500 characters)");
  res.json(await askAssistant(question, branchOf(req)));
});

/**
 * Second look at low-confidence suggestions: first with what the app has learned from your
 * confirmations, then (if an LLM key is configured) with the language model. Results stay
 * 'suggested' - a person still confirms them.
 */
aiRouter.post("/recategorize", async (req, res) => {
  const b = branchOf(req);
  const rows = db.prepare(
    `SELECT id, description, amount, category, category_confidence FROM transactions
     WHERE category_status = 'suggested' AND COALESCE(category_confidence,0) < 0.6${b ? " AND branch_id = ?" : ""} ORDER BY date DESC LIMIT 40`
  ).all(...(b ? [b] : [])) as any[];

  let updatedByLearning = 0, updatedByLlm = 0;
  const stillUnsure: any[] = [];
  const upd = db.prepare(`UPDATE transactions SET category = ?, category_confidence = ? WHERE id = ?`);

  for (const r of rows) {
    const s = smartCategorize(r.description, r.amount);
    if (s.confidence > (r.category_confidence ?? 0) && s.category !== r.category) { upd.run(s.category, s.confidence, r.id); updatedByLearning++; }
    else stillUnsure.push(r);
  }

  if (llmConfigured() && stillUnsure.length) {
    const allowed = [...new Set([...DEFAULT_RULES.map((r) => r.category), "Other Income", "Other Expense", ...(db.prepare(`SELECT DISTINCT category FROM transactions WHERE category IS NOT NULL`).all() as any[]).map((x) => x.category)])];
    try {
      const reply = await llmComplete(
        "You categorise bookkeeping transactions for an Ethiopian small business. Choose exactly one category from the allowed list for each item. " +
          'Reply with ONLY a JSON array like [{"id":"...","category":"..."}].',
        JSON.stringify({ allowedCategories: allowed, transactions: stillUnsure.map((r) => ({ id: r.id, description: r.description, amount: r.amount })) }),
        1500
      );
      const picks = extractJson<Array<{ id: string; category: string }>>(reply);
      const ids = new Set(stillUnsure.map((r) => r.id));
      for (const p of picks) if (ids.has(p.id) && allowed.includes(p.category)) { upd.run(p.category, 0.7, p.id); updatedByLlm++; }
    } catch (err: any) {
      res.json({ examined: rows.length, updatedByLearning, updatedByLlm, warning: `LLM step skipped: ${err?.message}` });
      return;
    }
  }
  res.json({ examined: rows.length, updatedByLearning, updatedByLlm });
});
