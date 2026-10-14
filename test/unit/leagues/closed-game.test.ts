import { describe, expect, it } from 'vitest';
import { diffEvents } from '../../../src/ingest/diff.js';
import { decideBatch } from '../../../src/ingest/freshness.js';
import { wnbaAdapter } from '../../../src/leagues/wnba/adapter.js';
import { contentHash } from '../../../src/model/content-hash.js';
import { LiveEventSchema } from '../../../src/model/live-event.js';
import { BoxscoreDocumentSchema } from '../../../src/providers/sportradar/schemas/boxscore.js';
import { PbpDocumentSchema } from '../../../src/providers/sportradar/schemas/pbp.js';
import { SummaryDocumentSchema } from '../../../src/providers/sportradar/schemas/summary.js';
import { fixture } from '../../helpers/fixtures.js';

const R = 'sim-93ee7c68';

describe('full recorded game (closed documents)', () => {
  const closed = wnbaAdapter.normalizePbp(PbpDocumentSchema.parse(fixture(`${R}-pbp-closed.json`)));
  const box = wnbaAdapter.normalizeBoxscore(
    BoxscoreDocumentSchema.parse(fixture(`${R}-boxscore-closed.json`)),
  );
  const summary = wnbaAdapter.normalizeSummary(
    SummaryDocumentSchema.parse(fixture(`${R}-summary-closed.json`)),
  );

  it('normalizes every event of the closed pbp into a valid LiveEvent with positions', () => {
    expect(closed.batch.events.length).toBeGreaterThan(400);
    for (const e of closed.batch.events) {
      expect(LiveEventSchema.safeParse(e.body).success).toBe(true);
      expect(e.periodSequence).not.toBeNull();
      expect(e.providerSequence).not.toBeNull();
    }
    const ids = new Set(closed.batch.events.map((e) => e.providerEventId));
    expect(ids.size).toBe(closed.batch.events.length);
  });

  it('carries the provider deletion markers (deleted_events[]) and never lists them as events', () => {
    expect(closed.batch.deletedEvents.length).toBeGreaterThan(0);
    const ids = new Set(closed.batch.events.map((e) => e.providerEventId));
    for (const d of closed.batch.deletedEvents) expect(ids.has(d.providerEventId)).toBe(false);
    // a stored copy of a deleted event yields exactly one event_delete; absent events are untouched
    const stored = new Map(
      closed.batch.events.map((e) => [
        e.providerEventId,
        {
          contentHash: contentHash(e.body),
          providerUpdatedAt: e.providerUpdatedAt,
          deleted: false,
          deletedRevisionAt: null,
        },
      ]),
    );
    const victim = closed.batch.deletedEvents[0]?.providerEventId as string;
    stored.set(victim, {
      contentHash: 'x',
      providerUpdatedAt: null,
      deleted: false,
      deletedRevisionAt: null,
    });
    const diff = diffEvents(stored, closed.batch.events, closed.batch.deletedEvents);
    expect(diff.changes).toEqual([
      { type: 'event_delete', providerEventId: victim, body: { providerEventId: victim } },
    ]);
  });

  it('final score and line score agree between pbp, summary and boxscore', () => {
    expect(closed.gameView?.status).toBe('closed');
    expect(closed.gameView?.score).toEqual(box.gameView?.score);
    expect(summary.gameView?.score).toEqual(box.gameView?.score);
    expect(closed.gameView?.periods.map((p) => p.score)).toEqual(
      box.gameView?.periods.map((p) => p.score),
    );
    const sum = (k: 'home' | 'away') =>
      closed.gameView?.periods.reduce((n, p) => n + p.score[k], 0);
    expect({ home: sum('home'), away: sum('away') }).toEqual(box.gameView?.score);
    expect(closed.gameView?.period).toEqual({ number: 4, type: 'quarter', sequence: 4 });
  });

  it('halftime -> closed as a new generation passes the gate; closed -> halftime as a new generation does not', () => {
    const half = wnbaAdapter.normalizePbp(
      PbpDocumentSchema.parse(fixture(`${R}-pbp-halftime.json`)),
    );
    expect(half.gameView?.status).toBe('halftime');
    const pos = (nd: typeof half) =>
      nd.batch.events.map((e) => ({
        periodSequence: e.periodSequence,
        providerSequence: e.providerSequence,
        providerNumber: e.providerNumber,
        wallClock: e.wallClock,
      }));
    const storedHalf = {
      watchRunId: 1,
      lastSeq: 500,
      status: 'halftime' as const,
      currentPeriodSequence: 2,
      observedAt: new Date('2026-10-13T09:00:00Z'),
      score: half.gameView?.score ?? null,
      clock: half.gameView?.clock ?? null,
      lastAmbiguous: null,
    };
    const storedEvents = half.batch.events.map((e) => ({
      providerEventId: e.providerEventId,
      deleted: false,
      periodSequence: e.periodSequence,
      providerSequence: e.providerSequence,
      providerNumber: e.providerNumber,
      wallClock: e.wallClock,
    }));
    const forward = decideBatch(
      storedHalf,
      {
        watchId: 2,
        observedAt: new Date('2026-10-13T10:00:00Z'),
        isComplete: true,
        gameView: closed.gameView,
        eventPositions: pos(closed),
        deletedEvents: closed.batch.deletedEvents,
        eventCount: closed.batch.events.length,
        deletionCount: closed.batch.deletedEvents.length,
      },
      storedEvents,
    );
    expect(forward).toMatchObject({ kind: 'accept', generation: 'new', gameLevel: 'write' });
    const storedClosed = {
      watchRunId: 1,
      lastSeq: 900,
      status: 'closed' as const,
      currentPeriodSequence: 4,
      observedAt: new Date('2026-10-13T10:00:00Z'),
      score: closed.gameView?.score ?? null,
      clock: closed.gameView?.clock ?? null,
      lastAmbiguous: null,
    };
    const closedEvents = closed.batch.events.map((e) => ({
      providerEventId: e.providerEventId,
      deleted: false,
      periodSequence: e.periodSequence,
      providerSequence: e.providerSequence,
      providerNumber: e.providerNumber,
      wallClock: e.wallClock,
    }));
    const backward = decideBatch(
      storedClosed,
      {
        watchId: 2,
        observedAt: new Date('2026-10-13T11:00:00Z'),
        isComplete: true,
        gameView: half.gameView,
        eventPositions: pos(half),
        deletedEvents: [],
        eventCount: half.batch.events.length,
        deletionCount: 0,
      },
      closedEvents,
    );
    expect(backward).toMatchObject({ kind: 'stale', reason: 'run_regresses_state' });
  });
});
