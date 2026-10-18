import { z } from 'zod';
import { type FaultSpec, parseFault } from './ingest/fault.js';

const Mode = z.enum(['sim', 'trial', 'production']);
export type Mode = z.infer<typeof Mode>;

const emptyToUndefined = (v: unknown) => (v === '' ? undefined : v);

export { SPORTRADAR_DEFAULT_BASE_URL } from './providers/sportradar/urls.js';

import { SPORTRADAR_DEFAULT_BASE_URL } from './providers/sportradar/urls.js';

/** Loopback hosts: `localhost`, `::1` (bracketed or not), any `127.x.x.x`, and `0.0.0.0` (binds every local interface). */
export function isLoopbackHost(host: string): boolean {
  return (
    host === 'localhost' ||
    host === '[::1]' ||
    host === '::1' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
    host === '0.0.0.0'
  );
}

/** The host override may only point at this machine: the key travels in `x-api-key`. Unparseable: not loopback (refused). */
export function isLoopbackUrl(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** The local dev/integration Supabase stack (`supabase/config.toml`, db port 54322): `supabase db reset` and `pnpm test:int` destroy it. */
export const DEV_STACK_DB_PORT = 54322;

/**
 * Does this connection string point at the dev/integration stack? Host 127.0.0.1 / localhost /
 * ::1 AND port 54322. The persistent trial stack (`supabase-trial/`, port 55322) is not it.
 */
export function isDevStackUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return isLoopbackHost(u.hostname) && u.port === String(DEV_STACK_DB_PORT);
  } catch {
    return false;
  }
}

