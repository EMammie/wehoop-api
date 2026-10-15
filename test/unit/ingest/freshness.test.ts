import { describe, expect, it } from 'vitest';
import { diffEvents } from '../../../src/ingest/diff.js';
import {
  type BatchInput,
  comparePositions,
  decideBatch,
  decideEvent,
  decideStats,
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
  unknownStatus: null,
  score: { home: 10, away: 8 },
  period: { number: 1, type: 'quarter', sequence: 1 },
  clock: '5:00',
  clockDecimal: '5:00',
  clockRunning: null,
  clockExtra: null,
  elamTargetScore: null,
  periods: [],
  providerUpdatedAt: null,
  scheduledAt: null,
  coverage: 'full',
  venue: null,
  broadcasts: null,
  title: null,
  season: null,
  ...over,
});
const stored = (over: Partial<StoredGameForFreshness> = {}): StoredGameForFreshness => ({
  watchRunId: 10,
  lastSeq: 50,
  status: 'inprogress',
  currentPeriodSequence: 1,
  observedAt: t('2026-06-30T23:20:00Z'),
  score: { home: 10, away: 8 },
  clock: '5:00',
  lastAmbiguous: null,
  ...over,
});
/** eventCount / deletionCount default to the lengths of eventPositions / deletedEvents. */
const batch = (over: Partial<BatchInput> = {}): BatchInput => {
  const eventPositions = over.eventPositions ?? [pos(1, 100), pos(1, 200)];
  const deletedEvents = over.deletedEvents ?? [];
  return {
    watchId: 10,
    observedAt: t('2026-06-30T23:20:10Z'),
    isComplete: true,
    gameView: view(),
    eventPositions,
    deletedEvents,
    eventCount: eventPositions.length,
    deletionCount: deletedEvents.length,
    ...over,
  };
};
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
      [
        'e1',
        { contentHash: 'h1', providerUpdatedAt: null, deleted: false, deletedRevisionAt: null },
      ],
      [
        'e2',
        { contentHash: 'h2', providerUpdatedAt: null, deleted: false, deletedRevisionAt: null },
      ],
    ]);
    const d = decideBatch(
      stored(),
      batch({
        eventPositions: [pos(1, 100)],
        deletedEvents: [{ providerEventId: 'e2', updatedAt: null }],
      }),
      liveEvents,
    );
    expect(d.kind).toBe('accept');
    const diff = diffEvents(
      storedMap,
      [nev('e1', { providerSequence: 100 })],
      [{ providerEventId: 'e2', updatedAt: null }],
    );
    expect(diff.changes.filter((c) => c.type === 'event_delete')).toEqual([
      { type: 'event_delete', providerEventId: 'e2', body: { providerEventId: 'e2' } },
    ]);
    expect(diff.counts.deleted).toBe(1);
    // applying the marker again deletes nothing more
    const again = diffEvents(
      new Map([
        ...storedMap,
        [
          'e2',
          { contentHash: 'h2', providerUpdatedAt: null, deleted: true, deletedRevisionAt: null },
        ],
      ]),
      [],
      [{ providerEventId: 'e2', updatedAt: null }],
    );
    expect(again.changes).toEqual([]);
  });

  it('case 4: absence of events without a marker never deletes', () => {
    const storedMap = new Map([
      [
        'e1',
        { contentHash: 'h1', providerUpdatedAt: null, deleted: false, deletedRevisionAt: null },
      ],
      [
        'e2',
        { contentHash: 'h2', providerUpdatedAt: null, deleted: false, deletedRevisionAt: null },
      ],
    ]);
    const e1 = nev('e1');
    storedMap.set('e1', {
      contentHash: hashOf(e1),
      providerUpdatedAt: null,
      deleted: false,
      deletedRevisionAt: null,
    });
    const diff = diffEvents(storedMap, [e1], []);
    expect(diff.changes).toEqual([]);
    expect(diff.deletions).toEqual([]);
    expect(decideEvent(storedMap.get('e2'), null, null)).toBe('unchanged');
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
        {
          contentHash: 'old',
          providerUpdatedAt: '2026-06-30T23:19:00+00:00',
          deleted: false,
          deletedRevisionAt: null,
        },
        { contentHash: 'new', providerUpdatedAt: '2026-06-30T23:19:30+00:00' },
        null,
      ),
    ).toBe('update');
    // and its older revision is ignored (counted, not stale)
    expect(
      decideEvent(
        {
          contentHash: 'new',
          providerUpdatedAt: '2026-06-30T23:19:30+00:00',
          deleted: false,
          deletedRevisionAt: null,
        },
        { contentHash: 'old', providerUpdatedAt: '2026-06-30T23:19:00+00:00' },
        null,
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
      [
        'e1',
        { contentHash: 'h1', providerUpdatedAt: null, deleted: false, deletedRevisionAt: null },
      ],
      [
        'e2',
        { contentHash: 'h2', providerUpdatedAt: null, deleted: false, deletedRevisionAt: null },
      ],
    ]);
    const e2 = nev('e2', { providerSequence: 200 });
    storedMap.set('e2', {
      contentHash: hashOf(e2),
      providerUpdatedAt: null,
      deleted: false,
      deletedRevisionAt: null,
    });
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
      batch({
        watchId: 11,
        eventPositions: [pos(1, 100)],
        deletedEvents: [{ providerEventId: 'e2', updatedAt: null }],
      }),
      liveEvents,
    );
    expect(d).toMatchObject({ kind: 'accept', generation: 'new', advanceWatchRunId: true });
    const storedMap = new Map([
      [
        'e1',
        { contentHash: 'h1', providerUpdatedAt: null, deleted: false, deletedRevisionAt: null },
      ],
      [
        'e2',
        { contentHash: 'h2', providerUpdatedAt: null, deleted: false, deletedRevisionAt: null },
      ],
    ]);
    const e1 = nev('e1', { providerSequence: 100 });
    storedMap.set('e1', {
      contentHash: hashOf(e1),
      providerUpdatedAt: null,
      deleted: false,
      deletedRevisionAt: null,
    });
    const diff = diffEvents(storedMap, [e1], [{ providerEventId: 'e2', updatedAt: null }]);
    expect(diff.changes).toEqual([
      { type: 'event_delete', providerEventId: 'e2', body: { providerEventId: 'e2' } },
    ]);
    // without the marker the same document is a regression (2c) for a new generation
    expect(
      decideBatch(stored(), batch({ watchId: 11, eventPositions: [pos(1, 100)] }), liveEvents),
    ).toMatchObject({ kind: 'stale' });
  });
});

