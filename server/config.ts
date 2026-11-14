export interface Config {
  host: string;
  port: number;
  dbPath: string;
  /** Absolute session lifetime. */
  sessionTtlSeconds: number;
  cookieSecure: boolean;
  logLevel: string;
}

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];
const MAX_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

function integer(
  name: string,
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
) {
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a whole number, got "${raw}"`);
  }
  const value = Number(raw);
  if (value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}, got ${value}`);
  }
  return value;
}

function boolean(name: string, raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be "true" or "false", got "${raw}"`);
}

/** Reads configuration from environment variables, failing loudly on malformed values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const logLevel = env.NORTHSTAR_LOG_LEVEL || 'info';
  if (!LOG_LEVELS.includes(logLevel)) {
    throw new Error(`NORTHSTAR_LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}`);
  }
  return {
    host: env.NORTHSTAR_HOST || '127.0.0.1',
    port: integer('NORTHSTAR_PORT', env.NORTHSTAR_PORT, 4100, 1, 65_535),
    dbPath: env.NORTHSTAR_DB_PATH || './var/northstar.sqlite',
    sessionTtlSeconds: integer(
      'NORTHSTAR_SESSION_TTL_SECONDS',
      env.NORTHSTAR_SESSION_TTL_SECONDS,
      3600,
      1,
      MAX_SESSION_TTL_SECONDS,
    ),
    cookieSecure: boolean('NORTHSTAR_COOKIE_SECURE', env.NORTHSTAR_COOKIE_SECURE, false),
    logLevel,
  };
}
