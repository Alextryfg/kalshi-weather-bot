/**
 * Portfolio positions & balance.
 *
 * Endpoints:
 *   GET /portfolio/positions   list current contract positions
 *   GET /portfolio/balance     account balance & total payout
 *   GET /portfolio/fills       fills history (for P&L reconciliation)
 */

import { KalshiClient } from './client';

export interface KalshiPosition {
  ticker: string;
  position: number;            // net contracts; positive = long YES, negative = long NO
  market_exposure: number;     // cents
  realized_pnl: number;        // cents
  total_traded: number;
  resting_orders_count?: number;
  fees_paid?: number;
}

export interface KalshiFill {
  trade_id: string;
  order_id: string;
  ticker: string;
  side: 'yes' | 'no';
  action: 'buy' | 'sell';
  yes_price?: number;
  no_price?: number;
  count: number;
  is_taker: boolean;
  created_time: string;
}

export class PositionsApi {
  constructor(private readonly client: KalshiClient) {}

  list(params: { ticker?: string; limit?: number; settlement_status?: string } = {}): Promise<{
    market_positions: KalshiPosition[];
    event_positions?: unknown[];
    cursor?: string;
  }> {
    return this.client.request('GET', '/portfolio/positions', { params, requireAuth: true });
  }

  balance(): Promise<{ balance: number; payout: number }> {
    return this.client.request('GET', '/portfolio/balance', { requireAuth: true });
  }

  fills(params: { ticker?: string; min_ts?: number; limit?: number } = {}): Promise<{
    fills: KalshiFill[];
    cursor?: string;
  }> {
    return this.client.request('GET', '/portfolio/fills', { params, requireAuth: true });
  }
}
