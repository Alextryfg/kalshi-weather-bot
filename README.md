# Kalshi Weather Bot

Automated trader for Kalshi weather prediction-market contracts. Pulls weather forecasts from Open-Meteo (GraphCast + GFS ensemble), compares its model probability to the implied probability in each market's order book, sizes trades with half-Kelly, and only enters when a five-gate risk filter is satisfied.

Runs on GitHub Actions every 30 minutes. Defaults to **SIMULATION mode** with a $1000 virtual bankroll — you must opt into live trading explicitly in two places.

---

## ⚠️ Safety disclaimers — read first

1. **This is software that can lose real money.** Kalshi contracts are CFTC-regulated event contracts. Treat any live deployment the same way you would treat trading any other regulated derivative: with capital you can afford to lose, after you understand the model.
2. **The forecast model is a baseline.** It combines two NWP models (GraphCast and GFS) into a Normal distribution over hourly temperatures. It does not currently use ensemble spread, station observations, climatology, or microclimate adjustments. Real edge against the Kalshi book is uncertain and may not exist for your chosen markets.
3. **Live mode requires dual opt-in.** Both `EXECUTION_MODE=live` (env) *and* `--live` (CLI flag) must be set. Any inconsistency drops back to simulation with a loud warning. This is intentional — it makes "oops, real trade" failure modes harder.
4. **Test against `demo-api.kalshi.co` first.** The default `.env.example` points to demo. Only change `KALSHI_API_BASE` when you have run the bot end-to-end against demo for several days.
5. **You are responsible for compliance.** Kalshi access is restricted in some jurisdictions. Verify you're eligible to trade before going live.

---

## Architecture

```
src/
├── bot.ts                  Orchestrator: forecast → scan → edge → gate → size → place
├── config.ts               Env+CLI loader with dual-control safety for live mode
├── logger.ts               Structured JSON logger
├── kalshi/
│   ├── client.ts           REST client + RSA-PSS-SHA256 request signing
│   ├── orders.ts           POST / DELETE / GET /portfolio/orders
│   └── positions.ts        /portfolio/positions, balance, fills
├── weather/
│   ├── forecast.ts         Open-Meteo fetcher (GraphCast + GFS seamless)
│   └── models.ts           Normal-CDF probability for temp / precip markets
├── engine/
│   ├── pricing.ts          Order book → implied probability + liquidity
│   └── edge.ts             Edge = modelProb − marketProb, side selection
├── sizing/
│   ├── kelly.ts            Half-Kelly with hard cap
│   └── position.ts         Aggregate exposure (live & sim)
├── risk/
│   ├── gatekeeper.ts       5-gate filter (liquidity, vol, concentration, daily-loss, time)
│   └── validator.ts        Structural order validation
└── db/
    ├── schema.sql          Tables: bot_state, decisions, orders, positions, pnl_history, price_history
    └── index.ts            better-sqlite3 wrapper
```

### Trade loop

1. **Fetch forecasts** for configured cities from Open-Meteo. Two models are queried; the spread between them is added to a 1.5°F baseline σ.
2. **List markets** by series ticker (`HIGHNY`, `LOWCHI`, …) and pull the order book for each.
3. **Compute model probability** for the parsed contract (e.g. "high temp NYC on 2025-05-19 > 75°F" → P(max(hourly) > 75) under N(μ, σ²)).
4. **Compute edge** = modelProb − impliedMid. If |edge| < `MIN_EDGE_PP`, log "no_edge" and skip.
5. **Provisional size** with half-Kelly to know the trade's notional.
6. **5-gate filter**:
   - **Gate 1 — Liquidity:** top-of-book depth on both sides ≥ `MIN_ORDERBOOK_DEPTH`.
   - **Gate 2 — Volatility:** range of midpoints over the last hour ≤ `MAX_VOLATILITY_PP_1H` pp.
   - **Gate 3 — Concentration:** post-trade notional on this ticker ≤ `MAX_POSITION_FRACTION` × bankroll.
   - **Gate 4 — Daily-loss cap:** today's realized P&L not worse than −`DAILY_LOSS_CAP_FRACTION` × bankroll.
   - **Gate 5 — Settlement clock:** market close is ≥ `MIN_HOURS_TO_SETTLEMENT` away.
7. **Place a limit order** 1¢ inside the best opposing offer (passive maker). In sim mode, the order is logged + assumed filled.
8. **Manage open positions**: mark to mid each cycle; close at `STOP_LOSS_PP` adverse move.

### Database tables

- `bot_state` — singleton row with bankroll, P&L, daily reset date
- `decisions` — every scan decision, including rejects (gate failures, no edge)
- `orders` — every order sent (or simulated)
- `positions` — open / closed lots with realized P&L
- `pnl_history` — daily rollups
- `price_history` — mid-price observations for the volatility gate

---

## Setup

### Prerequisites

