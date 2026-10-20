import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import { runBackfill } from '../../src/ingest/backfill.js';
import type { DocumentSource } from '../../src/ingest/game-watcher.js';
import { PushIngest } from '../../src/ingest/push-ingest.js';
import type { RunHandle } from '../../src/ingest/runs.js';
import { wnbaAdapter } from '../../src/leagues/wnba/adapter.js';
import { type FetchedDocument, ProviderHttpError } from '../../src/providers/sportradar/http.js';
import type { PushLine } from '../../src/providers/sportradar/push-client.js';
import {
  type PushClockMessage,
  PushClockMessageSchema,
  PushEventMessageSchema,
} from '../../src/providers/sportradar/schemas/push.js';
import {
  apply,
  counts,
  observation,
  pbpQ1,
  replayRun,
  seedGame,
  silentLog,
  staleReasons,
  testDb,
} from '../helpers/db.js';
import { fixture } from '../helpers/fixtures.js';

/**
 * Push ingestion through applyChanges (plan §4, M4): a push_stream sub-run of
 * the watch generation applies single events (insert/update/delete) without a
 * gameView, a push clock message as an observation write (clock alone -> no
 * durable change; a changed score -> one status change), and a backfill
 * sub-run reconciles with a complete REST pbp inside the same generation.
 */
const db = testDb();
const deps = { db, log: silentLog };
const T0 = new Date('2026-06-30T23:40:00Z');
const REAL_ID = '40bea3f6-68c0-4f3b-96fa-336dfb7a9034';
const sampleEvents = (fixture('sim-93ee7c68-push-events-sample.json') as unknown[]).slice(1);
const sampleClocks = fixture('sim-93ee7c68-push-clock-sample.json') as unknown[];

let gameId = '';
let providerGameId = '';
let root: RunHandle;
let ingest: PushIngest;

const retarget = (json: unknown): unknown =>
  JSON.parse(JSON.stringify(json).replaceAll(REAL_ID, providerGameId));

const eventLine = (
  i: number,
  patch: (ev: Record<string, unknown>) => Record<string, unknown> = (e) => e,
  operation: 'insert' | 'update' | 'delete' = 'update',
): PushLine => {
  const msg = PushEventMessageSchema.parse(retarget(sampleEvents[i]));
  return {
    kind: 'event',
    message: {
      ...msg,
      metadata: { ...msg.metadata, operation },
      payload: {
        ...msg.payload,
        event: PushEventMessageSchema.shape.payload.shape.event.parse(patch(msg.payload.event)),
      },
    },
  };
};

const clockLine = (patch: (m: PushClockMessage) => PushClockMessage = (m) => m): PushLine => ({
  kind: 'clock',
  message: patch(PushClockMessageSchema.parse(retarget(sampleClocks[2]))),
});

beforeAll(async () => {
  await db`select 1`;
  const nd = pbpQ1();
  const seeded = await seedGame(db, nd);
  gameId = seeded.gameId;
  providerGameId = seeded.providerGameId;
  root = await replayRun(db, gameId);
  await apply(deps, gameId, nd, observation(root, nd, T0));
  ingest = new PushIngest({
    db,
    log: silentLog,
    adapter: wnbaAdapter,
    apply: deps,
    gameId,
    providerGameId,
    parentRun: root,
    source: 'fixture',
  });
});
afterAll(async () => {
  await db.end();
});

