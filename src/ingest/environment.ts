import { z } from 'zod';
import { type Config, describeDbUrl } from '../config.js';
import type { Db } from '../db/client.js';
import type { Logger } from '../logger.js';

/**
 * What a database is (plan rev 4.15 (4), migration 0014 `ingest.environment`): one row, `dev`,
 * `demo` or `production`; no row = unmarked. Checked at worker / demo start against the
 * database itself, because a connection string alone cannot tell a demo project from a
 * production one:
 *   - MODE=demo runs only on the dev stack (both URLs at 127.0.0.1:54322, unless it is marked
 *     otherwise) or a database marked `demo`;
 *   - every other mode refuses a database marked `demo` (switching to production selects the
 *     production project; it never depends on a purge of the demo one);
 *   - the production worker marks an unmarked non-dev database `production` at start.
 */
export const EnvironmentKindSchema = z.enum(['dev', 'demo', 'production']);
export type EnvironmentKind = z.infer<typeof EnvironmentKindSchema>;

const EnvironmentRowSchema = z.object({ kind: EnvironmentKindSchema });

export class EnvironmentRefusedError extends Error {}

/**
 * The marker, or null when unmarked. A database without migration 0014 (the persistent trial
 * stack until `pnpm trial:db migration up --local`) is unmarked too, so this check never stops a
 * trial worker that predates the table.
 */
export async function readEnvironment(db: Db): Promise<EnvironmentKind | null> {
  const [exists] = await db<{ ok: boolean }[]>`
    select to_regclass('ingest.environment') is not null as ok`;
  if (!exists?.ok) return null;
  const rows = await db`select kind from ingest.environment`;
  const [row] = rows;
  if (!row) return null;
  return EnvironmentRowSchema.parse(row).kind;
}

/** Mark the database (`pnpm demo init`). Refuses to re-mark a database marked as something else. */
export async function markEnvironment(db: Db, kind: EnvironmentKind, note: string): Promise<void> {
  const current = await readEnvironment(db);
  if (current !== null && current !== kind) {
    throw new EnvironmentRefusedError(
      `this database is marked ${current}; refusing to mark it ${kind}`,
    );
  }
  await db`insert into ingest.environment (singleton, kind, note) values (true, ${kind}, ${note})
           on conflict (singleton) do update set note = excluded.note`;
}

/**
 * The rule above as a pure decision (unit-tested); null = allowed, otherwise why not.
 *   - A database marked `demo` is written only by MODE=demo: production, trial and sim are all
 *     refused (a trial key against a demo database would pass the guard on its synthetic verified
 *     limits and spend real quota unprotected; a sim replay would mix real fixtures into it).
 *   - MODE=demo needs a database marked `demo`, or the dev stack on BOTH connection strings
 *     (`devStackOnly`) and not marked `production`.
 */
export function environmentProblem(
  mode: Config['mode'],
  devStackOnly: boolean,
  kind: EnvironmentKind | null,
  where: string,
): string | null {
  if (mode === 'demo') {
    if (kind === 'demo') return null;
    if (devStackOnly && (kind === null || kind === 'dev')) return null;
    return `MODE=demo runs only on the dev stack (DATABASE_URL and DATABASE_SESSION_URL both 127.0.0.1:54322) or a database marked demo; ${where} is ${kind === null ? 'unmarked' : `marked ${kind}`}${devStackOnly ? '' : ' and not the dev stack on both URLs'} (run \`pnpm demo init\` on a fresh demo project)`;
  }
  if (kind === 'demo') {
    return `MODE=${mode} refuses ${where}: it is marked demo (its games are replays and its product limits synthetic); only MODE=demo (\`pnpm demo\`) writes to it. Point DATABASE_URL at the right project`;
  }
  return null;
}

/** Throws EnvironmentRefusedError when this mode may not run on this database. */
export async function assertEnvironment(
  db: Db,
  config: Pick<Config, 'mode' | 'devStackOnly' | 'db'>,
): Promise<EnvironmentKind | null> {
  const kind = await readEnvironment(db);
  const problem = environmentProblem(
    config.mode,
    config.devStackOnly,
    kind,
    describeDbUrl(config.db.url),
  );
  if (problem) throw new EnvironmentRefusedError(problem);
  return kind;
}

/**
 * MODE=production on a database that is neither marked nor the dev stack: mark it `production`
 * before anything else runs (rev 4.15 review), so `pnpm demo init` refuses it from then on, even
 * while it is still empty (the quiet deploy). Returns the marker now in place. A database without
 * migration 0014 cannot be marked and is left unmarked (logged).
 */
export async function markProductionOnStart(
  db: Db,
  config: Pick<Config, 'mode' | 'devStackDb' | 'db'>,
  log: Logger,
): Promise<EnvironmentKind | null> {
  const kind = await readEnvironment(db);
  if (config.mode !== 'production' || kind !== null || config.devStackDb) return kind;
  const [exists] = await db<{ ok: boolean }[]>`
    select to_regclass('ingest.environment') is not null as ok`;
  if (!exists?.ok) {
    log.warn('ingest.environment missing (migration 0014 not applied); database left unmarked');
    return null;
  }
  await markEnvironment(db, 'production', 'marked by the production worker at start');
  log.warn(
    { database: describeDbUrl(config.db.url) },
    'database was unmarked; marked production (pnpm demo init now refuses it)',
  );
  return 'production';
}

/** For the CLIs: the refusal message, or null when this mode may write to this database. */
export async function environmentRefusal(
  db: Db,
  config: Pick<Config, 'mode' | 'devStackOnly' | 'db'>,
): Promise<string | null> {
  try {
    await assertEnvironment(db, config);
    return null;
  } catch (err) {
    if (err instanceof EnvironmentRefusedError) return err.message;
    throw err;
  }
}