describe('freshness §4 acceptance cases (rev 4.3)', () => {
  // Rule 2d setup: stored 10-8 at 5:00 in Q1 by generation 10; generation 11 sends summary-only documents.
  const summaryOnly = (over: Partial<GameView>) =>
    batch({
      watchId: 11,
      isComplete: false,
      eventPositions: [],
      gameView: view({ score: { home: 8, away: 8 }, ...over }),
    });

  it("2d: a new generation's summary-only document inside the stored period with a lower score and more time on the clock -> run_regresses_state", () => {
    const d = decideBatch(stored(), summaryOnly({ clock: '7:00' }), liveEvents);
    expect(d).toMatchObject({ kind: 'stale', reason: 'run_regresses_state' });
    expect((d as { detail: string }).detail).toMatch(/^2d/);
    // the same document inside the SAME generation is never gated: a correction is a correction
    expect(
      decideBatch(stored(), { ...summaryOnly({ clock: '7:00' }), watchId: 10 }, liveEvents),
    ).toMatchObject({ kind: 'accept', generation: 'same' });
    // and a lower score in a later period is not 2d's business (2b and the period decide)
    expect(
      decideBatch(
        stored(),
        summaryOnly({ clock: '9:00', period: { number: 2, type: 'quarter', sequence: 2 } }),
        liveEvents,
      ),
    ).toMatchObject({ kind: 'accept' });
  });

  it('2d: the same with the clock at or past the stored clock -> accepted and written as a downward correction after a restart', () => {
    for (const clock of ['5:00', '4:59', '0:00.3']) {
      expect(decideBatch(stored(), summaryOnly({ clock }), liveEvents)).toMatchObject({
        kind: 'accept',
        generation: 'new',
        advanceWatchRunId: true,
        gameLevel: 'write',
      });
    }
  });

  it('2d: the same with no clock on either side -> ambiguous_regression, nothing written, watch_run_id unchanged', () => {
    const noClock = decideBatch(stored({ clock: null }), summaryOnly({ clock: null }), liveEvents);
    expect(noClock).toMatchObject({ kind: 'stale', reason: 'ambiguous_regression' });
    // one side unknown is enough to be ambiguous
    expect(decideBatch(stored(), summaryOnly({ clock: null }), liveEvents)).toMatchObject({
      kind: 'stale',
      reason: 'ambiguous_regression',
    });
    expect(
      decideBatch(stored({ clock: null }), summaryOnly({ clock: '7:00' }), liveEvents),
    ).toMatchObject({ kind: 'stale', reason: 'ambiguous_regression' });
    // a score at or above the stored one is not ambiguous
    expect(
      decideBatch(
        stored({ clock: null }),
        summaryOnly({ clock: null, score: { home: 10, away: 8 } }),
        liveEvents,
      ),
    ).toMatchObject({ kind: 'accept', generation: 'new' });
  });

  it('2d: a repeated ambiguous observation with the same score and a later observedAt -> accepted (corroborated)', () => {
    const first = summaryOnly({ clock: null });
    const la = {
      watchId: 11,
      score: { home: 8, away: 8 },
      observedAt: first.observedAt,
      otherScoresSeen: false,
    };
    const again = decideBatch(
      stored({ clock: null, lastAmbiguous: la }),
      { ...first, observedAt: new Date(first.observedAt.getTime() + 30_000) },
      liveEvents,
    );
    expect(again).toMatchObject({ kind: 'accept', generation: 'new', advanceWatchRunId: true });
    const later = { ...first, observedAt: new Date(first.observedAt.getTime() + 30_000) };
    // not corroborated when the generation's ambiguous rows ever carried another score (a climbing replay)
    expect(
      decideBatch(
        stored({ clock: null, lastAmbiguous: { ...la, otherScoresSeen: true } }),
        later,
        liveEvents,
      ),
    ).toMatchObject({ kind: 'stale', reason: 'ambiguous_regression' });
    // not corroborated by: a different generation, a different score, or an equal observedAt
    expect(
      decideBatch(
        stored({ clock: null, lastAmbiguous: { ...la, watchId: 9 } }),
        { ...first, observedAt: new Date(first.observedAt.getTime() + 30_000) },
        liveEvents,
      ),
    ).toMatchObject({ kind: 'stale', reason: 'ambiguous_regression' });
    expect(
      decideBatch(
        stored({ clock: null, lastAmbiguous: { ...la, score: { home: 6, away: 8 } } }),
        { ...first, observedAt: new Date(first.observedAt.getTime() + 30_000) },
        liveEvents,
      ),
    ).toMatchObject({ kind: 'stale', reason: 'ambiguous_regression' });
    expect(
      decideBatch(stored({ clock: null, lastAmbiguous: la }), first, liveEvents),
    ).toMatchObject({
      kind: 'stale',
      reason: 'ambiguous_regression',
    });
  });

  it('2d: an event-bearing batch after an ambiguous one advances the generation through rules 2a-2c as usual', () => {
    const la = {
      watchId: 11,
      score: { home: 8, away: 8 },
      observedAt: t('2026-06-30T23:20:10Z'),
      otherScoresSeen: false,
    };
    // a single push event (not complete, no gameView) of the same new generation
    const push = batch({
      watchId: 11,
      isComplete: false,
      gameView: null,
      eventPositions: [pos(1, 210)],
      observedAt: t('2026-06-30T23:20:40Z'),
    });
    expect(decideBatch(stored({ clock: null, lastAmbiguous: la }), push, liveEvents)).toMatchObject(
      {
        kind: 'accept',
        generation: 'new',
        advanceWatchRunId: true,
      },
    );
    // a complete document at the stored newest position carrying the lower score: 2c passes, 2d does not apply
    const complete = batch({
      watchId: 11,
      gameView: view({ score: { home: 8, away: 8 }, clock: null }),
      observedAt: t('2026-06-30T23:20:40Z'),
    });
    expect(
      decideBatch(stored({ clock: null, lastAmbiguous: la }), complete, liveEvents),
    ).toMatchObject({
      kind: 'accept',
      generation: 'new',
      advanceWatchRunId: true,
      gameLevel: 'write',
    });
  });

  it('unknown provider status makes no phase claim: 2a is skipped, 2b still applies, the stored status is kept', () => {
    const unknown = view({ status: null, unknownStatus: 'weird' });
    // a new generation whose status we cannot map is not a phase regression
    const d = decideBatch(stored(), batch({ watchId: 11, gameView: unknown }), liveEvents);
    expect(d).toMatchObject({ kind: 'accept', generation: 'new', gameLevel: 'write' });
    // but its period is still gated
    const d2 = decideBatch(
      stored({ currentPeriodSequence: 3 }),
      batch({
        watchId: 11,
        gameView: view({ status: null, unknownStatus: 'weird' }),
        eventPositions: [pos(3, 999)],
      }),
      liveEvents,
    );
    expect(d2).toMatchObject({ kind: 'stale', reason: 'run_regresses_state' });
    expect((d2 as { detail: string }).detail).toMatch(/2b/);
    // and phaseOf never sees a null: a stored status is always a real GameStatus
    expect(phaseOf('inprogress')).toBe('live');
  });
});

