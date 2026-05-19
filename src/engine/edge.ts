/**
 * Edge calculation: model probability vs. implied market probability.
 *
 * Definitions:
 *   modelProb  = our forecast of P(YES) ∈ [0,1]
 *   marketProb = mid-implied probability from the order book ∈ [0,1]
 *   edge       = modelProb - marketProb  (signed, ±pp/100)
 *
 * Side selection:
 *   edge > 0    → BUY YES at the ASK (or post a limit 1 cent inside)
 *   edge < 0    → BUY NO  at NO ASK (equivalently SELL YES)
 *
 * The minimum edge threshold is enforced in pp (1pp = 0.01 in probability).
 */

import type { BookSummary } from './pricing';

export interface EdgeDecision {
  modelProb: number;
  marketProb: number;
  /** Signed edge in probability units (positive = model > market). */
  edge: number;
  /** Edge in percentage points (signed). */
  edgePp: number;
  /** "yes" or "no" — which side we should be long. */
  side: 'yes' | 'no';
  /** "fair" market price for the chosen side, in cents. */
  fairPriceCents: number;
  /** Limit-order price (cents) using maker strategy: 1¢ inside best opposing offer. */
  makerLimitCents: number;
  /** True if the absolute edge meets the bot's minimum threshold. */
  meetsThreshold: boolean;
}

export function computeEdge(
  modelProb: number,
  book: BookSummary,
  minEdgePp: number,
): EdgeDecision {
  // Clamp to safe range.
  const p = clamp(modelProb, 0.001, 0.999);
  const marketProb = clamp(book.yesMidProb, 0.001, 0.999);
  const edge = p - marketProb;
  const edgePp = edge * 100;
  const meetsThreshold = Math.abs(edgePp) >= minEdgePp;

  if (edge >= 0) {
    // Long YES. Best ask is `book.yesAsk` (in cents). Post 1¢ below ask as maker.
    const fair = Math.round(p * 100);
    const maker = Math.max(1, Math.min(99, book.yesAsk - 1));
    return {
      modelProb: p,
      marketProb,
      edge,
      edgePp,
      side: 'yes',
      fairPriceCents: fair,
      makerLimitCents: maker,
      meetsThreshold,
    };
  } else {
    // Long NO. Best NO ask = 100 - best YES bid. NO price = 1 - p (in cents).
    const noFair = Math.round((1 - p) * 100);
    const noBestAsk = Math.max(1, Math.min(99, 100 - book.yesBid));
    const maker = Math.max(1, Math.min(99, noBestAsk - 1));
    return {
      modelProb: p,
      marketProb,
      edge,
      edgePp,
      side: 'no',
      fairPriceCents: noFair,
      makerLimitCents: maker,
      meetsThreshold,
    };
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
