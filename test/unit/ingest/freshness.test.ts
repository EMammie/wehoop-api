import { describe, expect, it } from 'vitest';
import { diffEvents } from '../../../src/ingest/diff.js';
import {
  type BatchInput,
  comparePositions,
  decideBatch,
  decideEvent,
  type EventPosition,
  newestPosition,
  phaseOf,
  type StoredEventForFreshness,
  type StoredGameForFreshness,
} from '../../../src/ingest/freshness.js';
import type { GameView, NormalizedEvent } from '../../../src/ingest/types.js';
import { contentHash } from '../../../src/model/content-hash.js';
import type { LiveEvent } from '../../../src/model/live-event.js';

/* ---------- helpers ---------- */

const t = (s: string) => new Date(s);
const pos = (periodSequence: number, providerSequence: number): EventPosition => ({
  periodSequence,
  providerSequence,
  providerNumber: null,
  wallClock: null,
});
const storedEv = (
  id: string,
  periodSequence: number,
  providerSequence: number,
  deleted = false,
): StoredEventForFreshness => ({
  providerEventId: id,
  deleted,
  ...pos(periodSequence, providerSequence),
});
const view = (over: Partial<GameView> = {}): GameView => ({
  status: 'inprogress',
  score: { home: 10, away: 8 },
  period: { number: 1, type: 'quarter', sequence: 1 },
  clock: '5:00',
  clockDecimal: '5:00',
  clockRunning: null,
  clockExtra: null,
  periods: [],
  providerUpdatedAt: null,
  scheduledAt: null,
  coverage: 'full',
  venue: null,
  broadcasts: null,
  ...over,
});
const stored = (over: Partial<StoredGameForFreshness> = {}): StoredGameForFreshness => ({
  watchRunId: 10,
  lastSeq: 50,
  status: 'inprogress',
  currentPeriodSequence: 1,
  observedAt: t('2026-06-30T23:20:00Z'),
  ...over,
});
const batch = (over: Partial<BatchInput> = {}): BatchInput => ({
  watchId: 10,
  observedAt: t('2026-06-30T23:20:10Z'),
  isComplete: true,
  gameView: view(),
  eventPositions: [pos(1, 100), pos(1, 200)],
  deletedEventIds: [],
  ...over,
});
const liveEvents: StoredEventForFreshness[] = [storedEv('e1', 1, 100), storedEv('e2', 1, 200)];

function nev(
  id: string,
  over: Partial<NormalizedEvent> & { body?: Partial<LiveEvent> } = {},
): NormalizedEvent {
  const body: LiveEvent = {
    type: 'other',
    providerEventType: 'stoppage',
    period: { number: 1, type: 'quarter', sequence: 1 },
    clock: '5:00',
    wallClock: null,
    score: { home: 0, away: 0 },
    ...(over.body as object),
  } as LiveEvent;
  return {
    providerEventId: id,
    providerNumber: null,
    providerSequence: null,
    providerUpdatedAt: null,
    wallClock: null,
    periodSequence: 1,
    periodNumber: 1,
    periodType: 'quarter',
    clock: '5:00',
    clockDecimal: null,
    providerEventType: 'stoppage',
    teamProviderId: null,
    playerProviderId: null,
    homePoints: null,
    awayPoints: null,
    raw: {},
    ...over,
    body,
  };
}
const hashOf = (ev: NormalizedEvent) => contentHash(ev.body);

/* ---------- §4 acceptance cases, one test each, in plan order ---------- */