/** `host:port` of a connection string, never its credentials (for preflight output and errors). */
export function describeDbUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || '5432'}`;
  } catch {
    return '<unparseable>';
  }
}

const Flag = z.preprocess(emptyToUndefined, z.enum(['0', '1']).default('0'));

/** `QUOTA_<PRODUCT>=<limit_30d>[/<reserve>]`: the console limit, typed by the operator. */
const QuotaOverride = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .regex(/^\d+(\/\d+)?$/, 'expected <limit_30d>[/<reserve>], e.g. 1000/100')
    .transform((v) => {
      const [limit = '0', reserve] = v.split('/');
      return { limit30d: Number(limit), reserve: reserve === undefined ? 100 : Number(reserve) };
    })
    .optional(),
);

const EnvSchema = z.object({
  MODE: Mode.default('sim'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  DATABASE_URL: z.url(),
  DATABASE_SESSION_URL: z.url().optional(),

  SUPABASE_URL: z.url(),
  SUPABASE_ANON_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  SUPABASE_SERVICE_ROLE_KEY: z.preprocess(emptyToUndefined, z.string().optional()),

  SPORTRADAR_WNBA_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  SPORTRADAR_NCAAWB_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  SPORTRADAR_UNRIVALED_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  SPORTRADAR_ACCESS_LEVEL: z.enum(['trial', 'production']).default('trial'),
  SPORTRADAR_PLAYBACK_URL: z.url().default('https://playback.sportradar.com'),
  SPORTRADAR_BASE_URL: z.preprocess(emptyToUndefined, z.url().default(SPORTRADAR_DEFAULT_BASE_URL)),
  QUOTA_WNBA: QuotaOverride,
  QUOTA_NCAAWB: QuotaOverride,
  QUOTA_UNRIVALED: QuotaOverride,
  /** Explicit consent to run trial/production against the dev stack (its quota ledger dies on `db reset`). */
  TRIAL_ALLOW_DEV_DB: Flag,

  PORT: z.coerce.number().int().positive().default(3000),
  ADMIN_BEARER_TOKEN: z.preprocess(emptyToUndefined, z.string().optional()),
  API_BASE_URL: z.preprocess(emptyToUndefined, z.url().optional()),
  WEHOOP_FAULT: z.preprocess(emptyToUndefined, z.string().optional()),
});

export type Env = z.infer<typeof EnvSchema>;

/** Supabase's Supavisor transaction pooler listens on 6543; pgbouncer URLs carry a flag. */
export function looksLikeTransactionPooler(url: string): boolean {
  try {
    const u = new URL(url);
    return u.port === '6543' || u.searchParams.get('pgbouncer') === 'true';
  } catch {
    return false;
  }
}

export interface Config {
  mode: Mode;
  nodeEnv: Env['NODE_ENV'];
  logLevel: Env['LOG_LEVEL'];
  db: { url: string; sessionUrl: string };
  supabase: { url: string; anonKey?: string; serviceRoleKey?: string };
  sportradar: {
    accessLevel: Env['SPORTRADAR_ACCESS_LEVEL'];
    playbackUrl: string;
    /** Production/trial API host; overridable only for a local rehearsal server (never in production). */
    baseUrl: string;
    keys: { wnba?: string; ncaawb?: string; unrivaled?: string };
  };
  /** Console limits typed by the operator (`QUOTA_<PRODUCT>`); override ingest.product_quotas. */
  quotaOverrides: Record<string, { limit30d: number; reserve: number }>;
  /** True when DATABASE_URL (or the session URL) is the dev/integration stack (127.0.0.1:54322). */
  devStackDb: boolean;
  /** True when calls go to a loopback stand-in host (`pnpm sim serve`), never to api.sportradar.com. */
  rehearsal: boolean;
  api: { port: number; adminBearerToken?: string; baseUrl: string };
  /** Crash-point fault injection (see src/ingest/fault.ts). Null unless WEHOOP_FAULT is set. */
  fault: FaultSpec | null;
}

/**
 * Parse process.env (or a supplied record) into a typed Config.
 * Throws a readable error listing every invalid or missing variable.
 * In `trial` / `production` mode the service-role key is required because the
 * worker must publish broadcasts; in `sim` mode it is optional so unit tests
 * and `pnpm sim list` work without a Supabase stack.
 */
export function loadConfig(source: Record<string, string | undefined> = process.env): Config {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join('\n')}`);
  }
  const e = parsed.data;

  const problems: string[] = [];
  if (e.MODE !== 'sim') {
    if (!e.SUPABASE_SERVICE_ROLE_KEY)
      problems.push(`SUPABASE_SERVICE_ROLE_KEY is required when MODE=${e.MODE}`);
    if (!e.DATABASE_SESSION_URL) {
      problems.push(
        `DATABASE_SESSION_URL is required when MODE=${e.MODE} (advisory lock + LISTEN need a session-mode connection)`,
      );
    }
    if (!e.SPORTRADAR_WNBA_KEY && !e.SPORTRADAR_NCAAWB_KEY && !e.SPORTRADAR_UNRIVALED_KEY) {
      problems.push(`at least one SPORTRADAR_*_KEY is required when MODE=${e.MODE}`);
    }
  }
  if (e.MODE === 'production' && e.WEHOOP_FAULT) {
    problems.push('WEHOOP_FAULT must not be set when MODE=production');
  }
  if (e.MODE === 'production' && e.SPORTRADAR_ACCESS_LEVEL !== 'production') {
    problems.push('SPORTRADAR_ACCESS_LEVEL must be "production" when MODE=production');
  }
  if (e.SPORTRADAR_BASE_URL !== SPORTRADAR_DEFAULT_BASE_URL) {
    if (e.MODE === 'production') {
      problems.push(
        `SPORTRADAR_BASE_URL must be ${SPORTRADAR_DEFAULT_BASE_URL} when MODE=production (the override exists for local rehearsal servers only)`,
      );
    } else if (!isLoopbackUrl(e.SPORTRADAR_BASE_URL)) {
      problems.push(
        'SPORTRADAR_BASE_URL may only point at a loopback host (127.x.x.x, localhost, ::1, 0.0.0.0): the API key is sent to it',
      );
    }
  }
  const sessionUrl = e.DATABASE_SESSION_URL ?? e.DATABASE_URL;
  if (looksLikeTransactionPooler(sessionUrl)) {
    problems.push(
      'DATABASE_SESSION_URL points at a transaction-mode pooler (port 6543 / pgbouncer=true); advisory locks and LISTEN would silently not work',
    );
  }
  // Ledger protection (rev 4.6). The quota ledger (ingest.provider_calls, budget_reservations,
  // product_quotas.verified_at, provider_rate_slots) is the only record of what a trial key has
  // spent; Sportradar keeps counting whether or not we remember. The dev stack is reset by
  // `supabase db reset` and by `pnpm test:int`, so a live run must use the persistent trial
  // stack (`supabase-trial/`, port 55322) unless the operator says otherwise explicitly. A
  // rehearsal (loopback SPORTRADAR_BASE_URL) spends nothing and is exempt.
  const rehearsal = e.SPORTRADAR_BASE_URL !== SPORTRADAR_DEFAULT_BASE_URL;
  const devStackDb = isDevStackUrl(e.DATABASE_URL) || isDevStackUrl(sessionUrl);
  if (e.MODE !== 'sim' && !rehearsal && devStackDb && e.TRIAL_ALLOW_DEV_DB !== '1') {
    problems.push(
      `DATABASE_URL points at the dev/integration stack (${describeDbUrl(e.DATABASE_URL)}) while MODE=${e.MODE} would spend real quota: \`supabase db reset\` and \`pnpm test:int\` erase that database, and with it the quota ledger (provider_calls, reservations, verified limits, rate slots) while Sportradar still counts every call. Point DATABASE_URL / DATABASE_SESSION_URL / SUPABASE_* at the persistent trial stack (\`pnpm trial:db start\`, port 55322, see .env.example) or set TRIAL_ALLOW_DEV_DB=1 to accept the loss`,
    );
  }
  if (problems.length > 0) throw new Error(`Invalid environment:\n  ${problems.join('\n  ')}`);

  return {
    mode: e.MODE,
    nodeEnv: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    db: { url: e.DATABASE_URL, sessionUrl },
    supabase: {
      url: e.SUPABASE_URL,
      ...(e.SUPABASE_ANON_KEY ? { anonKey: e.SUPABASE_ANON_KEY } : {}),
      ...(e.SUPABASE_SERVICE_ROLE_KEY ? { serviceRoleKey: e.SUPABASE_SERVICE_ROLE_KEY } : {}),
    },
    sportradar: {
      accessLevel: e.SPORTRADAR_ACCESS_LEVEL,
      playbackUrl: e.SPORTRADAR_PLAYBACK_URL,
      baseUrl: e.SPORTRADAR_BASE_URL,
      keys: {
        ...(e.SPORTRADAR_WNBA_KEY ? { wnba: e.SPORTRADAR_WNBA_KEY } : {}),
        ...(e.SPORTRADAR_NCAAWB_KEY ? { ncaawb: e.SPORTRADAR_NCAAWB_KEY } : {}),
        ...(e.SPORTRADAR_UNRIVALED_KEY ? { unrivaled: e.SPORTRADAR_UNRIVALED_KEY } : {}),
      },
    },
    quotaOverrides: {
      ...(e.QUOTA_WNBA ? { wnba: e.QUOTA_WNBA } : {}),
      ...(e.QUOTA_NCAAWB ? { ncaawb: e.QUOTA_NCAAWB } : {}),
      ...(e.QUOTA_UNRIVALED ? { unrivaled: e.QUOTA_UNRIVALED } : {}),
    },
    devStackDb,
    rehearsal,
    api: {
      port: e.PORT,
      ...(e.ADMIN_BEARER_TOKEN ? { adminBearerToken: e.ADMIN_BEARER_TOKEN } : {}),
      baseUrl: e.API_BASE_URL ?? `http://127.0.0.1:${e.PORT}`,
    },
    fault: parseFault(e.WEHOOP_FAULT),
  };
}
