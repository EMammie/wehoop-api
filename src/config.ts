import { z } from 'zod';

const Mode = z.enum(['sim', 'trial', 'production']);
export type Mode = z.infer<typeof Mode>;

const emptyToUndefined = (v: unknown) => (v === '' ? undefined : v);

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

  PORT: z.coerce.number().int().positive().default(3000),
  ADMIN_BEARER_TOKEN: z.preprocess(emptyToUndefined, z.string().optional()),
});

export type Env = z.infer<typeof EnvSchema>;

export interface Config {
  mode: Mode;
  nodeEnv: Env['NODE_ENV'];
  logLevel: Env['LOG_LEVEL'];
  db: { url: string; sessionUrl: string };
  supabase: { url: string; anonKey?: string; serviceRoleKey?: string };
  sportradar: {
    accessLevel: Env['SPORTRADAR_ACCESS_LEVEL'];
    playbackUrl: string;
    keys: { wnba?: string; ncaawb?: string; unrivaled?: string };
  };
  api: { port: number; adminBearerToken?: string };
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

  if (e.MODE !== 'sim' && !e.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(`SUPABASE_SERVICE_ROLE_KEY is required when MODE=${e.MODE}`);
  }

  return {
    mode: e.MODE,
    nodeEnv: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    db: { url: e.DATABASE_URL, sessionUrl: e.DATABASE_SESSION_URL ?? e.DATABASE_URL },
    supabase: {
      url: e.SUPABASE_URL,
      ...(e.SUPABASE_ANON_KEY ? { anonKey: e.SUPABASE_ANON_KEY } : {}),
      ...(e.SUPABASE_SERVICE_ROLE_KEY ? { serviceRoleKey: e.SUPABASE_SERVICE_ROLE_KEY } : {}),
    },
    sportradar: {
      accessLevel: e.SPORTRADAR_ACCESS_LEVEL,
      playbackUrl: e.SPORTRADAR_PLAYBACK_URL,
      keys: {
        ...(e.SPORTRADAR_WNBA_KEY ? { wnba: e.SPORTRADAR_WNBA_KEY } : {}),
        ...(e.SPORTRADAR_NCAAWB_KEY ? { ncaawb: e.SPORTRADAR_NCAAWB_KEY } : {}),
        ...(e.SPORTRADAR_UNRIVALED_KEY ? { unrivaled: e.SPORTRADAR_UNRIVALED_KEY } : {}),
      },
    },
    api: {
      port: e.PORT,
      ...(e.ADMIN_BEARER_TOKEN ? { adminBearerToken: e.ADMIN_BEARER_TOKEN } : {}),
    },
  };
}