describe('freshness §4 acceptance cases', () => {
  it('case 1: halftime -> period 3 inprogress accepted', () => {
    const s = stored({ status: 'halftime', currentPeriodSequence: 2 });
    const q3 = view({ status: 'inprogress', period: { number: 3, type: 'quarter', sequence: 3 } });
    const same = decideBatch(s, batch({ gameView: q3, eventPositions: [pos(3, 300)] }), liveEvents);
    expect(same).toMatchObject({ kind: 'accept', generation: 'same', gameLevel: 'write' });
    const restarted = decideBatch(
      s,
      batch({ watchId: 11, gameView: q3, eventPositions: [pos(3, 300)] }),
      liveEvents,
    );
    expect(restarted).toMatchObject({
      kind: 'accept',
      generation: 'new',
      advanceWatchRunId: true,
      gameLevel: 'write',
    });
  });

  it('case 2: clock correction 5:00 -> 5:30 inside one period accepted and observed', () => {
    const d = decideBatch(stored(), batch({ gameView: view({ clock: '5:30' }) }), liveEvents);
    expect(d).toMatchObject({ kind: 'accept', gameLevel: 'write' });
    // and in a new generation, same period: the clock going up is never a regression signal
    const d2 = decideBatch(
      stored(),
      batch({ watchId: 11, gameView: view({ clock: '5:30' }) }),
      liveEvents,
    );
    expect(d2).toMatchObject({ kind: 'accept', generation: 'new', gameLevel: 'write' });
  });

  it('case 3: explicit deletion lowering the event count accepted as exactly one event_delete', () => {
    const storedMap = new Map([
      ['e1', { contentHash: 'h1', providerUpdatedAt: null, deleted: false }],
      ['e2', { contentHash: 'h2', providerUpdatedAt: null, deleted: false }],
    ]);
    const d = decideBatch(
      stored(),
      batch({ eventPositions: [pos(1, 100)], deletedEventIds: ['e2'] }),
      liveEvents,
    );
    expect(d.kind).toBe('accept');
    const diff = diffEvents(storedMap, [nev('e1', { providerSequence: 100 })], ['e2']);
    expect(diff.changes.filter((c) => c.type === 'event_delete')).toEqual([
      { type: 'event_delete', providerEventId: 'e2', body: { providerEventId: 'e2' } },
    ]);
    expect(diff.counts.deleted).toBe(1);
    // applying the marker again deletes nothing more
    const again = diffEvents(
      new Map([
        ...storedMap,
        ['e2', { contentHash: 'h2', providerUpdatedAt: null, deleted: true }],
      ]),
      [],
      ['e2'],
    );
    expect(again.changes).toEqual([]);
  });

  it('case 4: absence of events without a marker never deletes', () => {
    const storedMap = new Map([
      ['e1', { contentHash: 'h1', providerUpdatedAt: null, deleted: false }],
      ['e2', { contentHash: 'h2', providerUpdatedAt: null, deleted: false }],
    ]);
    const e1 = nev('e1');
    storedMap.set('e1', { contentHash: hashOf(e1), providerUpdatedAt: null, deleted: false });
    const diff = diffEvents(storedMap, [e1], []);
    expect(diff.changes).toEqual([]);
    expect(diff.deletions).toEqual([]);
    expect(decideEvent(storedMap.get('e2'), null, false)).toBe('unchanged');
  });

  it('case 5: delayed REST (observedAt earlier than the stored push observation) -> superseded_observation, no game-level write; events still reconciled per entity', () => {
    const s = stored({ observedAt: t('2026-06-30T23:20:30Z') }); // push observed later than this REST request started
    const d = decideBatch(s, batch({ observedAt: t('2026-06-30T23:20:10Z') }), liveEvents);
    expect(d).toMatchObject({
      kind: 'accept',
      generation: 'same',
      gameLevel: 'superseded',
      advanceWatchRunId: false,
    });
    // the REST document's newer revision of an event is honoured by `updated`
    expect(
      decideEvent(
        { contentHash: 'old', providerUpdatedAt: '2026-06-30T23:19:00+00:00', deleted: false },
        { contentHash: 'new', providerUpdatedAt: '2026-06-30T23:19:30+00:00' },
        false,
      ),
    ).toBe('update');
    // and its older revision is ignored (counted, not stale)
    expect(
      decideEvent(
        { contentHash: 'new', providerUpdatedAt: '2026-06-30T23:19:30+00:00', deleted: false },
        { contentHash: 'old', providerUpdatedAt: '2026-06-30T23:19:00+00:00' },
        false,
      ),
    ).toBe('ignore_older');
  });

  it('case 6: replay restart from 0-0 as a new generation -> run_regresses_state', () => {
    // first document of the restarted replay: status created, no events (2a)
    const d = decideBatch(
      stored(),
      batch({
        watchId: 11,
        gameView: view({ status: 'created', score: { home: 0, away: 0 }, period: null }),
        eventPositions: [],
      }),
      liveEvents,
    );
    expect(d).toMatchObject({ kind: 'stale', reason: 'run_regresses_state' });
    // later in the restarted replay, same phase and period but events behind the stored newest (2c)
    const d2 = decideBatch(
      stored(),
      batch({ watchId: 11, eventPositions: [pos(1, 100), pos(1, 150)] }),
      liveEvents,
    );
    expect(d2).toMatchObject({ kind: 'stale', reason: 'run_regresses_state' });
    expect((d2 as { detail: string }).detail).toMatch(/2c/);
  });

  it('case 7: in-flight batch from an older generation -> older_run', () => {
    const d = decideBatch(stored({ watchRunId: 12 }), batch({ watchId: 11 }), liveEvents);
    expect(d).toMatchObject({ kind: 'stale', reason: 'older_run' });
    // even when it is complete, at the head, and newer by observedAt: generation wins
    const d2 = decideBatch(
      stored({ watchRunId: 12 }),
      batch({ watchId: 11, eventPositions: [pos(1, 999)], observedAt: t('2026-06-30T23:59:00Z') }),
      liveEvents,
    );
    expect(d2).toMatchObject({ kind: 'stale', reason: 'older_run' });
  });

  it('case 8: worker restart mid-game as a new generation -> accepted', () => {
    const d = decideBatch(
      stored(),
      batch({ watchId: 11, eventPositions: [pos(1, 100), pos(1, 200), pos(1, 250)] }),
      liveEvents,
    );
    expect(d).toMatchObject({
      kind: 'accept',
      generation: 'new',
      advanceWatchRunId: true,
      gameLevel: 'write',
    });
    // at exactly the stored newest position is also fine (restart with nothing new yet)
    const d2 = decideBatch(stored(), batch({ watchId: 11 }), liveEvents);
    expect(d2).toMatchObject({ kind: 'accept', generation: 'new', advanceWatchRunId: true });
  });

  it('case 9: a push sub-run and a backfill sub-run of the same generation interleave without either being marked stale', () => {
    const root = 10;
    const push = batch({
      watchId: root,
      isComplete: false,
      gameView: null,
      eventPositions: [pos(1, 210)],
    });
    const backfill = batch({
      watchId: root,
      isComplete: true,
      eventPositions: [pos(1, 100), pos(1, 200)],
      observedAt: t('2026-06-30T23:20:05Z'),
    });
    const d1 = decideBatch(stored(), push, liveEvents);
    const d2 = decideBatch(stored(), backfill, [...liveEvents, storedEv('e3', 1, 210)]);
    expect(d1).toMatchObject({
      kind: 'accept',
      generation: 'same',
      gameLevel: 'none',
      advanceWatchRunId: false,
    });
    expect(d2).toMatchObject({ kind: 'accept', generation: 'same', advanceWatchRunId: false });
    // the backfill trails the push by one event: within a generation that is not staleness
  });

  it('case 10: a generation-less schedule poll during a live game never advances watch_run_id and never overwrites a newer clock', () => {
    const d = decideBatch(
      stored(),
      batch({
        watchId: null,
        isComplete: false,
        eventPositions: [],
        gameView: view({ clock: '9:59' }),
        observedAt: t('2026-06-30T23:30:00Z'),
      }),
      liveEvents,
    );
    expect(d).toMatchObject({
      kind: 'accept',
      generation: 'none',
      advanceWatchRunId: false,
      gameLevel: 'superseded',
      restrictedGameLevel: true,
    });
  });

  it('case 11: a complete document missing one old event (not the newest) is not stale', () => {
    const d = decideBatch(
      stored(),
      batch({ watchId: 11, eventPositions: [pos(1, 200)] }),
      liveEvents,
    );
    expect(d).toMatchObject({ kind: 'accept', generation: 'new' });
    // and within the generation the missing old event is simply not touched
    const storedMap = new Map([
      ['e1', { contentHash: 'h1', providerUpdatedAt: null, deleted: false }],
      ['e2', { contentHash: 'h2', providerUpdatedAt: null, deleted: false }],
    ]);
    const e2 = nev('e2', { providerSequence: 200 });
    storedMap.set('e2', { contentHash: hashOf(e2), providerUpdatedAt: null, deleted: false });
    expect(diffEvents(storedMap, [e2], []).changes).toEqual([]);
  });

  it('case 12: a generation-less poll with a lagging score during a live game writes nothing game-level and logs superseded_observation', () => {
    const d = decideBatch(
      stored(),
      batch({
        watchId: null,
        isComplete: false,
        eventPositions: [],
        gameView: view({ score: { home: 2, away: 0 } }),
        observedAt: t('2026-06-30T23:30:00Z'),
      }),
      liveEvents,
    );
    expect(d).toMatchObject({ kind: 'accept', gameLevel: 'superseded', advanceWatchRunId: false });
    // before tip-off the same poll may fix the status (scheduled -> postponed) but still never score/period/clock
    const pre = decideBatch(
      stored({
        status: 'scheduled',
        lastSeq: 0,
        watchRunId: null,
        currentPeriodSequence: null,
        observedAt: null,
      }),
      batch({
        watchId: null,
        isComplete: false,
        eventPositions: [],
        gameView: view({ status: 'postponed' }),
      }),
      [],
    );
    expect(pre).toMatchObject({
      kind: 'accept',
      gameLevel: 'write',
      restrictedGameLevel: true,
      advanceWatchRunId: false,
    });
  });

  it("case 13: a new generation's first document that explicitly deletes the stored newest event is accepted and yields one event_delete", () => {
    const d = decideBatch(
      stored(),
      batch({ watchId: 11, eventPositions: [pos(1, 100)], deletedEventIds: ['e2'] }),
      liveEvents,
    );
    expect(d).toMatchObject({ kind: 'accept', generation: 'new', advanceWatchRunId: true });
    const storedMap = new Map([
      ['e1', { contentHash: 'h1', providerUpdatedAt: null, deleted: false }],
      ['e2', { contentHash: 'h2', providerUpdatedAt: null, deleted: false }],
    ]);
    const e1 = nev('e1', { providerSequence: 100 });
    storedMap.set('e1', { contentHash: hashOf(e1), providerUpdatedAt: null, deleted: false });
    const diff = diffEvents(storedMap, [e1], ['e2']);
    expect(diff.changes).toEqual([
      { type: 'event_delete', providerEventId: 'e2', body: { providerEventId: 'e2' } },
    ]);
    // without the marker the same document is a regression (2c) for a new generation
    expect(
      decideBatch(stored(), batch({ watchId: 11, eventPositions: [pos(1, 100)] }), liveEvents),
    ).toMatchObject({ kind: 'stale' });
  });
});