- Node.js ≥ 18 (workflow uses 20)
- Python (for `better-sqlite3`'s native build) and a C compiler — on Ubuntu: `sudo apt install build-essential python3`
- A Kalshi account with API credentials. Generate a key in the Kalshi web UI under **Account → API Keys**; download the private key PEM file.

### Local install

```bash
git clone <your-fork>
cd kalshi-weather-bot
npm ci
cp .env.example .env
# Edit .env: paste your KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY_PATH
mkdir data
npm run migrate
npm run simulate     # paper-trade once
```

### Running the tests

```bash
npm test
```

19 unit tests covering Kelly sizing, edge computation, normal CDF, market-ticker parsing, order-book summary, and each of the 5 risk gates.

### Switching to live

1. Verify the bot has been running cleanly in simulation against `demo-api.kalshi.co` for ≥ 7 days.
2. In `.env` (or repo secrets): set `KALSHI_API_BASE=https://api.elections.kalshi.com/trade-api/v2` and `EXECUTION_MODE=live`.
3. Run with the `--live` flag: `npm run live`. The bot refuses to send live orders unless BOTH conditions are met.

### GitHub Actions setup

1. Push this repo to GitHub.
2. Settings → Secrets and variables → Actions:
   - **Secret** `KALSHI_API_KEY_ID` — your API key UUID
   - **Secret** `KALSHI_PRIVATE_KEY` — the PEM contents (multi-line OK)
   - **Variable** `KALSHI_API_BASE` (optional) — defaults to demo
   - **Variable** `WEATHER_CITIES` (optional) — defaults to `New York,Chicago`
3. The workflow runs every 30 minutes. By default it stays in simulation. To do an ad-hoc live run, trigger **workflow_dispatch** and pick `live`.
4. The bot's SQLite database is cached between runs via `actions/cache`. Each run uploads `data/` + logs as an artifact for inspection.

> **Production note:** GitHub Actions cache is best-effort. For real money operation, replace the cache step with persistent storage (S3, Postgres, or Cloudflare R2).

---

## Configuration reference

| Env var | Default | Meaning |
| --- | --- | --- |
| `EXECUTION_MODE` | `simulation` | `simulation` or `live`. Live also needs `--live` CLI flag. |
| `SIM_INITIAL_CAPITAL` | `1000` | Starting virtual bankroll (USD). |
| `KALSHI_API_BASE` | demo URL | Switch to prod URL when ready. |
| `KALSHI_API_KEY_ID` | — | UUID from Kalshi. Required in live mode. |
| `KALSHI_PRIVATE_KEY` | — | PEM string (with `\n`). OR set `KALSHI_PRIVATE_KEY_PATH`. |
| `WEATHER_CITIES` | `New York,Chicago` | Comma-separated. Supports NYC, Chicago, LA, London. |
| `MIN_EDGE_PP` | `0.5` | Minimum |edge| (pp) to consider a trade. |
| `KELLY_FRACTION` | `0.5` | Kelly multiplier. 0.5 = half-Kelly. |
| `MAX_TRADE_FRACTION` | `0.05` | Hard cap per trade as fraction of bankroll. |
| `STOP_LOSS_PP` | `2.0` | Close position if mark moves this far against entry. |
| `MIN_ORDERBOOK_DEPTH` | `50` | Gate 1 threshold (contracts at top of book). |
| `MAX_VOLATILITY_PP_1H` | `20` | Gate 2 threshold (mid-price 1h range). |
| `MAX_POSITION_FRACTION` | `0.10` | Gate 3 threshold (per-ticker exposure). |
| `DAILY_LOSS_CAP_FRACTION` | `0.10` | Gate 4 threshold (today's realized loss). |
| `MIN_HOURS_TO_SETTLEMENT` | `6` | Gate 5 threshold. |
| `DB_PATH` | `./data/bot.db` | SQLite file path. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. |

---

## How signing works (Kalshi API auth)

Every authenticated request includes three headers:

```
KALSHI-ACCESS-KEY:       <api_key_id>
KALSHI-ACCESS-TIMESTAMP: <unix_ms>
KALSHI-ACCESS-SIGNATURE: base64(rsa_pss_sha256(privkey, ts + METHOD + path))
```

The signed string is the concatenation of the millisecond timestamp, the uppercase HTTP method, and the URL path *with query string* starting from `/trade-api/v2/...`. The padding is RSA-PSS with MGF1(SHA-256) and a salt length equal to the digest length (32 bytes for SHA-256). See `src/kalshi/client.ts` → `signRequest`.

If Kalshi rotates the scheme, that one method is the only place to update.

---

## Roadmap / open work

- **Better forecast model:** add ensemble spread from ECMWF EPS, climatology blending, station-observation Kalman update.
- **Precipitation markets:** the engine has `probabilityForPrecipMarket` but the ticker parser doesn't yet recognize precipitation series; add `RAINNY-…` style parsing.
- **Settlement reconciliation:** poll `/portfolio/fills` and `/portfolio/settlements` to update `positions.status` and `realized_pnl_usd` deterministically rather than relying on stop-loss + mark-to-mid.
- **Live exposure refresh:** today's daily-PnL gate uses Kalshi's cumulative realized P&L when in live mode; it should attribute fills to the bot's session by client_order_id prefix.
- **Persistent storage:** replace GH Actions cache with S3 / Postgres for production use.
- **Backtesting harness:** replay historical books against historical forecasts to estimate the bot's real win rate before going live.

---

## License

MIT. No warranty of any kind. You assume all trading risk.
