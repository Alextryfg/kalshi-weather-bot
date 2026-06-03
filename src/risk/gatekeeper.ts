/**
 * Risk gates. EVERY potential trade must pass ALL gates.
 *
 * Gate 0a — Extreme price:   limit price within [minPriceCents, maxPriceCents]
 * Gate 0b — Crossing sides:    no open position on same city+date with opposite side
 * Gate 0c — City+date limit:  max MAX_POSITIONS_PER_CITY_DATE positions per city per settlement date
 * Gate 1  — Liquidity:        counterparty depth >= MIN_ORDERBOOK_DEPTH
 * Gate 2  — Volatility:      price hasn't moved > MAX_VOLATILITY_PP_1H in last hour
 * Gate 3  — Concentration:   after trade, position notional <= MAX_POSITION_FRACTION
 * Gate 4  — Daily loss cap:  today's realized P&L not worse than -DAILY_LOSS_CAP_FRACTION
 * Gate 5  — Settlement clock: >= MIN_HOURS_TO_SETTLEMENT remaining
 */

import type { BotConfig } from '../config';
import type { BookSummary } from '../engine/pricing';
import type { KalshiMarket } from '../kalshi/client';
import type { ExposureSnapshot } from '../sizing/position';

export interface GateInput {
  cfg: BotConfig;
  market: KalshiMarket;
  book: BookSummary;
  /** Which side the bot intends to buy. */
  side: 'yes' | 'no';
  /** Recent mid-prices (cents) for this ticker over the past hour, newest last. */
  recentMidsCents: number[];
  exposure: ExposureSnapshot;
  /** Notional USD this trade would add to ticker's position. */
  proposedNotionalUsd: number;
  /** Open positions on the same city+date (to detect crossing sides). */
  openPositionsOnDate: { ticker: string; side: 'yes' | 'no' }[];
}

export interface GateResult {
  pass: boolean;
  reasons: string[];
}

export function checkRiskGates(g: GateInput): GateResult {
  const reasons: string[] = [];

  // Gate 0a: extreme price — books with 5¢ or 95¢ limit prices are phantom liquidity
  const limitPrice = g.side === 'yes' ? g.book.yesAsk : (100 - g.book.yesBid);
  if (limitPrice < g.cfg.minPriceCents || limitPrice > g.cfg.maxPriceCents) {
    reasons.push(
      `gate0a_extreme_price: limit ${limitPrice}¢ outside [${g.cfg.minPriceCents}, ${g.cfg.maxPriceCents}]`,
    );
  }

  // Gate 0b: crossing sides — don't open YES if already holding NO on same city+date
  for (const existing of g.openPositionsOnDate) {
    if (existing.side !== g.side) {
      reasons.push(
        `gate0b_crossing: already have ${existing.side.toUpperCase()} on ${existing.ticker}, ` +
        `would cross with ${g.side.toUpperCase()} on ${g.market.ticker}`,
      );
      break;
    }
  }

  // Gate 0c: city+date concentration — max N posiciones por ciudad+fecha
  // Previene riesgo correlado: comprar NO en 3 ventanas adyacentes de NY el mismo
  // día significa que si la temperatura cae en CUALQUIERA de ellas, una pierde.
  // Límite por defecto: 2 posiciones por ciudad por día.
  if (g.openPositionsOnDate.length >= g.cfg.maxPositionsPerCityDate) {
    reasons.push(
      `gate0c_city_date_limit: already ${g.openPositionsOnDate.length} position(s) ` +
      `on this city+date (max ${g.cfg.maxPositionsPerCityDate})`,
    );
  }

  // Gate 1: liquidity — check counterparty depth
  const relevantDepth = g.side === 'yes' ? g.book.noBidSize : g.book.yesBidSize;
  if (relevantDepth < g.cfg.minOrderbookDepth) {
    reasons.push(
      `gate1_liquidity: counterparty depth ${relevantDepth} < ${g.cfg.minOrderbookDepth}`,
    );
  }

  // Gate 2: volatility — max-min movement in 1h window
  if (g.recentMidsCents.length >= 2) {
    const hi = Math.max(...g.recentMidsCents);
    const lo = Math.min(...g.recentMidsCents);
    const movePp = hi - lo;
    if (movePp > g.cfg.maxVolatilityPp1h) {
      reasons.push(
        `gate2_volatility: 1h range ${movePp.toFixed(1)}pp > ${g.cfg.maxVolatilityPp1h}pp`,
      );
    }
  }

  // Gate 3: concentration
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
  const dailyLossUsd = -g.exposure.realizedPnlTodayUsd;
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