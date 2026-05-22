/**
 * Main bot orchestrator.
 *
 * Flow (per invocation, ~once every 30 minutes by GH Actions cron):
 *   1. Load config + open DB + apply migrations
 *   2. Fetch weather forecasts for configured cities
 *   3. List Kalshi weather markets (filtered to high-liquidity active contracts)
 *   4. For each market:
 *        a. Parse ticker -> (city, date, comparison, threshold)
 *        b. Pull order book; record mid price for volatility gate
 *        c. Compute model probability from forecast
 *        d. Compute edge vs market
 *        e. If edge meets threshold: check 5 risk gates, size with half-Kelly, place limit order
 *        f. Log decision either way
 *   5. Manage existing positions (stop-loss check)
 *   6. Roll daily P&L into history
 *   7. Exit (so the GH Actions runner can wrap up)
 *
 * IMPORTANT: This is a thin orchestrator. All real logic lives in the
 * specialized modules; this file is mostly glue + control flow.
 */

import * as fs from 'fs';
import * as path from 'path';
import { loadConfig, BotConfig } from './config';
import { log, setLogLevel } from './logger';
import { openDb, migrate, recordDecision, recordOrder, recordOpenPosition,
         recordPriceObservation, getRecentMids, adjustBankroll } from './db';
import { KalshiClient, KalshiMarket } from './kalshi/client';
import { OrdersApi } from './kalshi/orders';
import { PositionsApi } from './kalshi/positions';
import { fetchForecasts, CityForecast, CITY_COORDS } from './weather/forecast';
import { probabilityForTempMarket } from './weather/models';
import { summarizeBook, summarizeFromMarketQuotes, BookSummary } from './engine/pricing';
import { computeEdge } from './engine/edge';
import { checkRiskGates } from './risk/gatekeeper';
import { validateOrder } from './risk/validator';
import { halfKellySize } from './sizing/kelly';
import { getExposureLive, getExposureSim, ExposureSnapshot } from './sizing/position';
import * as crypto from 'crypto';

// ----------------------------------------------------------------------------
// Ticker parsing
// ----------------------------------------------------------------------------
//
// Kalshi weather tickers follow predictable patterns within a series. Examples
// (real schemas may evolve; the bot soft-fails when a ticker can't be parsed):
//
//   HIGHNY-25MAY19-T75    -> High temp NYC on 2025-05-19, threshold 75°F (>)
//   HIGHCHI-25MAY19-B70.75  -> High temp Chicago, between 70 and 75°F
//   LOWLAX-25MAY19-T55    -> Low temp LA, threshold 55°F (<)
//
// The series ticker prefix encodes the city:
//   HIGHNY, LOWNY     -> New York
//   HIGHCHI, LOWCHI   -> Chicago
//   HIGHLAX, LOWLAX   -> Los Angeles
//   HIGHLON, LOWLON   -> London
//
// If Kalshi's actual schema differs, override `parseWeatherTicker` here.

const CITY_PREFIX: Record<string, string> = {
  NY: 'New York',  CHI: 'Chicago',  LAX: 'Los Angeles',  LON: 'London',
};

interface ParsedTicker {
  city: string;
  aggregate: 'high' | 'low';
  comparison: 'greater' | 'less' | 'between';
  thresholdF: number;
  upperF?: number;
  /** Local date (YYYY-MM-DD) the contract covers. */
  date: string;
}

