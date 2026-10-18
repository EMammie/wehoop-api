import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config.js';
import type { QuotaGuard } from '../../../src/ingest/quota-guard.js';
import {
  gamesToWatch,
  inGameWindow,
  localDate,
  localHour,
  Scheduler,
  scheduleDates,
  shouldPollSchedule,
} from '../../../src/ingest/scheduler.js';
import type { GameRow } from '../../../src/ingest/trial-mode.js';
import { createLogger } from '../../../src/logger.js';

const log = createLogger({ level: 'silent', pretty: false });
const game = (id: string, scheduledAt: Date, status = 'scheduled', coverage = 'full'): GameRow => ({
  id,
  providerGameId: `p-${id}`,
  status,
  coverage,
  scheduledAt,
});

describe('scheduler decisions (plan §4 production scheduler)', () => {
  it('local dates and hours are Eastern; schedule polls cover today and tomorrow', () => {
    const t = new Date('2026-10-19T03:30:00Z'); // 23:30 ET on the 18th
    expect(localDate(t)).toBe('2026-10-18');
    expect(localHour(t)).toBe(23);
    expect(scheduleDates(t)).toEqual(['2026-10-18', '2026-10-19']);
  });

  it('polls when never polled, at the 06:00 hour once per day, and hourly inside a game window', () => {
    const six = new Date('2026-10-19T10:15:00Z'); // 06:15 ET
    expect(shouldPollSchedule(six, null, false)).toBe(true);
    expect(shouldPollSchedule(six, new Date('2026-10-18T10:30:00Z'), false)).toBe(true); // yesterday 06:30
    expect(shouldPollSchedule(six, new Date('2026-10-19T10:05:00Z'), false)).toBe(false); // already today 06:05
    const noon = new Date('2026-10-19T16:00:00Z');
    expect(shouldPollSchedule(noon, new Date('2026-10-19T10:05:00Z'), false)).toBe(false);
    expect(shouldPollSchedule(noon, new Date('2026-10-19T14:59:00Z'), true)).toBe(true); // 61 min, in window
    expect(shouldPollSchedule(noon, new Date('2026-10-19T15:30:00Z'), true)).toBe(false); // 30 min, in window
  });

  it('a game window spans tip-off - 30 min .. + 4 h for unfinished games', () => {
    const now = new Date('2026-10-19T23:00:00Z');
    const w = { windowBeforeMs: 30 * 60_000, windowAfterMs: 4 * 3_600_000 };
    expect(inGameWindow([game('a', new Date('2026-10-19T23:20:00Z'))], now, w)).toBe(true);
    expect(inGameWindow([game('a', new Date('2026-10-20T00:00:00Z'))], now, w)).toBe(false);
    expect(inGameWindow([game('a', new Date('2026-10-19T19:30:00Z'))], now, w)).toBe(true);
    expect(inGameWindow([game('a', new Date('2026-10-19T18:30:00Z'))], now, w)).toBe(false);
    expect(inGameWindow([game('a', new Date('2026-10-19T22:00:00Z'), 'closed')], now, w)).toBe(
      false,
    );
  });

  it('watches start within the lead, never for finished, too-late or already-running games', () => {
    const now = new Date('2026-10-19T23:00:00Z');
    const o = { watchLeadMs: 10 * 60_000, maxLateStartMs: 6 * 3_600_000 };
    const soon = game('soon', new Date('2026-10-19T23:08:00Z'));
    const later = game('later', new Date('2026-10-19T23:30:00Z'));
    const live = game('live', new Date('2026-10-19T21:00:00Z'), 'inprogress');
    const old = game('old', new Date('2026-10-19T12:00:00Z'), 'inprogress');
    const done = game('done', new Date('2026-10-19T19:00:00Z'), 'closed');
    const running = game('running', new Date('2026-10-19T22:30:00Z'), 'inprogress');
    expect(
      gamesToWatch([soon, later, live, old, done, running], now, new Set(['running']), o).map(
        (g) => g.id,
      ),
    ).toEqual(['soon', 'live']);
  });
});

