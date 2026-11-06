import { z } from 'zod';
import { type Config, describeDbUrl } from '../config.js';
import type { Db } from '../db/client.js';

/**
 * What a database is (plan rev 4.15 (4), migration 0014 `ingest.environment`): one row, `dev`,
 * `demo` or `production`; no row = unmarked. Checked at worker / demo start against the
 * database itself, because a connection string alone cannot tell a demo project from a
 * production one:
 *   - MODE=demo runs only on the dev stack (127.0.0.1:54322, unless it is marked otherwise) or a
 *     database marked `demo`;
 *   - MODE=production refuses a database marked `demo` (switching to production selects the
 *     production project; it never depends on a purge of the demo one).
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

/** The rule above as a pure decision (unit-tested); null = allowed, otherwise why not. */
export function environmentProblem(
  mode: Config['mode'],
  devStackDb: boolean,
  kind: EnvironmentKind | null,
  where: string,
): string | null {
  if (mode === 'demo') {
    if (kind === 'demo') return null;
    if (devStackDb && kind === null) return null;
    if (devStackDb && kind === 'dev') return null;
    return `MODE=demo runs only on the dev stack or a database marked demo; ${where} is ${kind === null ? 'unmarked' : `marked ${kind}`} (run \`pnpm demo init\` on a fresh demo project)`;
  }
  if (mode === 'production' && kind === 'demo') {
    return `MODE=production refuses ${where}: it is marked demo (its games are replays); point DATABASE_URL at the production project`;
  }
  return null;
}

/** Throws EnvironmentRefusedError when this mode may not run on this database. */
export async function assertEnvironment(
  db: Db,
  config: Pick<Config, 'mode' | 'devStackDb' | 'db'>,
): Promise<EnvironmentKind | null> {
  const kind = await readEnvironment(db);
  const problem = environmentProblem(
    config.mode,
    config.devStackDb,
    kind,
    describeDbUrl(config.db.url),
  );
  if (problem) throw new EnvironmentRefusedError(problem);
  return kind;
}
