import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Config, loadConfig } from '../../src/config.js';
import { GameWatcher, replayRecording } from '../../src/ingest/game-watcher.js';
import { QuotaGuard } from '../../src/ingest/quota-guard.js';
import { relabelRecording } from '../../src/ingest/recording.js';
import { planDay, resolveGame, runTrialWatch } from '../../src/ingest/trial-mode.js';
import { wnbaAdapter } from '../../src/leagues/wnba/adapter.js';
import { canonicalJson } from '../../src/model/content-hash.js';
import {
  type FakeProvider,
  startFakeProvider,
} from '../../src/providers/sportradar/fake-provider.js';
import { replayRun, silentLog, testDb } from '../helpers/db.js';

/**
 * Push mode end to end (plan §7 M4 acceptance: "30 s stream drop -> reconnect
 * + backfill, counts match"). The fake provider streams the WNBA recording's
 * pbp deltas as push lines and cuts the push sockets once mid-game; the watch
 * runs in push mode (events + clock streams, REST pbp reconciliation every
 * 5 scaled minutes) under MODE=trial against the loopback host (source
 * `rehearsal`: rate-limited, never counted). The same recording is then
 * replayed polling-only through a GameWatcher and the durable state is
 * compared: non-deleted play_events (count and bodies), game_periods and the
 * final score must match exactly; game_changes may not (push applies finer
 * steps: single events, clock-carried scores), so only ">=" is asserted there.
 */
const FIXTURE = new URL('../../fixtures/wnba/sim-93ee7c68-replay.compact.jsonl.gz', import.meta.url)
  .pathname;
const REAL_ID = '40bea3f6-68c0-4f3b-96fa-336dfb7a9034';
const SPEED = 300;
const DATE = '2026-06-30';

const db = testDb();
const log = silentLog;
const dir = mkdtempSync(join(tmpdir(), 'wehoop-push-flow-'));
const pushCopy = join(dir, 'push.jsonl.gz');
const pollCopy = join(dir, 'poll.jsonl.gz');
const pushId = `test-${randomUUID()}`;
const pollId = `test-${randomUUID()}`;
const product = `m4-push-${randomUUID().slice(0, 8)}`;
const adapter = { ...wnbaAdapter, product };
const FAKE_KEY = `push-rehearsal-key-${randomUUID()}`;

const configFor = (server: FakeProvider): Config =>
  loadConfig({
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_SESSION_URL: process.env.DATABASE_URL,
    SUPABASE_URL: process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321',
    SUPABASE_SERVICE_ROLE_KEY: 'not-used-here',
    MODE: 'trial',
    SPORTRADAR_WNBA_KEY: FAKE_KEY,
    SPORTRADAR_BASE_URL: server.url,
  });

/** Durable state without volatile ids: what two ingestion paths of one recording must agree on. */
async function durableState(gameId: string) {
  const [g] = await db<{ status: string; home: number; away: number; lastSeq: string }[]>`
    select status::text as status, home_points as home, away_points as away, last_seq::text as "lastSeq"
    from public.games where id = ${gameId}`;
  const periods = await db<
    { sequence: number; number: number; type: string; h: number; a: number }[]
  >`
    select sequence, number, type::text as type, home_points as h, away_points as a
    from public.game_periods where game_id = ${gameId} order by sequence`;
  const events = await db<{ providerEventId: string; body: unknown }[]>`
    select provider_event_id as "providerEventId", payload as body from public.play_events
    where game_id = ${gameId} and deleted_at is null order by provider_event_id`;
  const [deleted] = await db<{ n: number }[]>`
    select count(*)::int as n from public.play_events where game_id = ${gameId} and deleted_at is not null`;
  return {
    status: g?.status,
    score: { home: g?.home, away: g?.away },
    lastSeq: Number(g?.lastSeq ?? 0),
    periods,
    eventCount: events.length,
    deleted: deleted?.n ?? 0,
    eventsHash: canonicalJson(events),
  };
}

beforeAll(async () => {
  await db`select 1`;
  await relabelRecording(FIXTURE, pushCopy, {
    coverage: 'full',
    gameId: { from: REAL_ID, to: pushId },
  });
  await relabelRecording(FIXTURE, pollCopy, {
    coverage: 'full',
    gameId: { from: REAL_ID, to: pollId },
  });
  await db`insert into ingest.product_quotas (product, limit_30d, qps, reserve, note, verified_at)
           values (${product}, 1000, 1, 100, 'push integration rehearsal', now())`;
});
afterAll(async () => {
  await db`update ingest.budget_reservations set product = 'wnba', released_at = coalesce(released_at, now()),
             note = coalesce(note, '') || ' [integration product row removed]' where product = ${product}`;
  await db`delete from ingest.product_quotas where product = ${product}`;
  rmSync(dir, { recursive: true, force: true });
  await db.end();
});