describe('push ingestion', () => {
  it('opens a push_stream sub-run that inherits the watch generation', async () => {
    const run = await ingest.start({ test: true });
    expect(run.watchId).toBe(root.id);
    const [row] = await db<{ kind: string; parentRunId: string; gameId: string }[]>`
      select kind, parent_run_id::text as "parentRunId", game_id as "gameId"
      from ingest.ingestion_runs where id = ${run.id}`;
    expect(row).toEqual({ kind: 'push_stream', parentRunId: String(root.id), gameId });
  });

  it('a repeated event (same body, same revision) is a no-op; a corrected body with a newer revision is exactly one event_update', async () => {
    const before = await counts(db, gameId);
    const same = await ingest.handle(eventLine(0), new Date(T0.getTime() + 1000));
    expect(same?.outcome).toBe('applied');
    if (same?.outcome === 'applied') expect(same.changes).toEqual([]);
    const corrected = await ingest.handle(
      eventLine(0, (ev) => ({
        ...ev,
        description: `${ev.description} [push corrected]`,
        updated: '2026-06-30T23:16:40+00:00',
      })),
      new Date(T0.getTime() + 2000),
    );
    expect(corrected?.outcome).toBe('applied');
    if (corrected?.outcome === 'applied') {
      expect(corrected.changes.map((c) => c.type)).toEqual(['event_update']);
      expect(corrected.gameLevel).toBe('none');
    }
    const after = await counts(db, gameId);
    expect(after.changes).toBe(before.changes + 1);
    expect(after.watchRunId).toBe(String(root.id));
    const [pe] = await db<{ description: string; updatedAt: Date }[]>`
      select payload->>'description' as description, provider_updated_at as "updatedAt"
      from public.play_events where game_id = ${gameId} and provider_event_id = 'aeaa8af3-ca64-45c5-ab47-0f19c11410dd'`;
    expect(pe?.description).toContain('[push corrected]');
    expect(pe?.updatedAt?.toISOString()).toBe('2026-06-30T23:16:40.000Z');
  });

  it('operation=delete is an explicit deletion marker carrying the message revision: exactly one event_delete', async () => {
    const r = await ingest.handle(
      eventLine(2, (ev) => ({ ...ev, updated: '2026-06-30T23:16:50+00:00' }), 'delete'),
      new Date(T0.getTime() + 3000),
    );
    expect(r?.outcome).toBe('applied');
    if (r?.outcome === 'applied') expect(r.changes.map((c) => c.type)).toEqual(['event_delete']);
    const [pe] = await db<{ deletedAt: Date | null; rev: Date | null }[]>`
      select deleted_at as "deletedAt", deleted_revision_at as rev from public.play_events
      where game_id = ${gameId} and provider_event_id = ${eventLine(2).kind === 'event' ? (eventLine(2) as { message: { payload: { event: { id: string } } } }).message.payload.event.id : ''}`;
    expect(pe?.deletedAt).toBeInstanceOf(Date);
    expect(pe?.rev?.toISOString()).toBe('2026-06-30T23:16:50.000Z');
    expect(ingest.stats.deletes).toBe(1);
  });

  it('a clock message with the stored status/score/period is an observation write only: clock, clockRunning, no change row', async () => {
    const before = await counts(db, gameId);
    const [g] = await db<{ status: string; home: number; away: number; seq: number }[]>`
      select status::text as status, home_points as home, away_points as away, current_period_sequence as seq
      from public.games where id = ${gameId}`;
    if (!g) throw new Error('game missing');
    const at = new Date(T0.getTime() + 4000);
    const r = await ingest.handle(
      clockLine((m) => ({
        ...m,
        payload: {
          ...m.payload,
          game: {
            ...m.payload.game,
            status: g.status,
            home: { ...m.payload.game.home, points: g.home },
            away: { ...m.payload.game.away, points: g.away },
          },
          period: { number: g.seq, sequence: g.seq, type: 'REG' },
          clocks: { game: '0347', game_decimal: '0347', shot: '12.00', running: true },
        },
      })),
      at,
    );
    expect(r?.outcome).toBe('applied');
    if (r?.outcome === 'applied') {
      expect(r.changes).toEqual([]);
      expect(r.gameLevel).toBe('write');
    }
    const after = await counts(db, gameId);
    expect(after.changes).toBe(before.changes);
    const [obs] = await db<
      { clock: string; running: boolean; asOf: Date; observedAt: Date; source: string }[]
    >`select clock, clock_running as running, clock_as_of as "asOf", observed_at as "observedAt", observed_source::text as source
      from public.games where id = ${gameId}`;
    expect(obs).toMatchObject({ clock: '3:47', running: true, source: 'push' });
    expect(obs?.asOf.getTime()).toBe(at.getTime());
    expect(obs?.observedAt.getTime()).toBe(at.getTime());
  });

  it('a clock message carrying a new score is one status change (game-level fields follow observedAt); an older one is superseded', async () => {
    const [g] = await db<{ status: string; home: number; away: number; seq: number }[]>`
      select status::text as status, home_points as home, away_points as away, current_period_sequence as seq
      from public.games where id = ${gameId}`;
    if (!g) throw new Error('game missing');
    const withScore = (home: number, clock: string): PushLine =>
      clockLine((m) => ({
        ...m,
        payload: {
          ...m.payload,
          game: {
            ...m.payload.game,
            status: g.status,
            home: { ...m.payload.game.home, points: home },
            away: { ...m.payload.game.away, points: g.away },
          },
          period: { number: g.seq, sequence: g.seq, type: 'REG' },
          clocks: { game: clock, game_decimal: clock, running: false },
        },
      }));
    const r = await ingest.handle(withScore(g.home + 2, '0330'), new Date(T0.getTime() + 5000));
    expect(r?.outcome).toBe('applied');
    if (r?.outcome === 'applied') {
      expect(r.changes.map((c) => c.type)).toEqual(['status']);
      expect(r.changes[0]?.body).toMatchObject({ score: { home: g.home + 2, away: g.away } });
    }
    // delayed message (earlier receipt time than the stored observation): superseded, nothing written
    const before = await staleReasons(db, gameId);
    const late = await ingest.handle(withScore(g.home, '0340'), new Date(T0.getTime() + 4500));
    expect(late?.outcome).toBe('applied');
    if (late?.outcome === 'applied') {
      expect(late.gameLevel).toBe('superseded');
      expect(late.changes).toEqual([]);
    }
    const after = await staleReasons(db, gameId);
    expect((after.superseded_observation ?? 0) - (before.superseded_observation ?? 0)).toBe(1);
    const [row] = await db<{ home: number; clock: string }[]>`
      select home_points as home, clock from public.games where id = ${gameId}`;
    expect(row).toEqual({ home: g.home + 2, clock: '3:30' });
  });

  it('a clock line without points keeps the stored score: no change row, no 0-0 (review blocker)', async () => {
    const [g] = await db<{ status: string; home: number; away: number; seq: number }[]>`
      select status::text as status, home_points as home, away_points as away, current_period_sequence as seq
      from public.games where id = ${gameId}`;
    if (!g) throw new Error('game missing');
    expect(g.home + g.away).toBeGreaterThan(0);
    const before = await counts(db, gameId);
    const r = await ingest.handle(
      clockLine((m) => {
        const { points: _h, ...home } = m.payload.game.home;
        const { points: _a, ...away } = m.payload.game.away;
        return {
          ...m,
          payload: {
            ...m.payload,
            game: { ...m.payload.game, status: g.status, home, away },
            period: { number: g.seq, sequence: g.seq, type: 'REG' },
            clocks: { game: '0310', game_decimal: '0310', running: true },
          },
        };
      }),
      new Date(T0.getTime() + 6000),
    );
    expect(r?.outcome).toBe('applied');
    if (r?.outcome === 'applied') {
      expect(r.changes).toEqual([]);
      expect(r.gameLevel).toBe('write');
    }
    const after = await counts(db, gameId);
    expect(after.changes).toBe(before.changes);
    expect({ home: after.home, away: after.away, clock: after.clock }).toEqual({
      home: g.home,
      away: g.away,
      clock: '3:10',
    });
  });

  it('a clock line whose period lags the stored period is a lagging view: superseded, period unchanged (rule 3, rev 4.6)', async () => {
    // Advance the stored period to 2 with a clock line (same generation, newest observedAt).
    const [g] = await db<{ status: string; home: number; away: number }[]>`
      select status::text as status, home_points as home, away_points as away from public.games where id = ${gameId}`;
    if (!g) throw new Error('game missing');
    const at = (ms: number) => new Date(T0.getTime() + 7000 + ms);
    const withPeriod = (seq: number, clock: string): PushLine =>
      clockLine((m) => ({
        ...m,
        payload: {
          ...m.payload,
          game: {
            ...m.payload.game,
            status: g.status,
            home: { ...m.payload.game.home, points: g.home },
            away: { ...m.payload.game.away, points: g.away },
          },
          period: { number: seq, sequence: seq, type: 'REG' },
          clocks: { game: clock, game_decimal: clock, running: false },
        },
      }));
    const p2 = await ingest.handle(withPeriod(2, '1000'), at(0));
    expect(p2?.outcome).toBe('applied');
    if (p2?.outcome === 'applied') expect(p2.changes.map((c) => c.type)).toEqual(['status']);
    const before = await staleReasons(db, gameId);
    const lagging = await ingest.handle(withPeriod(1, '0005'), at(1000));
    expect(lagging?.outcome).toBe('applied');
    if (lagging?.outcome === 'applied') {
      expect(lagging.gameLevel).toBe('superseded');
      expect(lagging.changes).toEqual([]);
      expect(lagging.detail).toContain('3-lagging-view');
    }
    const after = await staleReasons(db, gameId);
    expect((after.superseded_observation ?? 0) - (before.superseded_observation ?? 0)).toBe(1);
    const [row] = await db<{ seq: number; clock: string }[]>`
      select current_period_sequence as seq, clock from public.games where id = ${gameId}`;
    expect(row).toEqual({ seq: 2, clock: '10:00' });
  });

  it('a message for another game is skipped and counted', async () => {
    const other = eventLine(1, (ev) => ev);
    if (other.kind !== 'event') throw new Error('unreachable');
    const foreign: PushLine = {
      kind: 'event',
      message: {
        ...other.message,
        payload: {
          ...other.message.payload,
          game: { ...other.message.payload.game, id: 'someone-else' },
        },
      },
    };
    expect(await ingest.handle(foreign, new Date())).toBeNull();
    expect(ingest.stats.otherGame).toBe(1);
  });

  it('backfill: a 429 that never clears ends the backfill sub-run as error after one retry, nothing applied', async () => {
    let fetches = 0;
    const source: DocumentSource = {
      observationSource: 'rest',
      async fetch<T>(): Promise<FetchedDocument<T>> {
        fetches++;
        throw new ProviderHttpError(429, 'pbp', 'Too Many Requests');
      },
    };
    const before = await counts(db, gameId);
    await expect(
      runBackfill(
        {
          db,
          log: silentLog,
          adapter: wnbaAdapter,
          apply: deps,
          gameId,
          parentRun: root,
          source: 'fixture',
          observationSource: 'rest',
          makeSource: () => source,
        },
        'test drop (429)',
      ),
    ).rejects.toBeInstanceOf(ProviderHttpError);
    expect(fetches).toBe(2);
    expect((await counts(db, gameId)).changes).toBe(before.changes);
    const [run] = await db<{ status: string }[]>`
      select status from ingest.ingestion_runs
       where kind = 'backfill' and parent_run_id = ${root.id} order by id desc limit 1`;
    expect(run?.status).toBe('error');
  });

  it('backfill: a complete REST pbp through a backfill sub-run of the same generation reconciles without staleness (after one HTTP 429, retried at the next slot)', async () => {
    const halftime = fixture('sim-93ee7c68-pbp-halftime.json');
    let fetches = 0;
    const source: DocumentSource = {
      observationSource: 'rest',
      async fetch<T>(_feed: string, schema: ZodType<T>): Promise<FetchedDocument<T>> {
        if (++fetches === 1) throw new ProviderHttpError(429, 'pbp', 'Too Many Requests');
        const body = retarget(halftime);
        const now = new Date(T0.getTime() + 10_000);
        return {
          data: schema.parse(body),
          requestedAt: now,
          receivedAt: now,
          bytes: 0,
          rawText: JSON.stringify(body),
        };
      },
    };
    const before = await counts(db, gameId);
    const out = await runBackfill(
      {
        db,
        log: silentLog,
        adapter: wnbaAdapter,
        apply: deps,
        gameId,
        parentRun: root,
        source: 'fixture',
        observationSource: 'rest',
        makeSource: () => source,
      },
      'test drop',
    );
    expect(fetches).toBe(2);
    expect(out.watchId).toBe(root.id);
    expect(out.outcome?.result.outcome).toBe('applied');
    expect(out.outcome?.status).toBe('halftime');
    const after = await counts(db, gameId);
    expect(after.changes).toBeGreaterThan(before.changes + 100);
    expect(after.watchRunId).toBe(String(root.id));
    expect(after.deleted).toBe(1); // the push deletion stays: absence from the document never reinstates
    const [run] = await db<{ kind: string; parentRunId: string; status: string }[]>`
      select kind, parent_run_id::text as "parentRunId", status from ingest.ingestion_runs where id = ${out.runId}`;
    expect(run).toEqual({ kind: 'backfill', parentRunId: String(root.id), status: 'ok' });
    // the push sub-run keeps applying inside the same generation after the backfill
    const again = await ingest.handle(eventLine(1), new Date(T0.getTime() + 11_000));
    expect(again?.outcome).toBe('applied');
    await ingest.end('ok');
    const [pr] = await db<{ status: string }[]>`
      select status from ingest.ingestion_runs where id = ${ingest.run?.id ?? 0}`;
    expect(pr?.status).toBe('ok');
  });
});
