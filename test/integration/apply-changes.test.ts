import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureGame } from '../../src/ingest/apply-changes.js';
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

  it('clock correction 5:00 -> 5:30 inside one period is accepted AND observed: games.clock equals the corrected clock and observed_at advanced', async () => {
    const nd0 = pbpQ1();
    const nd = {
      ...nd0,
      gameView: nd0.gameView ? { ...nd0.gameView, clock: '5:00', clockDecimal: '5:00' } : null,
    };
    const { gameId } = await seedGame(db, nd);
    const run = await replayRun(db, gameId);
    await apply(deps, gameId, nd, observation(run, nd, T0));
    const game = async () =>
      (
        await db<{ clock: string | null; observedAt: Date; clockAsOf: Date; lastSeq: string }[]>`
          select clock, observed_at as "observedAt", clock_as_of as "clockAsOf", last_seq::text as "lastSeq"
          from public.games where id = ${gameId}`
      )[0];
    const before = await game();
    expect(before).toMatchObject({ clock: '5:00', observedAt: T0 });
    const corrected = {
      ...nd,
      gameView: nd.gameView ? { ...nd.gameView, clock: '5:30', clockDecimal: '5:30' } : null,
    };
    const r = await apply(deps, gameId, corrected, observation(run, corrected, later(10)));
    expect(r).toMatchObject({ outcome: 'applied', gameLevel: 'write' });
    expect(r.outcome === 'applied' && r.changes).toEqual([]); // clock is an observation, never a seq
    const after = await game();
    expect(after).toMatchObject({ clock: '5:30', observedAt: later(10), clockAsOf: later(10) });
    expect(after?.lastSeq).toBe(before?.lastSeq);
    // and the same correction arriving in a NEW generation is also accepted (the clock going up
    // inside a period is never a regression signal when the score did not drop)
    const gen2 = await replayRun(db, gameId);
    const r2 = await apply(deps, gameId, corrected, observation(gen2, corrected, later(20)));
    expect(r2).toMatchObject({ outcome: 'applied', generationAdvanced: true, gameLevel: 'write' });
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
      batch: {
        events: [],
        deletedEvents: [{ providerEventId, updatedAt: null }],
        teamStats: [],
        playerStats: [],
      },
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

  it('revision-only update: a newer updated with the same body advances provider_updated_at without a change; a missing updated never nulls the stored revision', async () => {
    const nd = pbpQ1();
    const { gameId } = await seedGame(db, nd);
    const run = await replayRun(db, gameId);
    await apply(deps, gameId, nd, observation(run, nd, T0));
    const before = await counts(db, gameId);
    const target = nd.batch.events[4];
    if (!target?.providerUpdatedAt) throw new Error('fixture event has no updated');
    const rev = (plusSeconds: number) =>
      new Date(Date.parse(target.providerUpdatedAt ?? '') + plusSeconds * 1000).toISOString();
    const revised = (updatedAt: string | null, ev = target): NormalizedDocument => ({
      ...nd,
      batch: { ...nd.batch, events: [{ ...ev, providerUpdatedAt: updatedAt }] },
      gameView: null,
      isComplete: false,
    });
    // revision +12 s, identical body: touch
    const touch = await apply(deps, gameId, revised(rev(12)), observation(run, nd, later(1)));
    expect(touch.outcome === 'applied' && touch.changes).toEqual([]);
    expect(touch.outcome === 'applied' && touch.counts.touched).toBe(1);
    const row = async () =>
      (
        await db<{ providerUpdatedAt: Date; payload: { description?: string }; rawRev: Date }[]>`
          select p.provider_updated_at as "providerUpdatedAt", p.payload, r.provider_updated_at as "rawRev"
          from public.play_events p join ingest.play_event_raw r on r.play_event_id = p.id
          where p.game_id = ${gameId} and p.provider_event_id = ${target.providerEventId}`
      )[0];
    const r1 = await row();
    expect(r1?.providerUpdatedAt.toISOString()).toBe(rev(12));
    expect(r1?.rawRev.toISOString()).toBe(rev(12));
    expect((await counts(db, gameId)).changes).toBe(before.changes);
    // revision +11 s with a different body: older than the stored 12, ignored, body unchanged
    const { doc } = withCorrection(nd, 4, false);
    const corrected = doc.batch.events[4];
    if (!corrected) throw new Error('missing');
    const older = await apply(
      deps,
      gameId,
      revised(rev(11), corrected),
      observation(run, nd, later(2)),
    );
    expect(older.outcome === 'applied' && older.changes).toEqual([]);
    expect(older.outcome === 'applied' && older.counts.ignoredOlder).toBe(1);
    expect((await row())?.payload.description).not.toMatch(/\[corrected\]/);
    // a differing body without any `updated`: hash decides (update) and the stored revision stays 12
    const noRev = await apply(
      deps,
      gameId,
      revised(null, corrected),
      observation(run, nd, later(3)),
    );
    expect(noRev.outcome === 'applied' && noRev.changes.map((c) => c.type)).toEqual([
      'event_update',
    ]);
    const r3 = await row();
    expect(r3?.payload.description).toMatch(/\[corrected\]/);
    expect(r3?.providerUpdatedAt.toISOString()).toBe(rev(12));
  });

  it('deletion revision: an older marker is ignored (counted); a marker without one deletes with deleted_revision_at null; reinstatement needs a newer revision than the deletion', async () => {
    const nd = pbpQ1();
    const { gameId } = await seedGame(db, nd);
    const run = await replayRun(db, gameId);
    await apply(deps, gameId, nd, observation(run, nd, T0));
    const target = nd.batch.events[6];
    if (!target?.providerUpdatedAt) throw new Error('fixture event has no updated');
    const id = target.providerEventId;
    const rev = (plusSeconds: number) =>
      new Date(Date.parse(target.providerUpdatedAt ?? '') + plusSeconds * 1000).toISOString();
    const markerDoc = (updatedAt: string | null): NormalizedDocument => ({
      ...nd,
      batch: {
        events: [],
        deletedEvents: [{ providerEventId: id, updatedAt }],
        teamStats: [],
        playerStats: [],
      },
      gameView: null,
      isComplete: false,
    });
    const row = async () =>
      (
        await db<{ deletedAt: Date | null; deletedRevisionAt: Date | null }[]>`
          select deleted_at as "deletedAt", deleted_revision_at as "deletedRevisionAt"
          from public.play_events where game_id = ${gameId} and provider_event_id = ${id}`
      )[0];
    // marker older than the event's own revision: ignored
    const olderMarker = await apply(
      deps,
      gameId,
      markerDoc(rev(-5)),
      observation(run, nd, later(1)),
    );
    expect(olderMarker.outcome === 'applied' && olderMarker.changes).toEqual([]);
    expect(olderMarker.outcome === 'applied' && olderMarker.counts.ignoredOlderDeletions).toBe(1);
    expect((await row())?.deletedAt).toBeNull();
    // marker without a revision (the recorded fixture's shape): applied, revision recorded as null
    const del = await apply(deps, gameId, markerDoc(null), observation(run, nd, later(2)));
    expect(del.outcome === 'applied' && del.changes.map((c) => c.type)).toEqual(['event_delete']);
    const afterDel = await row();
    expect(afterDel?.deletedAt).not.toBeNull();
    expect(afterDel?.deletedRevisionAt).toBeNull();
    // the event's own revision again: not reinstated (not newer than coalesce(null, updated))
    const same: NormalizedDocument = {
      ...nd,
      batch: { ...nd.batch, events: [target] },
      gameView: null,
      isComplete: false,
    };
    expect((await apply(deps, gameId, same, observation(run, nd, later(3)))).changes).toEqual([]);
    // a newer revision reinstates and clears deleted_revision_at
    const newer: NormalizedDocument = {
      ...same,
      batch: { ...same.batch, events: [{ ...target, providerUpdatedAt: rev(10) }] },
    };
    const back = await apply(deps, gameId, newer, observation(run, nd, later(4)));
    expect(back.outcome === 'applied' && back.changes.map((c) => c.type)).toEqual(['event_insert']);
    expect(await row()).toEqual({ deletedAt: null, deletedRevisionAt: null });
    // a marker carrying revision +20 deletes again and is recorded; +15 (older than the event's +10? no: newer) ...
    const del2 = await apply(deps, gameId, markerDoc(rev(20)), observation(run, nd, later(5)));
    expect(del2.outcome === 'applied' && del2.changes.map((c) => c.type)).toEqual(['event_delete']);
    expect((await row())?.deletedRevisionAt?.toISOString()).toBe(rev(20));
    // now an incoming revision +15 is newer than the event (+10) but not than the deletion (+20): stays deleted
    const r15: NormalizedDocument = {
      ...same,
      batch: { ...same.batch, events: [{ ...target, providerUpdatedAt: rev(15) }] },
    };
    expect((await apply(deps, gameId, r15, observation(run, nd, later(6)))).changes).toEqual([]);
    expect((await row())?.deletedAt).not.toBeNull();
  });

  it('repeated deletion revision is persisted without seq/outbox growth and blocks an intermediate event', async () => {
    const nd = pbpQ1();
    const { gameId } = await seedGame(db, nd);
    const run = await replayRun(db, gameId);
    await apply(deps, gameId, nd, observation(run, nd, T0));
    const target = nd.batch.events[6];
    if (!target?.providerUpdatedAt) throw new Error('fixture event has no updated');
    const id = target.providerEventId;
    const rev = (s: number) =>
      new Date(Date.parse(target.providerUpdatedAt ?? '') + s * 1000).toISOString();
    const marker = (updatedAt: string | null): NormalizedDocument => ({
      ...nd,
      gameView: null,
      isComplete: false,
      batch: {
        events: [],
        deletedEvents: [{ providerEventId: id, updatedAt }],
        teamStats: [],
        playerStats: [],
      },
    });
    const applyDoc = (doc: NormalizedDocument, at: number) =>
      apply(deps, gameId, doc, observation(run, doc, later(at)));
    const row = async () =>
      (
        await db<{ deletedAt: Date | null; deletedRevisionAt: Date | null }[]>`
      select deleted_at as "deletedAt", deleted_revision_at as "deletedRevisionAt"
      from public.play_events where game_id = ${gameId} and provider_event_id = ${id}`
      )[0];
    await applyDoc(marker(rev(20)), 1);
    const deleted = await row();
    const before = await counts(db, gameId);
    expect((await applyDoc(marker(rev(40)), 2)).changes).toEqual([]);
    expect((await row())?.deletedRevisionAt?.toISOString()).toBe(rev(40));
    expect((await row())?.deletedAt).toEqual(deleted?.deletedAt);
    for (const revision of [rev(30), rev(40), null]) {
      expect((await applyDoc(marker(revision), 3)).changes).toEqual([]);
      expect((await row())?.deletedRevisionAt?.toISOString()).toBe(rev(40));
    }
    const event = (revision: string): NormalizedDocument => ({
      ...nd,
      gameView: null,
      isComplete: false,
      batch: {
        events: [{ ...target, providerUpdatedAt: revision }],
        deletedEvents: [],
        teamStats: [],
        playerStats: [],
      },
    });
    expect((await applyDoc(event(rev(30)), 4)).changes).toEqual([]);
    expect((await row())?.deletedAt).not.toBeNull();
    expect(await counts(db, gameId)).toEqual(before);
    expect((await applyDoc(event(rev(50)), 5)).changes.map((c) => c.type)).toEqual([
      'event_insert',
    ]);
    expect(await row()).toEqual({ deletedAt: null, deletedRevisionAt: null });
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
    // its stats were still reconciled per entity (team lines and, since M2, player lines)
    const types = r.outcome === 'applied' ? r.changes.map((c) => c.type) : [];
    expect(types.filter((t) => t === 'stats_team')).toHaveLength(2);
    expect(types.filter((t) => t === 'stats_player')).toHaveLength(sum.batch.playerStats.length);
    expect(types.every((t) => t === 'stats_team' || t === 'stats_player')).toBe(true);
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

  it('omission is not change: a document without coverage / provider updated keeps the stored values; a present value changes them', async () => {
    const nd = pbpQ1();
    const { gameId } = await seedGame(db, nd);
    const run = await replayRun(db, gameId);
    const withUpdated: NormalizedDocument = {
      ...nd,
      gameView: nd.gameView
        ? { ...nd.gameView, providerUpdatedAt: '2026-06-30T23:31:00+00:00' }
        : null,
    };
    await apply(deps, gameId, withUpdated, observation(run, withUpdated, T0));
    const game = async () =>
      (
        await db<{ coverage: string; providerUpdatedAt: Date | null; venue: unknown }[]>`
          select coverage::text as coverage, provider_updated_at as "providerUpdatedAt", venue
          from public.games where id = ${gameId}`
      )[0];
    expect(await game()).toMatchObject({
      coverage: 'full',
      providerUpdatedAt: new Date('2026-06-30T23:31:00Z'),
    });
    // omitted coverage, omitted provider updated, omitted venue: nothing moves
    const omitting: NormalizedDocument = {
      ...nd,
      gameView: nd.gameView
        ? { ...nd.gameView, coverage: null, providerUpdatedAt: null, venue: null }
        : null,
    };
    const r = await apply(deps, gameId, omitting, observation(run, omitting, later(1)));
    expect(r.outcome === 'applied' && r.gameLevel).toBe('write');
    expect(await game()).toMatchObject({
      coverage: 'full',
      providerUpdatedAt: new Date('2026-06-30T23:31:00Z'),
      venue: nd.gameView?.venue ?? null,
    });
    // an unrecognized coverage string is treated as omitted, never written as 'unknown'
    const weird: NormalizedDocument = {
      ...nd,
      gameView: nd.gameView ? { ...nd.gameView, coverage: 'something_new' } : null,
    };
    await apply(deps, gameId, weird, observation(run, weird, later(2)));
    expect((await game())?.coverage).toBe('full');
    // a present, recognized value is a change
    const extended: NormalizedDocument = {
      ...nd,
      gameView: nd.gameView
        ? {
            ...nd.gameView,
            coverage: 'extended_boxscore',
            providerUpdatedAt: '2026-06-30T23:32:00+00:00',
          }
        : null,
    };
    await apply(deps, gameId, extended, observation(run, extended, later(3)));
    expect(await game()).toMatchObject({
      coverage: 'extended_boxscore',
      providerUpdatedAt: new Date('2026-06-30T23:32:00Z'),
    });
    // and the row-creation path (ensureGame): no coverage creates the row as 'unknown' once (the only
    // place that value is written), a later document with coverage fixes it, a later one without keeps it
    const base = {
      league: 'wnba' as const,
      providerGameId: `test-cov-${gameId}`,
      scheduledAt: T0.toISOString(),
      status: 'scheduled' as const,
      homeTeamId: null,
      awayTeamId: null,
      venue: null,
      broadcasts: null,
    };
    const { id: created } = await ensureGame(db, { ...base, coverage: null });
    const cov = async () =>
      (
        await db<
          { c: string }[]
        >`select coverage::text as c from public.games where id = ${created}`
      )[0]?.c;
    expect(await cov()).toBe('unknown');
    await ensureGame(db, { ...base, coverage: 'boxscore' });
    expect(await cov()).toBe('boxscore');
    await ensureGame(db, { ...base, coverage: null });
    expect(await cov()).toBe('boxscore');
    // scheduled_at: a document without `scheduled` keeps the stored one (insert without one uses now())
    const sched = async () =>
      (
        await db<{ s: Date }[]>`select scheduled_at as s from public.games where id = ${created}`
      )[0]?.s.toISOString();
    expect(await sched()).toBe(T0.toISOString());
    await ensureGame(db, { ...base, coverage: null, scheduledAt: null });
    expect(await sched()).toBe(T0.toISOString());
    await ensureGame(db, { ...base, coverage: null, scheduledAt: later(3600).toISOString() });
    expect(await sched()).toBe(later(3600).toISOString());
    const { id: noSched } = await ensureGame(db, {
      ...base,
      providerGameId: `test-nosched-${gameId}`,
      coverage: null,
      scheduledAt: null,
    });
    const [row] = await db<
      { s: Date }[]
    >`select scheduled_at as s from public.games where id = ${noSched}`;
    expect(Math.abs(Date.now() - (row?.s.getTime() ?? 0))).toBeLessThan(60_000);
  });

  it('2d: after a restart a summary-only lower score is stale when its clock is earlier, a downward correction when at/past the stored clock', async () => {
    const nd = pbpQ1(); // stored: inprogress Q1, 10-2 (home-away), clock 7:25
    const { gameId } = await seedGame(db, nd);
    const gen1 = await replayRun(db, gameId);
    await apply(deps, gameId, nd, observation(gen1, nd, T0));
    const before = await counts(db, gameId);
    expect(before).toMatchObject({ home: 10, away: 2, clock: '7:25' });
    const gen2 = await replayRun(db, gameId);
    const sum = summaryQ1();
    const summary = (score: { home: number; away: number }, clock: string | null) => ({
      ...sum,
      gameView: sum.gameView ? { ...sum.gameView, score, clock } : null,
    });
    const stale = summary({ home: 8, away: 2 }, '8:00');
    const r1 = await apply(deps, gameId, stale, observation(gen2, stale, later(60)));
    expect(r1).toMatchObject({ outcome: 'stale', reason: 'run_regresses_state' });
    expect(r1.outcome === 'stale' && r1.detail).toMatch(/^2d/);
    expect(await counts(db, gameId)).toMatchObject({
      home: 10,
      away: 2,
      clock: '7:25',
      watchRunId: String(gen1.watchId),
    });
    const correction = summary({ home: 8, away: 2 }, '7:10');
    const r2 = await apply(deps, gameId, correction, observation(gen2, correction, later(61)));
    expect(r2).toMatchObject({ outcome: 'applied', generationAdvanced: true, gameLevel: 'write' });
    expect(r2.outcome === 'applied' && r2.changes.map((c) => c.type)).toContain('status');
    expect(await counts(db, gameId)).toMatchObject({
      home: 8,
      away: 2,
      clock: '7:10',
      watchRunId: String(gen2.watchId),
    });
    expect(await staleReasons(db, gameId)).toEqual({ run_regresses_state: 1 });
  });

  it('2d: with no clock on either side the lower score is ambiguous_regression (no write, generation unchanged) until the same generation repeats it later', async () => {
    const nd0 = pbpQ1();
    const nd = { ...nd0, gameView: nd0.gameView ? { ...nd0.gameView, clock: null } : null };
    const { gameId } = await seedGame(db, nd);
    const gen1 = await replayRun(db, gameId);
    await apply(deps, gameId, nd, observation(gen1, nd, T0));
    expect((await counts(db, gameId)).clock).toBeNull();
    const gen2 = await replayRun(db, gameId);
    const sum = summaryQ1();
    const lower = {
      ...sum,
      gameView: sum.gameView ? { ...sum.gameView, score: { home: 8, away: 2 }, clock: null } : null,
    };
    const r1 = await apply(deps, gameId, lower, observation(gen2, lower, later(60)));
    expect(r1).toMatchObject({ outcome: 'stale', reason: 'ambiguous_regression' });
    expect(await counts(db, gameId)).toMatchObject({
      home: 10,
      away: 2,
      watchRunId: String(gen1.watchId),
    });
    const [g1] = await db<{ observedAt: Date }[]>`
      select observed_at as "observedAt" from public.games where id = ${gameId}`;
    expect(g1?.observedAt.toISOString()).toBe(T0.toISOString()); // no game-level write
    expect(await staleReasons(db, gameId)).toEqual({ ambiguous_regression: 1 });
    // a climbing replay would arrive with a different score; the same score later corroborates
    const r2 = await apply(deps, gameId, lower, observation(gen2, lower, later(90)));
    expect(r2).toMatchObject({ outcome: 'applied', generationAdvanced: true, gameLevel: 'write' });
    expect(await counts(db, gameId)).toMatchObject({
      home: 8,
      away: 2,
      watchRunId: String(gen2.watchId),
    });
    // the ambiguous row recorded the generation and the score it was waiting to corroborate
    const [row] = await db<{ observation: { watchId: number; score: { home: number } } }[]>`
      select observation from ingest.stale_observations where game_id = ${gameId} and reason = 'ambiguous_regression'`;
    expect(row?.observation).toMatchObject({ watchId: gen2.watchId, score: { home: 8, away: 2 } });
  });

  it('2d: a clockless restarted replay climbing through ambiguous scores never corroborates itself, even when a score repeats', async () => {
    const nd0 = pbpQ1();
    const nd = { ...nd0, gameView: nd0.gameView ? { ...nd0.gameView, clock: null } : null };
    const { gameId } = await seedGame(db, nd);
    const gen1 = await replayRun(db, gameId);
    await apply(deps, gameId, nd, observation(gen1, nd, T0));
    const gen2 = await replayRun(db, gameId);
    const sum = summaryQ1();
    const at = (score: { home: number; away: number }) => ({
      ...sum,
      gameView: sum.gameView ? { ...sum.gameView, score, clock: null } : null,
    });
    for (const [i, score] of [
      { home: 2, away: 0 },
      { home: 4, away: 0 },
      { home: 6, away: 2 },
      { home: 6, away: 2 }, // the repeat would corroborate if the climb before it were ignored
    ].entries()) {
      const d = at(score);
      expect(await apply(deps, gameId, d, observation(gen2, d, later(60 + i)))).toMatchObject({
        outcome: 'stale',
        reason: 'ambiguous_regression',
      });
    }
    expect(await staleReasons(db, gameId)).toEqual({ ambiguous_regression: 4 });
    expect(await counts(db, gameId)).toMatchObject({
      home: 10,
      away: 2,
      watchRunId: String(gen1.watchId),
    });
  });

  it('2d: an event-bearing batch after an ambiguous one advances the generation', async () => {
    const nd0 = pbpQ1();
    const nd = { ...nd0, gameView: nd0.gameView ? { ...nd0.gameView, clock: null } : null };
    const { gameId } = await seedGame(db, nd);
    const gen1 = await replayRun(db, gameId);
    await apply(deps, gameId, nd, observation(gen1, nd, T0));
    const gen2 = await replayRun(db, gameId);
    const sum = summaryQ1();
    const lower = {
      ...sum,
      gameView: sum.gameView ? { ...sum.gameView, score: { home: 8, away: 2 }, clock: null } : null,
    };
    expect(await apply(deps, gameId, lower, observation(gen2, lower, later(60)))).toMatchObject({
      outcome: 'stale',
      reason: 'ambiguous_regression',
    });
    // the restarted replay's full pbp catches up to the stored newest position: 2c passes, generation advances
    const r = await apply(deps, gameId, nd, observation(gen2, nd, later(61)));
    expect(r).toMatchObject({ outcome: 'applied', generationAdvanced: true });
    expect(r.outcome === 'applied' && r.changes).toEqual([]);
    expect((await counts(db, gameId)).watchRunId).toBe(String(gen2.watchId));
    // and from then on the summary's lower score is a same-generation correction
    const r2 = await apply(deps, gameId, lower, observation(gen2, lower, later(62)));
    expect(r2).toMatchObject({ outcome: 'applied', gameLevel: 'write' });
    expect((await counts(db, gameId)).home).toBe(8);
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

  /**
   * Status "flicker" within ONE generation (M3 corrective pass, external review; evidence M3
   * finding 3 notes the case "did not occur in these runs"). Sportradar caches the summary /
   * boxscore feed longer than pbp, so inside one watch a summary REQUESTED later (newer
   * `observedAt`) can carry OLDER game-level content: `halftime` / period 2 while the pbp
   * already showed period 3 in progress. Plan §4 rule 3 as written says game-level fields
   * follow the newest `observedAt`, and rule 2(b) (period behind stored) only gates a NEW
   * generation, so today this emits a durable `status` change back to halftime / period 2 and a
   * second one when the next pbp document restores period 3: two regressive seqs broadcast to
   * every client. Rule 3 "lagging view" (rev 4.6, ratified 2026-10-17): a view whose phase or
   * period is behind stored state, in a batch with no event newer than the stored newest, is
   * `superseded_observation` for game-level fields (detail `3-lagging-view`); events and stats
   * are still reconciled per entity.
   */
  it('same generation: a later summary carrying provider-cached older game-level content (halftime/P2 after pbp P3) is a lagging view: superseded, no status change', async () => {
    const nd = pbpQ1();
    const { gameId } = await seedGame(db, nd);
    const run = await replayRun(db, gameId);
    const p3 = {
      ...nd,
      gameView: nd.gameView
        ? {
            ...nd.gameView,
            status: 'inprogress' as const,
            period: { number: 3, type: 'quarter' as const, sequence: 3 },
            clock: '7:25',
            score: { home: 40, away: 38 },
          }
        : null,
    };
    const r1 = await apply(deps, gameId, p3, observation(run, p3, later(30)));
    expect(r1.outcome === 'applied' && r1.changes.some((c) => c.type === 'status')).toBe(true);
    const stored = await counts(db, gameId);
    const [g1] = await db<{ status: string; period: number | null }[]>`
      select status::text as status, current_period as period from public.games where id = ${gameId}`;
    expect(g1).toEqual({ status: 'inprogress', period: 3 });

    // Same generation, requested 30 s later, but the provider served a cached halftime summary.
    const sum = summaryQ1();
    const laggingSummary = {
      ...sum,
      gameView: sum.gameView
        ? {
            ...sum.gameView,
            status: 'halftime' as const,
            period: { number: 2, type: 'quarter' as const, sequence: 2 },
            clock: '0:00',
            score: { home: 40, away: 38 }, // same score: nothing in the batch is newer than stored
          }
        : null,
    };
    const r2 = await apply(
      deps,
      gameId,
      laggingSummary,
      observation(run, laggingSummary, later(60), { source: 'rest' }),
    );
    // Lagging view: superseded, logged once, no game_changes row of any kind, stored state intact.
    expect(r2.outcome === 'applied' && r2.gameLevel).toBe('superseded');
    expect(r2.outcome === 'applied' && r2.changes.filter((c) => c.type === 'status')).toEqual([]);
    expect(await staleReasons(db, gameId)).toEqual({ superseded_observation: 1 });
    const [stale] = await db<{ detail: string }[]>`
      select observation->>'detail' as detail from ingest.stale_observations where game_id = ${gameId}`;
    expect(stale?.detail ?? '').toContain('3-lagging-view');
    const [g2] = await db<{ status: string; period: number | null; seq: number | null }[]>`
      select status::text as status, current_period as period, current_period_sequence as seq from public.games where id = ${gameId}`;
    expect(g2).toEqual({ status: 'inprogress', period: 3, seq: 3 });
    const mid = await counts(db, gameId);
    // Its team and player stats were still reconciled per entity (the only changes it produced).
    expect(mid.changes - stored.changes).toBe(r2.outcome === 'applied' ? r2.changes.length : -1);
    expect(
      r2.outcome === 'applied' &&
        r2.changes.every((c) => c.type === 'stats_team' || c.type === 'stats_player'),
    ).toBe(true);

    // The next pbp (period 3 again) then has nothing to restore: no flip-back change either.
    const r3 = await apply(deps, gameId, p3, observation(run, p3, later(90)));
    expect(r3.outcome === 'applied' && r3.changes.filter((c) => c.type === 'status')).toEqual([]);
    const [statusChanges] = await db<{ n: number }[]>`
      select count(*)::int as n from public.game_changes where game_id = ${gameId} and change_type = 'status' and seq > ${stored.lastSeq}`;
    expect(statusChanges?.n).toBe(0);
  });

  /**
   * Second live run (2026-10-21, WNBA Finals G3): the pbp at 02:33:20Z reported `closed`
   * (seq 1942); the closing boxscore requested 4 s later was provider-cached and still said
   * `complete`, and rule 3 followed its newer `observedAt`: seq 1943 moved the game from
   * closed back to complete and the stored game was left `complete`. Rev 4.9: inside the post
   * phase `complete` is less final than `closed`, so the view is lagging (3-lagging-view).
   */
  it('same generation: a closing boxscore still carrying complete after the pbp reported closed is a lagging view: no status change, game stays closed', async () => {
    const nd = pbpQ1();
    const { gameId } = await seedGame(db, nd);
    const run = await replayRun(db, gameId);
    const final = (status: 'complete' | 'closed') => ({
      status,
      period: { number: 4, type: 'quarter' as const, sequence: 4 },
      clock: '0:00',
      score: { home: 97, away: 71 },
    });
    const closedPbp = {
      ...nd,
      gameView: nd.gameView ? { ...nd.gameView, ...final('closed') } : null,
    };
    const r1 = await apply(deps, gameId, closedPbp, observation(run, closedPbp, later(30)));
    expect(r1.outcome === 'applied' && r1.changes.some((c) => c.type === 'status')).toBe(true);
    const stored = await counts(db, gameId);

    const sum = summaryQ1();
    const cachedBox = {
      ...sum,
      gameView: sum.gameView ? { ...sum.gameView, ...final('complete') } : null,
    };
    const r2 = await apply(
      deps,
      gameId,
      cachedBox,
      observation(run, cachedBox, later(34), { source: 'rest' }),
    );
    expect(r2.outcome === 'applied' && r2.gameLevel).toBe('superseded');
    expect(r2.outcome === 'applied' && r2.changes.filter((c) => c.type === 'status')).toEqual([]);
    const [stale] = await db<{ detail: string }[]>`
      select observation->>'detail' as detail from ingest.stale_observations where game_id = ${gameId}`;
    expect(stale?.detail ?? '').toContain('status complete < stored closed (finality)');
    const [g] = await db<{ status: string }[]>`
      select status::text as status from public.games where id = ${gameId}`;
    expect(g?.status).toBe('closed');
    // Its stats were still reconciled per entity (the only changes it produced).
    expect(r2.outcome === 'applied' && r2.changes.length).toBeGreaterThan(0);
    const after = await counts(db, gameId);
    expect(after.changes - stored.changes).toBe(r2.outcome === 'applied' ? r2.changes.length : -1);
    expect(
      r2.outcome === 'applied' &&
        r2.changes.every((c) => c.type === 'stats_team' || c.type === 'stats_player'),
    ).toBe(true);
  });

  it('same generation: the same lagging summary carrying an event newer than the stored newest is a correction: game-level write', async () => {
    const nd = pbpQ1();
    const { gameId } = await seedGame(db, nd);
    const run = await replayRun(db, gameId);
    const p3 = {
      ...nd,
      gameView: nd.gameView
        ? {
            ...nd.gameView,
            status: 'inprogress' as const,
            period: { number: 3, type: 'quarter' as const, sequence: 3 },
            score: { home: 40, away: 38 },
          }
        : null,
    };
    await apply(deps, gameId, p3, observation(run, p3, later(30)));
    const last = nd.batch.events.at(-1);
    if (!last) throw new Error('fixture has no events');
    const maxSeq = Math.max(...nd.batch.events.map((e) => e.providerSequence ?? 0));
    const maxNum = Math.max(...nd.batch.events.map((e) => e.providerNumber ?? 0));
    const newer = {
      ...last,
      providerEventId: `newer-evidence-${gameId}`,
      providerSequence: maxSeq + 1,
      providerNumber: maxNum + 1,
    };
    const sum = summaryQ1();
    const withEvidence = {
      ...sum,
      batch: { ...sum.batch, events: [newer] },
      gameView: sum.gameView
        ? {
            ...sum.gameView,
            status: 'halftime' as const,
            period: { number: 2, type: 'quarter' as const, sequence: 2 },
            score: { home: 40, away: 38 },
          }
        : null,
    };
    const r = await apply(
      deps,
      gameId,
      withEvidence,
      observation(run, withEvidence, later(60), { source: 'rest', isComplete: false }),
    );
    expect(r.outcome === 'applied' && r.gameLevel).toBe('write');
    const types = r.outcome === 'applied' ? r.changes.map((c) => c.type) : [];
    expect(types).toContain('event_insert');
    expect(types).toContain('status'); // the rule fires only on lagging views
    expect(await staleReasons(db, gameId)).toEqual({});
  });
});
