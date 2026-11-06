import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSnapshot } from '../../src/api/routes/snapshot.js';
import { type Config, loadConfig } from '../../src/config.js';
import { ensureGame } from '../../src/ingest/apply-changes.js';
import { DEMO_QUOTA_LIMIT, demoInit } from '../../src/ingest/demo-init.js';
import { purgeReplayGames } from '../../src/ingest/demo-purge.js';
import {
  assertEnvironment,
  EnvironmentRefusedError,
  markEnvironment,
  readEnvironment,
} from '../../src/ingest/environment.js';
import { GameWatcher, replayRecording } from '../../src/ingest/game-watcher.js';
import { QuotaGuard } from '../../src/ingest/quota-guard.js';
import { startRun } from '../../src/ingest/runs.js';
import { planDay } from '../../src/ingest/trial-mode.js';
import { wnbaAdapter } from '../../src/leagues/wnba/adapter.js';
import { buildPulse } from '../../src/live/pulse.js';
import { DbScoreboardSource } from '../../src/live/scoreboard.js';
import { ScheduleRowSchema } from '../../src/model/views.js';
import {
  DEFAULT_INTERVAL_MS,
  type DemoHost,
  PgProvenanceStore,
  rotationFor,
  SLOT_ORIGIN_MS,
  slotAt,
  slotRecording,
  startDemoHost,
} from '../../src/providers/sportradar/demo-host.js';
import { silentLog, testDb } from '../helpers/db.js';

/**
 * Demo environment on the dev stack (plan rev 4.15 (3)-(5)): the label on all four surfaces,
 * purge (everything dependent deleted, unpublished outbox skipped), and the environment marker
 * refusals. The host runs in-process at a fixed demo time in January 2027, outside any scheduler
 * range, so nothing here is picked up by another test's or the validator's scheduler.
 */
const db = testDb();
const log = silentLog;
const dir = mkdtempSync(join(tmpdir(), 'wehoop-demo-'));
const rotation = rotationFor({ leagues: ['wnba'] });
// A year ahead: the replayed documents' observation times (the slot's own clock) must be newer
// than the schedule poll's (now), as on a live demo, and the games stay outside every scheduler's
// two-day range.
const TIP = Date.UTC(2027, 0, 10, 23, 0);
const slot = slotAt(
  Math.round((TIP - SLOT_ORIGIN_MS) / DEFAULT_INTERVAL_MS),
  rotation,
  DEFAULT_INTERVAL_MS,
);
const now = TIP - 60 * 60_000;
let host: DemoHost;
let config: Config;
let gameId = '';

beforeAll(async () => {
  await db`select 1`;
  // A previous run of this file left nothing (purged below), but be robust to an aborted one.
  await db`delete from ingest.environment`;
  host = await startDemoHost({
    rotation,
    clock: { now: () => now, speed: 1, epochMs: 0 },
    provenance: new PgProvenanceStore(db),
    minSpacingMs: 0,
    log,
  });
  config = loadConfig({
    MODE: 'demo',
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_SESSION_URL: process.env.DATABASE_URL,
    SUPABASE_URL: process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321',
    SUPABASE_SERVICE_ROLE_KEY: 'not-used-here',
    SPORTRADAR_BASE_URL: host.url,
  });
});
afterAll(async () => {
  await db`delete from ingest.environment`;
  await host?.close();
  rmSync(dir, { recursive: true, force: true });
  await db.end();
});

