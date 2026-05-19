/**
 * SQLite access layer. Uses better-sqlite3 (synchronous, fast, embedded).
 *
 * Responsibilities:
 *   - Open / create DB file
 *   - Apply schema on first boot
 *   - Initialize the singleton bot_state row
 *   - Expose helpers for recording decisions, orders, positions, P&L
 */

import BetterSqlite3, { Database } from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { log } from '../logger';
import type { BotConfig, ExecutionMode } from '../config';

export interface DecisionRow {
  ts: string;
  ticker: string;
  city?: string;
  modelProb?: number;
  marketProb?: number;
  edgePp?: number;
  side?: 'yes' | 'no';
  decision: 'trade' | 'reject' | 'no_edge';
  gateFailures?: string[];
  reasoning?: Record<string, unknown>;
}

export interface OrderRow {
  ts: string;
  ticker: string;
  side: 'yes' | 'no';
  action: 'buy' | 'sell';
  type: 'limit' | 'market';
  priceCents?: number;
  count: number;
  clientOrderId: string;
  kalshiOrderId?: string;
  status: 'pending' | 'filled' | 'partial' | 'canceled' | 'sim';
  filledCount?: number;
  avgFillCents?: number;
  decisionId?: number;
}

export function openDb(cfg: BotConfig): Database {
  const dir = path.dirname(cfg.dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new BetterSqlite3(cfg.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export function migrate(db: Database, mode: ExecutionMode, initialCapital: number): void {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  db.exec(sql);

  const today = new Date().toISOString().slice(0, 10);
  const existing = db.prepare('SELECT id FROM bot_state WHERE id = 1').get();
  if (!existing) {
    db.prepare(
      `INSERT INTO bot_state (id, mode, bankroll_usd, last_daily_reset_date, updated_at)
       VALUES (1, ?, ?, ?, ?)`,
    ).run(mode, initialCapital, today, new Date().toISOString());
    log.info('db.migrated.initialized', { mode, bankroll: initialCapital });
  } else {
    log.info('db.migrated.existing');
  }

  // Daily reset of realized_pnl_today_usd if we crossed midnight UTC.
  db.prepare(
    `UPDATE bot_state
        SET realized_pnl_today_usd = 0, last_daily_reset_date = ?, updated_at = ?
      WHERE id = 1 AND last_daily_reset_date <> ?`,
  ).run(today, new Date().toISOString(), today);
}

export function recordDecision(db: Database, d: DecisionRow): number {
  const res = db
    .prepare(
      `INSERT INTO decisions (ts, ticker, city, model_prob, market_prob, edge_pp, side, decision, gate_failures, reasoning)
       VALUES (@ts, @ticker, @city, @modelProb, @marketProb, @edgePp, @side, @decision, @gateFailures, @reasoning)`,
    )
    .run({
      ts: d.ts,
      ticker: d.ticker,
      city: d.city ?? null,
      modelProb: d.modelProb ?? null,
      marketProb: d.marketProb ?? null,
      edgePp: d.edgePp ?? null,
      side: d.side ?? null,
      decision: d.decision,
      gateFailures: d.gateFailures?.join(',') ?? null,
      reasoning: d.reasoning ? JSON.stringify(d.reasoning) : null,
    });
  return Number(res.lastInsertRowid);
}

export function recordOrder(db: Database, o: OrderRow): number {
  const res = db
    .prepare(
      `INSERT INTO orders (ts, ticker, side, action, type, price_cents, count, client_order_id, kalshi_order_id, status, filled_count, avg_fill_cents, decision_id)
       VALUES (@ts, @ticker, @side, @action, @type, @priceCents, @count, @clientOrderId, @kalshiOrderId, @status, @filledCount, @avgFillCents, @decisionId)`,
    )
    .run({
      ts: o.ts,
      ticker: o.ticker,
      side: o.side,
      action: o.action,
      type: o.type,
      priceCents: o.priceCents ?? null,
      count: o.count,
      clientOrderId: o.clientOrderId,
      kalshiOrderId: o.kalshiOrderId ?? null,
      status: o.status,
      filledCount: o.filledCount ?? 0,
      avgFillCents: o.avgFillCents ?? null,
      decisionId: o.decisionId ?? null,
    });
  return Number(res.lastInsertRowid);
}

export function recordOpenPosition(
  db: Database,
  args: {
    ticker: string;
    side: 'yes' | 'no';
    contracts: number;
    priceCents: number;
    entryOrderId: number;
  },
): number {
  const res = db
    .prepare(
      `INSERT INTO positions (ticker, side, contracts, price_cents, entry_ts, status, open_order_id)
       VALUES (?, ?, ?, ?, ?, 'open', ?)`,
    )
    .run(args.ticker, args.side, args.contracts, args.priceCents, new Date().toISOString(), args.entryOrderId);
  return Number(res.lastInsertRowid);
}

export function recordPriceObservation(
  db: Database,
  ticker: string,
  midCents: number,
  yesBidCents: number,
  yesAskCents: number,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO price_history (ticker, ts, mid_cents, yes_bid_cents, yes_ask_cents)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(ticker, new Date().toISOString(), Math.round(midCents), yesBidCents, yesAskCents);
}

export function getRecentMids(db: Database, ticker: string, sinceMinutes: number): number[] {
  const since = new Date(Date.now() - sinceMinutes * 60_000).toISOString();
  const rows = db
    .prepare(
      `SELECT mid_cents FROM price_history WHERE ticker = ? AND ts >= ? ORDER BY ts ASC`,
    )
    .all(ticker, since) as { mid_cents: number }[];
  return rows.map((r) => r.mid_cents);
}

export function adjustBankroll(db: Database, deltaUsd: number, realizedPnlDelta = 0): void {
  db.prepare(
    `UPDATE bot_state
        SET bankroll_usd = bankroll_usd + ?,
            realized_pnl_today_usd = realized_pnl_today_usd + ?,
            realized_pnl_total_usd = realized_pnl_total_usd + ?,
            updated_at = ?
      WHERE id = 1`,
  ).run(deltaUsd, realizedPnlDelta, realizedPnlDelta, new Date().toISOString());
}

// CLI entry point: `ts-node src/db/index.ts --migrate`
if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--migrate')) {
    // Load config lazily to avoid circular import at module load.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { loadConfig } = require('../config');
    const cfg = loadConfig(argv);
    const db = openDb(cfg);
    migrate(db, cfg.mode, cfg.simInitialCapital);
    log.info('migrate.done');
    db.close();
  }
}
