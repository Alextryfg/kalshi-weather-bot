/**
 * Central configuration module.
 *
 * Loads all configuration from environment variables and CLI flags, validates
 * them, and exposes a single immutable `config` object to the rest of the bot.
 *
 * Critical safety invariant: live trading requires BOTH `EXECUTION_MODE=live`
 * env var AND `--live` CLI flag. This dual-control prevents accidental real
 * trades from a stray env file or a stray CLI command.
 */

import 'dotenv/config';
import * as fs from 'fs';

export type ExecutionMode = 'simulation' | 'live';

export interface BotConfig {
  // Execution
  mode: ExecutionMode;
  dryRun: boolean;
  simInitialCapital: number;

  // Kalshi
  kalshiApiBase: string;
  kalshiApiKeyId: string;
  kalshiPrivateKeyPem: string;

  // Strategy
  weatherCities: string[];
  minEdgePp: number;
  kellyFraction: number;
  maxTradeFraction: number;
  stopLossPp: number;

  // Risk gates
  minOrderbookDepth: number;
  maxVolatilityPp1h: number;
  maxPositionFraction: number;
  dailyLossCapFraction: number;
  minHoursToSettlement: number;

  // Infra
  dbPath: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

function readEnv(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function readEnvNum(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Env var ${name} is not a number: ${v}`);
  return n;
}

function loadPrivateKey(): string {
  // Allow either inline PEM or a file path on disk.
  const path = process.env.KALSHI_PRIVATE_KEY_PATH;
  if (path && path.trim() !== '') {
    return fs.readFileSync(path, 'utf8');
  }
  const inline = process.env.KALSHI_PRIVATE_KEY;
  if (inline && inline.trim() !== '') {
    // Allow `\n` literal sequences in env files to be expanded to real newlines.
    return inline.replace(/\\n/g, '\n');
  }
  return ''; // empty is OK in simulation mode
}

export function loadConfig(argv: string[] = process.argv.slice(2)): BotConfig {
  const wantsLive = argv.includes('--live');
  const wantsSim = argv.includes('--simulation');
  const dryRun = argv.includes('--dry-run');

  const envMode = (process.env.EXECUTION_MODE ?? 'simulation').toLowerCase();
  if (envMode !== 'simulation' && envMode !== 'live') {
    throw new Error(`EXECUTION_MODE must be 'simulation' or 'live', got '${envMode}'`);
  }

  // Dual-control: live requires BOTH env=live AND --live flag.
  // Any conflict downgrades to simulation, loudly.
  let mode: ExecutionMode = 'simulation';
  if (envMode === 'live' && wantsLive && !wantsSim) {
    mode = 'live';
  } else if (envMode === 'live' || wantsLive) {
    console.warn(
      '[config] Live mode requested but missing other half of dual-control ' +
        '(need both EXECUTION_MODE=live AND --live flag). Falling back to simulation.',
    );
  }

  const kalshiKeyId = process.env.KALSHI_API_KEY_ID ?? '';
  const privKey = loadPrivateKey();

  if (mode === 'live' && (!kalshiKeyId || !privKey)) {
    throw new Error('Live mode requires KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY[_PATH]');
  }

  const cities = readEnv('WEATHER_CITIES', 'New York,Chicago')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    mode,
    dryRun,
    simInitialCapital: readEnvNum('SIM_INITIAL_CAPITAL', 1000),

    kalshiApiBase: readEnv('KALSHI_API_BASE', 'https://demo-api.kalshi.co/trade-api/v2'),
    kalshiApiKeyId: kalshiKeyId,
    kalshiPrivateKeyPem: privKey,

    weatherCities: cities,
    minEdgePp: readEnvNum('MIN_EDGE_PP', 0.5),
    kellyFraction: readEnvNum('KELLY_FRACTION', 0.5),
    maxTradeFraction: readEnvNum('MAX_TRADE_FRACTION', 0.05),
    stopLossPp: readEnvNum('STOP_LOSS_PP', 2.0),

    minOrderbookDepth: readEnvNum('MIN_ORDERBOOK_DEPTH', 50),
    maxVolatilityPp1h: readEnvNum('MAX_VOLATILITY_PP_1H', 20),
    maxPositionFraction: readEnvNum('MAX_POSITION_FRACTION', 0.10),
    dailyLossCapFraction: readEnvNum('DAILY_LOSS_CAP_FRACTION', 0.10),
    minHoursToSettlement: readEnvNum('MIN_HOURS_TO_SETTLEMENT', 6),

    dbPath: readEnv('DB_PATH', './data/bot.db'),
    logLevel: (readEnv('LOG_LEVEL', 'info') as BotConfig['logLevel']),
  };
}
