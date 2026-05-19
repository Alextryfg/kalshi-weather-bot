/**
 * 5-gate risk filter. EVERY potential trade must pass ALL FIVE gates.
 *
 * Gate 1 — Liquidity:        order-book depth at top of book >= MIN_ORDERBOOK_DEPTH
 * Gate 2 — Volatility:       price hasn't moved more than MAX_VOLATILITY_PP_1H in the last hour
 * Gate 3 — Concentration:    after this trade, position notional ≤ MAX_POSITION_FRACTION of bankroll
 * Gate 4 — Daily loss cap:   today's realized P&L isn't worse than -DAILY_LOSS_CAP_FRACTION
 * Gate 5 — Settlement clock: market settlement is at least MIN_HOURS_TO_SETTLEMENT away
 *
 * Each gate returns a Reason string so the decision log explains *why* a
 * candidate was rejected.
 */

import type { BotConfig } from '../config';
import type { BookSummary } from '../engine/pricing';
import type { KalshiMarket } from '../kalshi/client';
import type { ExposureSnapshot } from '../sizing/position';

export interface GateInput {
  cfg: BotConfig;
  market: KalshiMarket;
  book: BookSummary;
  /** Recent mid-prices (cents) for this ticker over the past hour, newest last. */
  recentMidsCents: number[];
  exposure: ExposureSnapshot;
  /** Notional USD this trade would add to ticker's position. */
  proposedNotionalUsd: number;
}

export interface GateResult {
  pass: boolean;
  reasons: string[]; // empty when pass = true
}

export function checkRiskGates(g: GateInput): GateResult {
  const reasons: string[] = [];

  // Gate 1: liquidity
  if (g.book.topDepthMin < g.cfg.minOrderbookDepth) {
    reasons.push(
      `gate1_liquidity: top-of-book depth ${g.book.topDepthMin} < ${g.cfg.minOrderbookDepth}`,
    );
  }

  // Gate 2: volatility — max - min midpoint movement (pp) in window
  if (g.recentMidsCents.length >= 2) {
    const hi = Math.max(...g.recentMidsCents);
    const lo = Math.min(...g.recentMidsCents);
    const movePp = hi - lo; // 1 cent = 1pp
    if (movePp > g.cfg.maxVolatilityPp1h) {
      reasons.push(
        `gate2_volatility: 1h range ${movePp.toFixed(1)}pp > ${g.cfg.maxVolatilityPp1h}pp`,
      );
    }
  }

  // Gate 3: concentration — proposed + existing on this ticker vs bankroll
  const existingOnTicker = g.exposure.byTicker.get(g.market.ticker) ?? 0;
  const afterUsd = existingOnTicker + g.proposedNotionalUsd;
  const fraction = afterUsd / Math.max(0.01, g.exposure.bankrollUsd);
  if (fraction > g.cfg.maxPositionFraction) {
    reasons.push(
      `gate3_concentration: would be ${(fraction * 100).toFixed(1)}% of bankroll ` +
        `(> ${(g.cfg.maxPositionFraction * 100).toFixed(1)}%)`,
    );
  }

  // Gate 4: daily loss cap
  const dailyLossUsd = -g.exposure.realizedPnlTodayUsd; // positive when losing
  const dailyLossFrac = dailyLossUsd / Math.max(0.01, g.exposure.bankrollUsd);
  if (dailyLossFrac >= g.cfg.dailyLossCapFraction) {
    reasons.push(
      `gate4_daily_loss: today -${(dailyLossFrac * 100).toFixed(1)}% ` +
        `>= cap ${(g.cfg.dailyLossCapFraction * 100).toFixed(1)}%`,
    );
  }

  // Gate 5: settlement clock
  const closeTimeStr = g.market.close_time;
  if (!closeTimeStr) {
    reasons.push('gate5_settlement: market has no close_time');
  } else {
    const hoursLeft = (new Date(closeTimeStr).getTime() - Date.now()) / 3_600_000;
    if (!Number.isFinite(hoursLeft) || hoursLeft < g.cfg.minHoursToSettlement) {
      reasons.push(
        `gate5_settlement: ${hoursLeft.toFixed(1)}h to close < ${g.cfg.minHoursToSettlement}h`,
      );
    }
  }

  return { pass: reasons.length === 0, reasons };
}
