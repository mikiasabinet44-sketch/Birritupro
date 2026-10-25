import db from "../../db/index.js";
import { round2 } from "../branch.js";
import { stockOnHand } from "../inventory.js";

const SAFETY_DAYS = 7;   // buffer on top of supplier lead time
const COVER_DAYS = 14;   // how much extra cover a reorder should buy

export interface ReorderSuggestion {
  productId: string; sku: string; name: string; unit: string; branchId: string; branchName: string;
  onHand: number; dailySales: number; daysOfCover: number | null; leadTimeDays: number;
  suggestedQty: number; urgency: "urgent" | "soon"; reason: string; estimatedCost: number;
}
export interface TransferSuggestion { productId: string; name: string; fromBranchId: string; fromBranch: string; toBranchId: string; toBranch: string; qty: number; reason: string }
export interface SlowMover { productId: string; sku: string; name: string; branchName: string; onHand: number; tiedUpValue: number; daysSinceLastSale: number | null }

function netSold(productId: string, branchId: string, days: number): number {
  const r = db.prepare(
    `SELECT COALESCE(-SUM(qty),0) AS q FROM stock_movements
     WHERE product_id = ? AND branch_id = ? AND type IN ('sale','sale_return') AND date >= date('now', ?)`
  ).get(productId, branchId, `-${days} days`) as { q: number };
  return r.q;
}

/**
 * Per product and branch: sales velocity over the last 30 days -> days of cover ->
 * reorder when stock won't outlast supplier lead time + safety buffer. Also finds
 * stock that is idle, and surplus in one branch that could cover a shortfall in another.
 */
export function reorderSuggestions(branchId: string | null) {
  const products = db.prepare(`SELECT * FROM products WHERE active = 1`).all() as any[];
  const branches = db.prepare(`SELECT id, name FROM branches WHERE active = 1`).all() as any[];

  const suggestions: ReorderSuggestion[] = [];
  const slow: SlowMover[] = [];
  const state = new Map<string, Array<{ b: any; onHand: number; velocity: number; need: number; urgent: boolean }>>();

  for (const p of products) {
    const per: Array<{ b: any; onHand: number; velocity: number; need: number; urgent: boolean }> = [];
    for (const b of branches) {
      const onHand = stockOnHand(p.id, b.id);
      const velocity = netSold(p.id, b.id, 30) / 30;
      const horizon = p.lead_time_days + SAFETY_DAYS;
      const reorderPoint = Math.max(p.reorder_level, Math.ceil(velocity * horizon));
      const target = Math.ceil(velocity * (horizon + COVER_DAYS));
      const cover = velocity > 0 ? onHand / velocity : null;
      const needs = (velocity > 0 || p.reorder_level > 0) && onHand <= reorderPoint;
      const suggestedQty = needs ? Math.max(Math.ceil(Math.max(target, p.reorder_level * 2) - onHand), 1) : 0;
      const urgent = needs && (onHand <= 0 || (cover !== null && cover < p.lead_time_days));
      per.push({ b, onHand, velocity, need: suggestedQty, urgent });

      if (needs && (!branchId || branchId === b.id)) {
        suggestions.push({
          productId: p.id, sku: p.sku, name: p.name, unit: p.unit, branchId: b.id, branchName: b.name,
          onHand, dailySales: round2(velocity), daysOfCover: cover === null ? null : round2(cover), leadTimeDays: p.lead_time_days,
          suggestedQty, urgency: urgent ? "urgent" : "soon",
          reason: velocity > 0
            ? `Selling ~${round2(velocity)}/day; ${onHand} left covers ${cover === null ? "n/a" : round2(cover)} day(s) but resupply takes ${p.lead_time_days} day(s).`
            : `At or below the reorder level of ${p.reorder_level}.`,
          estimatedCost: round2(suggestedQty * p.cost_price),
        });
      }

      // Idle stock: on the shelf, nothing sold for 60 days.
      if (onHand > 0 && netSold(p.id, b.id, 60) <= 0 && (!branchId || branchId === b.id)) {
        const last = db.prepare(`SELECT MAX(date) AS d FROM stock_movements WHERE product_id = ? AND branch_id = ? AND type = 'sale'`).get(p.id, b.id) as { d: string | null };
        slow.push({
          productId: p.id, sku: p.sku, name: p.name, branchName: b.name, onHand, tiedUpValue: round2(onHand * p.cost_price),
          daysSinceLastSale: last.d ? Math.round((Date.now() - new Date(last.d).getTime()) / 86400000) : null,
        });
      }
    }
    state.set(p.id, per);
  }

  // Branch-to-branch transfers: move surplus to a branch that is about to run out.
  const transfers: TransferSuggestion[] = [];
  for (const p of products) {
    const per = state.get(p.id) ?? [];
    const horizon = p.lead_time_days + SAFETY_DAYS + COVER_DAYS;
    const short = per.filter((x) => x.urgent && x.need > 0);
    for (const s of short) {
      let remaining = s.need;
      const donors = per
        .filter((x) => x.b.id !== s.b.id && !x.urgent)
        .map((x) => ({ ...x, surplus: Math.floor(x.onHand - Math.max(x.velocity * horizon, p.reorder_level)) }))
        .filter((x) => x.surplus > 0)
        .sort((a, b) => b.surplus - a.surplus);
      for (const d of donors) {
        if (remaining <= 0) break;
        const qty = Math.min(d.surplus, remaining);
        remaining -= qty;
        if (!branchId || branchId === d.b.id || branchId === s.b.id) {
          transfers.push({ productId: p.id, name: p.name, fromBranchId: d.b.id, fromBranch: d.b.name, toBranchId: s.b.id, toBranch: s.b.name, qty, reason: `${d.b.name} holds ${d.onHand} (surplus ${d.surplus}); ${s.b.name} is about to run out. Transferring is faster and cheaper than a new purchase.` });
        }
      }
    }
  }

  suggestions.sort((a, b) => (a.urgency === b.urgency ? 0 : a.urgency === "urgent" ? -1 : 1));
  slow.sort((a, b) => b.tiedUpValue - a.tiedUpValue);
  return { suggestions, transfers, slowMoving: slow };
}
