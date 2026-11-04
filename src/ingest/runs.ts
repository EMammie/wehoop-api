import type { Db } from '../db/client.js';
import type { LeagueCode } from '../leagues/codes.js';

export type RunKind =
  | 'poll_schedule'
  | 'watch_game'
  | 'push_stream'
  | 'replay'
  | 'backfill'
  | 'changes'
  | 'profile';
/** `rehearsal` = trial/production code path against a local stand-in host: rate-limited, never quota-counted. */
export type RunSource = 'production' | 'trial' | 'rehearsal' | 'simulation' | 'fixture';

export interface RunHandle {
  id: number;
  /** Watch generation: coalesce(parent_run_id, id); null for generation-less kinds. */
  watchId: number | null;
}

const GENERATION_KINDS = new Set<RunKind>(['watch_game', 'replay', 'push_stream', 'backfill']);

/** Insert an ingest.ingestion_runs row and return its id and watch generation. */
export async function startRun(
  db: Db,
  run: {
    kind: RunKind;
    league: LeagueCode;
    gameId: string | null;
    source: RunSource;
    parentRunId?: number | null;
    meta?: Record<string, unknown>;
  },
): Promise<RunHandle> {
  const [row] = await db<{ id: string; parentRunId: string | null }[]>`
    insert into ingest.ingestion_runs (kind, league, game_id, source, parent_run_id, meta)
    values (${run.kind}, ${run.league}, ${run.gameId}, ${run.source}, ${run.parentRunId ?? null},
            ${db.json((run.meta ?? {}) as never)})
    returning id::text, parent_run_id::text as "parentRunId"`;
  if (!row) throw new Error('ingestion_runs insert returned no row');
  const id = Number(row.id);
  const watchId = GENERATION_KINDS.has(run.kind)
    ? row.parentRunId
      ? Number(row.parentRunId)
      : id
    : null;
  return { id, watchId };
}

export async function endRun(
  db: Db,
  id: number,
  status: 'ok' | 'error' | 'aborted',
  error?: string,
): Promise<void> {
  await db`update ingest.ingestion_runs
           set ended_at = now(), status = ${status}, error = ${error ?? null}
           where id = ${id}`;
}

export async function setRunMeta(db: Db, id: number, meta: Record<string, unknown>): Promise<void> {
  await db`update ingest.ingestion_runs set meta = coalesce(meta, '{}'::jsonb) || ${db.json(meta as never)} where id = ${id}`;
}
