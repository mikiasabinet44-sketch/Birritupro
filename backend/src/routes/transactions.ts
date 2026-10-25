import { createRouter, HttpError } from "../lib/httpRouter.js";
import { nanoid } from "../lib/id.js";
import db from "../db/index.js";
import { branchClause, writeBranch } from "../lib/branch.js";
import { learn, smartCategorize } from "../lib/ai/learner.js";

export const transactionsRouter = createRouter();

transactionsRouter.get("/", (req, res) => {
  const status = req.query.get("status");
  const c = branchClause(req, "t.branch_id");
  res.json(
    db.prepare(
      `SELECT t.*, b.code AS branch_code FROM transactions t LEFT JOIN branches b ON b.id = t.branch_id
       WHERE 1=1${status ? " AND t.category_status = ?" : ""}${c.sql} ORDER BY t.date DESC, t.created_at DESC`
    ).all(...(status ? [status] : []), ...c.params)
  );
});

// Create a manual transaction; auto-categorized (rules + what the app has learned from you) unless a category is supplied.
transactionsRouter.post("/", (req, res) => {
  const { date, description, amount, debitAccountId, creditAccountId, category } = req.body ?? {};
  if (!date || !description || amount === undefined) {
    return res.status(400).json({ error: "date, description, amount are required" });
  }
  const branchId = writeBranch(req, req.body?.branchId);
  const id = nanoid();

  let finalCategory = category;
  let confidence = 1;
  let status: "manual" | "suggested" = "manual";
  let source = "manual";
  if (!category) {
    const result = smartCategorize(description, amount);
    finalCategory = result.category;
    confidence = result.confidence;
    source = result.source;
    status = "suggested";
  } else {
    learn(description, category); // an explicit category is a human decision worth learning from
  }

  db.prepare(
    `INSERT INTO transactions
      (id, date, description, amount, debit_account_id, credit_account_id, category, category_confidence, category_status, source, branch_id)
     VALUES (?,?,?,?,?,?,?,?,?, 'manual', ?)`
  ).run(id, date, description, amount, debitAccountId ?? null, creditAccountId ?? null, finalCategory, confidence, status, branchId);

  res.status(201).json({ id, category: finalCategory, confidence, status, suggestedBy: category ? "you" : source });
});

// Confirm or change a suggested category - the human-in-the-loop step. Each confirmation also teaches the categorizer.
transactionsRouter.patch("/:id/category", (req, res) => {
  const { category } = req.body ?? {};
  if (!category) return res.status(400).json({ error: "category is required" });
  const t = db.prepare(`SELECT description FROM transactions WHERE id = ?`).get(req.params.id) as { description: string } | undefined;
  if (!t) throw new HttpError(404, "transaction not found");
  db.prepare(`UPDATE transactions SET category = ?, category_status = 'confirmed' WHERE id = ?`).run(category, req.params.id);
  learn(t.description, category);
  res.json({ ok: true });
});

transactionsRouter.delete("/:id", (req, res) => {
  db.prepare(`DELETE FROM transactions WHERE id = ?`).run(req.params.id);
  res.status(204).end();
});