describe('demo label', () => {
  it('a game created from the demo schedule is labelled recorded on v_schedule, the snapshot, the pulse and the scoreboard delta; a real game is null', async () => {
    const existing = await db<{ id: string }[]>`
      select id from public.games where league = 'wnba' and provider_game_id = ${slot.providerGameId}`;
    if (existing[0]) await purgeAll([existing[0].id]);

    // The production code path: the daily schedule (one call to the demo host) through
    // ReferenceIngester, which creates the game row; provenance was written first.
    const guard = new QuotaGuard({ db, log });
    const plan = await planDay(
      { db, log, config, adapter: wnbaAdapter, guard },
      { date: '2027-01-10' },
    );
    const listed = plan.games.find((g) => g.providerGameId === slot.providerGameId);
    expect(listed).toBeDefined();
    gameId = listed?.id ?? '';
    const [prov] = await db<
      { shiftMs: string; recordedGameId: string; sha: string; provenance: string }[]
    >`
      select shift_ms::text as "shiftMs", recorded_game_id as "recordedGameId", fixture_sha256 as sha, provenance
      from ingest.replay_slots where league = 'wnba' and provider_game_id = ${slot.providerGameId}`;
    const rec = host.recordings.get('93ee7c68');
    expect(prov).toEqual({
      shiftMs: String(TIP - (rec?.recordedTipOffMs ?? 0)),
      recordedGameId: '40bea3f6-68c0-4f3b-96fa-336dfb7a9034',
      sha: rec?.sha256,
      provenance: 'recorded',
    });
    const calls = await db<{ url: string; source: string; counted: boolean }[]>`
      select url, source::text as source, quota_counted as counted from ingest.provider_calls
      where url like ${`%${'/games/2027/01/10/schedule.json'}`} order by id desc limit 1`;
    expect(calls[0]?.url.startsWith(host.url)).toBe(true);
    expect(calls[0]).toMatchObject({ source: 'rehearsal', counted: false });

    // The game's documents, as the host serves them, through the ordinary watcher.
    const file = join(dir, 'slot.jsonl');
    writeFileSync(
      file,
      `${slotRecording(rec ?? fail(), slot)
        .map((l) => JSON.stringify(l))
        .join('\n')}\n`,
    );
    const run = await startRun(db, {
      kind: 'replay',
      league: 'wnba',
      gameId,
      source: 'fixture',
      meta: { test: 'demo' },
    });
    const watcher = new GameWatcher({
      db,
      log,
      adapter: wnbaAdapter,
      run,
      apply: { db, log },
      pulse: null,
    });
    const out = await replayRecording(watcher, file, log, {
      paceMs: 0,
      isStopped: () => false,
      maxDocs: null,
    });
    expect(out.status).toBe('closed');
    expect(watcher.gameId).toBe(gameId);

    // As a client receives it: JSON (timestamps as strings), then the contract's Zod row.
    const [row] = await db`select to_jsonb(v) as j from public.v_schedule v where id = ${gameId}`;
    expect(ScheduleRowSchema.parse(row?.j).replay).toBe('recorded');
    const snap = await loadSnapshot(db, gameId);
    expect(snap?.game.replay).toBe('recorded');
    expect(snap?.game.providerGameId).toBe(slot.providerGameId);
    expect((await buildPulse(db, gameId))?.replay).toBe('recorded');
    const deltas = await new DbScoreboardSource(db).changedSince(new Date(Date.now() - 600_000));
    expect(deltas.find((d) => d.gameId === gameId)?.replay).toBe('recorded');

    // A game without provenance (every real game) stays null on every surface.
    const [real] = await db<{ id: string }[]>`
      select id from public.games where replay is null order by updated_at desc limit 1`;
    if (real) {
      expect((await loadSnapshot(db, real.id))?.game.replay).toBeNull();
      expect((await buildPulse(db, real.id))?.replay).toBeNull();
      const [v] = await db`select replay from public.v_schedule where id = ${real.id}`;
      expect(v?.replay).toBeNull();
    }
  }, 120_000);
});

/** Count every row a purge must delete for one game (and the runs that were its). */
async function dependents(id: string, runIds: string[]) {
  const [c] = await db<Record<string, number>[]>`
    select
      (select count(*)::int from ingest.broadcast_outbox where game_id = ${id}) as broadcast_outbox,
      (select count(*)::int from public.game_changes where game_id = ${id}) as game_changes,
      (select count(*)::int from ingest.play_event_raw r join public.play_events p on p.id = r.play_event_id where p.game_id = ${id}) as play_event_raw,
      (select count(*)::int from public.play_events where game_id = ${id}) as play_events,
      (select count(*)::int from public.game_player_stats where game_id = ${id}) as game_player_stats,
      (select count(*)::int from public.game_team_stats where game_id = ${id}) as game_team_stats,
      (select count(*)::int from public.game_periods where game_id = ${id}) as game_periods,
      (select count(*)::int from ingest.stale_observations where game_id = ${id}) as stale_observations,
      (select count(*)::int from ingest.budget_reservations where game_id = ${id}) as budget_reservations,
      (select count(*)::int from ingest.provider_calls where run_id = any(${runIds}::bigint[])) as provider_calls,
      (select count(*)::int from ingest.ingestion_runs where id = any(${runIds}::bigint[])) as ingestion_runs,
      (select count(*)::int from ingest.replay_slots where provider_game_id = ${slot.providerGameId}) as replay_slots,
      (select count(*)::int from public.games where id = ${id}) as games`;
  return c ?? {};
}

