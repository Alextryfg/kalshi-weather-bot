/**
 * Pre-trade validator. Final sanity checks AFTER risk gates pass and Kelly
 * sizes the bet. These are simple structural assertions to catch logic bugs
 * before we hit the exchange.
 */

import type { PlaceOrderRequest } from '../kalshi/orders';

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateOrder(req: PlaceOrderRequest): ValidationResult {
  const errors: string[] = [];

  if (!req.ticker || typeof req.ticker !== 'string') errors.push('ticker_missing');
  if (req.count == null || !Number.isInteger(req.count) || req.count < 1) {
    errors.push(`count_invalid: ${req.count}`);
  }
  if (req.type === 'limit') {
    if (req.price == null || !Number.isInteger(req.price) || req.price < 1 || req.price > 99) {
      errors.push(`price_invalid: ${req.price}`);
    }
  }
  if (req.action !== 'buy' && req.action !== 'sell') errors.push(`action_invalid: ${req.action}`);
  if (req.side !== 'yes' && req.side !== 'no') errors.push(`side_invalid: ${req.side}`);

  return { ok: errors.length === 0, errors };
}
