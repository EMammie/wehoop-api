import { type Config, describeDbUrl, isLoopbackHost, loadConfig } from '../config.js';
import { createDb } from '../db/client.js';
import { type LeagueCode, LeagueCodeSchema } from '../leagues/codes.js';
import { createLogger } from '../logger.js';
import { KEY_ENV_NAMES } from '../providers/sportradar/resolver.js';
import { QuotaGuard, type QuotaStatus } from './quota-guard.js';

/**
 * `pnpm trial preflight` (plan rev 4.6): what a live run is about to do, with
 * nothing in the output that could be a secret. Prints the mode, the access
 * level, the provider HOSTNAME (never a URL or query string), per product
 * whether its key is present (never a value, never a length), the quota state
 * per product, the database host:port (no credentials) and whether that
 * database is the dev/integration stack that `supabase db reset` destroys.
 * Exit 0 when everything a live run needs is ready; EX_DATAERR (65) with one
 * line per problem otherwise.
 */
export const PREFLIGHT_EXIT_PROBLEMS = 65;

const LEAGUE_CODES: readonly LeagueCode[] = LeagueCodeSchema.options;

export interface PreflightInput {
  config: Config;
  quota: QuotaStatus[];
  /** Null when the database answered; otherwise a short reason (never the URL). */
  dbError: string | null;
  /** Whether migration 0011 (ingest.provider_rate_slots) is applied on that database. */
  rateSlotsTable: boolean;
}

export interface PreflightReport {
  lines: string[];
  problems: string[];
  ready: boolean;
}

export function composePreflight(input: PreflightInput): PreflightReport {
  const { config, quota } = input;
  const lines: string[] = [];
  const problems: string[] = [];
  const hostname = (() => {
    try {
      return new URL(config.sportradar.baseUrl).hostname;
    } catch {
      return '<unparseable>';
    }
  })();
  lines.push(`mode            ${config.mode}`);
  lines.push(`accessLevel     ${config.sportradar.accessLevel}`);
  lines.push(
    `provider        ${hostname}${config.rehearsal ? '  (rehearsal: loopback stand-in, never quota-counted)' : ''}`,
  );
  lines.push(
    `database        ${describeDbUrl(config.db.url)}  dev/integration stack: ${config.devStackDb ? 'YES (supabase db reset / pnpm test:int erase it)' : 'no'}`,
  );
  if (config.db.sessionUrl !== config.db.url) {
    lines.push(`database(sess)  ${describeDbUrl(config.db.sessionUrl)}`);
  }
  lines.push(`supabase        ${describeHttpUrl(config.supabase.url)}`);
  const pairing = stackPairing(config.supabase.url, config.db.url);
  if (pairing !== null) problems.push(pairing);
  if (config.mode === 'sim') problems.push('MODE=sim: a live run needs MODE=trial (or production)');
  const present: LeagueCode[] = [];
  for (const league of LEAGUE_CODES) {
    const has = config.sportradar.keys[league] !== undefined;
    if (has) present.push(league);
    lines.push(
      `key ${league.padEnd(11)} ${has ? 'present' : 'missing'}  (${KEY_ENV_NAMES[league]})`,
    );
  }
  if (present.length === 0) problems.push('no SPORTRADAR_*_KEY present');
  if (input.dbError !== null) {
    lines.push(`quota           unavailable: ${input.dbError}`);
    problems.push(`database unreachable (${describeDbUrl(config.db.url)}): ${input.dbError}`);
  } else {
    if (!input.rateSlotsTable) {
      problems.push(
        'database schema is behind: ingest.provider_rate_slots (migration 0011) is missing; run `pnpm trial:db migration up --local` (trial stack) or `pnpm supabase db reset` (dev stack)',
      );
    }
    for (const league of LEAGUE_CODES) {
      const q = quota.find((s) => s.product === league);
      const keyed = present.includes(league);
      if (!q) {
        lines.push(`quota ${league.padEnd(9)} no ingest.product_quotas row`);
        if (keyed) problems.push(`no ingest.product_quotas row for ${league}`);
        continue;
      }
      const envName = `QUOTA_${league.toUpperCase()}`;
      let state: string;
      if (q.overridden) {
        state = `env-override (${envName}) limit ${q.limit30d} reserve ${q.reserve} used ${q.used30d} spendable ${q.spendable}`;
        if (keyed) {
          problems.push(
            `${envName} is set: an environment override replaces the verified database values; leave it blank`,
          );
        }
      } else if (q.verifiedAt === null) {
        state = 'UNVERIFIED';
        if (keyed) {
          problems.push(
            `quota ${league} UNVERIFIED: run \`pnpm trial:live quota --product ${league} --limit-30d <console value> --reserve 100 --note "console <date>"\``,
          );
        }
      } else {
        state = `verified ${q.verifiedAt.toISOString().slice(0, 10)} limit ${q.limit30d} reserve ${q.reserve} used ${q.used30d} spendable ${q.spendable}`;
        if (keyed && q.spendable <= 0) {
          problems.push(
            `quota ${league}: nothing spendable (remaining ${q.remaining} - reserved ${q.reserved} - reserve ${q.reserve} = ${q.spendable})`,
          );
        }
      }
      lines.push(`quota ${league.padEnd(9)} ${state}`);
    }
  }
  if (config.devStackDb && !config.rehearsal && config.mode !== 'sim') {
    problems.push(
      `database is the dev/integration stack (${describeDbUrl(config.db.url)}) with TRIAL_ALLOW_DEV_DB=1: a \`supabase db reset\` or \`pnpm test:int\` would erase the quota ledger; use the trial stack (\`pnpm trial:db start\`)`,
    );
  }
  return { lines, problems, ready: problems.length === 0 };
}

