import db from "../../db/index.js";
import { categorizeTransaction, type CategorizationResult } from "../categorizer.js";

/**
 * A small, transparent learner: every time a person confirms or corrects a
 * category, the words in that transaction's description are remembered against
 * the chosen category. Later transactions that share those words (a supplier's
 * name, a customer's name, "ethio telecom"...) are categorised the same way,
 * with confidence that grows as confirmations accumulate. No external service,
 * and every suggestion can be explained by the words that triggered it.
 */

const STOP = new Set([
  "the", "and", "for", "from", "with", "via", "ref", "etb", "birr", "credit", "credited", "debit", "debited", "payment",
  "received", "paid", "cbe", "boa", "telebirr", "dear", "customer", "account", "has", "been", "your", "you", "this", "that",
  "n/a", "stock", "purchase",
]);

export function tokenize(description: string): string[] {
  return description
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOP.has(t));
}

/** Remember that this description belongs to this category. */
export function learn(description: string, category: string) {
  const stmt = db.prepare(
    `INSERT INTO category_memory (token, category, count) VALUES (?, ?, 1)
     ON CONFLICT(token, category) DO UPDATE SET count = count + 1`
  );
  for (const t of new Set(tokenize(description))) stmt.run(t, category);
}

export interface LearnedPrediction { category: string; confidence: number; tokens: string[] }

export function predict(description: string): LearnedPrediction | null {
  const tokens = [...new Set(tokenize(description))];
  const score = new Map<string, number>();
  const maxVotes = new Map<string, number>();
  const hit = new Map<string, string[]>();

  for (const t of tokens) {
    const rows = db.prepare(`SELECT category, count FROM category_memory WHERE token = ?`).all(t) as Array<{ category: string; count: number }>;
    const total = rows.reduce((s, r) => s + r.count, 0);
    if (!total) continue;
    for (const r of rows) {
      score.set(r.category, (score.get(r.category) ?? 0) + r.count / total);
      maxVotes.set(r.category, Math.max(maxVotes.get(r.category) ?? 0, r.count));
      hit.set(r.category, [...(hit.get(r.category) ?? []), t]);
    }
  }
  if (!score.size) return null;

  let best = ""; let bestScore = -1;
  for (const [c, s] of score) if (s > bestScore) { best = c; bestScore = s; }
  const share = bestScore / [...score.values()].reduce((a, b) => a + b, 0);
  const votes = maxVotes.get(best) ?? 1;
  // One confirmation -> 0.5, two -> 0.67, four -> 0.8 ... scaled down when other categories compete for the same words.
  const confidence = Math.min(0.95, share * (1 - 1 / (1 + votes)));
  return { category: best, confidence: Math.round(confidence * 100) / 100, tokens: hit.get(best) ?? [] };
}

export interface SmartCategorization extends CategorizationResult { source: "learned" | "rules" }

/** Learned memory wins when it is at least as confident as the keyword rules. */
export function smartCategorize(description: string, amount: number): SmartCategorization {
  const rule = categorizeTransaction(description, amount);
  const learned = predict(description);
  if (learned && learned.confidence >= rule.confidence) {
    return { category: learned.category, confidence: learned.confidence, matchedKeywords: learned.tokens, source: "learned" };
  }
  return { ...rule, source: "rules" };
}