describe('push mode against the fake provider with a mid-game stream drop', () => {
  it('reconnects, backfills, finishes closed, and matches a polling-only replay of the same recording', async () => {
    const server = await startFakeProvider({
      replayFile: pushCopy,
      speed: SPEED,
      heartbeatMs: 1000,
      // One outage ~6 s in (about Q2 at this speed) lasting 2.5 s = 12.5 recorded minutes of events
      // that only the backfill can recover.
      pushDrop: { afterMs: 6000, forMs: 2500 },
    });
    try {
      const config = configFor(server);
      const guard = new QuotaGuard({ db, log });
      const plan = await planDay({ db, log, config, adapter, guard }, { date: DATE });
      const planned = plan.games.find((g) => g.providerGameId === pushId);
      expect(planned).toMatchObject({ coverage: 'full' });
      const game = await resolveGame(db, 'wnba', pushId);
      if (!game) throw new Error('plan did not create the game');

      const out = await runTrialWatch(
        { db, log, config, adapter, guard, pulse: null, isStopped: () => false },
        {
          game,
          profile: 'full',
          speed: SPEED,
          note: 'push integration rehearsal',
          push: { watchdogMs: 5000, backoffMinMs: 200, backoffMaxMs: 1000 },
        },
      );
      expect(out.status).toBe('closed');
      expect(out.refused).toBe(0);
      expect(out.push).toBeDefined();
      const push = out.push;
      if (!push) throw new Error('no push outcome');
      const events = push.streams.find((s) => s.feed === 'push_events');
      const clock = push.streams.find((s) => s.feed === 'push_clock');
      expect(events?.reconnects).toBeGreaterThanOrEqual(1);
      expect(clock?.connections).toBeGreaterThanOrEqual(1);
      // Every events-stream reconnect is reconciled: by a backfill sub-run, or by skipping it because
      // an APPLIED REST pbp of this generation was requested at or after the reconnect
      // (backfillNeeded). The skip branch is checked against the ledger: a 200 pbp call of the
      // generation whose called_at is at or after the push_events reconnect call.
      expect(push.backfills + push.backfillsSkipped).toBe(events?.reconnects);
      if (push.backfillsSkipped > 0) {
        const [cover] = await db<{ n: number }[]>`
          with reconnect as (
            select min(called_at) as at from ingest.provider_calls
            where feed = 'push_events' and status = 200
              and run_id in (select id from ingest.ingestion_runs where parent_run_id = ${out.runId})
              and called_at > (select min(called_at) from ingest.provider_calls
                               where feed = 'push_events' and status = 200
                                 and run_id in (select id from ingest.ingestion_runs where parent_run_id = ${out.runId})))
          select count(*)::int as n from ingest.provider_calls c, reconnect r
          where c.feed = 'pbp' and c.status = 200 and c.called_at >= r.at
            and (c.run_id = ${out.runId} or c.run_id in (select id from ingest.ingestion_runs where parent_run_id = ${out.runId}))`;
        expect(cover?.n).toBeGreaterThanOrEqual(1);
      }
      expect(push.ingest.events).toBeGreaterThan(50);
      expect(push.ingest.clocks).toBeGreaterThan(5);
      expect(push.ingest.otherGame).toBe(0);
      expect(events?.skipped).toBe(0);
      // Push sends leave on their ledger slot or re-claim (validator M4 §2e); the cadence loop and
      // each backfill have their own single-caller limiter on the shared ledger, so no caller can
      // send on another's slot: zero 429.
      expect(server.stats.rejected429).toBe(0);
      expect(server.stats.rejected401).toBe(0);
      expect(server.stats.pushDrops).toBeGreaterThanOrEqual(1);
      // Budget: REST profile plus the stream connection allowance, released at the end.
      expect(out.reservation.reservedCalls).toBe(out.budget.total);
      expect(out.reservation.releasedAt).toBeInstanceOf(Date);

      // Sub-runs of the watch generation: one push_stream, >= 1 backfill, every provider call accounted.
      const runs = await db<{ kind: string; status: string; parentRunId: string }[]>`
        select kind, status, parent_run_id::text as "parentRunId" from ingest.ingestion_runs
        where parent_run_id = ${out.runId} order by id`;
      expect(runs.filter((r) => r.kind === 'push_stream')).toEqual([
        { kind: 'push_stream', status: 'ok', parentRunId: String(out.runId) },
      ]);
      expect(runs.filter((r) => r.kind === 'backfill').length).toBe(push.backfills);
      expect(runs.every((r) => r.status === 'ok')).toBe(true);
      const calls = await db<{ feed: string; counted: boolean; source: string; n: number }[]>`
        select feed, quota_counted as counted, source::text as source, count(*)::int as n
        from ingest.provider_calls where reservation_id = ${out.reservation.id}
        group by feed, quota_counted, source order by feed`;
      const byFeed = Object.fromEntries(calls.map((c) => [c.feed, c]));
      expect(byFeed.push_events?.n).toBeGreaterThanOrEqual(2);
      expect(byFeed.push_clock?.n).toBeGreaterThanOrEqual(1);
      expect(byFeed.pbp?.n).toBeGreaterThanOrEqual(2);
      for (const c of calls) expect(c).toMatchObject({ counted: false, source: 'rehearsal' });
      const [gap] = await db<{ ms: number | null }[]>`
        select (extract(epoch from min(gap)) * 1000)::int as ms from (
          select called_at - lag(called_at) over (order by called_at, id) as gap
          from ingest.provider_calls where product = ${product}) g`;
      expect(gap?.ms ?? 0).toBeGreaterThanOrEqual(1000);
      const [stateMeta] = await db<{ meta: { push?: Record<string, { status: string }> } }[]>`
        select meta from ingest.ingestion_runs where kind = 'push_stream' and parent_run_id = ${out.runId}`;
      expect(stateMeta?.meta.push?.push_events?.status).toBe('stopped');

      // Change stream: gap-free, one outbox row per change.
      const [stream] = await db<
        { changes: number; lastSeq: string; outbox: number; maxSeq: string }[]
      >`
        select (select count(*)::int from public.game_changes where game_id = ${game.id}) as changes,
               (select last_seq::text from public.games where id = ${game.id}) as "lastSeq",
               (select count(*)::int from ingest.broadcast_outbox where game_id = ${game.id}) as outbox,
               (select coalesce(max(seq), 0)::text from public.game_changes where game_id = ${game.id}) as "maxSeq"`;
      expect(stream?.changes).toBe(Number(stream?.lastSeq));
      expect(stream?.maxSeq).toBe(stream?.lastSeq);
      expect(stream?.outbox).toBe(stream?.changes);

      // Equivalence with a polling-only replay of the same recording.
      const pollRun = await replayRun(db);
      const watcher = new GameWatcher({
        db,
        log,
        adapter: wnbaAdapter,
        run: pollRun,
        apply: { db, log },
        pulse: null,
      });
      await replayRecording(watcher, pollCopy, log, {
        paceMs: 0,
        isStopped: () => false,
        maxDocs: null,
      });
      if (!watcher.gameId) throw new Error('polling replay created no game');
      const viaPush = await durableState(game.id);
      const viaPoll = await durableState(watcher.gameId);
      expect(viaPush.status).toBe('closed');
      expect(viaPush.score).toEqual(viaPoll.score);
      expect(viaPush.periods).toEqual(viaPoll.periods);
      expect(viaPush.eventCount).toBe(viaPoll.eventCount);
      expect(viaPush.eventsHash).toBe(viaPoll.eventsHash);
      // Deleted rows exist only for events a path OBSERVED before the provider retracted them (the
      // 3 s polling replay sees every document; push + 5-minute REST may never see a play that was
      // inserted and retracted between two reconciliations), so they may be fewer, never more.
      expect(viaPush.deleted).toBeLessThanOrEqual(viaPoll.deleted);
      // game_changes legitimately differ: the 3 s polling replay numbers every intermediate event
      // revision and every summary's stats, push + 5-minute REST sees fewer intermediate states but
      // adds clock-carried score steps. Both are complete, gap-free streams of their own history.
      expect(viaPush.lastSeq).toBeGreaterThan(400);
      expect(viaPoll.lastSeq).toBeGreaterThan(400);
    } finally {
      await server.close();
    }
  }, 120_000);
});
