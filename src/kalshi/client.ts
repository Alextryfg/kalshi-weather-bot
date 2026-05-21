/**
 * Kalshi REST API client.
 *
 * Authentication scheme (per Kalshi docs as of 2024+):
 *   Headers on every request:
 *     KALSHI-ACCESS-KEY:       <api_key_id (UUID)>
 *     KALSHI-ACCESS-TIMESTAMP: <unix ms as string>
 *     KALSHI-ACCESS-SIGNATURE: <base64 RSA-PSS-SHA256 signature of `timestamp + METHOD + path`>
 *
 * Notes:
 *   - The signed string concatenates: `${timestamp}${methodUpper}${pathWithoutHost}`
 *     where path is everything after the host, INCLUDING the `/trade-api/v2` prefix
 *     and the query string (if any).
 *   - RSA-PSS with MGF1(SHA-256), salt length = digest length (SHA-256 = 32 bytes).
 *   - Signature is base64-encoded.
 *
 * If Kalshi rotates the scheme, only `signRequest` here needs updating.
 */

import axios, { AxiosInstance, AxiosRequestConfig, AxiosError } from 'axios';
import axiosRetry from 'axios-retry';
import * as crypto from 'crypto';
import { log } from '../logger';
import type { BotConfig } from '../config';

export type HttpMethod = 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH';

export class KalshiClient {
  private readonly http: AxiosInstance;
  private readonly keyId: string;
  private readonly privateKeyPem: string;
  private readonly authEnabled: boolean;

  constructor(cfg: BotConfig) {
    this.keyId = cfg.kalshiApiKeyId;
    this.privateKeyPem = cfg.kalshiPrivateKeyPem;
    // In simulation we still read public endpoints (markets, order books).
    // Auth is enabled only when we have credentials.
    this.authEnabled = Boolean(this.keyId && this.privateKeyPem);

    this.http = axios.create({
      baseURL: cfg.kalshiApiBase,
      timeout: 15_000,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    });

    // Exponential backoff on transient errors and 429s.
    axiosRetry(this.http, {
      retries: 4,
      retryDelay: (count, err) => {
        // Honor Retry-After header if present.
        const ra = err?.response?.headers?.['retry-after'];
        if (ra) {
          const sec = Number(ra);
          if (Number.isFinite(sec)) return sec * 1000;
        }
        return Math.min(8000, 500 * 2 ** count) + Math.floor(Math.random() * 250);
      },
      retryCondition: (err: AxiosError) => {
        if (axiosRetry.isNetworkOrIdempotentRequestError(err)) return true;
        const s = err.response?.status;
        return s === 429 || (s !== undefined && s >= 500 && s < 600);
      },
    });
  }

  /**
   * Build & attach RSA-PSS-SHA256 signature headers.
   * The signed string MUST match exactly what Kalshi's server reconstructs:
   *   timestamp(ms) + METHOD(upper) + path-with-query (starts at /trade-api/v2/...)
   */
  private signRequest(method: HttpMethod, pathWithQuery: string): Record<string, string> {
    if (!this.authEnabled) return {};
    const timestamp = Date.now().toString();
    const message = `${timestamp}${method}${pathWithQuery}`;

    const signature = crypto
      .sign('sha256', Buffer.from(message, 'utf8'), {
        key: this.privateKeyPem,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST, // = 32 for SHA-256
      })
      .toString('base64');

    return {
      'KALSHI-ACCESS-KEY': this.keyId,
      'KALSHI-ACCESS-TIMESTAMP': timestamp,
      'KALSHI-ACCESS-SIGNATURE': signature,
    };
  }

  /**
   * Build the path-with-query that goes into the signature. axios will
   * eventually request `baseURL + path + ?query`, but the signature uses
   * the path relative to host *including* the `/trade-api/v2` prefix.
   */
  private buildSignedPath(path: string, params?: Record<string, unknown>): string {
    // Extract just the pathname+search from baseURL+path, host-stripped.
    const base = new URL(this.http.defaults.baseURL ?? '');
    const url = new URL(base.pathname.replace(/\/$/, '') + '/' + path.replace(/^\//, ''), base);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null) continue;
        url.searchParams.set(k, String(v));
      }
    }
    return url.pathname + (url.search || '');
  }

  async request<T>(
    method: HttpMethod,
    path: string,
    opts: { params?: Record<string, unknown>; body?: unknown; requireAuth?: boolean } = {},
  ): Promise<T> {
    const signedPath = this.buildSignedPath(path, opts.params);

    if (opts.requireAuth && !this.authEnabled) {
      throw new Error(`Authenticated endpoint ${path} called without API credentials`);
    }

    const headers = this.signRequest(method, signedPath);

    const axiosCfg: AxiosRequestConfig = {
      method,
      // Pass the path as-is; axios will resolve against baseURL.
      url: path,
      params: opts.params,
      data: opts.body,
      headers,
    };

    try {
      const res = await this.http.request<T>(axiosCfg);
      return res.data;
    } catch (err) {
      const ae = err as AxiosError;
      log.error('kalshi.request.failed', {
        method,
        path,
        status: ae.response?.status,
        data: ae.response?.data,
        message: ae.message,
      });
      throw err;
    }
  }

  // ---------- Public endpoints (no auth required) ----------

  /**
   * GET /markets — list markets with optional filters.
   * Common params: series_ticker, event_ticker, status, limit, cursor.
   */
  listMarkets(params: Record<string, unknown> = {}): Promise<KalshiMarketsResponse> {
    return this.request<KalshiMarketsResponse>('GET', '/markets', { params });
  }

  getMarket(ticker: string): Promise<{ market: KalshiMarket }> {
    return this.request<{ market: KalshiMarket }>('GET', `/markets/${encodeURIComponent(ticker)}`);
  }

  getOrderbook(ticker: string, depth = 32): Promise<KalshiOrderbookResponse> {
    return this.request<KalshiOrderbookResponse>(
      'GET',
      `/markets/${encodeURIComponent(ticker)}/orderbook`,
      { params: { depth } },
    );
  }

  // ---------- Authenticated endpoints ----------

  getPortfolioBalance(): Promise<{ balance: number; payout: number }> {
    return this.request('GET', '/portfolio/balance', { requireAuth: true });
  }

  // Wired in detail by ./positions.ts and ./orders.ts to keep this file small.
}

// ---------- Response shapes (best-effort, only fields we use) ----------

export interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  series_ticker?: string;
  title: string;
  subtitle?: string;
  yes_sub_title?: string;
  status: 'initialized' | 'active' | 'closed' | 'settled' | 'determined';
  close_time: string;           // ISO8601
  expected_expiration_time?: string;
  expiration_time?: string;
  yes_bid?: number;             // cents 0-99
  yes_ask?: number;
  no_bid?: number;
  no_ask?: number;
  last_price?: number;
  volume?: number;
  open_interest?: number;
  liquidity?: number;
  // Strike info varies by market type:
  cap_strike?: number;
  floor_strike?: number;
  strike_type?: 'greater' | 'less' | 'between' | 'structured' | string;
  result?: string;
}

export interface KalshiMarketsResponse {
  markets: KalshiMarket[];
  cursor?: string;
}

export interface KalshiOrderbookLevel {
  // Each level is [price_in_cents, size_contracts]
  0: number;
  1: number;
}

export interface KalshiOrderbookResponse {
  orderbook: {
    yes?: KalshiOrderbookLevel[]; // sorted desc by price (best first)
    no?: KalshiOrderbookLevel[];
  };
}
