/**
 * Tiny leveled logger. JSON output so GitHub Actions artifacts can be
 * post-processed easily (e.g. `jq` over the log file).
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let activeLevel: number = LEVELS.info;

export function setLogLevel(level: Level): void {
  activeLevel = LEVELS[level];
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < activeLevel) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(fields ?? {}),
  };
  // stdout for info+debug, stderr for warn+error
  const line = JSON.stringify(entry);
  if (level === 'warn' || level === 'error') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

export const log = {
  debug: (m: string, f?: Record<string, unknown>) => emit('debug', m, f),
  info: (m: string, f?: Record<string, unknown>) => emit('info', m, f),
  warn: (m: string, f?: Record<string, unknown>) => emit('warn', m, f),
  error: (m: string, f?: Record<string, unknown>) => emit('error', m, f),
};
