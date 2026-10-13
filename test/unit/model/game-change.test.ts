import { describe, expect, it } from 'vitest';
import { GameChangeSchema, gameChangeFromRow } from '../../../src/model/game-change.js';
import { LiveEventSchema } from '../../../src/model/live-event.js';
import { PulseSchema } from '../../../src/model/pulse.js';

const uuid = '11111111-1111-4111-8111-111111111111';
const gameId = '22222222-2222-4222-8222-222222222222';

describe('GameChange schema', () => {
  it('rebuilds the envelope from stored columns and parses it', () => {
    const c = gameChangeFromRow({
      id: uuid,
      gameId,
      seq: '7',
      changeType: 'status',
      providerEventId: null,
      body: {
        status: 'inprogress',
        score: { home: 2, away: 0 },
        period: { number: 1, type: 'quarter', sequence: 1 },
      },
      createdAt: new Date('2026-06-30T23:16:33Z'),
    });
    expect(c).toEqual({
      v: 1,
      id: uuid,
      gameId,
      seq: 7,
      ts: '2026-06-30T23:16:33.000Z',
      type: 'status',
      body: {
        status: 'inprogress',
        score: { home: 2, away: 0 },
        period: { number: 1, type: 'quarter', sequence: 1 },
      },
    });
  });

  it('requires providerEventId on event changes and rejects unknown types', () => {
    const base = { v: 1, id: uuid, gameId, seq: 1, ts: '2026-06-30T23:16:33+00:00' };
    expect(
      GameChangeSchema.safeParse({ ...base, type: 'event_delete', body: { providerEventId: 'x' } })
        .success,
    ).toBe(false);
    expect(
      GameChangeSchema.safeParse({
        ...base,
        type: 'event_delete',
        providerEventId: 'x',
        body: { providerEventId: 'x' },
      }).success,
    ).toBe(true);
    expect(GameChangeSchema.safeParse({ ...base, type: 'clock', body: {} }).success).toBe(false);
    expect(
      GameChangeSchema.safeParse({
        ...base,
        type: 'status',
        body: { status: 'nope', score: { home: 0, away: 0 }, period: null },
      }).success,
    ).toBe(false);
  });

  it('LiveEvent is a closed union on type', () => {
    const base = {
      period: { number: 1, type: 'quarter', sequence: 1 },
      clock: '9:35',
      wallClock: '2026-06-30T23:16:56+00:00',
      score: { home: 2, away: 0 },
    };
    expect(
      LiveEventSchema.safeParse({ ...base, type: 'shot', made: true, points: 2 }).success,
    ).toBe(true);
    expect(LiveEventSchema.safeParse({ ...base, type: 'dunk' }).success).toBe(false);
    expect(
      LiveEventSchema.safeParse({ ...base, type: 'other', providerEventType: 'stoppage' }).success,
    ).toBe(true);
  });

  it('pulse carries latestSeq and a tri-state clockRunning', () => {
    const p = {
      v: 1,
      type: 'pulse',
      gameId,
      latestSeq: 10,
      status: 'inprogress',
      clock: '4:00',
      clockRunning: null,
      clockAsOf: null,
      observedAt: '2026-06-30T23:16:56+00:00',
    };
    expect(PulseSchema.safeParse(p).success).toBe(true);
    expect(PulseSchema.safeParse({ ...p, clockRunning: 'yes' }).success).toBe(false);
  });
});