describe('Scheduler.tick with injected provider and watch', () => {
  const config = loadConfig({
    DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
    DATABASE_SESSION_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
    SUPABASE_URL: 'http://127.0.0.1:54321',
    SUPABASE_SERVICE_ROLE_KEY: 'service',
    SPORTRADAR_WNBA_KEY: 'unit-test-key',
    SPORTRADAR_ACCESS_LEVEL: 'production',
    MODE: 'production',
    TRIAL_ALLOW_DEV_DB: '1',
  });

  it('polls once, starts one watch per game near tip-off (push for full-coverage push leagues), never twice, and survives a failing poll', async () => {
    let now = new Date('2026-10-19T23:00:00Z');
    const polls: string[][] = [];
    const watches: Array<{ id: string; push: boolean }> = [];
    const finishers: Array<() => void> = [];
    const games: GameRow[] = [
      game('g1', new Date('2026-10-19T23:05:00Z')),
      game('g2', new Date('2026-10-20T00:00:00Z')),
      game('g3', new Date('2026-10-19T23:05:00Z'), 'scheduled', 'extended_boxscore'),
    ];
    let failPoll = false;
    const sched = new Scheduler({
      db: {} as never,
      log,
      config,
      guard: {} as QuotaGuard,
      pulse: null,
      leagues: ['wnba'],
      isStopped: () => false,
      now: () => now,
      loadGames: async () => games,
      pollSchedule: async (_adapter, dates) => {
        if (failPoll) throw new Error('503');
        polls.push(dates);
      },
      watch: (_adapter, g, push) =>
        new Promise<void>((resolve) => {
          watches.push({ id: g.id, push });
          finishers.push(resolve);
        }),
    });
    await sched.tick();
    expect(polls).toEqual([['2026-10-19', '2026-10-20']]);
    expect(watches).toEqual([
      { id: 'g1', push: true },
      { id: 'g3', push: false }, // score-only coverage: REST only
    ]);
    expect(sched.running.size).toBe(2);
    // next tick: nothing new, no second poll (06:00 rule not met, last poll fresh), watches not restarted
    now = new Date('2026-10-19T23:30:00Z');
    await sched.tick();
    expect(polls).toHaveLength(1);
    expect(watches).toHaveLength(2);
    // an hour later inside the window: a poll is due; a failing poll is counted, not fatal
    now = new Date('2026-10-20T00:01:00Z');
    failPoll = true;
    await sched.tick();
    expect(sched.stats.schedulePollFailures).toBe(1);
    expect(watches.map((w) => w.id)).toEqual(['g1', 'g3', 'g2']); // g2 now within its lead
    // a failed poll is retried after pollRetryMs (5 min), not at tomorrow's 06:00
    expect(sched.nextPollAt.get('wnba')?.toISOString()).toBe('2026-10-20T00:06:00.000Z');
    now = new Date('2026-10-20T00:04:00Z');
    await sched.tick();
    expect(sched.stats.schedulePollFailures).toBe(1); // not yet due
    now = new Date('2026-10-20T00:06:30Z');
    failPoll = false;
    await sched.tick();
    expect(sched.stats.schedulePolls).toBe(2);
    expect(sched.nextPollAt.has('wnba')).toBe(false);
    for (const f of finishers) f();
    await new Promise((r) => setTimeout(r, 0));
    expect(sched.stats).toMatchObject({ ticks: 5, schedulePolls: 2, watchesStarted: 3 });
  });

  it('a failed watch is not restarted every tick: exponential retry window from 10 min', async () => {
    let now = new Date('2026-10-19T23:00:00Z');
    const starts: Date[] = [];
    const sched = new Scheduler({
      db: {} as never,
      log,
      config,
      guard: {} as QuotaGuard,
      pulse: null,
      leagues: ['wnba'],
      isStopped: () => false,
      now: () => now,
      loadGames: async () => [game('g1', new Date('2026-10-19T23:05:00Z'))],
      pollSchedule: async () => undefined,
      watch: async () => {
        starts.push(now);
        throw new Error('HTTP 503');
      },
    });
    await sched.tick();
    await new Promise((r) => setTimeout(r, 0));
    expect(sched.stats.watchesFailed).toBe(1);
    expect(sched.failedWatches.get('g1')?.nextAt.toISOString()).toBe('2026-10-19T23:10:00.000Z');
    now = new Date('2026-10-19T23:05:00Z');
    await sched.tick();
    expect(starts).toHaveLength(1); // inside the window: not restarted
    now = new Date('2026-10-19T23:11:00Z');
    await sched.tick();
    await new Promise((r) => setTimeout(r, 0));
    expect(starts).toHaveLength(2);
    expect(sched.failedWatches.get('g1')?.attempts).toBe(2);
    expect(sched.failedWatches.get('g1')?.nextAt.toISOString()).toBe('2026-10-19T23:31:00.000Z'); // 20 min
  });
});
