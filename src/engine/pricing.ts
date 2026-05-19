/**
 * Extract implied probability from a Kalshi order book.
 *
 * Kalshi quotes prices in cents (1-99) for both YES and NO contracts that sum
 * (approximately) to 100. The bid-ask midpoint of the YES side gives the
 * cleanest implied probability; we also surface top-of-book depth so the
 * risk gates can check liquidity.
 *
 * Order book shape (from /markets/{ticker}/orderbook):
 *   { orderbook: { yes: [[price, size], ...sorted desc],
 *                  no:  [[price, size], ...sorted desc] } }
 *
 * "Best YES bid" = highest YES bid price.  "Best YES ask" derives from the NO
 * side: if best NO bid is B, the implied best YES ask is (100 - B).
 */

import type { KalshiOrderbookResponse, KalshiOrderbookLevel, KalshiMarket } from '../kalshi/client';

export interface BookSummary {
  /** Best YES bid (cents), 0 if empty. */
  yesBid: number;
  /** Implied best YES ask (cents) = 100 - best NO bid; 100 if no NO bids. */
  yesAsk: number;
  /** Midpoint probability ∈ [0,1]. */
  yesMidProb: number;
  /** Size at top YES bid (contracts). */
  yesBidSize: number;
  /** Size at top NO bid (contracts) — i.e. size offered against a YES buy. */
  noBidSize: number;
  /** Min of top-of-book sizes; used by liquidity gate. */
  topDepthMin: number;
  /** Total contracts across top 5 levels each side; used as secondary liquidity check. */
  totalTop5Depth: number;
  spreadCents: number;
}

function topLevels(levels: KalshiOrderbookLevel[] | undefined): KalshiOrderbookLevel[] {
  if (!levels || levels.length === 0) return [];
  // Sort by price desc to ensure "best" is at index 0.
  return [...levels].sort((a, b) => b[0] - a[0]);
}

export function summarizeBook(book: KalshiOrderbookResponse): BookSummary {
  // Kalshi has used several response shapes:
  //   { orderbook: { yes: [[cents,size],...], no: [...] } }   (v2 documented)
  //   { orderbook_fp: { yes_dollars: [["0.35",size],...], no_dollars: [...] } }  (demo 2025+)
  const raw = book as any;

  let yesBid = 0, yesBidSize = 0, noBid = 0, noBidSize = 0;
  let top5Yes = 0, top5No = 0;

  if (raw.orderbook_fp) {
    // New format: prices in dollar strings e.g. "0.35" = 35 cents
    const yesDollars: [string, string][] = raw.orderbook_fp.yes_dollars ?? [];
    const noDollars: [string, string][] = raw.orderbook_fp.no_dollars ?? [];

    // Best yes bid = highest yes price
    const yesSorted = [...yesDollars].sort((a, b) => parseFloat(b[0]) - parseFloat(a[0]));
    const noSorted  = [...noDollars].sort((a, b) => parseFloat(b[0]) - parseFloat(a[0]));

    if (yesSorted.length > 0) {
      yesBid     = Math.round(parseFloat(yesSorted[0][0]) * 100);
      yesBidSize = parseFloat(yesSorted[0][1]);
    }
    if (noSorted.length > 0) {
      noBid     = Math.round(parseFloat(noSorted[0][0]) * 100);
      noBidSize = parseFloat(noSorted[0][1]);
    }
    top5Yes = yesSorted.slice(0, 5).reduce((a, l) => a + parseFloat(l[1]), 0);
    top5No  = noSorted.slice(0, 5).reduce((a, l) => a + parseFloat(l[1]), 0);
  } else {
    // Legacy format: { orderbook: { yes: [[cents,size],...] } } or flat
    const ob = raw.orderbook ?? raw;
    const yesLevels = topLevels(ob.yes);
    const noLevels  = topLevels(ob.no);
    yesBid      = yesLevels[0]?.[0] ?? 0;
    yesBidSize  = yesLevels[0]?.[1] ?? 0;
    noBid       = noLevels[0]?.[0] ?? 0;
    noBidSize   = noLevels[0]?.[1] ?? 0;
    top5Yes = yesLevels.slice(0, 5).reduce((a, l) => a + (l?.[1] ?? 0), 0);
    top5No  = noLevels.slice(0, 5).reduce((a, l) => a + (l?.[1] ?? 0), 0);
  }

  const yesAsk = noBid > 0 ? 100 - noBid : 100;
  const yesMidCents = yesBid > 0 && yesAsk < 100 ? (yesBid + yesAsk) / 2
                    : yesBid > 0 ? yesBid
                    : yesAsk < 100 ? yesAsk
                    : 50;

  return {
    yesBid,
    yesAsk,
    yesMidProb: yesMidCents / 100,
    yesBidSize,
    noBidSize,
    topDepthMin: Math.min(yesBidSize, noBidSize),
    totalTop5Depth: Math.min(top5Yes, top5No),
    spreadCents: yesAsk - yesBid,
  };
}

/** When a fresh book isn't available, fall back to the market's last quoted bid/ask. */
export function summarizeFromMarketQuotes(m: KalshiMarket): BookSummary {
  const yesBid = m.yes_bid ?? 0;
  const yesAsk = m.yes_ask ?? 100;
  const yesMidCents = yesBid > 0 && yesAsk < 100 ? (yesBid + yesAsk) / 2 : (m.last_price ?? 50);
  return {
    yesBid,
    yesAsk,
    yesMidProb: yesMidCents / 100,
    yesBidSize: 0,
    noBidSize: 0,
    topDepthMin: 0,
    totalTop5Depth: 0,
    spreadCents: yesAsk - yesBid,
  };
}
