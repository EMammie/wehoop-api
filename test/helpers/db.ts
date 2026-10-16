import { randomUUID } from 'node:crypto';
import { createDb, type Db } from '../../src/db/client.js';
import { type ApplyDeps, applyChanges, ensureGame } from '../../src/ingest/apply-changes.js';
import { ensurePlayers, ensureTeams } from '../../src/ingest/identity.js';
import { type RunHandle, startRun } from '../../src/ingest/runs.js';
import type { NormalizedDocument, Observation, ObservationSource } from '../../src/ingest/types.js';
import { wnbaAdapter } from '../../src/leagues/wnba/adapter.js';
import { createLogger } from '../../src/logger.js';
import { PbpDocumentSchema } from '../../src/providers/sportradar/schemas/pbp.js';
import { SummaryDocumentSchema } from '../../src/providers/sportradar/schemas/summary.js';
import { fixture } from './fixtures.js';

export const R = 'sim-93ee7c68';

export function testDb(): Db {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required for integration tests');
  return createDb(url, { max: 4 });
}

export const silentLog = createLogger({ level: 'silent', pretty: false });

/** A game row with the fixture's two teams, under a unique provider id so tests never collide. */
export async function seedGame(
  db: Db,
  nd: NormalizedDocument,
): Promise<{ gameId: string; providerGameId: string }> {
  const providerGameId = `test-${randomUUID()}`;
  const teamIds = await ensureTeams(db, 'wnba', nd.teams);
  const home = nd.teams.find((t) => t.isHome);
  const away = nd.teams.find((t) => !t.isHome);
  const { id } = await ensureGame(db, {
    league: 'wnba',
    providerGameId,
    scheduledAt: nd.gameView?.scheduledAt ?? new Date().toISOString(),
    status: 'scheduled',
    coverage: 'full',
    homeTeamId: home ? (teamIds.get(home.providerTeamId) ?? null) : null,
    awayTeamId: away ? (teamIds.get(away.providerTeamId) ?? null) : null,
    venue: null,
    broadcasts: null,
  });
  return { gameId: id, providerGameId };
}

export function pbpQ1(): NormalizedDocument {
  return wnbaAdapter.normalizePbp(PbpDocumentSchema.parse(fixture(`${R}-pbp-q1.json`)));
}
/** The whole recorded game (400+ events): a long backlog for outbox fairness tests. */
export function pbpClosed(): NormalizedDocument {
  return wnbaAdapter.normalizePbp(PbpDocumentSchema.parse(fixture(`${R}-pbp-closed.json`)));
}
export function pbpCreated(): NormalizedDocument {
  return wnbaAdapter.normalizePbp(PbpDocumentSchema.parse(fixture(`${R}-pbp-created.json`)));
}
export function summaryQ1(): NormalizedDocument {
  return wnbaAdapter.normalizeSummary(SummaryDocumentSchema.parse(fixture(`${R}-summary-q1.json`)));
}

export async function replayRun(db: Db, gameId: string | null = null): Promise<RunHandle> {
  return startRun(db, {
    kind: 'replay',
    league: 'wnba',
    gameId,
    source: 'fixture',
    meta: { test: true },
  });
}

export function observation(
  run: RunHandle,
  nd: NormalizedDocument,
  observedAt: Date,
  over: Partial<Observation> = {},
): Observation {
  return {
    source: 'fixture' as ObservationSource,
    runId: run.id,
    watchId: run.watchId,
    observedAt,
    isComplete: nd.isComplete,
    gameView: nd.gameView,
    ...over,
  };
}

/** Like GameWatcher.process: identity first (players the document names), then applyChanges. */
export async function apply(
  deps: ApplyDeps,
  gameId: string,
  nd: NormalizedDocument,
  obs: Observation,
) {
  if (nd.players.length > 0) {
    const [g] = await deps.db<{ league: 'wnba' | 'ncaawb' | 'unrivaled' }[]>`
      select league from public.games where id = ${gameId}`;
    if (g) await ensurePlayers(deps.db, g.league, nd.players);
  }
  return applyChanges(deps, gameId, nd.batch, obs);
}

export async function counts(db: Db, gameId: string) {
  const [c] = await db<
    {
      changes: number;
      events: number;
      deleted: number;
      outbox: number;
      published: number;
      lastSeq: string;
      home: number;
      away: number;
      watchRunId: string | null;
      clock: string | null;
    }[]
  >`
    select (select count(*)::int from public.game_changes where game_id = ${gameId}) as changes,
           (select count(*)::int from public.play_events where game_id = ${gameId} and deleted_at is null) as events,
           (select count(*)::int from public.play_events where game_id = ${gameId} and deleted_at is not null) as deleted,
           (select count(*)::int from ingest.broadcast_outbox where game_id = ${gameId}) as outbox,
           (select count(published_at)::int from ingest.broadcast_outbox where game_id = ${gameId}) as published,
           last_seq::text as "lastSeq", home_points as home, away_points as away, watch_run_id::text as "watchRunId", clock
    from public.games where id = ${gameId}`;
  if (!c) throw new Error('game missing');
  return { ...c, lastSeq: Number(c.lastSeq) };
}

export async function staleReasons(db: Db, gameId: string): Promise<Record<string, number>> {
  const rows = await db<{ reason: string; n: number }[]>`
    select reason, count(*)::int as n from ingest.stale_observations where game_id = ${gameId} group by reason`;
  return Object.fromEntries(rows.map((r) => [r.reason, r.n]));
}
