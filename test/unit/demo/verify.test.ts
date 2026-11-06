import { describe, expect, it } from 'vitest';
import { canonicalGame, differences } from '../../../src/ingest/demo-verify.js';
import type { Snapshot } from '../../../src/model/snapshot.js';

/** verify-slot's comparison (demo-verify.ts): what is compared, what is deliberately not. */
const event = (id: string, description: string) => ({
  providerEventId: id,
  providerSequence: 1,
  providerNumber: 1,
  body: {
    type: 'other',
    providerEventType: 'x',
    period: { number: 1, type: 'quarter', sequence: 1 },
    clock: '9:00',
    description,
  },
});
function snapshot(over: Partial<Snapshot> = {}, game: Partial<Snapshot['game']> = {}): Snapshot {
  return {
    game: {
      id: '11111111-1111-4111-8111-111111111111',
      league: 'wnba',
      providerGameId: 'replay-93ee7c68-202611062300',
      status: 'closed',
      scheduledAt: '2026-11-06T23:00:00.000Z',
      coverage: 'full',
      homeTeamId: null,
      awayTeamId: null,
      score: { home: 93, away: 85 },
      period: null,
      clock: '0:00',
      clockDecimal: null,
      clockRunning: false,
      clockAsOf: null,
      observedAt: '2026-11-06T23:00:00.000Z',
      elamTargetScore: null,
      replay: 'recorded',
      ...game,
    },
    periods: [{ number: 1, type: 'quarter', sequence: 1, score: { home: 20, away: 18 } }],
    teamStats: [],
    playerStats: [],
    events: [event('a', 'one'), event('b', 'two')] as Snapshot['events'],
    seq: 1000,
    retainedFrom: 1,
    coverage: 'full',
    serverTime: '2026-11-07T00:00:00.000Z',
    ...over,
  };
}

describe('verify-slot comparison', () => {
  it('ignores ids, seq, observation times and event order; compares state', () => {
    const demo = snapshot();
    const check = snapshot(
      {
        seq: 1233,
        serverTime: 'x',
        events: [event('b', 'two'), event('a', 'one')] as Snapshot['events'],
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        providerGameId: 'check-replay-93ee7c68-202611062300',
        observedAt: '2026-11-06T23:59:00.000Z',
      },
    );
    expect(differences(canonicalGame(demo), canonicalGame(check))).toEqual([]);
  });

  it('reports the first differences by path (event body, score, counts)', () => {
    const demo = snapshot();
    const check = snapshot(
      { events: [event('a', 'one'), event('b', 'TWO')] as Snapshot['events'] },
      { score: { home: 93, away: 84 } },
    );
    expect(differences(canonicalGame(demo), canonicalGame(check))).toEqual([
      '.events[1].body.description: "two" != "TWO"',
      '.score.away: 85 != 84',
    ]);
    const fewer = snapshot({ events: [event('a', 'one')] as Snapshot['events'] });
    expect(differences(canonicalGame(demo), canonicalGame(fewer), 2)).toEqual([
      '.eventCount: 2 != 1',
      '.events: length 2 != 1',
    ]);
  });
});
