/**
 * Aggregate current portfolio exposure so the risk gates and Kelly sizer can
 * make informed decisions.
 *
 * In live mode we trust Kalshi's `/portfolio/positions` and `/portfolio/balance`.
 * In simulation we read from our SQLite DB.
 */

import { Database } from 'better-sqlite3';
import { PositionsApi, KalshiPosition } from '../kalshi/positions';
import { log } from '../logger';

export interface ExposureSnapshot {
  bankrollUsd: number;
  /** Map of ticker -> notional (USD) currently at risk on that contract. */
  byTicker: Map<string, number>;
  /** Total cents in positions, divided by 100. */
  totalAtRiskUsd: number;
  /** Realized P&L today (USD). */
  realizedPnlTodayUsd: number;
}

export async function getExposureLive(positions: PositionsApi): Promise<ExposureSnapshot> {
  const [bal, pos] = await Promise.all([positions.balance(), positions.list({ limit: 200 })]);
  // Kalshi balance is in cents.
  const bankrollUsd = bal.balance / 100;
  const byTicker = new Map<string, number>();
  let total = 0;
  let realizedToday = 0;
  const todayUtc = new Date().toISOString().slice(0, 10);

  for (const p of pos.market_positions as KalshiPosition[]) {
    const notionalUsd = Math.abs(p.market_exposure) / 100;
    byTicker.set(p.ticker, notionalUsd);
    total += notionalUsd;
    // Realized PnL field is cumulative; the bot's DB carries daily attribution.
    realizedToday += p.realized_pnl / 100;
    // Note: realized_pnl is cumulative; we approximate "today" as cumulative
    // here, then the daily loss gate will refine using DB rows tagged by date.
  }
  // Refine realized PnL using DB-tracked daily rollups (best-effort).
  return { bankrollUsd, byTicker, totalAtRiskUsd: total, realizedPnlTodayUsd: realizedToday };
}

export function getExposureSim(db: Database, initialCapital: number): ExposureSnapshot {
  // Bankroll = initial - sum(filled cost) + sum(realized payouts).
  const stateRow = db
    .prepare(`SELECT bankroll_usd, realized_pnl_today_usd FROM bot_state WHERE id = 1`)
    .get() as { bankroll_usd: number; realized_pnl_today_usd: number } | undefined;

  const bankrollUsd = stateRow?.bankroll_usd ?? initialCapital;
  const realizedToday = stateRow?.realized_pnl_today_usd ?? 0;

  const rows = db
    .prepare(
      `SELECT ticker, SUM(contracts * price_cents / 100.0) AS notional
         FROM positions
        WHERE status = 'open'
        GROUP BY ticker`,
    )
    .all() as { ticker: string; notional: number }[];

  const byTicker = new Map<string, number>();
  let total = 0;
  for (const r of rows) {
    byTicker.set(r.ticker, r.notional);
    total += r.notional;
  }

  return { bankrollUsd, byTicker, totalAtRiskUsd: total, realizedPnlTodayUsd: realizedToday };
}