/* ---------- supporting rules ---------- */

describe('freshness rules: details', () => {
  it('phase ordering and post -> pre only when nothing live was recorded', () => {
    expect(phaseOf('created')).toBe('pre');
    expect(phaseOf('halftime')).toBe('live');
    expect(phaseOf('postponed')).toBe('post');
    const rescheduled = decideBatch(
      stored({ status: 'postponed', lastSeq: 0, currentPeriodSequence: null }),
      batch({
        watchId: 11,
        gameView: view({ status: 'scheduled', period: null }),
        eventPositions: [],
      }),
      [],
    );
    expect(rescheduled.kind).toBe('accept');
    const notAllowed = decideBatch(
      stored({ status: 'closed' }),
      batch({ watchId: 11, gameView: view({ status: 'scheduled' }) }),
      liveEvents,
    );
    expect(notAllowed).toMatchObject({ kind: 'stale', reason: 'run_regresses_state' });
  });

  it('2b: same phase, earlier game-level period is a regression; an earlier individual event is not', () => {
    const s = stored({ currentPeriodSequence: 3 });
    const q2view = view({ period: { number: 2, type: 'quarter', sequence: 2 } });
    expect(
      decideBatch(
        s,
        batch({ watchId: 11, gameView: q2view, eventPositions: [pos(3, 999)] }),
        liveEvents,
      ),
    ).toMatchObject({ kind: 'stale' });
    const q3view = view({ period: { number: 3, type: 'quarter', sequence: 3 } });
    expect(
      decideBatch(
        s,
        batch({ watchId: 11, gameView: q3view, eventPositions: [pos(1, 5), pos(3, 999)] }),
        liveEvents,
      ),
    ).toMatchObject({ kind: 'accept' });
  });

  it('2c: a complete document whose events carry no position fields is not gated; an empty one against stored live events is', () => {
    const noPos: EventPosition = {
      periodSequence: null,
      providerSequence: null,
      providerNumber: null,
      wallClock: null,
    };
    expect(
      decideBatch(stored(), batch({ watchId: 11, eventPositions: [noPos, noPos] }), liveEvents),
    ).toMatchObject({ kind: 'accept' });
    expect(
      decideBatch(stored(), batch({ watchId: 11, eventPositions: [] }), liveEvents),
    ).toMatchObject({ kind: 'stale' });
    // stored events that were deleted do not count as the stored newest
    expect(
      decideBatch(stored(), batch({ watchId: 11, eventPositions: [pos(1, 100)] }), [
        storedEv('e1', 1, 100),
        storedEv('e2', 1, 200, true),
      ]),
    ).toMatchObject({ kind: 'accept' });
  });

  it('first ever write (watch_run_id null, last_seq 0) is accepted without the gate; durable state from an unknown generation is gated', () => {
    const fresh = stored({
      watchRunId: null,
      lastSeq: 0,
      status: 'scheduled',
      currentPeriodSequence: null,
      observedAt: null,
    });
    expect(
      decideBatch(fresh, batch({ gameView: view({ status: 'created' }), eventPositions: [] }), []),
    ).toMatchObject({ kind: 'accept', generation: 'new', advanceWatchRunId: true });
    const unknownGen = stored({ watchRunId: null, lastSeq: 5 });
    expect(
      decideBatch(
        unknownGen,
        batch({ gameView: view({ status: 'created' }), eventPositions: [] }),
        liveEvents,
      ),
    ).toMatchObject({ kind: 'stale', reason: 'run_regresses_state' });
  });

  it('positions: (period_sequence, provider_sequence), nulls broken by provider_number then wall_clock', () => {
    expect(comparePositions(pos(1, 5), pos(2, 1))).toBeLessThan(0);
    expect(comparePositions(pos(2, 1), pos(1, 5))).toBeGreaterThan(0);
    expect(comparePositions(pos(1, 5), pos(1, 5))).toBe(0);
    const byNumber = (n: number): EventPosition => ({
      periodSequence: 1,
      providerSequence: null,
      providerNumber: n,
      wallClock: null,
    });
    expect(comparePositions(byNumber(3), byNumber(4))).toBeLessThan(0);
    const byWall = (w: string): EventPosition => ({
      periodSequence: null,
      providerSequence: null,
      providerNumber: null,
      wallClock: w,
    });
    expect(
      comparePositions(byWall('2026-06-30T23:00:00Z'), byWall('2026-06-30T23:00:01Z')),
    ).toBeLessThan(0);
    expect(newestPosition([pos(1, 1), pos(1, 9), pos(1, 3)])).toEqual(pos(1, 9));
    expect(newestPosition([])).toBeNull();
  });

  it('decideEvent: revision then hash; deletion only by marker; reinstate only by a newer revision', () => {
    const s = { contentHash: 'h', providerUpdatedAt: '2026-06-30T23:00:00+00:00', deleted: false };
    expect(decideEvent(undefined, { contentHash: 'h', providerUpdatedAt: null }, false)).toBe(
      'insert',
    );
    expect(
      decideEvent(s, { contentHash: 'h', providerUpdatedAt: '2026-06-30T23:00:00+00:00' }, false),
    ).toBe('unchanged');
    expect(
      decideEvent(s, { contentHash: 'x', providerUpdatedAt: '2026-06-30T23:00:00+00:00' }, false),
    ).toBe('update'); // equal updated, body differs: correction
    expect(decideEvent(s, { contentHash: 'x', providerUpdatedAt: null }, false)).toBe('update'); // missing updated: hash decides
    expect(
      decideEvent(s, { contentHash: 'x', providerUpdatedAt: '2026-06-30T22:59:00+00:00' }, false),
    ).toBe('ignore_older');
    expect(
      decideEvent(s, { contentHash: 'h', providerUpdatedAt: '2026-06-30T23:01:00+00:00' }, false),
    ).toBe('unchanged'); // newer but identical
    expect(decideEvent(s, null, true)).toBe('delete');
    expect(decideEvent(undefined, null, true)).toBe('ignore_missing');
    const del = { ...s, deleted: true };
    expect(decideEvent(del, null, true)).toBe('unchanged');
    expect(
      decideEvent(del, { contentHash: 'h', providerUpdatedAt: '2026-06-30T23:00:00+00:00' }, false),
    ).toBe('unchanged');
    expect(
      decideEvent(del, { contentHash: 'h', providerUpdatedAt: '2026-06-30T23:05:00+00:00' }, false),
    ).toBe('reinstate');
  });

  it('diffEvents: the same batch twice is empty; last duplicate in a batch wins; a marker overrides a body in the same batch', () => {
    const a = nev('a', { providerUpdatedAt: '2026-06-30T23:00:00+00:00' });
    const first = diffEvents(new Map(), [a, a], []);
    expect(first.changes.map((c) => c.type)).toEqual(['event_insert']);
    const storedMap = new Map(
      first.writes.map((w) => [
        w.event.providerEventId,
        { contentHash: w.hash, providerUpdatedAt: w.event.providerUpdatedAt, deleted: false },
      ]),
    );
    expect(diffEvents(storedMap, [a], []).changes).toEqual([]);
    const withMarker = diffEvents(storedMap, [a], ['a']);
    expect(withMarker.changes.map((c) => c.type)).toEqual(['event_delete']);
  });
});
