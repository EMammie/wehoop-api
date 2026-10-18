import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import type { LeagueAdapter } from '../leagues/adapter.js';
import type { LeagueCode } from '../leagues/codes.js';
import { adapterFor } from '../leagues/registry.js';
import type { PulseSender } from '../live/pulse.js';
import type { Logger } from '../logger.js';
import type { GameStatus } from '../model/live-event.js';
import { SportradarHttp } from '../providers/sportradar/http.js';
import { rateLimiterFor } from '../providers/sportradar/rate-limiter.js';
import { createResolver } from '../providers/sportradar/resolver.js';
import { DailyScheduleDocumentSchema } from '../providers/sportradar/schemas/schedule.js';
import { coverageIsFull } from './cadence.js';
import type { FaultInjector } from './fault.js';
import { phaseOf } from './freshness.js';
import { needsRateLimit, type QuotaGuard, QuotaRefusedError } from './quota-guard.js';
import { ReferenceIngester } from './reference.js';
import { endRun, startRun } from './runs.js';
import { type GameRow, runSourceOf, runTrialWatch } from './trial-mode.js';

/**
 * Production scheduler (plan §4 "Production/simulation scheduler"), the
 * minimal slice the deploy needs: the worker idles holding the lock while
 * the publisher drains the outbox, polls the daily schedule for today and
 * tomorrow per league with a key (06:00 Eastern, then hourly while a game of
 * that league is inside its window), and starts a coverage-aware watch for
 * every game near tip-off (`runTrialWatch`, push mode where the league offers
 * push events and the game has play-by-play coverage). Several watches run at
 * once; each is the ordinary watch generation with its own reservation.
 *
 * Deliberately NOT here yet: `changes(date)` every 30 min (no daily change
 * log feed, schema or fixture exists in the repo; see the M4 handoff), and any
 * trial-mode automation: in MODE=trial the worker still watches exactly the
 * one game the operator planned (plan §4 "Trial mode": no automatic discovery).
 */
export const SCHEDULER_TZ = 'America/New_York';
export const SCHEDULE_POLL_HOUR = 6;

export interface SchedulerOptions {
  /** How often the loop wakes to decide (default 60 s). */
  tickMs?: number;
  /** Start a watch this long before tip-off (default 10 min). */
  watchLeadMs?: number;
  /** A game is inside its window from this long before tip-off ... (default 30 min) */
  windowBeforeMs?: number;
  /** ... to this long after (default 4 h); hourly schedule polls happen inside windows. */
  windowAfterMs?: number;
  /** Never start a watch on a game whose tip-off is older than this (default 6 h). */
  maxLateStartMs?: number;
  /** A failed watch is retried after this, doubling per failure (default 10 min, capped at 6 h). */
  watchRetryMs?: number;
  /** A failed schedule poll is retried after this (default 5 min). */
  pollRetryMs?: number;
}

export interface SchedulerDeps extends SchedulerOptions {
  db: Db;
  log: Logger;
  config: Config;
  guard: QuotaGuard;
  pulse: PulseSender | null;
  fault?: FaultInjector;
  /** Leagues to schedule (those with a key). */
  leagues: LeagueCode[];
  isStopped: () => boolean;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Injection points for tests; the defaults talk to the database and the provider. */
  loadGames?: (league: LeagueCode, from: Date, to: Date) => Promise<GameRow[]>;
  pollSchedule?: (adapter: LeagueAdapter, dates: string[]) => Promise<void>;
  watch?: (adapter: LeagueAdapter, game: GameRow, push: boolean) => Promise<void>;
  fetchImpl?: typeof fetch;
}

export interface SchedulerStats {
  ticks: number;
  schedulePolls: number;
  schedulePollFailures: number;
  watchesStarted: number;
  watchesFinished: number;
  watchesFailed: number;
}

/** `YYYY-MM-DD` of `d` in the scheduler time zone. */
export function localDate(d: Date, timeZone = SCHEDULER_TZ): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Hour of day (0-23) of `d` in the scheduler time zone. */
export function localHour(d: Date, timeZone = SCHEDULER_TZ): number {
  const h = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hour12: false }).format(
    d,
  );
  return Number(h) % 24;
}

/** The two calendar dates a schedule poll covers: today and tomorrow in the scheduler time zone. */
export function scheduleDates(now: Date, timeZone = SCHEDULER_TZ): string[] {
  return [localDate(now, timeZone), localDate(new Date(now.getTime() + 86_400_000), timeZone)];
}

/**
 * Poll the schedule when: never polled; it is the 06:00 hour and the last poll
 * was before today's 06:00 hour; or a game of the league is inside its window
 * and the last poll is an hour old.
 */
