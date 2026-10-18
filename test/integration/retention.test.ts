import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadChanges } from '../../src/api/routes/changes.js';
import { applyChanges } from '../../src/ingest/apply-changes.js';
import { parseClosedBefore, runRetention } from '../../src/ingest/retention.js';
import { startRun } from '../../src/ingest/runs.js';
import { normalizeEvent } from '../../src/leagues/sportradar-basketball/normalize.js';
import { OutboxPublisher } from '../../src/live/outbox-publisher.js';
import { MemoryTransport } from '../../src/live/transport.js';
import { PbpEventSchema } from '../../src/providers/sportradar/schemas/pbp.js';
import {
  apply,
  counts,
  observation,
  pbpClosed,
  replayRun,
  seedGame,
  silentLog,
  testDb,
} from '../helpers/db.js';

/**
 * Retention (plan §2 retained_from_seq, §8 head/tail invariant, §9 "game_changes
 * growth"): for a closed, fully published game the job moves the floor to
 * last_seq + 1 and deletes the change rows and their outbox rows below it;
 * /changes then returns changes=[] with retainedFrom; a later correction
 * continues the sequence; games with unpublished or dead outbox rows are skipped.
 */
const db = testDb();
const deps = { db, log: silentLog };
const T0 = new Date('2026-06-30T23:40:00Z');

beforeAll(async () => {
  await db`select 1`;
});
afterAll(async () => {
  await db.end();
});

async function closedGame(publish: boolean) {
  const nd = pbpClosed();
  const { gameId } = await seedGame(db, nd);
  const run = await replayRun(db, gameId);
  await apply(deps, gameId, nd, observation(run, nd, T0));
  if (publish) {
    const publisher = new OutboxPublisher({ db, log: silentLog, transport: new MemoryTransport() });
    await publisher.drain();
  }
  const c = await counts(db, gameId);
  expect(c.changes).toBeGreaterThan(400);
  return { gameId, run, lastSeq: c.lastSeq, changes: c.changes };
}