async function purgeAll(ids: string[]) {
  await db`update ingest.broadcast_outbox set published_at = coalesce(published_at, now()), dead_at = null
           where game_id = any(${ids}::uuid[])`;
  await purgeReplayGames(db, log, { olderThan: null, dryRun: false, gameIds: ids });
}

const fail = (): never => {
  throw new Error('missing');
};

describe('demo purge', () => {
  it('skips a game with unpublished outbox rows, then deletes the game and every dependent row in one transaction', async () => {
    expect(gameId).not.toBe('');
    // Rows in every dependent table, including the restricted chains: a watch sub-run (parent
    // RESTRICT), a call and a reservation of the watch run, a stale observation.
    const [watch] = await db<{ id: string }[]>`
      select watch_run_id::text as id from public.games where id = ${gameId}`;
    const sub = await startRun(db, {
      kind: 'backfill',
      league: 'wnba',
      gameId,
      source: 'rehearsal',
      parentRunId: Number(watch?.id),
    });
    await db`insert into ingest.provider_calls (run_id, source, product, league, feed, url, status, duration_ms, bytes, quota_counted)
             values (${sub.id}, 'rehearsal', 'wnba', 'wnba', 'pbp', ${`${host.url}/x`}, 200, 1, 1, false)`;
    await db`insert into ingest.budget_reservations (game_id, product, profile, reserved_calls, source, run_id)
             values (${gameId}, 'wnba', 'full', 1, 'rehearsal', ${Number(watch?.id)})`;
    await db`insert into ingest.stale_observations (game_id, source, observed_at, observation, reason, run_id)
             values (${gameId}, 'rest', now(), '{}'::jsonb, 'older_run', ${sub.id})`;
    const runIds = (
      await db<
        { id: string }[]
      >`select id::text from ingest.ingestion_runs where game_id = ${gameId}`
    ).map((r) => r.id);
    const before = await dependents(gameId, runIds);
    for (const [table, n] of Object.entries(before)) expect(n, table).toBeGreaterThan(0);

    // No publisher ran: every outbox row is pending, so the game is skipped and nothing changes.
    const skipped = await purgeReplayGames(db, log, {
      olderThan: null,
      dryRun: false,
      gameIds: [gameId],
    });
    expect(skipped.purged).toEqual([]);
    expect(skipped.skipped).toEqual([
      expect.objectContaining({
        gameId,
        reason: expect.stringMatching(/^unpublished outbox rows \(pending \d+, dead 0\)/),
      }),
    ]);
    expect(await dependents(gameId, runIds)).toEqual(before);

    // Published (what the publisher does), quiet-since cutoff in the past: not yet eligible.
    await db`update ingest.broadcast_outbox set published_at = now() where game_id = ${gameId}`;
    const young = await purgeReplayGames(db, log, {
      olderThan: new Date(Date.now() - 7 * 86_400_000),
      dryRun: false,
      gameIds: [gameId],
    });
    expect(young.candidates).toBe(0);
    // A dry run reports exactly what a real run deletes and deletes nothing.
    const dry = await purgeReplayGames(db, log, {
      olderThan: null,
      dryRun: true,
      gameIds: [gameId],
    });
    expect(await dependents(gameId, runIds)).toEqual(before);
    const real = await purgeReplayGames(db, log, {
      olderThan: null,
      dryRun: false,
      gameIds: [gameId],
    });
    expect(real.purged).toHaveLength(1);
    expect(real.purged[0]?.deleted).toEqual(dry.purged[0]?.deleted);
    expect(real.purged[0]?.deleted).toMatchObject({
      game_changes: before.game_changes,
      play_events: before.play_events,
      ingestion_runs: before.ingestion_runs,
      games: 1,
      replay_slots: 1,
    });
    const after = await dependents(gameId, runIds);
    for (const [table, n] of Object.entries(after)) expect(n, table).toBe(0);
  }, 120_000);
});