export function shouldPollSchedule(
  now: Date,
  lastPoll: Date | null,
  inGameWindow: boolean,
  timeZone = SCHEDULER_TZ,
): boolean {
  if (lastPoll === null) return true;
  if (
    localHour(now, timeZone) === SCHEDULE_POLL_HOUR &&
    (localDate(lastPoll, timeZone) !== localDate(now, timeZone) ||
      localHour(lastPoll, timeZone) < SCHEDULE_POLL_HOUR)
  )
    return true;
  return inGameWindow && now.getTime() - lastPoll.getTime() >= 3_600_000;
}

const isPost = (status: string) => phaseOf(status as GameStatus) === 'post';

/** Any game inside [tip-off - before, tip-off + after] that is not finished. */
export function inGameWindow(
  games: GameRow[],
  now: Date,
  opts: { windowBeforeMs: number; windowAfterMs: number },
): boolean {
  return games.some(
    (g) =>
      !isPost(g.status) &&
      g.scheduledAt.getTime() - opts.windowBeforeMs <= now.getTime() &&
      now.getTime() <= g.scheduledAt.getTime() + opts.windowAfterMs,
  );
}

/** Games to start watching now: tip-off within the lead, not too late, not finished, not already watched. */
export function gamesToWatch(
  games: GameRow[],
  now: Date,
  running: ReadonlySet<string>,
  opts: { watchLeadMs: number; maxLateStartMs: number },
): GameRow[] {
  return games.filter(
    (g) =>
      !running.has(g.id) &&
      !isPost(g.status) &&
      g.scheduledAt.getTime() <= now.getTime() + opts.watchLeadMs &&
      g.scheduledAt.getTime() >= now.getTime() - opts.maxLateStartMs,
  );
}

export class Scheduler {
  readonly stats: SchedulerStats = {
    ticks: 0,
    schedulePolls: 0,
    schedulePollFailures: 0,
    watchesStarted: 0,
    watchesFinished: 0,
    watchesFailed: 0,
  };
  readonly running = new Map<string, Promise<void>>();
  readonly lastSchedulePoll = new Map<LeagueCode, Date>();
  /** After a failed poll: when to try again (independent of the 06:00 / hourly rules). */
  readonly nextPollAt = new Map<LeagueCode, Date>();
  /** Games whose watch failed: attempts so far and when the next attempt may start. */
  readonly failedWatches = new Map<string, { attempts: number; nextAt: Date }>();
  private readonly opts: Required<SchedulerOptions>;

