/**
 * Lightweight "AI-style" auto-categorizer for bookkeeping transactions.
 *
 * This is a transparent, keyword + heuristic rule engine (not a call to an
 * external LLM) so it works fully offline and every suggestion is
 * explainable. It assigns a category and a confidence score; transactions
 * are always stored as "suggested" until a human confirms them, which is
 * the same review loop a real ML categorizer would need.
 */

export interface CategoryRule {
  category: string;
  keywords: string[];
  accountType: "income" | "expense";
}

export const DEFAULT_RULES: CategoryRule[] = [
  { category: "Sales Revenue", keywords: ["invoice", "sale", "payment received", "customer payment"], accountType: "income" },
  { category: "Rent", keywords: ["rent", "lease"], accountType: "expense" },
  { category: "Utilities", keywords: ["electric", "water bill", "eeu", "internet", "ethio telecom"], accountType: "expense" },
  { category: "Salaries & Wages", keywords: ["salary", "payroll", "wage"], accountType: "expense" },
  { category: "Transport & Fuel", keywords: ["fuel", "petrol", "diesel", "transport", "taxi", "ride"], accountType: "expense" },
  { category: "Supplies & Inventory", keywords: ["supplier", "inventory", "stock", "purchase", "goods"], accountType: "expense" },
  { category: "Bank Charges", keywords: ["fee", "charge", "commission", "service charge"], accountType: "expense" },
  { category: "Tax Payment", keywords: ["vat", "withholding", "tax", "ministry of revenue", "mor"], accountType: "expense" },
  { category: "Loan / Financing", keywords: ["loan", "credit facility", "interest"], accountType: "expense" },
  { category: "Marketing & Advertising", keywords: ["advert", "marketing", "promotion", "facebook ads"], accountType: "expense" },
];

export interface CategorizationResult {
  category: string;
  confidence: number; // 0..1
  matchedKeywords: string[];
}

export function categorizeTransaction(description: string, amount: number, rules: CategoryRule[] = DEFAULT_RULES): CategorizationResult {
  const text = description.toLowerCase();
  let best: CategorizationResult = { category: "Uncategorized", confidence: 0, matchedKeywords: [] };

  for (const rule of rules) {
    const matched = rule.keywords.filter((k) => text.includes(k.toLowerCase()));
    if (matched.length === 0) continue;
    // Confidence grows with number of matched keywords, capped at 0.95.
    const confidence = Math.min(0.5 + matched.length * 0.18, 0.95);
    if (confidence > best.confidence) {
      best = { category: rule.category, confidence, matchedKeywords: matched };
    }
  }

  // Fallback heuristic: positive/incoming amounts with no keyword match are
  // likely sales income; negative/outgoing are likely general expense.
  if (best.category === "Uncategorized") {
    best = amount >= 0
      ? { category: "Other Income", confidence: 0.3, matchedKeywords: [] }
      : { category: "Other Expense", confidence: 0.3, matchedKeywords: [] };
  }

  return best;
}