/** `host:port` of an http(s) URL (default port filled in), never its path, query or credentials. */
function describeHttpUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`;
  } catch {
    return '<unparseable>';
  }
}

/**
 * A local Supabase stack exposes its API on port P and its database on P+1 (dev 54321/54322,
 * trial 55321/55322). When either URL is a loopback host, both must be, on one stack; a hosted
 * project (no loopback on either side) is not checked here. Returns the problem text or null.
 */
export function stackPairing(supabaseUrl: string, databaseUrl: string): string | null {
  let api: URL;
  let db: URL;
  try {
    api = new URL(supabaseUrl);
    db = new URL(databaseUrl);
  } catch {
    return null; // loadConfig already validated both as URLs
  }
  const apiLocal = isLoopbackHost(api.hostname);
  const dbLocal = isLoopbackHost(db.hostname);
  if (!apiLocal && !dbLocal) return null;
  const apiPort = Number(api.port || (api.protocol === 'https:' ? 443 : 80));
  const dbPort = Number(db.port || 5432);
  if (apiLocal && dbLocal && dbPort === apiPort + 1) return null;
  return `SUPABASE_URL and DATABASE_URL point at different stacks (${describeHttpUrl(supabaseUrl)} vs ${describeDbUrl(databaseUrl)}; a local stack is API port P, database port P+1)`;
}

/** Load config (its refusals are problems too), ask the database, print, return the exit code. */
export async function runPreflight(
  env: Record<string, string | undefined>,
  out: (line: string) => void,
): Promise<number> {
  let config: Config;
  try {
    config = loadConfig(env);
  } catch (err) {
    out('preflight: configuration refused');
    for (const line of (err as Error).message.split('\n'))
      if (line.trim()) out(`  - ${line.trim()}`);
    return PREFLIGHT_EXIT_PROBLEMS;
  }
  const db = createDb(config.db.url, { max: 1 });
  let quota: QuotaStatus[] = [];
  let dbError: string | null = null;
  let rateSlotsTable = false;
  try {
    const [t] = await db<{ ok: boolean }[]>`
      select to_regclass('ingest.provider_rate_slots') is not null as ok`;
    rateSlotsTable = t?.ok ?? false;
    const guard = new QuotaGuard({
      db,
      log: createLogger({ level: 'silent', pretty: false }),
      overrides: config.quotaOverrides,
    });
    quota = await guard.status();
  } catch (err) {
    const e = err as { code?: string; message?: string };
    // Codes only (ECONNREFUSED, 28P01, 3D000 ...): a driver message could echo the URL.
    dbError = e.code ?? 'error';
  } finally {
    await db.end({ timeout: 2 }).catch(() => undefined);
  }
  const report = composePreflight({ config, quota, dbError, rateSlotsTable });
  for (const line of report.lines) out(line);
  if (report.ready) {
    out('ready: yes');
    return 0;
  }
  out(`ready: NO (${report.problems.length} problem${report.problems.length === 1 ? '' : 's'})`);
  for (const p of report.problems) out(`  - ${p}`);
  return PREFLIGHT_EXIT_PROBLEMS;
}
