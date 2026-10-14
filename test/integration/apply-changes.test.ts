import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFaultInjector } from '../../src/ingest/fault.js';
import type { NormalizedDocument } from '../../src/ingest/types.js';
import { normalizeEvent } from '../../src/leagues/sportradar-basketball/normalize.js';
import { PbpEventSchema } from '../../src/providers/sportradar/schemas/pbp.js';
import {
  apply,
  counts,
  observation,
  pbpCreated,
  pbpQ1,
  replayRun,
  seedGame,
  silentLog,
  staleReasons,
  summaryQ1,
  testDb,
} from '../helpers/db.js';

const db = testDb();
const deps = { db, log: silentLog };
const T0 = new Date('2026-06-30T23:30:00Z');
const later = (s: number) => new Date(T0.getTime() + s * 1000);

beforeAll(async () => {
  await db`select 1`;
});
afterAll(async () => {
  await db.end();
});

/** Clone the fixture document with one event's body changed and its `updated` bumped (or not). */
function withCorrection(
  nd: NormalizedDocument,
  index: number,
  bumpUpdated: boolean,
): { doc: NormalizedDocument; providerEventId: string } {
  const target = nd.batch.events[index];
  if (!target) throw new Error('no such event');
  const raw = PbpEventSchema.parse(target.raw);
  const updated = bumpUpdated
    ? new Date(Date.parse(raw.updated ?? T0.toISOString()) + 1000).toISOString()
    : raw.updated;
  const mutated = PbpEventSchema.parse({
    ...raw,
    description: `${raw.description} [corrected]`,
    ...(updated ? { updated } : {}),
  });
  const period = {
    number: target.periodNumber ?? 1,
    type: target.periodType ?? 'quarter',
    sequence: target.periodSequence ?? 1,
  };
  const events = nd.batch.events.map((e, i) => (i === index ? normalizeEvent(mutated, period) : e));
  return {
    doc: { ...nd, batch: { ...nd.batch, events } },
    providerEventId: target.providerEventId,
  };
}

