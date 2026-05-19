-- ============================================================
-- Kalshi Weather Bot — SQLite Schema
-- ============================================================
-- All monetary fields are USD (REAL) unless suffixed `_cents` (INTEGER).
-- All timestamps are ISO8601 UTC strings (TEXT).
-- ============================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Bot singleton state: one row, id=1
CREATE TABLE IF NOT EXISTS bot_state (
  id                       INTEGER PRIMARY KEY CHECK (id = 1),
  mode                     TEXT NOT NULL,                -- 'simulation' | 'live'
  bankroll_usd             REAL NOT NULL,
  realized_pnl_today_usd   REAL NOT NULL DEFAULT 0,
  realized_pnl_total_usd   REAL NOT NULL DEFAULT 0,
  last_daily_reset_date    TEXT NOT NULL,                -- YYYY-MM-DD UTC
  updated_at               TEXT NOT NULL
);

-- Every market-scanning + trade-attempt decision is logged, including rejects.
CREATE TABLE IF NOT EXISTS decisions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                TEXT NOT NULL,
  ticker            TEXT NOT NULL,
  city              TEXT,
  model_prob        REAL,
  market_prob       REAL,
  edge_pp           REAL,
  side              TEXT,                                -- 'yes' | 'no' | NULL
  decision          TEXT NOT NULL,                       -- 'trade' | 'reject' | 'no_edge'
  gate_failures     TEXT,                                -- comma-separated gate ids
  reasoning         TEXT                                 -- free-form JSON
);
CREATE INDEX IF NOT EXISTS idx_decisions_ts ON decisions(ts);
CREATE INDEX IF NOT EXISTS idx_decisions_ticker ON decisions(ticker);

-- Orders we sent (or would have sent in sim).
CREATE TABLE IF NOT EXISTS orders (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                  TEXT NOT NULL,
  ticker              TEXT NOT NULL,
  side                TEXT NOT NULL,                     -- 'yes' | 'no'
  action              TEXT NOT NULL,                     -- 'buy' | 'sell'
  type                TEXT NOT NULL,                     -- 'limit' | 'market'
  price_cents         INTEGER,
  count               INTEGER NOT NULL,
  client_order_id     TEXT NOT NULL UNIQUE,
  kalshi_order_id     TEXT,                              -- NULL in sim
  status              TEXT NOT NULL,                     -- 'pending'|'filled'|'partial'|'canceled'|'sim'
  filled_count        INTEGER NOT NULL DEFAULT 0,
  avg_fill_cents      REAL,
  decision_id         INTEGER REFERENCES decisions(id)
);
CREATE INDEX IF NOT EXISTS idx_orders_ts ON orders(ts);
CREATE INDEX IF NOT EXISTS idx_orders_ticker ON orders(ticker);

-- Open / closed positions (one row per ticker per "lot").
CREATE TABLE IF NOT EXISTS positions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker            TEXT NOT NULL,
  side              TEXT NOT NULL,                       -- 'yes' | 'no'
  contracts         INTEGER NOT NULL,
  price_cents       INTEGER NOT NULL,                    -- avg entry price
  entry_ts          TEXT NOT NULL,
  exit_ts           TEXT,
  exit_price_cents  INTEGER,
  realized_pnl_usd  REAL,
  status            TEXT NOT NULL DEFAULT 'open',        -- 'open'|'closed'
  open_order_id     INTEGER REFERENCES orders(id),
  close_order_id    INTEGER REFERENCES orders(id),
  close_reason      TEXT                                 -- 'settled'|'stop_loss'|'manual'
);
CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
CREATE INDEX IF NOT EXISTS idx_positions_ticker ON positions(ticker);

-- Daily P&L rollup for the dashboard / artifact summary.
CREATE TABLE IF NOT EXISTS pnl_history (
  date              TEXT PRIMARY KEY,                    -- YYYY-MM-DD UTC
  realized_pnl_usd  REAL NOT NULL DEFAULT 0,
  unrealized_pnl_usd REAL NOT NULL DEFAULT 0,
  trades_opened     INTEGER NOT NULL DEFAULT 0,
  trades_closed     INTEGER NOT NULL DEFAULT 0,
  ending_bankroll_usd REAL
);

-- Cached price observations for the 1h volatility gate.
CREATE TABLE IF NOT EXISTS price_history (
  ticker        TEXT NOT NULL,
  ts            TEXT NOT NULL,
  mid_cents     INTEGER NOT NULL,
  yes_bid_cents INTEGER,
  yes_ask_cents INTEGER,
  PRIMARY KEY (ticker, ts)
);
CREATE INDEX IF NOT EXISTS idx_price_history_ticker_ts ON price_history(ticker, ts);
