/**
 * Edge calculation: model probability vs. implied market probability.
 *
 * After computing raw edge (modelProb - marketProb), we subtract estimated
 * trading friction (Kalshi fees + bid-ask spread) before comparing to the
 * minimum threshold. This prevents taking trades that look profitable on
 * paper but lose money after costs.
 */

import type { BookSummary } from './pricing';

// Estimated round-trip costs in percentage points
const KALSHI_FEE_PP = 2.0;    // ~7% fee on profit, amortised
const SPREAD_COST_PP = 3.0;   // typical bid-ask crossing cost in+out
const FRICTION_PP = KALSHI_FEE_PP + SPREAD_COST_PP;

export interface EdgeDecision {
  modelProb: number;
  marketProb: number;
  edge: number;
  edgePp: number;
  /** Net edge after subtracting estimated friction. */
  netEdgePp: number;
  side: 'yes' | 'no';
  fairPriceCents: number;
  makerLimitCents: number;
  meetsThreshold: boolean;
}

export function computeEdge(
  modelProb: number,
  book: BookSummary,
  minEdgePp: number,
): EdgeDecision {
  const p = clamp(modelProb, 0.001, 0.999);
  const marketProb = clamp(book.yesMidProb, 0.001, 0.999);
  const edge = p - marketProb;
  const edgePp = edge * 100;

  if (edge >= 0) {
    const netEdgePp = edgePp - FRICTION_PP;
    const meetsThreshold = netEdgePp >= minEdgePp;
    const fair = Math.round(p * 100);
    const maker = Math.max(1, Math.min(99, book.yesAsk - 1));
    return { modelProb: p, marketProb, edge, edgePp, netEdgePp, side: 'yes',
             fairPriceCents: fair, makerLimitCents: maker, meetsThreshold };
  } else {
    const noEdgePp = -edgePp;
    const netEdgePp = noEdgePp - FRICTION_PP;
    const meetsThreshold = netEdgePp >= minEdgePp;
    const noFair = Math.round((1 - p) * 100);
    const noBestAsk = Math.max(1, Math.min(99, 100 - book.yesBid));
    const maker = Math.max(1, Math.min(99, noBestAsk - 1));
    return { modelProb: p, marketProb, edge, edgePp, netEdgePp, side: 'no',
             fairPriceCents: noFair, makerLimitCents: maker, meetsThreshold };
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