describe('freshness rule 3: stats observation precedence', () => {
  const T1 = t('2026-06-30T23:30:00Z');
  const T2 = t('2026-06-30T23:30:30Z');
  it('a new row inserts; a newer observation with a differing hash updates; an identical hash touches; older or equal is ignored', () => {
    expect(decideStats(undefined, { contentHash: 'h', observedAt: T1 })).toBe('insert');
    const stored = { contentHash: 'h', observedAt: T1 };
    expect(decideStats(stored, { contentHash: 'x', observedAt: T2 })).toBe('update');
    expect(decideStats(stored, { contentHash: 'h', observedAt: T2 })).toBe('touch');
    expect(decideStats(stored, { contentHash: 'x', observedAt: T1 })).toBe('ignore_older'); // equal: not newer
    expect(decideStats(stored, { contentHash: 'x', observedAt: t('2026-06-30T23:29:00Z') })).toBe(
      'ignore_older',
    );
    // a replay re-presenting an older stats document over a finished game never oscillates:
    // doc 142 (older) against stored doc 146 -> ignored; doc 146 again -> touch, no change
    expect(
      decideStats({ contentHash: 'd146', observedAt: T2 }, { contentHash: 'd142', observedAt: T1 }),
    ).toBe('ignore_older');
    expect(
      decideStats({ contentHash: 'd146', observedAt: T2 }, { contentHash: 'd146', observedAt: T2 }),
    ).toBe('ignore_older');
    // an official correction on a closed game arrives later: applied
    expect(
      decideStats(
        { contentHash: 'd146', observedAt: T2 },
        { contentHash: 'official', observedAt: t('2026-07-01T10:00:00Z') },
      ),
    ).toBe('update');
    // a row predating 0004 has no observed_at: hash decides
    expect(
      decideStats({ contentHash: 'h', observedAt: null }, { contentHash: 'h', observedAt: T1 }),
    ).toBe('touch');
    expect(
      decideStats({ contentHash: 'h', observedAt: null }, { contentHash: 'x', observedAt: T1 }),
    ).toBe('update');
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
    const s = {
      contentHash: 'h',
      providerUpdatedAt: '2026-06-30T23:00:00+00:00',
      deleted: false,
      deletedRevisionAt: null,
    };
    expect(decideEvent(undefined, { contentHash: 'h', providerUpdatedAt: null }, null)).toBe(
      'insert',
    );
    expect(
      decideEvent(s, { contentHash: 'h', providerUpdatedAt: '2026-06-30T23:00:00+00:00' }, null),
    ).toBe('unchanged');
    expect(
      decideEvent(s, { contentHash: 'x', providerUpdatedAt: '2026-06-30T23:00:00+00:00' }, null),
    ).toBe('update'); // equal updated, body differs: correction
    expect(decideEvent(s, { contentHash: 'x', providerUpdatedAt: null }, null)).toBe('update'); // missing updated: hash decides
    expect(
      decideEvent(s, { contentHash: 'x', providerUpdatedAt: '2026-06-30T22:59:00+00:00' }, null),
    ).toBe('ignore_older');
    expect(
      decideEvent(s, { contentHash: 'h', providerUpdatedAt: '2026-06-30T23:01:00+00:00' }, null),
    ).toBe('touch'); // newer but identical: revision-only update, no change row
    expect(decideEvent(s, null, { updatedAt: null })).toBe('delete');
    expect(decideEvent(undefined, null, { updatedAt: null })).toBe('ignore_missing');
    const del = { ...s, deleted: true, deletedRevisionAt: null };
    expect(decideEvent(del, null, { updatedAt: null })).toBe('unchanged');
    expect(
      decideEvent(del, { contentHash: 'h', providerUpdatedAt: '2026-06-30T23:00:00+00:00' }, null),
    ).toBe('unchanged');
    expect(
      decideEvent(del, { contentHash: 'h', providerUpdatedAt: '2026-06-30T23:05:00+00:00' }, null),
    ).toBe('reinstate');
  });

  it('deletion revisions: an older marker is ignored, a marker without one is applied, reinstatement needs a newer revision than the deletion, none on either side is sticky', () => {
    const T1 = '2026-06-30T23:00:00+00:00';
    const T2 = '2026-06-30T23:05:00+00:00';
    const T3 = '2026-06-30T23:10:00+00:00';
    const live = {
      contentHash: 'h',
      providerUpdatedAt: T2,
      deleted: false,
      deletedRevisionAt: null,
    };
    expect(decideEvent(live, null, { updatedAt: T1 })).toBe('ignore_older_deletion');
    expect(decideEvent(live, null, { updatedAt: T2 })).toBe('delete'); // equal: explicit statement wins
    expect(decideEvent(live, null, { updatedAt: T3 })).toBe('delete');
    expect(decideEvent(live, null, { updatedAt: null })).toBe('delete'); // no revision: applied
    const noRev = { ...live, providerUpdatedAt: null };
    expect(decideEvent(noRev, null, { updatedAt: T1 })).toBe('delete');
    // deleted by a marker with revision T3: only an incoming newer than T3 reinstates
    const deletedAtT3 = { ...live, deleted: true, deletedRevisionAt: T3 };
    expect(decideEvent(deletedAtT3, { contentHash: 'h', providerUpdatedAt: T3 }, null)).toBe(
      'unchanged',
    );
    expect(
      decideEvent(
        deletedAtT3,
        { contentHash: 'h', providerUpdatedAt: '2026-06-30T23:11:00+00:00' },
        null,
      ),
    ).toBe('reinstate');
    // deleted by a marker without revision: coalesce falls back to the event's own `updated` (T2)
    const deletedNoRev = { ...live, deleted: true };
    expect(decideEvent(deletedNoRev, { contentHash: 'h', providerUpdatedAt: T2 }, null)).toBe(
      'unchanged',
    );
    expect(decideEvent(deletedNoRev, { contentHash: 'h', providerUpdatedAt: T3 }, null)).toBe(
      'reinstate',
    );
    // neither side carries a revision: sticky (no special case for "incoming has one, stored has none")
    const sticky = { ...noRev, deleted: true };
    expect(decideEvent(sticky, { contentHash: 'h', providerUpdatedAt: null }, null)).toBe(
      'unchanged',
    );
    expect(decideEvent(sticky, { contentHash: 'h', providerUpdatedAt: T3 }, null)).toBe(
      'unchanged',
    );
    // through diffEvents the older marker is counted, not applied
    const storedMap = new Map([['e1', live]]);
    const d = diffEvents(storedMap, [], [{ providerEventId: 'e1', updatedAt: T1 }]);
    expect(d.changes).toEqual([]);
    expect(d.counts.ignoredOlderDeletions).toBe(1);
    const d2 = diffEvents(storedMap, [], [{ providerEventId: 'e1', updatedAt: null }]);
    expect(d2.deletions).toEqual([{ providerEventId: 'e1', updatedAt: null }]);
  });

  it('repeated deletion advances its revision without a change and rejects intermediate reinstatement', () => {
    const rev = (s: number) => new Date(Date.UTC(2026, 5, 30, 23, 0, s)).toISOString();
    const stored = {
      contentHash: 'h',
      providerUpdatedAt: rev(10),
      deleted: true,
      deletedRevisionAt: rev(20),
    };
    const d = diffEvents(
      new Map([['e1', stored]]),
      [],
      [{ providerEventId: 'e1', updatedAt: rev(40) }],
    );
    expect(d.changes).toEqual([]);
    expect(d.deletionTouches).toEqual([{ providerEventId: 'e1', updatedAt: rev(40) }]);
    const advanced = { ...stored, deletedRevisionAt: rev(40) };
    expect(decideEvent(advanced, { contentHash: 'h', providerUpdatedAt: rev(30) }, null)).toBe(
      'unchanged',
    );
    expect(decideEvent(advanced, { contentHash: 'h', providerUpdatedAt: rev(50) }, null)).toBe(
      'reinstate',
    );
    expect(decideEvent(advanced, null, { updatedAt: rev(30) })).toBe('ignore_older_deletion');
    expect(decideEvent(advanced, null, { updatedAt: rev(40) })).toBe('unchanged');
    expect(decideEvent(advanced, null, { updatedAt: null })).toBe('unchanged');
    expect(
      decideEvent({ ...stored, providerUpdatedAt: null, deletedRevisionAt: null }, null, {
        updatedAt: rev(40),
      }),
    ).toBe('touch_deletion');
  });

  it('revision-only update: revision 12 with revision 10 body touches (no change); a later differing revision 11 is then older and ignored', () => {
    const r10 = nev('a', { providerUpdatedAt: '2026-06-30T23:00:10+00:00' });
    const first = diffEvents(new Map(), [r10], []);
    const storedMap = new Map(
      first.writes.map((w) => [
        w.event.providerEventId,
        {
          contentHash: w.hash,
          providerUpdatedAt: w.event.providerUpdatedAt,
          deleted: false,
          deletedRevisionAt: null,
        },
      ]),
    );
    const r12 = nev('a', { providerUpdatedAt: '2026-06-30T23:00:12+00:00' });
    const touch = diffEvents(storedMap, [r12], []);
    expect(touch.changes).toEqual([]);
    expect(touch.touches.map((e) => e.providerUpdatedAt)).toEqual(['2026-06-30T23:00:12+00:00']);
    expect(touch.counts).toMatchObject({ touched: 1, updated: 0, unchanged: 0 });
    // the store advanced to 12; revision 11 with a different body is older
    const s = storedMap.get('a');
    if (!s) throw new Error('missing');
    storedMap.set('a', { ...s, providerUpdatedAt: '2026-06-30T23:00:12+00:00' });
    const r11 = nev('a', { providerUpdatedAt: '2026-06-30T23:00:11+00:00' });
    r11.body = { ...r11.body, description: 'different' };
    const older = diffEvents(storedMap, [r11], []);
    expect(older.changes).toEqual([]);
    expect(older.counts.ignoredOlder).toBe(1);
  });

  it('diffEvents: the same batch twice is empty; last duplicate in a batch wins; a marker overrides a body in the same batch', () => {
    const a = nev('a', { providerUpdatedAt: '2026-06-30T23:00:00+00:00' });
    const first = diffEvents(new Map(), [a, a], []);
    expect(first.changes.map((c) => c.type)).toEqual(['event_insert']);
    const storedMap = new Map(
      first.writes.map((w) => [
        w.event.providerEventId,
        {
          contentHash: w.hash,
          providerUpdatedAt: w.event.providerUpdatedAt,
          deleted: false,
          deletedRevisionAt: null,
        },
      ]),
    );
    expect(diffEvents(storedMap, [a], []).changes).toEqual([]);
    const withMarker = diffEvents(storedMap, [a], [{ providerEventId: 'a', updatedAt: null }]);
    expect(withMarker.changes.map((c) => c.type)).toEqual(['event_delete']);
  });
});