function parseWeatherTicker(ticker: string): ParsedTicker | null {
  // Strip optional KX prefix (Kalshi renamed series HIGHNY -> KXHIGHNY in 2025)
  const stripped = ticker.replace(/^KX/, '');
  // Match "HIGH<city>-<YYMMMDD>-<rest>" or "LOW<city>-<YYMMMDD>-<rest>"
  const m = stripped.match(/^(HIGH|LOW)([A-Z]{2,4})-(\d{2}[A-Z]{3}\d{2})-(.+)$/);
  if (!m) return null;
  const [, hl, cityCode, dateCode, tail] = m;
  const city = CITY_PREFIX[cityCode];
  if (!city) return null;

  // Date: "25MAY19" -> "2025-05-19"
  const yy = Number(dateCode.slice(0, 2));
  const mon = dateCode.slice(2, 5);
  const dd = Number(dateCode.slice(5, 7));
  const months: Record<string, number> = {
    JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
    JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
  };
  const mm = months[mon];
  if (!mm) return null;
  const date = `20${String(yy).padStart(2, '0')}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;

  // Threshold: T<num>=greater (YES if > T), L<num>=less (YES if < T), B<a>.<b>=between
  let comparison: ParsedTicker['comparison'];
  let thresholdF: number;
  let upperF: number | undefined;

  if (tail.startsWith('T')) {
    comparison = 'greater';
    thresholdF = Number(tail.slice(1));
  } else if (tail.startsWith('L')) {
    comparison = 'less';
    thresholdF = Number(tail.slice(1));
  } else if (tail.startsWith('B')) {
    // Kalshi 'between' format: B<lower>.<upper-fractional>
    // e.g. B95.5 = [94, 96] or more precisely lower=94, upper=96
    // The number after B is the midpoint; bounds are mid±1
    // e.g. B95.5 -> lower=94, upper=96 (2°F bin centred at 95)
    // Confirmed by ticker spacing: B95.5,B93.5,B91.5... (2°F apart)
    const mid = Number(tail.slice(1));
    comparison = 'between';
    thresholdF = mid - 1;   // lower bound (exclusive on Kalshi: temp in [lower, upper))
    upperF = mid + 1;        // upper bound
  } else {
    return null;
  }
  if (!Number.isFinite(thresholdF)) return null;

  return {
    city,
    aggregate: hl === 'HIGH' ? 'high' : 'low',
    comparison,
    thresholdF,
    upperF,
    date,
  };
}

// ----------------------------------------------------------------------------
// Forecast lookup
// ----------------------------------------------------------------------------

function hoursForDate(forecast: CityForecast, dateLocal: string) {
  return Array.from(forecast.hourly.values()).filter((h) => h.time.startsWith(dateLocal));
}

// ----------------------------------------------------------------------------
// Main entrypoint
// ----------------------------------------------------------------------------

async function main(): Promise<void> {
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);
  log.info('bot.start', {
    mode: cfg.mode,
    dryRun: cfg.dryRun,
    cities: cfg.weatherCities,
    apiBase: cfg.kalshiApiBase,
  });

  const db = openDb(cfg);

  if (cfg.resetSim && cfg.mode === 'simulation') {
    db.prepare('DROP TABLE IF EXISTS bot_state').run();
    db.prepare('DROP TABLE IF EXISTS positions').run();
    db.prepare('DROP TABLE IF EXISTS orders').run();
    db.prepare('DROP TABLE IF EXISTS decisions').run();
    db.prepare('DROP TABLE IF EXISTS pnl_history').run();
    log.info('bot.sim_reset');
  }

  migrate(db, cfg.mode, cfg.simInitialCapital);

  const kalshi = new KalshiClient(cfg);
  const ordersApi = new OrdersApi(kalshi);
  const positionsApi = new PositionsApi(kalshi);

  let exposure: ExposureSnapshot;
  if (cfg.mode === 'live') {
    try {
      exposure = await getExposureLive(positionsApi);
    } catch (e) {
      log.error('exposure.live.failed.using_sim_fallback', { err: (e as Error).message });
      exposure = getExposureSim(db, cfg.simInitialCapital);
    }
  } else {
    exposure = getExposureSim(db, cfg.simInitialCapital);
  }
  log.info('exposure', {
    bankroll: exposure.bankrollUsd,
    atRisk: exposure.totalAtRiskUsd,
    realizedToday: exposure.realizedPnlTodayUsd,
  });

  try {
    // Manage existing positions (stop-loss and settlement) FIRST so exposure is accurate, but we already got exposure. That's fine.
    await manageOpenPositions({ cfg, db, kalshi, ordersApi });
    await settleOpenPositions({ cfg, db, kalshi });

    // 1. Fetch forecasts
    const forecasts = await fetchForecasts(cfg.weatherCities);
    if (forecasts.size === 0) {
      log.error('bot.no_forecasts');
      return;
    }

  // 2. List weather markets.
  // Kalshi series naming has changed over time (HIGHNY, KXHIGHNY, etc.)
  // Strategy: try several known prefixes, plus a broad category fallback.
  const cityCodes = cfg.weatherCities
    .map((c) => Object.entries(CITY_PREFIX).find(([, n]) => n === c)?.[0])
    .filter((c): c is string => !!c);

  const seriesCandidates = cityCodes.flatMap((code) => [
    `HIGH${code}`, `LOW${code}`,
    `KXHIGH${code}`, `KXLOW${code}`,
  ]);

  const seen = new Set<string>();
  const candidates: KalshiMarket[] = [];

  for (const s of seriesCandidates) {
    try {
      const res = await kalshi.listMarkets({ series_ticker: s, status: 'open', limit: 100 });
      for (const m of res.markets ?? []) {
        if (!seen.has(m.ticker)) { seen.add(m.ticker); candidates.push(m); }
      }
    } catch (e) {
      log.debug('markets.series.miss', { series: s, err: (e as Error).message });
    }
  }

  // Broad category fallback — catches future naming changes
  if (candidates.length === 0) {
    try {
      const res = await kalshi.listMarkets({ category: 'weather', status: 'open', limit: 200 });
      for (const m of res.markets ?? []) {
        if (!seen.has(m.ticker)) { seen.add(m.ticker); candidates.push(m); }
      }
      log.info('markets.category_fallback', { found: candidates.length });
    } catch (e) {
      log.warn('markets.category_fallback.failed', { err: (e as Error).message });
    }
  }
  log.info('markets.fetched', { count: candidates.length });

  // 4. Iterate markets
  for (const m of candidates) {
    try {
      await processMarket({ cfg, db, kalshi, ordersApi, market: m, forecasts, exposure });
    } catch (e) {
      log.error('market.process.failed', { ticker: m.ticker, err: (e as Error).message });
    }
  }

  } finally {
    // 6. Generate summary
    dumpSummary({ db, exposure, cfg });
    log.info('bot.done');
    db.close();
  }
}


interface ProcessCtx {
  cfg: BotConfig;
  db: ReturnType<typeof openDb>;
  kalshi: KalshiClient;
  ordersApi: OrdersApi;
  market: KalshiMarket;
  forecasts: Map<string, CityForecast>;
  exposure: ExposureSnapshot;
}

async function processMarket(ctx: ProcessCtx): Promise<void> {
  const { cfg, db, kalshi, ordersApi, market, forecasts, exposure } = ctx;
  const parsed = parseWeatherTicker(market.ticker);
  if (!parsed) {
    log.debug('market.unparseable', { ticker: market.ticker });
    return;
  }
  const fc = forecasts.get(parsed.city);
  if (!fc) {
    log.debug('market.no_forecast_for_city', { ticker: market.ticker, city: parsed.city });
    return;
  }
  const hours = hoursForDate(fc, parsed.date);
  if (hours.length === 0) {
    log.debug('market.no_hours_in_window', { ticker: market.ticker, date: parsed.date });
    return;
  }

  // Order book
  let book: BookSummary;
  try {
    const ob = await kalshi.getOrderbook(market.ticker, 10);
    book = summarizeBook(ob);
    log.debug('orderbook.summary', { ticker: market.ticker, yesBid: book.yesBid, yesAsk: book.yesAsk, mid: book.yesMidProb.toFixed(3), depth: book.topDepthMin });
  } catch (e) {
    log.warn('orderbook.failed.using_quotes', { ticker: market.ticker, err: (e as Error).message });
    book = summarizeFromMarketQuotes(market);
  }

  recordPriceObservation(
    db,
    market.ticker,
    book.yesMidProb * 100,
    book.yesBid,
    book.yesAsk,
  );

  // Model probability — currently only temperature contracts; precipitation
  // markets can be wired in via probabilityForPrecipMarket when needed.
  const modelProb = probabilityForTempMarket({
    hours,
    aggregate: parsed.aggregate,
    comparison: parsed.comparison,
    thresholdF: parsed.thresholdF,
    upperThresholdF: parsed.upperF,
  });

  const decision = computeEdge(modelProb, book, cfg.minEdgePp);
  const ts = new Date().toISOString();

  if (!decision.meetsThreshold) {
    recordDecision(db, {
      ts,
      ticker: market.ticker,
      city: parsed.city,
      modelProb,
      marketProb: book.yesMidProb,
      edgePp: decision.edgePp,
      side: decision.side,
      decision: 'no_edge',
      reasoning: { parsed, book },
    });
    return;
  }

  // Recent mids for volatility gate
  const recentMids = getRecentMids(db, market.ticker, 60);

  // Estimate proposed notional BEFORE Kelly to evaluate concentration gate
  // (use the maker limit price as cost basis).
  const pricePer = decision.makerLimitCents;
  const provisionalSize = halfKellySize({
    pWin: decision.side === 'yes' ? modelProb : 1 - modelProb,
    pricePerContractCents: pricePer,
    bankrollUsd: exposure.bankrollUsd,
    kellyFraction: cfg.kellyFraction,
    maxTradeFraction: cfg.maxTradeFraction,
  });
  const proposedNotionalUsd = (provisionalSize.contracts * pricePer) / 100;

  // Risk gates
  const gates = checkRiskGates({
    cfg,
    market,
    book,
    side: decision.side,
    recentMidsCents: recentMids,
    exposure,
    proposedNotionalUsd,
  });

  if (!gates.pass || provisionalSize.contracts < 1) {
    recordDecision(db, {
      ts,
      ticker: market.ticker,
      city: parsed.city,
      modelProb,
      marketProb: book.yesMidProb,
      edgePp: decision.edgePp,
      side: decision.side,
      decision: 'reject',
      gateFailures: provisionalSize.contracts < 1 ? [...gates.reasons, 'size_zero'] : gates.reasons,
      reasoning: { parsed, kelly: provisionalSize, makerCents: pricePer },
    });
    return;
  }

  // Build the order
  const clientOrderId = crypto.randomUUID();
  const orderReq = {
    ticker: market.ticker,
    action: 'buy' as const,
    side: decision.side,
    type: 'limit' as const,
    count: provisionalSize.contracts,
    price: pricePer,
    clientOrderId,
  };
  const validation = validateOrder(orderReq);
  if (!validation.ok) {
    log.error('order.validation.failed', { ticker: market.ticker, errors: validation.errors });
    recordDecision(db, {
      ts,
      ticker: market.ticker,
      city: parsed.city,
      decision: 'reject',
      gateFailures: ['validation:' + validation.errors.join(';')],
    });
    return;
  }

  const decisionId = recordDecision(db, {
    ts,
    ticker: market.ticker,
    city: parsed.city,
    modelProb,
    marketProb: book.yesMidProb,
    edgePp: decision.edgePp,
    side: decision.side,
    decision: 'trade',
    reasoning: { parsed, kelly: provisionalSize, makerCents: pricePer, book },
  });

  // Place it (or simulate)
  if (cfg.mode === 'simulation' || cfg.dryRun) {
    const orderId = recordOrder(db, {
      ts,
      ticker: market.ticker,
      side: decision.side,
      action: 'buy',
      type: 'limit',
      priceCents: pricePer,
      count: provisionalSize.contracts,
      clientOrderId,
      status: 'sim',
      filledCount: provisionalSize.contracts, // assume full fill in sim
      avgFillCents: pricePer,
      decisionId,
    });
    recordOpenPosition(db, {
      ticker: market.ticker,
      side: decision.side,
      contracts: provisionalSize.contracts,
      priceCents: pricePer,
      entryOrderId: orderId,
    });
    // Adjust simulated bankroll: pay cost up front.
    adjustBankroll(db, -(provisionalSize.contracts * pricePer) / 100);
    log.info('order.simulated', {
      ticker: market.ticker,
      side: decision.side,
      count: provisionalSize.contracts,
      price: pricePer,
      edgePp: decision.edgePp,
    });
  } else {
    try {
      const res = await ordersApi.place(orderReq);
      recordOrder(db, {
        ts,
        ticker: market.ticker,
        side: decision.side,
        action: 'buy',
        type: 'limit',
        priceCents: pricePer,
        count: provisionalSize.contracts,
        clientOrderId,
        kalshiOrderId: res.order.order_id,
        status: 'pending',
        decisionId,
      });
      log.info('order.placed.live', {
        ticker: market.ticker,
        side: decision.side,
        count: provisionalSize.contracts,
        price: pricePer,
        orderId: res.order.order_id,
      });
    } catch (e) {
      log.error('order.place.failed', { ticker: market.ticker, err: (e as Error).message });
    }
  }
}

async function manageOpenPositions(args: {
  cfg: BotConfig;
  db: ReturnType<typeof openDb>;
  kalshi: KalshiClient;
  ordersApi: OrdersApi;
}): Promise<void> {
  const { cfg, db, kalshi, ordersApi } = args;
  const open = db
    .prepare(
      // Skip positions opened in this run (within last 2 min) to avoid
      // immediate stop-loss from a stale book at a different price than entry.
      `SELECT id, ticker, side, contracts, price_cents FROM positions
       WHERE status = 'open' AND entry_ts < datetime('now', '-2 minutes')`,
    )
    .all() as { id: number; ticker: string; side: 'yes' | 'no'; contracts: number; price_cents: number }[];

  for (const p of open) {
    try {
      const ob = await kalshi.getOrderbook(p.ticker, 5);
      const book = summarizeBook(ob);
      // For long YES: mark to mid (yesMidProb*100). For long NO: mark to (1 - mid).
      const markCents = p.side === 'yes' ? book.yesMidProb * 100 : (1 - book.yesMidProb) * 100;
      const movePp = markCents - p.price_cents; // positive = winning
      if (-movePp >= cfg.stopLossPp) {
        log.info('stop_loss.triggered', { ticker: p.ticker, entry: p.price_cents, mark: markCents.toFixed(1) });
        // Close: sell same side at best bid (cross the spread).
        const closePriceCents = p.side === 'yes' ? Math.max(1, book.yesBid) : Math.max(1, 100 - book.yesAsk);
        if (cfg.mode === 'simulation' || cfg.dryRun) {
          const realized = (closePriceCents - p.price_cents) * p.contracts / 100;
          db.prepare(
            `UPDATE positions SET status='closed', exit_ts=?, exit_price_cents=?, realized_pnl_usd=?, close_reason='stop_loss' WHERE id=?`,
          ).run(new Date().toISOString(), closePriceCents, realized, p.id);
          adjustBankroll(db, (closePriceCents * p.contracts) / 100, realized);
          log.info('position.closed.sim', { ticker: p.ticker, realized });
        } else {
          // Live: send a sell limit at best bid.
          try {
            await ordersApi.place({
              ticker: p.ticker,
              action: 'sell',
              side: p.side,
              type: 'limit',
              count: p.contracts,
              price: closePriceCents,
            });
            // Reconciliation of the actual fill happens on the next run via Kalshi fills/positions.
          } catch (e) {
            log.error('stop_loss.order.failed', { ticker: p.ticker, err: (e as Error).message });
          }
        }
      }
    } catch (e) {
      log.warn('manage.position.failed', { ticker: p.ticker, err: (e as Error).message });
    }
  }
}

async function settleOpenPositions(args: {
  cfg: BotConfig;
  db: ReturnType<typeof openDb>;
  kalshi: KalshiClient;
}): Promise<void> {
  const { cfg, db, kalshi } = args;
  // Get all open positions
  const open = db
    .prepare(`SELECT id, ticker, side, contracts, price_cents, entry_ts FROM positions WHERE status = 'open'`)
    .all() as { id: number; ticker: string; side: 'yes' | 'no'; contracts: number; price_cents: number; entry_ts: string }[];

  for (const p of open) {
    try {
      const res = await kalshi.getMarket(p.ticker);
      const m = res.market;
      if (m.status === 'settled' || m.status === 'determined') {
        let win = false;
        if (m.result) {
          win = (m.result === p.side);
        } else if (m.last_price !== undefined) {
          win = (p.side === 'yes' && m.last_price === 100) || (p.side === 'no' && m.last_price === 0);
        } else {
          continue; // Cannot determine result yet
        }
        
        const closePriceCents = win ? 100 : 0;
        const realized = (closePriceCents - p.price_cents) * p.contracts / 100;
        
        if (cfg.mode === 'simulation' || cfg.dryRun) {
          db.prepare(
            `UPDATE positions SET status='closed', exit_ts=?, exit_price_cents=?, realized_pnl_usd=?, close_reason='settled' WHERE id=?`,
          ).run(new Date().toISOString(), closePriceCents, realized, p.id);
          adjustBankroll(db, (closePriceCents * p.contracts) / 100, realized);
          log.info('position.settled.sim', { ticker: p.ticker, win, realized });
        } else {
          // Live mode handles payout in Kalshi balance, but we still need to update our DB status
          db.prepare(
            `UPDATE positions SET status='closed', exit_ts=?, exit_price_cents=?, realized_pnl_usd=?, close_reason='settled' WHERE id=?`,
          ).run(new Date().toISOString(), closePriceCents, realized, p.id);
          // In live mode adjustBankroll isn't strictly needed for bankroll (as it's read from API) but we want to track realized PnL
          adjustBankroll(db, 0, realized);
          log.info('position.settled.live', { ticker: p.ticker, win, realized });
        }
        
        // Update pnl_history
        const today = new Date().toISOString().slice(0, 10);
        db.prepare(`
          INSERT INTO pnl_history (date, realized_pnl_usd, trades_closed)
          VALUES (?, ?, 1)
          ON CONFLICT(date) DO UPDATE SET 
            realized_pnl_usd = realized_pnl_usd + ?,
            trades_closed = trades_closed + 1
        `).run(today, realized, realized);
      }
    } catch (e) {
      log.warn('settle.position.failed', { ticker: p.ticker, err: (e as Error).message });
    }
  }
}

function dumpSummary(args: {
  db: ReturnType<typeof openDb>;
  exposure: any;
  cfg: BotConfig;
}): void {
  const { db, exposure, cfg } = args;
  try {
    const state = db.prepare('SELECT * FROM bot_state WHERE id = 1').get() as any;
    const openPos = db.prepare('SELECT ticker, side, contracts, price_cents, entry_ts FROM positions WHERE status = "open" ORDER BY entry_ts DESC').all();
    const recentDecs = db.prepare('SELECT ts, ticker, city, model_prob as model_prob, market_prob as market_prob, edge_pp, side, decision, gate_failures FROM decisions ORDER BY ts DESC LIMIT 50').all();
    const recentOrds = db.prepare('SELECT ts, ticker, side, action, price_cents, count, status, avg_fill_cents FROM orders ORDER BY ts DESC LIMIT 50').all();
    const pnlHist = db.prepare('SELECT date, realized_pnl_usd FROM pnl_history ORDER BY date DESC LIMIT 14').all();

    const summary = {
      generated_at: new Date().toISOString(),
      mode: state?.mode || cfg.mode,
      bankroll_usd: exposure.bankrollUsd,
      realized_pnl_today_usd: state?.realized_pnl_today_usd || 0,
      realized_pnl_total_usd: state?.realized_pnl_total_usd || 0,
      open_positions: openPos,
      recent_decisions: recentDecs,
      recent_orders: recentOrds,
      pnl_history: pnlHist,
    };

    const outPath = path.join(__dirname, '..', 'docs', 'summary.json');
    if (!fs.existsSync(path.dirname(outPath))) {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
    }
    fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
    log.info('summary.dumped', { path: outPath });
  } catch (e) {
    log.error('summary.dump.failed', { err: (e as Error).message });
  }
}

// Silence the unused-import warning for CITY_COORDS; it's a public re-export
// for downstream callers and is intentionally imported for side-effect of
// keeping the city table referenced.
void CITY_COORDS;

if (require.main === module) {
  main().catch((e) => {
    log.error('bot.fatal', { err: (e as Error).message, stack: (e as Error).stack });
    process.exit(1);
  });
}

export { main, parseWeatherTicker };
