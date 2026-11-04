import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Config, loadConfig } from '../../src/config.js';
import { QuotaGuard } from '../../src/ingest/quota-guard.js';
import { Scheduler } from '../../src/ingest/scheduler.js';
import { type GameRow, RetryReportSchema } from '../../src/ingest/trial-mode.js';
import { wnbaAdapter } from '../../src/leagues/wnba/adapter.js';
import { contentHash } from '../../src/model/content-hash.js';
import { PbpDocumentSchema } from '../../src/providers/sportradar/schemas/pbp.js';
import { SummaryDocumentSchema } from '../../src/providers/sportradar/schemas/summary.js';
import { counts, pbpClosed, R, seedGame, silentLog, staleReasons, testDb } from '../helpers/db.js';
import { fixture } from '../helpers/fixtures.js';
import { relabelDoc, scriptedProvider } from '../helpers/scripted-provider.js';

/**
 * Review should 1 (M4 merge): a Fly worker restarted during the complete -> closed wait must
 * resume the watch. The scheduler (production code path, `defaultWatch` -> runTrialWatch, push
 * mode as it picks for a full-coverage WNBA game) watches a game to `complete` (generation 1),
 * stops (the simulated restart), and a NEW scheduler instance (the restarted worker) picks the
 * stored `complete` game up again as generation 2. The scripted provider then reports `closed`
 * with corrected final statistics and a corrected play. Dev stack only; the provider is a
 * `fetchImpl` on a loopback base URL (source `rehearsal`: rate-limited and guarded, never counted).
 */
const REAL_ID = '40bea3f6-68c0-4f3b-96fa-336dfb7a9034';
const SPEED = 300;
const CORRECTED_EVENT = '82b16535-6a1e-445d-b1a7-0e5c9fda227f';

const db = testDb();
const log = silentLog;

type Json = Record<string, unknown> & {
  status: string;
  periods?: Array<{ events: Array<Record<string, unknown>> }>;
  home: {
    statistics: Record<string, number>;
    players: Array<{ id: string; statistics: Record<string, number> }>;
  };
};

beforeAll(async () => {
  await db`select 1`;
});
afterAll(async () => {
  await db.end();
});

