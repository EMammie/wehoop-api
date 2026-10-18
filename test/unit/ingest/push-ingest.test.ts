import { describe, expect, it } from 'vitest';
import {
  normalizePushClock,
  pushClockToGameView,
  pushEventToBatch,
} from '../../../src/ingest/push-ingest.js';
import {
  type PushClockMessage,
  PushClockMessageSchema,
  type PushEventMessage,
  PushEventMessageSchema,
} from '../../../src/providers/sportradar/schemas/push.js';
import { fixture } from '../../helpers/fixtures.js';

const events = (fixture('sim-93ee7c68-push-events-sample.json') as unknown[]).slice(1);
const clocks = fixture('sim-93ee7c68-push-clock-sample.json') as unknown[];
const event = (i: number) => PushEventMessageSchema.parse(events[i]);
const clock = (i: number) => PushClockMessageSchema.parse(clocks[i]);

describe('normalizePushClock', () => {
  it('turns the push feed digits into the REST m:ss form and leaves m:ss alone', () => {
    expect(normalizePushClock('1000')).toBe('10:00');
    expect(normalizePushClock('959')).toBe('9:59');
    expect(normalizePushClock('025')).toBe('00:25');
    expect(normalizePushClock('0')).toBe('00:00');
    expect(normalizePushClock('1000.5')).toBe('10:00.5');
    expect(normalizePushClock('10:00')).toBe('10:00');
    expect(normalizePushClock('00:25.4')).toBe('00:25.4');
    expect(normalizePushClock('')).toBeNull();
    expect(normalizePushClock(undefined)).toBeNull();
    expect(normalizePushClock(null)).toBeNull();
    expect(normalizePushClock('n/a')).toBe('n/a'); // unknown text is passed through, never invented
  });
});

describe('pushEventToBatch', () => {
  it('insert/update -> one normalized event with its inline period, no gameView, the players it names', () => {
    const n = pushEventToBatch(event(0));
    expect(n.ok).toBe(true);
    if (!n.ok) return;
    expect(n.operation).toBe('update');
    expect(n.providerGameId).toBe('40bea3f6-68c0-4f3b-96fa-336dfb7a9034');
    expect(n.batch.events).toHaveLength(1);
    expect(n.batch.deletedEvents).toEqual([]);
    const ev = n.batch.events[0];
    expect(ev?.providerEventId).toBe('aeaa8af3-ca64-45c5-ab47-0f19c11410dd');
    expect(ev?.periodSequence).toBe(1);
    expect(ev?.body.type).toBe('lineup_change');
    expect(ev?.providerUpdatedAt).toBe('2026-06-30T23:16:33+00:00');
    expect(n.players.length).toBeGreaterThanOrEqual(5);
  });

  it('delete -> one explicit deletion marker carrying the message revision, no events', () => {
    const msg: PushEventMessage = {
      ...event(0),
      metadata: { ...event(0).metadata, operation: 'delete' },
    };
    const n = pushEventToBatch(msg);
    expect(n.ok).toBe(true);
    if (!n.ok) return;
    expect(n.operation).toBe('delete');
    expect(n.batch.events).toEqual([]);
    expect(n.batch.deletedEvents).toEqual([
      {
        providerEventId: 'aeaa8af3-ca64-45c5-ab47-0f19c11410dd',
        updatedAt: '2026-06-30T23:16:33+00:00',
      },
    ]);
  });

  it('an event without its period, or an unknown operation, is reported, never guessed', () => {
    const { period: _p, ...noPeriod } = event(0).payload.event;
    const n = pushEventToBatch({ ...event(0), payload: { ...event(0).payload, event: noPeriod } });
    expect(n).toMatchObject({ ok: false, reason: 'no_period' });
    const m = pushEventToBatch({
      ...event(0),
      metadata: { ...event(0).metadata, operation: 'merge' },
    });
    expect(m).toMatchObject({ ok: false, reason: 'unknown_operation' });
  });
});

describe('pushClockToGameView', () => {
  it('status, score, period, normalized clock and clockRunning from clocks.running; no events, no line score', () => {
    const gv = pushClockToGameView(clock(2), null);
    expect(gv).toMatchObject({
      status: 'inprogress',
      unknownStatus: null,
      score: { home: 0, away: 0 },
      period: { number: 1, sequence: 1, type: 'quarter' },
      clock: '10:00',
      clockDecimal: '10:00',
      clockRunning: true,
      periods: [],
      coverage: 'full',
      scheduledAt: '2026-06-30T23:00:00+00:00',
    });
  });

  it('a message without a period keeps the stored period (omission is not change); running=false is carried', () => {
    const stored = { number: 2, sequence: 2, type: 'quarter' as const };
    const gv = pushClockToGameView(clock(0), stored);
    expect(gv.period).toEqual(stored);
    expect(gv.clockRunning).toBe(false);
    expect(pushClockToGameView(clock(0), null).period).toBeNull();
  });

  it('an unknown provider status is reported on the view, not mapped', () => {
    const msg: PushClockMessage = {
      ...clock(0),
      payload: { ...clock(0).payload, game: { ...clock(0).payload.game, status: 'weird' } },
    };
    const gv = pushClockToGameView(msg, null);
    expect(gv.status).toBeNull();
    expect(gv.unknownStatus).toBe('weird');
  });
});