describe('environment marker', () => {
  const production = (): Pick<Config, 'mode' | 'devStackDb' | 'db'> => ({
    mode: 'production',
    devStackDb: false,
    db: config.db,
  });

  it('demo runs on the unmarked dev stack; production refuses a demo database; demo refuses a production one', async () => {
    expect(await readEnvironment(db)).toBeNull();
    await expect(assertEnvironment(db, config)).resolves.toBeNull();
    await expect(assertEnvironment(db, production())).resolves.toBeNull();
    await markEnvironment(db, 'demo', 'integration test');
    await expect(assertEnvironment(db, config)).resolves.toBe('demo');
    await expect(assertEnvironment(db, { ...config, devStackDb: false })).resolves.toBe('demo');
    await expect(assertEnvironment(db, production())).rejects.toThrow(
      /MODE=production refuses .*marked demo/,
    );
    await expect(markEnvironment(db, 'production', 'x')).rejects.toBeInstanceOf(
      EnvironmentRefusedError,
    );
    await db`delete from ingest.environment`;
    await markEnvironment(db, 'production', 'integration test');
    await expect(assertEnvironment(db, config)).rejects.toThrow(
      /MODE=demo runs only on the dev stack or a database marked demo/,
    );
    await expect(assertEnvironment(db, { ...config, devStackDb: false })).rejects.toBeInstanceOf(
      EnvironmentRefusedError,
    );
    await db`delete from ingest.environment`;
    // Only one row can exist.
    await db`insert into ingest.environment (kind) values ('dev')`;
    await expect(db`insert into ingest.environment (kind) values ('demo')`).rejects.toThrow();
    await db`delete from ingest.environment`;
  });

  it('demo init refuses a database with games unless it is marked demo; then marks, writes the synthetic limits and loads references idempotently', async () => {
    const [g] = await db<{ n: number }[]>`select count(*)::int as n from public.games`;
    if ((g?.n ?? 0) === 0)
      await ensureGame(db, {
        league: 'wnba',
        providerGameId: 'demo-init-guard',
        scheduledAt: '2026-06-30T23:00:00Z',
        status: 'closed',
        coverage: 'full',
        homeTeamId: null,
        awayTeamId: null,
        venue: null,
        broadcasts: null,
      });
    await expect(demoInit(db, log)).rejects.toThrow(
      /needs an empty database or one already marked demo/,
    );
    expect(await readEnvironment(db)).toBeNull();

    const saved =
      await db`select product, limit_30d, reserve, note, verified_at from ingest.product_quotas`;
    try {
      await markEnvironment(db, 'demo', 'integration test');
      const first = await demoInit(db, log);
      expect(first.marked).toBe('demo');
      expect(first.quotas.map((q) => q.product)).toEqual(['ncaawb', 'unrivaled', 'wnba']);
      for (const q of first.quotas)
        expect(q).toMatchObject({ limit30d: DEMO_QUOTA_LIMIT, reserve: 0, verified: true });
      expect(first.references.length).toBeGreaterThan(10);
      expect(
        first.references.some((r) => r.feed === 'schedule' || r.feed === 'daily_schedule'),
      ).toBe(false);
      const [games] = await db<{ n: number }[]>`select count(*)::int as n from public.games`;
      await demoInit(db, log);
      const [again] = await db<{ n: number }[]>`select count(*)::int as n from public.games`;
      expect(again?.n).toBe(games?.n); // references create no game, a second init changes nothing
    } finally {
      for (const q of saved) {
        await db`update ingest.product_quotas set limit_30d = ${q.limit_30d}, reserve = ${q.reserve},
                   note = ${q.note}, verified_at = ${q.verified_at} where product = ${q.product}`;
      }
      await db`delete from ingest.environment`;
    }
  }, 120_000);
});
