/**
 * Order placement / cancellation / listing.
 *
 * Endpoints (Kalshi trade-api v2):
 *   POST   /portfolio/orders          create order
 *   GET    /portfolio/orders          list orders (filter by status/ticker)
 *   DELETE /portfolio/orders/{id}     cancel order
 *
 * Order body fields (see Kalshi API reference):
 *   ticker          string   Market ticker, e.g. "HIGHNY-25MAY19-T75"
 *   action          "buy"|"sell"
 *   side            "yes"|"no"
 *   type            "limit"|"market"
 *   count           int      number of contracts
 *   yes_price       int      cents, 1-99 (required when side=yes & type=limit)
 *   no_price        int      cents, 1-99 (required when side=no & type=limit)
 *   client_order_id string   idempotency key (UUID recommended)
 *   expiration_ts   int      optional unix seconds; 0 = GTC; absent = IOC for market
 */

import * as crypto from 'crypto';
import { KalshiClient } from './client';
import { log } from '../logger';

export type OrderSide = 'yes' | 'no';
export type OrderAction = 'buy' | 'sell';
export type OrderType = 'limit' | 'market';

export interface PlaceOrderRequest {
  ticker: string;
  action: OrderAction;
  side: OrderSide;
  type: OrderType;
  count: number;
  /** Limit price in cents (1-99). Required for limit orders. */
  price?: number;
  /** Defaults to a fresh UUID. */
  clientOrderId?: string;
  /** Optional GTC expiration as unix-seconds. 0 = good-till-cancel. */
  expirationTs?: number;
}

export interface KalshiOrder {
  order_id: string;
  client_order_id?: string;
  ticker: string;
  status: 'resting' | 'canceled' | 'executed' | 'pending' | string;
  yes_price?: number;
  no_price?: number;
  remaining_count?: number;
  filled_count?: number;
  side: OrderSide;
  action: OrderAction;
  type: OrderType;
  created_time?: string;
}

export class OrdersApi {
  constructor(private readonly client: KalshiClient) {}

  async place(req: PlaceOrderRequest): Promise<{ order: KalshiOrder }> {
    const clientOrderId = req.clientOrderId ?? crypto.randomUUID();

    const body: Record<string, unknown> = {
      ticker: req.ticker,
      action: req.action,
      side: req.side,
      type: req.type,
      count: req.count,
      client_order_id: clientOrderId,
    };

    if (req.type === 'limit') {
      if (req.price == null || req.price < 1 || req.price > 99) {
        throw new Error(`Limit price must be integer cents in [1,99], got ${req.price}`);
      }
      // Kalshi uses side-specific price fields.
      if (req.side === 'yes') body.yes_price = Math.round(req.price);
      else body.no_price = Math.round(req.price);
    }
    if (req.expirationTs != null) body.expiration_ts = req.expirationTs;

    log.info('order.place.send', { ...body });
    const res = await this.client.request<{ order: KalshiOrder }>('POST', '/portfolio/orders', {
      body,
      requireAuth: true,
    });
    log.info('order.place.ack', { order_id: res.order.order_id, status: res.order.status });
    return res;
  }

  async cancel(orderId: string): Promise<{ order: KalshiOrder }> {
    return this.client.request('DELETE', `/portfolio/orders/${encodeURIComponent(orderId)}`, {
      requireAuth: true,
    });
  }

  async list(params: { ticker?: string; status?: string; limit?: number } = {}): Promise<{
    orders: KalshiOrder[];
    cursor?: string;
  }> {
    return this.client.request('GET', '/portfolio/orders', { params, requireAuth: true });
  }
}
