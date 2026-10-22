import { describe, expect, it } from 'vitest';
import {
  HEALTH_THRESHOLDS,
  type HealthFacts,
  healthAlerts,
} from '../../../src/api/routes/health.js';

const now = new Date('2026-10-18T20:00:00Z');
const healthy: HealthFacts = {
  now,
  outboxPending: 0,
  outboxLagMs: null,
  outboxDead: 0,
  lockHeld: true,
  lastCallAt: new Date(now.getTime() - 10_000),
  lastObservedAt: now,
  runningRuns: 1,
  runningWatches: 1,
  pushRuns: [],
  regressingGames: [],
};

describe('healthAlerts (docs/DEPLOY.md alert conditions)', () => {
  it('a healthy worker raises nothing', () => {
    expect(healthAlerts(healthy)).toEqual([]);
  });

  it('outbox lag > 30 s and dead rows', () => {
    expect(healthAlerts({ ...healthy, outboxLagMs: HEALTH_THRESHOLDS.outboxLagMs })).toEqual([]);
    expect(healthAlerts({ ...healthy, outboxLagMs: 31_000 })[0]).toMatch(/^outbox_lag/);
    expect(healthAlerts({ ...healthy, outboxDead: 2 })[0]).toMatch(/^outbox_dead: 2/);
  });

  it('a running watch without a provider call for > 5 min; fixture replays (no calls) never count', () => {
    expect(
      healthAlerts({ ...healthy, lastCallAt: new Date(now.getTime() - 6 * 60_000) })[0],
    ).toMatch(/^watch_without_provider_calls/);
    expect(healthAlerts({ ...healthy, lastCallAt: null })[0]).toMatch(/no provider call ever/);
    expect(healthAlerts({ ...healthy, runningWatches: 0, lastCallAt: null })).toEqual([]);
  });

  it('three consecutive run_regresses_state rows for one game', () => {
    const a = healthAlerts({ ...healthy, regressingGames: ['g1', 'g2'] });
    expect(a).toHaveLength(2);
    expect(a[0]).toMatch(/^consecutive_regressions: game g1/);
  });

  it('a push stream disconnected for > 60 s, from the push_stream run meta; stopped streams never alert', () => {
    const pushRuns = [
      {
        runId: '42',
        gameId: 'g1',
        push: {
          push_events: {
            status: 'backoff',
            disconnectedSince: new Date(now.getTime() - 90_000).toISOString(),
          },
          push_clock: { status: 'connected', disconnectedSince: null },
        },
      },
      {
        runId: '43',
        gameId: 'g2',
        push: {
          push_events: {
            status: 'stopped',
            disconnectedSince: new Date(now.getTime() - 900_000).toISOString(),
          },
        },
      },
      {
        runId: '44',
        gameId: 'g3',
        push: {
          push_events: {
            status: 'backoff',
            disconnectedSince: new Date(now.getTime() - 30_000).toISOString(),
          },
        },
      },
    ];
    const a = healthAlerts({ ...healthy, pushRuns });
    expect(a).toHaveLength(1);
    expect(a[0]).toMatch(
      /^push_stream_disconnected: push_events of game g1 \(run 42\) down for 90 s/,
    );
    // unparsable meta is ignored, never thrown
    expect(healthAlerts({ ...healthy, pushRuns: 'garbage' })).toEqual([]);
  });
});