describe('scheduler resumes a complete game after a worker restart (review should 1)', () => {
  it('generation 2 starts in the slow phase, reaches closed, applies the corrected stats and play, writes no regression row', async () => {
    // A unique game with the fixture's teams, tipped off 3 h ago: inside COMPLETE_REWATCH_MS (270 min).
    // The documents carry the same tip-off (they write games.scheduled_at).
    const { gameId, providerGameId } = await seedGame(db, pbpClosed());
    const tipOff = new Date(Date.now() - 3 * 3_600_000).toISOString();
    await db`update public.games set scheduled_at = ${tipOff} where id = ${gameId}`;
    const doc = (feed: string) => ({
      ...(relabelDoc(fixture(`${R}-${feed}-closed.json`), REAL_ID, providerGameId) as Json),
      scheduled: tipOff,
    });
    const closed = { pbp: doc('pbp'), summary: doc('summary'), boxscore: doc('boxscore') };
    // The `complete` documents: the same game before validation. One play carries a provisional
    // description and an older revision; one team and one player stat line differ by an assist.
    const complete = {
      pbp: { ...structuredClone(closed.pbp), status: 'complete' },
      summary: { ...structuredClone(closed.summary), status: 'complete' },
      boxscore: { ...structuredClone(closed.boxscore), status: 'complete' },
    };
    const event = complete.pbp.periods
      ?.flatMap((p) => p.events)
      .find((e) => e.id === CORRECTED_EVENT);
    if (!event) throw new Error('fixture event missing');
    event.description = `${String(event.description)} (provisional)`;
    event.updated = new Date(Date.parse(String(event.updated)) - 60_000).toISOString();
    complete.summary.home.statistics.assists = (complete.summary.home.statistics.assists ?? 0) + 1;
    const player = complete.summary.home.players[0];
    if (!player) throw new Error('fixture player missing');
    player.statistics.assists = (player.statistics.assists ?? 0) + 1;

    const provider = scriptedProvider();
    provider.docs = { ...complete };
    const config: Config = loadConfig({
      DATABASE_URL: process.env.DATABASE_URL,
      DATABASE_SESSION_URL: process.env.DATABASE_URL,
      SUPABASE_URL: process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321',
      SUPABASE_SERVICE_ROLE_KEY: 'not-used-here',
      MODE: 'trial',
      SPORTRADAR_WNBA_KEY: 'scheduler-resume-made-up-key',
      SPORTRADAR_BASE_URL: 'http://127.0.0.1:9', // loopback shape; fetchImpl answers, nothing listens
    });
    const guard = new QuotaGuard({ db, log });
    // Only this game: the dev database holds other tests' games inside the scheduler's range.
    const loadGames = async () =>
      db<GameRow[]>`
        select id, provider_game_id as "providerGameId", status::text as status,
               coverage::text as coverage, scheduled_at as "scheduledAt"
        from public.games where id = ${gameId}`;
    const schedulerFor = (isStopped: () => boolean) =>
      new Scheduler({
        db,
        log,
        config,
        guard,
        pulse: null,
        leagues: ['wnba'],
        isStopped,
        loadGames,
        pollSchedule: async () => undefined,
        fetchImpl: provider.fetchImpl,
        watchSpeed: SPEED,
      });

    // Generation 1: watched until the complete summary has been applied, then the worker stops.
    let stop1 = false;
    provider.onServe = (feed, doc) => {
      if (feed === 'summary' && (doc as Json).status === 'complete') stop1 = true;
    };
    const first = schedulerFor(() => stop1);
    await first.tick();
    expect(first.running.size).toBe(1);
    await Promise.allSettled([...first.running.values()]);
    expect(first.stats).toMatchObject({ watchesStarted: 1, watchesFinished: 1, watchesFailed: 0 });
    const afterFirst = await counts(db, gameId);
    const [g1] = await db<{ status: string; watchRunId: string }[]>`
      select status::text as status, watch_run_id::text as "watchRunId" from public.games where id = ${gameId}`;
    expect(g1?.status).toBe('complete');
    const gen1 = Number(g1?.watchRunId);
    const [run1] = await db<{ status: string }[]>`
      select status from ingest.ingestion_runs where id = ${gen1}`;
    expect(run1?.status).toBe('aborted');
    expect(provider.openStreams).toBe(0);

    // The restart: a new scheduler (fresh process state) finds the stored complete game. The
    // provider has validated it meanwhile.
    provider.onServe = null;
    provider.docs = { ...closed };
    const restartedAt = new Date();
    const requestsBefore = provider.requests.length;
    const second = schedulerFor(() => false);
    await second.tick();
    expect(second.running.size).toBe(1);
    await Promise.allSettled([...second.running.values()]);
    expect(second.stats).toMatchObject({
      watchesStarted: 1,
      watchesFinished: 1,
      watchesFailed: 0,
    });

    // A new generation, closed.
    const [g2] = await db<{ status: string; watchRunId: string }[]>`
      select status::text as status, watch_run_id::text as "watchRunId" from public.games where id = ${gameId}`;
    expect(g2?.status).toBe('closed');
    const gen2 = Number(g2?.watchRunId);
    expect(gen2).toBeGreaterThan(gen1);
    const [run2] = await db<{ status: string; kind: string; meta: Record<string, unknown> }[]>`
      select status, kind, meta from ingest.ingestion_runs where id = ${gen2}`;
    expect(run2).toMatchObject({ status: 'ok', kind: 'watch_game' });
    expect(run2?.meta.push).toBe(true);
    expect(RetryReportSchema.parse(run2?.meta.retries)).toEqual({
      used: 0,
      allowance: 6,
      retried429: 0,
      retriedClosing: 0,
    });

    // Slow phase from the stored status (rev 4.13 (4)): the pbp is paused, the summary is the
    // first REST call and reports closed; the closing set is the other feeds (rev 4.12 (2)).
    const gen2Requests = provider.requests.slice(requestsBefore).map((r) => r.feed);
    expect(gen2Requests.filter((f) => f !== 'push_events' && f !== 'push_clock')).toEqual([
      'summary',
      'pbp',
      'boxscore',
    ]);
    // Push for a resumed complete game: both streams open once (no reconnect, so no backfill)
    // and stop with the watch; its push_stream sub-run ends ok.
    expect(gen2Requests.filter((f) => f === 'push_events')).toHaveLength(1);
    expect(gen2Requests.filter((f) => f === 'push_clock')).toHaveLength(1);
    expect(provider.openStreams).toBe(0);
    const subRuns = await db<{ kind: string; status: string }[]>`
      select kind, status from ingest.ingestion_runs where parent_run_id = ${gen2} order by id`;
    expect(subRuns).toEqual([{ kind: 'push_stream', status: 'ok' }]);
    expect(provider.tooClose).toBe(0);
    const [res] = await db<{ releasedAt: Date | null; used: number; reserved: number }[]>`
      select released_at as "releasedAt", used_calls as used, reserved_calls as reserved
      from ingest.budget_reservations where run_id = ${gen2}`;
    expect(res?.releasedAt).toBeInstanceOf(Date);
    expect(res?.used).toBe(5); // 2 stream connections + summary + closing pbp + boxscore

    // The corrections land in game_changes as one gap-free continuation of generation 1's stream.
    const after = await counts(db, gameId);
    expect(after.changes).toBe(after.lastSeq);
    const tail = await db<{ seq: string; type: string; providerEventId: string | null }[]>`
      select seq::text, change_type::text as type, provider_event_id as "providerEventId"
      from public.game_changes where game_id = ${gameId} and seq > ${afterFirst.lastSeq} order by seq`;
    expect(tail.map((c) => Number(c.seq))).toEqual(
      Array.from(
        { length: after.lastSeq - afterFirst.lastSeq },
        (_, i) => afterFirst.lastSeq + 1 + i,
      ),
    );
    const types = tail.map((c) => c.type);
    expect(types).toContain('status');
    expect(types.filter((t) => t === 'stats_team')).toHaveLength(1);
    expect(types.filter((t) => t === 'stats_player')).toHaveLength(1);
    expect(tail.filter((c) => c.type === 'event_update')).toEqual([
      { seq: expect.any(String), type: 'event_update', providerEventId: CORRECTED_EVENT },
    ]);
    const [play] = await db<{ description: string }[]>`
      select payload->>'description' as description from public.play_events
      where game_id = ${gameId} and provider_event_id = ${CORRECTED_EVENT}`;
    expect(play?.description).toBe('Sabrina Ionescu makes two point driving layup');

    // Stored statistics equal the closed document (content hashes of every team and player line).
    const nd = wnbaAdapter.normalizeSummary(SummaryDocumentSchema.parse(closed.summary));
    const teams = await db<{ providerTeamId: string; hash: string }[]>`
      select t.provider_team_id as "providerTeamId", s.content_hash as hash
      from public.game_team_stats s join public.teams t on t.id = s.team_id
      where s.game_id = ${gameId} order by 1`;
    expect(teams).toEqual(
      nd.batch.teamStats
        .map((t) => ({ providerTeamId: t.providerTeamId, hash: contentHash(t.stats) }))
        .sort((a, b) => a.providerTeamId.localeCompare(b.providerTeamId)),
    );
    const players = await db<{ providerPlayerId: string; hash: string }[]>`
      select provider_player_id as "providerPlayerId", content_hash as hash
      from public.game_player_stats where game_id = ${gameId} order by 1`;
    expect(players).toEqual(
      nd.batch.playerStats
        .map((p) => ({ providerPlayerId: p.providerPlayerId, hash: contentHash(p) }))
        .sort((a, b) => a.providerPlayerId.localeCompare(b.providerPlayerId)),
    );
    // And the stored play-by-play is the closed document's.
    const closedPbp = wnbaAdapter.normalizePbp(PbpDocumentSchema.parse(closed.pbp));
    expect(after.events).toBe(closedPbp.batch.events.length);

    // No regression row: generation 2's first document (the closed summary) passed the
    // new-generation gate, and nothing else was rejected either.
    const reasons = await staleReasons(db, gameId);
    expect(reasons.run_regresses_state ?? 0).toBe(0);
    expect(reasons.ambiguous_regression ?? 0).toBe(0);
    expect(reasons.older_run ?? 0).toBe(0);
    const [late] = await db<{ n: number }[]>`
      select count(*)::int as n from ingest.stale_observations
      where game_id = ${gameId} and created_at >= ${restartedAt}
        and reason in ('run_regresses_state', 'ambiguous_regression', 'older_run')`;
    expect(late?.n).toBe(0);
  }, 120_000);
});
