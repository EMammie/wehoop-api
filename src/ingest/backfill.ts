import type { Db } from '../db/client.js';
import type { LeagueAdapter } from '../leagues/adapter.js';
import type { Logger } from '../logger.js';
import { ProviderHttpError } from '../providers/sportradar/http.js';
import { PbpDocumentSchema } from '../providers/sportradar/schemas/pbp.js';
import type { ApplyDeps } from './apply-changes.js';
import { type DocumentSource, GameWatcher, type ProcessOutcome } from './game-watcher.js';
import { endRun, type RunHandle, type RunSource, startRun } from './runs.js';
import type { ObservationSource } from './types.js';

/**
 * Backfill reconciliation (plan §4 "Push client": after a stream drop,
 * `backfill(gameId)` = the full REST pbp through `applyChanges`). A `backfill`
 * sub-run of the watch generation (`parent_run_id` = the root watch run, so it
 * shares the generation with the push_stream sub-run and the two interleave
 * without either being marked stale) fetches ONE complete pbp document through
 * the ordinary `GameWatcher.process` path: the document is `isComplete`, so
 * freshness rules 2(c) and 3 apply exactly as for a polled document, events
 * missed during the outage are inserted, corrections are honoured per entity
 * by `updated` / hash, and absence never deletes.
 */
export interface BackfillDeps {
  db: Db;
  log: Logger;
  adapter: LeagueAdapter;
  apply: ApplyDeps;
  gameId: string;
  /** The watch generation the backfill belongs to. */
  parentRun: RunHandle;
  source: RunSource;
  observationSource: ObservationSource;
  /** The REST source for this game, attributed to the backfill run (`provider_calls.run_id`). */
  makeSource: (run: RunHandle) => DocumentSource;
  /** Retries of a provider 429 at the next rate slot (plan rev 4.8 (2)); default 1, like a cadence feed. */
  retriesOn429?: number;
}

export interface BackfillOutcome {
  runId: number;
  watchId: number | null;
  outcome: ProcessOutcome | null;
  /** The pbp document's request time (`provider_calls.called_at`: the slot on the database clock). */
  pbpRequestedAt: Date;
}

export async function runBackfill(
  deps: BackfillDeps,
  reason: string,
  meta: Record<string, unknown> = {},
): Promise<BackfillOutcome> {
  const run = await startRun(deps.db, {
    kind: 'backfill',
    league: deps.adapter.league,
    gameId: deps.gameId,
    source: deps.source,
    parentRunId: deps.parentRun.watchId ?? deps.parentRun.id,
    meta: { reason, ...meta },
  });
  deps.log.info(
    { runId: run.id, watchId: run.watchId, gameId: deps.gameId, reason },
    'backfill started',
  );
  const watcher = new GameWatcher({
    db: deps.db,
    log: deps.log,
    adapter: deps.adapter,
    run,
    apply: deps.apply,
    pulse: null,
  });
  try {
    await watcher.attach(deps.gameId);
    const source = deps.makeSource(run);
    const retries = deps.retriesOn429 ?? 1;
    // A residual 429 is retried at the next slot, as the cadence loop does (each retry is a logged,
    // quota-counted call); otherwise one 429 would leave the outage unreconciled until the next
    // 5-minute REST reconciliation.
    const fetchPbp = async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await source.fetch('pbp', PbpDocumentSchema);
        } catch (err) {
          if (err instanceof ProviderHttpError && err.status === 429 && attempt < retries) {
            deps.log.warn(
              { runId: run.id, gameId: deps.gameId, attempt: attempt + 1 },
              'backfill pbp got HTTP 429; retrying at the next rate slot',
            );
            continue;
          }
          throw err;
        }
      }
    };
    const pbp = await fetchPbp();
    const outcome = await watcher.process(
      'pbp',
      JSON.parse(pbp.rawText),
      pbp.requestedAt,
      deps.observationSource,
    );
    await endRun(deps.db, run.id, 'ok');
    deps.log.info(
      {
        runId: run.id,
        gameId: deps.gameId,
        changes: watcher.applied,
        stale: watcher.stale,
        status: outcome?.status ?? null,
      },
      'backfill finished',
    );
    return { runId: run.id, watchId: run.watchId, outcome, pbpRequestedAt: pbp.requestedAt };
  } catch (err) {
    await endRun(deps.db, run.id, 'error', (err as Error).message);
    throw err;
  }
}