describe('retention job', () => {
  it('dry run reports, the real run moves the floor and deletes changes + outbox rows; /changes answers retainedFrom; a later correction continues the seq', async () => {
    const g = await closedGame(true);
    const future = new Date(Date.now() + 60_000);
    const dry = await runRetention(db, silentLog, {
      closedBefore: future,
      dryRun: true,
      gameIds: [g.gameId],
    });
    expect(dry.candidates).toBe(1);
    expect(dry.retained).toEqual([
      {
        gameId: g.gameId,
        floor: g.lastSeq + 1,
        deletedChanges: g.changes,
        deletedOutbox: g.changes,
      },
    ]);
    expect(await counts(db, g.gameId)).toMatchObject({ changes: g.changes, outbox: g.changes });

    // play_event_raw: age this game's raw rows past the window (the set_updated_at trigger would
    // reset the stamp, so the test bypasses triggers for this one statement)
    await db.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update ingest.play_event_raw r set updated_at = now() - interval '40 days'
               from public.play_events p where p.id = r.play_event_id and p.game_id = ${g.gameId}`;
    });
    const real = await runRetention(db, silentLog, {
      closedBefore: future,
      dryRun: false,
      gameIds: [g.gameId],
      rawRetentionDays: 30,
    });
    expect(real.retained).toEqual(dry.retained);
    expect(real.skipped).toEqual([]);
    expect(real.rawDeleted).toBeGreaterThan(400);
    const after = await counts(db, g.gameId);
    expect(after).toMatchObject({ changes: 0, outbox: 0, lastSeq: g.lastSeq });
    const [row] = await db<{ floor: string; events: number; raw: number }[]>`
      select g.retained_from_seq::text as floor,
             (select count(*)::int from public.play_events p where p.game_id = g.id) as events,
             (select count(*)::int from ingest.play_event_raw r join public.play_events p on p.id = r.play_event_id where p.game_id = g.id) as raw
      from public.games g where g.id = ${g.gameId}`;
    expect(row).toEqual({
      floor: String(g.lastSeq + 1),
      events: after.events + after.deleted,
      raw: 0,
    });

    // /changes: history expired -> changes=[], retainedFrom set, client re-snapshots
    const page = await loadChanges(db, g.gameId, 0, 200);
    expect(page).toEqual({
      changes: [],
      nextAfter: 0,
      latestSeq: g.lastSeq,
      hasMore: false,
      retainedFrom: g.lastSeq + 1,
    });
    // A client already at last_seq is current: after >= retainedFrom - 1
    expect((await loadChanges(db, g.gameId, g.lastSeq, 200))?.changes).toEqual([]);

    // A later correction (same generation, a backfill sub-run) continues the sequence at last_seq + 1.
    const [pe] = await db<{ raw: unknown; number: number; type: 'quarter'; seq: number }[]>`
      select r.raw, p.period_number as number, p.period_type as type, p.period_sequence as seq
      from public.play_events p join ingest.play_event_raw r on r.play_event_id = p.id
      where p.game_id = ${g.gameId} and p.deleted_at is null order by p.provider_sequence limit 1`;
    // raw rows were deleted above, so re-use a raw body from the fixture document instead
    expect(pe).toBeUndefined();
    const ev = PbpEventSchema.parse(pbpClosed().batch.events[0]?.raw);
    const mutated = {
      ...ev,
      description: `${ev.description ?? ''} [late correction]`,
      updated: '2026-07-01T05:00:00+00:00',
    };
    const sub = await startRun(db, {
      kind: 'backfill',
      league: 'wnba',
      gameId: g.gameId,
      source: 'fixture',
      parentRunId: g.run.id,
    });
    const first = pbpClosed().batch.events[0];
    const period = {
      number: first?.periodNumber ?? 1,
      type: first?.periodType ?? ('quarter' as const),
      sequence: first?.periodSequence ?? 1,
    };
    const r = await applyChanges(
      deps,
      g.gameId,
      {
        events: [normalizeEvent(mutated, period)],
        deletedEvents: [],
        teamStats: [],
        playerStats: [],
      },
      {
        source: 'fixture',
        runId: sub.id,
        watchId: sub.watchId,
        observedAt: new Date(),
        isComplete: false,
        gameView: null,
      },
    );
    expect(r.outcome).toBe('applied');
    if (r.outcome === 'applied') {
      expect(r.changes.map((c) => c.type)).toEqual(['event_update']);
      expect(r.firstSeq).toBe(g.lastSeq + 1);
    }
    const tail = await loadChanges(db, g.gameId, g.lastSeq, 200);
    expect(tail?.changes.map((c) => c.seq)).toEqual([g.lastSeq + 1]);
    expect(tail?.retainedFrom).toBe(g.lastSeq + 1);
    // The floor is untouched by the new row and the head/tail invariant holds.
    const [inv] = await db<{ below: number; head: number }[]>`
      select (select count(*)::int from public.game_changes c where c.game_id = ${g.gameId} and c.seq < ${g.lastSeq + 1}) as below,
             (select count(*)::int from public.game_changes c where c.game_id = ${g.gameId} and c.seq = ${g.lastSeq + 1}) as head`;
    expect(inv).toEqual({ below: 0, head: 1 });
  });

  it('skips a closed game with unpublished outbox rows, and one with dead rows, writing nothing', async () => {
    // The dead game first: closedGame(true) drains the WHOLE outbox, which would publish the
    // "unpublished" game's rows if it existed already.
    const dead = await closedGame(true);
    await db`update ingest.broadcast_outbox set published_at = null, dead_at = now(), attempts = 10
             where game_id = ${dead.gameId} and seq = 1`;
    const unpublished = await closedGame(false);
    const r = await runRetention(db, silentLog, {
      closedBefore: new Date(Date.now() + 60_000),
      dryRun: false,
      gameIds: [unpublished.gameId, dead.gameId],
    });
    expect(r.retained).toEqual([]);
    expect(r.skipped.map((s) => [s.gameId, s.reason]).sort()).toEqual(
      [
        [unpublished.gameId, 'unpublished_outbox_rows'],
        [dead.gameId, 'dead_outbox_rows'],
      ].sort(),
    );
    expect(await counts(db, unpublished.gameId)).toMatchObject({ changes: unpublished.changes });
    expect(await counts(db, dead.gameId)).toMatchObject({ changes: dead.changes });
    // clean up the dead row so the global outbox invariants hold for the validator
    await db`update ingest.broadcast_outbox set dead_at = null, attempts = 0, next_attempt_at = now() where game_id = ${dead.gameId}`;
    await new OutboxPublisher({ db, log: silentLog, transport: new MemoryTransport() }).drain();
  });

  it('a game that is not closed, or whose history moved after the cutoff, is never a candidate; the floor cannot be bypassed', async () => {
    const g = await closedGame(true);
    const past = new Date(Date.now() - 3_600_000);
    const r = await runRetention(db, silentLog, {
      closedBefore: past,
      dryRun: false,
      gameIds: [g.gameId],
    });
    expect(r.candidates).toBe(0);
    // Direct deletes of live history are refused by the trigger (CLAUDE.md non-negotiable 5).
    await expect(
      db`delete from public.game_changes where game_id = ${g.gameId} and seq = 1`,
    ).rejects.toThrow(/append-only|retained_from_seq/);
    expect(parseClosedBefore('30d', new Date('2026-10-18T00:00:00Z')).toISOString()).toBe(
      '2026-09-18T00:00:00.000Z',
    );
    expect(() => parseClosedBefore('soon')).toThrow(/--closed-before/);
  });
});