describe('applyChanges: durable + observation writes in one transaction', () => {
  it('idempotence: the same normalized batch applied twice yields 0 new changes', async () => {
    const nd = pbpQ1();
    const { gameId } = await seedGame(db, nd);
    const run = await replayRun(db, gameId);
    const first = await apply(deps, gameId, nd, observation(run, nd, T0));
    expect(first.outcome).toBe('applied');
    if (first.outcome !== 'applied') return;
    expect(first.changes.length).toBe(nd.batch.events.length + 2); // events + status + period line score
    expect(first.changes.map((c) => c.seq)).toEqual(first.changes.map((_c, i) => i + 1));
    const before = await counts(db, gameId);
    const second = await apply(deps, gameId, nd, observation(run, nd, T0));
    expect(second.outcome).toBe('applied');
    if (second.outcome !== 'applied') return;
    expect(second.changes).toEqual([]);
    expect(second.gameLevel).toBe('superseded'); // same observedAt: not newer
    const third = await apply(deps, gameId, nd, observation(run, nd, later(3)));
    expect(third.outcome === 'applied' && third.changes).toEqual([]);
    expect(third.outcome === 'applied' && third.gameLevel).toBe('write'); // observation refreshed, no seq
    const after = await counts(db, gameId);
    expect(after.changes).toBe(before.changes);
    expect(after.lastSeq).toBe(before.lastSeq);
    expect(after.events).toBe(nd.batch.events.length);
  });

  it('contiguity and outbox parity by join: one outbox row per change, 0 unmatched, 0 dead', async () => {
    const nd = pbpQ1();
    const { gameId } = await seedGame(db, nd);
    const run = await replayRun(db, gameId);
    await apply(deps, gameId, nd, observation(run, nd, T0));
    const sum = summaryQ1();
    await apply(deps, gameId, sum, observation(run, sum, later(1)));
    const [gaps] = await db<{ n: number }[]>`
      select count(*)::int as n from public.game_changes c
      where c.game_id = ${gameId} and c.seq > 1
        and not exists (select 1 from public.game_changes p where p.game_id = c.game_id and p.seq = c.seq - 1)`;
    expect(gaps?.n).toBe(0);
    const [parity] = await db<{ n: number }[]>`
      select count(*)::int as n from public.game_changes c
      full outer join ingest.broadcast_outbox o on o.change_id = c.id
      where (c.game_id = ${gameId} or o.game_id = ${gameId})
        and (c.id is null or o.change_id is null or o.game_id <> c.game_id or o.seq <> c.seq or o.channel <> 'game:' || c.game_id::text)`;
    expect(parity?.n).toBe(0);
    const c = await counts(db, gameId);
    expect(c.outbox).toBe(c.changes);
    expect(c.lastSeq).toBe(c.changes);
    const [dead] = await db<
      { n: number }[]
    >`select count(*)::int as n from ingest.broadcast_outbox where game_id = ${gameId} and dead_at is not null`;
    expect(dead?.n).toBe(0);
    const types = await db<
      { t: string; n: number }[]
    >`select change_type::text as t, count(*)::int as n from public.game_changes where game_id = ${gameId} group by 1`;
    const byType = Object.fromEntries(types.map((r) => [r.t, r.n]));
    expect(byType).toMatchObject({ stats_team: 2, event_insert: nd.batch.events.length });
    expect(byType.status).toBeGreaterThanOrEqual(1);
    expect(byType.period).toBeGreaterThanOrEqual(1);
  });

  it('correction: mutate one event body and bump updated -> exactly one event_update with a new seq, play row updated in place', async () => {
    const nd = pbpQ1();
    const { gameId } = await seedGame(db, nd);
    const run = await replayRun(db, gameId);
    await apply(deps, gameId, nd, observation(run, nd, T0));
    const before = await counts(db, gameId);
    const [rowBefore] = await db<{ id: string; payload: { description?: string } }[]>`
      select id, payload from public.play_events where game_id = ${gameId} and provider_event_id = ${nd.batch.events[5]?.providerEventId ?? ''}`;
    const { doc, providerEventId } = withCorrection(nd, 5, true);
    const r = await apply(deps, gameId, doc, observation(run, doc, later(5)));
    expect(r.outcome === 'applied' && r.changes.map((c) => [c.type, c.seq])).toEqual([
      ['event_update', before.lastSeq + 1],
    ]);
    expect(
      r.outcome === 'applied' &&
        r.changes[0]?.type === 'event_update' &&
        r.changes[0].providerEventId,
    ).toBe(providerEventId);
    const [rowAfter] = await db<
      { id: string; payload: { description?: string }; providerUpdatedAt: Date }[]
    >`
      select id, payload, provider_updated_at as "providerUpdatedAt" from public.play_events where game_id = ${gameId} and provider_event_id = ${providerEventId}`;
    expect(rowAfter?.id).toBe(rowBefore?.id);
    expect(rowAfter?.payload.description).toMatch(/\[corrected\]$/);
    const after = await counts(db, gameId);
    expect(after.changes).toBe(before.changes + 1);
    expect(after.events).toBe(before.events);
    // an older revision of the same event arriving afterwards is ignored, not applied and not stale
    const stale = await apply(deps, gameId, nd, observation(run, nd, later(6)));
    expect(stale.outcome === 'applied' && stale.changes).toEqual([]);
    expect(stale.outcome === 'applied' && stale.counts.ignoredOlder).toBe(1);
  });

  it('correction without an updated bump is still applied (hash decides), and the marker path yields one event_delete', async () => {
    const nd = pbpQ1();
    const { gameId } = await seedGame(db, nd);
    const run = await replayRun(db, gameId);
    await apply(deps, gameId, nd, observation(run, nd, T0));
    const { doc, providerEventId } = withCorrection(nd, 3, false);
    const r = await apply(deps, gameId, doc, observation(run, doc, later(1)));
    expect(r.outcome === 'applied' && r.changes.map((c) => c.type)).toEqual(['event_update']);
    const before = await counts(db, gameId);
    const del: NormalizedDocument = {
      ...doc,
      batch: { events: [], deletedEventIds: [providerEventId], teamStats: [] },
      gameView: null,
      isComplete: false,
    };
    const d = await apply(deps, gameId, del, observation(run, del, later(2)));
    expect(d.outcome === 'applied' && d.changes.map((c) => [c.type, c.seq])).toEqual([
      ['event_delete', before.lastSeq + 1],
    ]);
    const after = await counts(db, gameId);
    expect(after.deleted).toBe(1);
    expect(after.events).toBe(before.events - 1);
    // the same marker again: nothing; the event's own body again (same revision): nothing (stays deleted)
    expect((await apply(deps, gameId, del, observation(run, del, later(3)))).changes).toEqual([]);
    expect((await apply(deps, gameId, doc, observation(run, doc, later(4)))).changes).toEqual([]);
    // absence of the deleted event from a later full document never deletes anything else
    const c2 = await counts(db, gameId);
    expect(c2.deleted).toBe(1);
  });

  it('no regression: a new generation replaying from the start is stale (run_regresses_state), score and watch_run_id unchanged', async () => {
    const nd = pbpQ1();
    const { gameId } = await seedGame(db, nd);
    const gen1 = await replayRun(db, gameId);
    await apply(deps, gameId, nd, observation(gen1, nd, T0));
    const before = await counts(db, gameId);
    const gen2 = await replayRun(db, gameId);
    const created = pbpCreated(); // the restarted replay's first document: status created, 0-0, no events
    const r1 = await apply(deps, gameId, created, observation(gen2, created, later(60)));
    expect(r1).toMatchObject({ outcome: 'stale', reason: 'run_regresses_state' });
    const partial: NormalizedDocument = {
      ...nd,
      batch: { ...nd.batch, events: nd.batch.events.slice(0, 5) },
    };
    const r2 = await apply(deps, gameId, partial, observation(gen2, partial, later(61)));
    expect(r2).toMatchObject({ outcome: 'stale', reason: 'run_regresses_state' });
    const after = await counts(db, gameId);
    expect(after).toMatchObject({
      changes: before.changes,
      home: before.home,
      away: before.away,
      watchRunId: String(gen1.watchId),
    });
    expect(await staleReasons(db, gameId)).toEqual({ run_regresses_state: 2 });
    // once the restarted replay catches up to the stored newest position it is accepted and advances the generation with 0 changes
    const r3 = await apply(deps, gameId, nd, observation(gen2, nd, later(62)));
    expect(r3.outcome === 'applied' && r3.changes).toEqual([]);
    expect(r3.outcome === 'applied' && r3.generationAdvanced).toBe(true);
    expect((await counts(db, gameId)).watchRunId).toBe(String(gen2.watchId));
  });

  it('delayed REST summary whose observedAt precedes the stored observation -> no game-level write, one superseded_observation', async () => {
    const nd = pbpQ1();
    const { gameId } = await seedGame(db, nd);
    const run = await replayRun(db, gameId);
    await apply(deps, gameId, nd, observation(run, nd, later(30)));
    const stored = await counts(db, gameId);
    const sum = summaryQ1();
    const older = {
      ...sum,
      gameView: sum.gameView
        ? { ...sum.gameView, clock: '0:01', score: { home: 99, away: 99 } }
        : null,
    };
    const r = await apply(
      deps,
      gameId,
      older,
      observation(run, older, later(10), { source: 'rest' }),
    );
    expect(r.outcome === 'applied' && r.gameLevel).toBe('superseded');
    const after = await counts(db, gameId);
    expect(after).toMatchObject({ clock: stored.clock, home: stored.home, away: stored.away });
    expect(await staleReasons(db, gameId)).toEqual({ superseded_observation: 1 });
    // its stats were still reconciled per entity
    expect(r.outcome === 'applied' && r.changes.map((c) => c.type)).toEqual([
      'stats_team',
      'stats_team',
    ]);
    // and a delayed pbp whose event carries a newer `updated` still corrects that event while the clock stays put
    const { doc } = withCorrection(nd, 2, true);
    const r2 = await apply(deps, gameId, doc, observation(run, doc, later(11), { source: 'rest' }));
    expect(r2.outcome === 'applied' && r2.changes.map((c) => c.type)).toEqual(['event_update']);
    expect((await counts(db, gameId)).clock).toBe(stored.clock);
  });

  it('in-flight batch tagged with an older watchId -> older_run, nothing written', async () => {
    const nd = pbpQ1();
    const { gameId } = await seedGame(db, nd);
    const gen1 = await replayRun(db, gameId);
    const gen2 = await replayRun(db, gameId);
    await apply(deps, gameId, nd, observation(gen2, nd, T0));
    const before = await counts(db, gameId);
    const { doc } = withCorrection(nd, 1, true);
    const r = await apply(deps, gameId, doc, observation(gen1, doc, later(5)));
    expect(r).toMatchObject({ outcome: 'stale', reason: 'older_run' });
    expect(await counts(db, gameId)).toEqual(before);
    expect(await staleReasons(db, gameId)).toEqual({ older_run: 1 });
  });

  it('generation-less poll: writes status before tip-off, is superseded during the game, never advances watch_run_id', async () => {
    const created = pbpCreated();
    const { gameId } = await seedGame(db, created);
    const poll = { id: 0, watchId: null } as const;
    const postponed = {
      ...created,
      gameView: created.gameView
        ? { ...created.gameView, status: 'time_tbd' as const, score: { home: 5, away: 5 } }
        : null,
    };
    const pollRun = await db<
      { id: string }[]
    >`insert into ingest.ingestion_runs (kind, league, source) values ('poll_schedule', 'wnba', 'fixture') returning id::text`;
    const pollId = Number(pollRun[0]?.id);
    const r0 = await apply(deps, gameId, postponed, {
      ...observation({ id: pollId, watchId: poll.watchId }, postponed, T0),
      isComplete: false,
    });
    expect(r0.outcome === 'applied' && r0.changes.map((c) => c.type)).toEqual(['status']);
    expect(r0.outcome === 'applied' && r0.changes[0]?.body).toMatchObject({
      status: 'time_tbd',
      score: { home: 0, away: 0 },
    }); // score never written by a poll
    const nd = pbpQ1();
    const run = await replayRun(db, gameId);
    await apply(deps, gameId, nd, observation(run, nd, later(100)));
    const before = await counts(db, gameId);
    const lagging = {
      ...created,
      gameView: created.gameView
        ? { ...created.gameView, status: 'inprogress' as const, clock: '9:59' }
        : null,
    };
    const r1 = await apply(deps, gameId, lagging, {
      ...observation({ id: pollId, watchId: null }, lagging, later(200)),
      isComplete: false,
    });
    expect(r1.outcome === 'applied' && r1.gameLevel).toBe('superseded');
    expect(await counts(db, gameId)).toEqual(before);
    expect(await staleReasons(db, gameId)).toEqual({ superseded_observation: 1 });
  });

  it('unknown provider status mid-game keeps inprogress, emits no status change, is reported on the batch', async () => {
    const nd = pbpQ1();
    const { gameId } = await seedGame(db, nd);
    const run = await replayRun(db, gameId);
    await apply(deps, gameId, nd, observation(run, nd, T0));
    // the same document again with an unmappable status: nothing changes, the observation refreshes
    const weird: NormalizedDocument = {
      ...nd,
      gameView: nd.gameView ? { ...nd.gameView, status: null, unknownStatus: 'weird' } : null,
    };
    const r = await apply(deps, gameId, weird, observation(run, weird, later(5)));
    expect(r.outcome === 'applied' && r.gameLevel).toBe('write');
    expect(r.outcome === 'applied' && r.changes).toEqual([]);
    const [g] = await db<{ status: string; observedAt: Date }[]>`
      select status::text as status, observed_at as "observedAt" from public.games where id = ${gameId}`;
    expect(g?.status).toBe('inprogress');
    expect(g?.observedAt?.toISOString()).toBe(later(5).toISOString());
    // a later summary (new score) with an unmappable status: its status change still says inprogress
    const sum = summaryQ1();
    const weirdSum: NormalizedDocument = {
      ...sum,
      gameView: sum.gameView ? { ...sum.gameView, status: null, unknownStatus: 'weird' } : null,
    };
    const r2 = await apply(deps, gameId, weirdSum, observation(run, weirdSum, later(6)));
    const statusChange = r2.outcome === 'applied' && r2.changes.find((c) => c.type === 'status');
    expect(statusChange && statusChange.type === 'status' && statusChange.body.status).toBe(
      'inprogress',
    );
    expect(
      (
        await db<
          { status: string }[]
        >`select status::text as status from public.games where id = ${gameId}`
      )[0]?.status,
    ).toBe('inprogress');
    // and a brand-new row created from an unknown status defaults to scheduled, the only default there is
    const created = await seedGame(db, { ...nd, gameView: weird.gameView });
    const [row] = await db<{ status: string }[]>`
      select status::text as status from public.games where id = ${created.gameId}`;
    expect(row?.status).toBe('scheduled');
  });

  it('crash point (b): a fault just before commit rolls the whole batch back; the retry applies it once', async () => {
    const nd = pbpQ1();
    const { gameId } = await seedGame(db, nd);
    const run = await replayRun(db, gameId);
    const fault = createFaultInjector(
      { kind: 'before_commit', atSeq: 1 },
      () => {
        throw new Error('SIGKILL (simulated)');
      },
      () => undefined,
    );
    await expect(apply({ ...deps, fault }, gameId, nd, observation(run, nd, T0))).rejects.toThrow(
      /SIGKILL/,
    );
    expect(await counts(db, gameId)).toMatchObject({
      changes: 0,
      events: 0,
      outbox: 0,
      lastSeq: 0,
    });
    const r = await apply(deps, gameId, nd, observation(run, nd, later(1)));
    expect(r.outcome === 'applied' && r.changes.length).toBeGreaterThan(0);
    const c = await counts(db, gameId);
    expect(c.changes).toBe(c.lastSeq);
    expect(c.outbox).toBe(c.changes);
  });
});