  constructor(private readonly deps: SchedulerDeps) {
    this.opts = {
      tickMs: deps.tickMs ?? 60_000,
      watchLeadMs: deps.watchLeadMs ?? 10 * 60_000,
      windowBeforeMs: deps.windowBeforeMs ?? 30 * 60_000,
      windowAfterMs: deps.windowAfterMs ?? 4 * 3_600_000,
      maxLateStartMs: deps.maxLateStartMs ?? 6 * 3_600_000,
      watchRetryMs: deps.watchRetryMs ?? 10 * 60_000,
      pollRetryMs: deps.pollRetryMs ?? 5 * 60_000,
    };
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  /** One scheduling pass for every league. */
  async tick(): Promise<void> {
    this.stats.ticks++;
    const now = this.now();
    for (const league of this.deps.leagues) {
      if (this.deps.isStopped()) return;
      const adapter = adapterFor(league);
      const from = new Date(now.getTime() - this.opts.maxLateStartMs);
      const to = new Date(now.getTime() + 2 * 86_400_000);
      let games = await this.loadGames(league, from, to);
      const window = inGameWindow(games, now, this.opts);
      const retryAt = this.nextPollAt.get(league);
      const due = retryAt
        ? now.getTime() >= retryAt.getTime()
        : shouldPollSchedule(now, this.lastSchedulePoll.get(league) ?? null, window);
      if (due) {
        const dates = scheduleDates(now);
        try {
          await (this.deps.pollSchedule ?? this.defaultPollSchedule.bind(this))(adapter, dates);
          this.stats.schedulePolls++;
          this.lastSchedulePoll.set(league, now);
          this.nextPollAt.delete(league);
          games = await this.loadGames(league, from, to);
        } catch (err) {
          this.stats.schedulePollFailures++;
          // A refusal (quota) or a provider error: retry in pollRetryMs, never crash the loop, and
          // never wait for tomorrow's 06:00 because of one failure.
          this.nextPollAt.set(league, new Date(now.getTime() + this.opts.pollRetryMs));
          this.deps.log.error({ err, league, dates }, 'schedule poll failed');
        }
      }
      const blocked = new Set(this.running.keys());
      for (const [gameId, f] of this.failedWatches) {
        if (now.getTime() < f.nextAt.getTime()) blocked.add(gameId);
      }
      for (const game of gamesToWatch(games, now, blocked, this.opts)) {
        this.startWatch(adapter, game);
      }
    }
  }

  private startWatch(adapter: LeagueAdapter, game: GameRow): void {
    const push = adapter.capabilities.pushEvents && coverageIsFull(game.coverage);
    this.stats.watchesStarted++;
    this.deps.log.info(
      {
        gameId: game.id,
        providerGameId: game.providerGameId,
        league: adapter.league,
        coverage: game.coverage,
        push,
        scheduledAt: game.scheduledAt,
      },
      'scheduler: starting watch',
    );
    const p = (this.deps.watch ?? this.defaultWatch.bind(this))(adapter, game, push)
      .then(() => {
        this.stats.watchesFinished++;
        this.failedWatches.delete(game.id);
      })
      .catch((err) => {
        this.stats.watchesFailed++;
        // Exponential retry window (>= watchRetryMs, doubling, capped at 6 h): a quota refusal,
        // a 5xx or "already closed" must not open a new generation and reservation every tick.
        const prev = this.failedWatches.get(game.id);
        const attempts = (prev?.attempts ?? 0) + 1;
        const wait = Math.min(6 * 3_600_000, this.opts.watchRetryMs * 2 ** (attempts - 1));
        this.failedWatches.set(game.id, {
          attempts,
          nextAt: new Date(this.now().getTime() + wait),
        });
        if (err instanceof QuotaRefusedError)
          this.deps.log.error(
            { gameId: game.id, product: err.product, reason: err.reason },
            err.message,
          );
        else this.deps.log.error({ err, gameId: game.id }, 'scheduler: watch failed');
      })
      .finally(() => {
        this.running.delete(game.id);
      });
    this.running.set(game.id, p);
  }

  /** Loop until stopped, then wait for the running watches (they stop at their next tick via isStopped). */
  async run(): Promise<void> {
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    this.deps.log.info({ leagues: this.deps.leagues, ...this.opts }, 'scheduler started');
    while (!this.deps.isStopped()) {
      try {
        await this.tick();
      } catch (err) {
        this.deps.log.error({ err }, 'scheduler tick failed');
      }
      if (this.deps.isStopped()) break;
      await sleep(this.opts.tickMs);
    }
    await Promise.allSettled([...this.running.values()]);
    this.deps.log.info({ stats: this.stats }, 'scheduler stopped');
  }

  private async loadGames(league: LeagueCode, from: Date, to: Date): Promise<GameRow[]> {
    if (this.deps.loadGames) return this.deps.loadGames(league, from, to);
    return this.deps.db<GameRow[]>`
      select id, provider_game_id as "providerGameId", status::text as status, coverage::text as coverage,
             scheduled_at as "scheduledAt"
      from public.games
      where league = ${league} and scheduled_at between ${from} and ${to}
      order by scheduled_at, id`;
  }

  /** One `poll_schedule` run: the daily schedule for each date, ingested generation-less. */
  private async defaultPollSchedule(adapter: LeagueAdapter, dates: string[]): Promise<void> {
    const { db, log, config, guard } = this.deps;
    const resolver = createResolver(config, adapter.league);
    const source = runSourceOf(resolver.source);
    const run = await startRun(db, {
      kind: 'poll_schedule',
      league: adapter.league,
      gameId: null,
      source,
      meta: { scheduler: true, dates },
    });
    const http = new SportradarHttp({
      db,
      log,
      league: adapter.league,
      product: adapter.product,
      runId: run.id,
      resolver,
      limiter: rateLimiterFor(adapter.product, needsRateLimit(source) ? { db } : {}),
      guard,
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
    });
    const ingester = new ReferenceIngester({
      db,
      log,
      league: adapter.league,
      source: 'rest',
      runSource: source,
      run,
    });
    try {
      for (const date of dates) {
        const doc = await http.getJson('daily_schedule', DailyScheduleDocumentSchema, { date });
        const out = await ingester.process(
          'daily_schedule',
          JSON.parse(doc.rawText),
          doc.requestedAt,
        );
        log.info(
          { league: adapter.league, date, games: out.games, stale: out.stale },
          'scheduler: daily schedule ingested',
        );
      }
      await endRun(db, run.id, 'ok');
    } catch (err) {
      await endRun(db, run.id, 'error', (err as Error).message);
      throw err;
    }
  }

  private async defaultWatch(adapter: LeagueAdapter, game: GameRow, push: boolean): Promise<void> {
    const { db, log, config, guard, pulse } = this.deps;
    try {
      await runTrialWatch(
        {
          db,
          log,
          config,
          adapter,
          guard,
          pulse,
          ...(this.deps.fault ? { fault: this.deps.fault } : {}),
          isStopped: this.deps.isStopped,
          ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
        },
        { game, push, untilClosed: true, note: 'scheduler' },
      );
    } finally {
      // The closing pulse (plan §4: once when the game closes); the per-game timer ended with the watch.
      await pulse?.sendOnce(game.id);
    }
  }
}
