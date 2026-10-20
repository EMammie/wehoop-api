import { type Config, SPORTRADAR_DEFAULT_BASE_URL } from '../config.js';
import type { Db } from '../db/client.js';
import type { LeagueAdapter } from '../leagues/adapter.js';
import type { LeagueCode } from '../leagues/codes.js';
import type { PulseSender } from '../live/pulse.js';
import type { Logger } from '../logger.js';
import { GameChangeSchema } from '../model/game-change.js';
import { SportradarHttp } from '../providers/sportradar/http.js';
import {
  PushStream,
  type PushStreamDeps,
  type PushStreamState,
} from '../providers/sportradar/push-client.js';
import { PgSlotStore, RateLimiter, rateLimiterFor } from '../providers/sportradar/rate-limiter.js';
import { createResolver } from '../providers/sportradar/resolver.js';
import {
  DailyScheduleDocumentSchema,
  SeasonScheduleDocumentSchema,
} from '../providers/sportradar/schemas/schedule.js';
import type {
  Feed,
  PushFeed,
  PushUrlResolver,
  ResolverSource,
  UrlResolver,
} from '../providers/sportradar/urls.js';
import { runBackfill } from './backfill.js';
import {
  type Budget,
  budgetFor,
  type Cadence,
  cadenceFor,
  PUSH_CONNECTION_ALLOWANCE,
  scaleCadence,
  type TrialProfile,
} from './cadence.js';
import type { FaultInjector } from './fault.js';
import {
  cadenceLoop,
  GameWatcher,
  HttpDocumentSource,
  type ProcessOutcome,
  type WatcherDeps,
} from './game-watcher.js';
import { PushIngest, type PushIngestStats } from './push-ingest.js';
import { needsRateLimit, type QuotaGuard, type Reservation } from './quota-guard.js';
import { ReferenceIngester } from './reference.js';
import { endRun, type RunHandle, type RunSource, setRunMeta, startRun } from './runs.js';
import { seasonFor } from './season.js';
import type { ObservationSource } from './types.js';

/**
 * Push mode: the newest pbp document of this generation that was APPLIED (outcome `applied`),
 * by its request time (database clock). A reconnect's backfill is skipped only when this is at or
 * after the reconnect; a fetched pbp whose document failed or was stale covers nothing.
 */
interface AppliedPbp {
  lastRequestedAt: Date | null;
}

function noteAppliedPbp(tracker: AppliedPbp, requestedAt: Date): void {
  if (tracker.lastRequestedAt === null || requestedAt > tracker.lastRequestedAt)
    tracker.lastRequestedAt = requestedAt;
}

/** The cadence watcher in push mode: records every applied pbp document for the backfill decision. */
class PbpTrackingWatcher extends GameWatcher {
  constructor(
    deps: WatcherDeps,
    private readonly tracker: AppliedPbp,
  ) {
    super(deps);
  }

  override async process(
    feed: Feed,
    body: unknown,
    observedAt: Date,
    source: ObservationSource,
  ): Promise<ProcessOutcome | null> {
    const out = await super.process(feed, body, observedAt, source);
    if (feed === 'pbp' && out?.result.outcome === 'applied')
      noteAppliedPbp(this.tracker, observedAt);
    return out;
  }
}

/**
 * Trial mode (plan §4): no automatic discovery. The operator plans a date (one
 * schedule call), reserves a budget for one game under a profile, and watches
 * it through the ordinary watcher at the profile's cadence. Daily
 * `changes(date)` polling does not exist here at all.
 */

/**
 * `--speed` compresses the cadence for a rehearsal against a local stand-in host; against the
 * real host it would burn a full-game reservation in minutes of a real game, and against the
 * simulation service (natural pace) it is meaningless. Refused anywhere but a rehearsal host.
 */
export function assertSpeedAllowed(config: Pick<Config, 'mode' | 'sportradar'>, speed: number) {
  if (speed === 1) return;
  if (!Number.isInteger(speed) || speed < 1) throw new Error('--speed must be an integer >= 1');
  if (config.mode === 'sim' || config.sportradar.baseUrl === SPORTRADAR_DEFAULT_BASE_URL) {
    throw new Error(
      `--speed ${speed} is only allowed against a rehearsal host (SPORTRADAR_BASE_URL on a loopback host, pnpm sim serve); against ${config.mode === 'sim' ? 'the simulation service' : 'api.sportradar.com'} the cadence must be real`,
    );
  }
}

/** The run/reservation source a resolver implies: trial, production, rehearsal (local stand-in), or simulation. */
export function runSourceOf(resolverSource: ResolverSource): RunSource {
  return resolverSource;
}

export { seasonFor } from './season.js';

export interface PlannedGame {
  id: string;
  providerGameId: string;
  scheduledAt: Date;
  status: string;
  coverage: string;
  /** What the client shows for this coverage (same mapping as `v_schedule.coverage_label`). */
  coverageLabel: string;
  home: string | null;
  away: string | null;
  profile: TrialProfile;
  budget: Budget;
}

/** `v_schedule.coverage_label` (plan §9): NCAAWB partial coverage is "score only". */
export function coverageLabel(coverage: string | null): string {
  if (coverage === 'full') return 'live plays';
  if (coverage === null || coverage === 'unknown') return 'unknown';
  return 'score only';
}

/** `gamesOn` filter: a UTC calendar date (season snapshot) or exactly the games a document listed. */
export type GamesFilter = string | { providerGameIds: string[] };

/**
 * Games stored for a league, with the profile and budget each would take: those scheduled on a
 * UTC date, or exactly the provider ids a daily document returned (its day boundary is the
 * provider's, likely the Eastern calendar day; a 7 pm ET tip is 00:00 UTC the next day).
 */
export async function gamesOn(
  db: Db,
  league: LeagueCode,
  filter: GamesFilter,
): Promise<PlannedGame[]> {
  const byDate = typeof filter === 'string';
  const rows = await db<
    {
      id: string;
      providerGameId: string;
      scheduledAt: Date;
      status: string;
      coverage: string;
      home: string | null;
      away: string | null;
    }[]
  >`
    select g.id, g.provider_game_id as "providerGameId", g.scheduled_at as "scheduledAt",
           g.status::text as status, g.coverage::text as coverage,
           coalesce(nullif(concat_ws(' ', h.market, h.name), ''), h.alias) as home,
           coalesce(nullif(concat_ws(' ', a.market, a.name), ''), a.alias) as away
    from public.games g
    left join public.teams h on h.id = g.home_team_id
    left join public.teams a on a.id = g.away_team_id
    where g.league = ${league}
      and ${
        byDate
          ? db`(g.scheduled_at at time zone 'utc')::date = ${filter}::date`
          : db`g.provider_game_id = any(${filter.providerGameIds})`
      }
    order by g.scheduled_at, g.id`;
  return rows.map((r) => {
    const profile: TrialProfile = r.coverage === 'full' ? 'full' : 'extended';
    return {
      ...r,
      coverageLabel: coverageLabel(r.coverage),
      profile,
      budget: budgetFor(cadenceFor({ ...PLAN_ARGS, coverage: r.coverage, profile })),
    };
  });
}

const PLAN_ARGS = {
  source: 'trial' as RunSource,
  capabilities: {
    pushClock: false,
    pushEvents: false,
    pushStats: false,
    coverageFor: () => ({ events: false, stats: 'none' as const }),
  },
};

export interface PlanDeps {
  db: Db;
  log: Logger;
  config: Config;
  adapter: LeagueAdapter;
  guard: QuotaGuard;
  fetchImpl?: typeof fetch;
}

export type PlanFeed = 'daily_schedule' | 'schedule';

/**
 * `pnpm trial plan --league ncaawb --date 2026-11-08`: exactly one call, by
 * default the **daily schedule** for that date (the day's games with coverage
 * as it stands; Sportradar may change coverage until tip-off and NCAAWB `full`
 * follows AP Top 25 teams, so game day is when the feed answers which games
 * are `full`), or with `season: true` the whole season schedule (a pre-season
 * snapshot, ~4.8 MB for NCAAWB). Ingested as a generation-less batch
 * (ReferenceIngester), then the day's games from the database.
 */
export async function planDay(
  deps: PlanDeps,
  opts: { date: string; seasonYear?: number; seasonType?: string; season?: boolean },
): Promise<{
  games: PlannedGame[];
  season: { year: number; type: string };
  calls: number;
  feed: PlanFeed;
  /** Games the document carried (ingested); the listing is exactly these for the daily feed. */
  ingested: number;
}> {
  const league = deps.adapter.league;
  const season = seasonFor(league, new Date(`${opts.date}T00:00:00Z`), {
    ...(opts.seasonYear !== undefined ? { year: opts.seasonYear } : {}),
    ...(opts.seasonType !== undefined ? { type: opts.seasonType } : {}),
  });
  if (deps.config.mode === 'sim') {
    throw new Error(
      'trial plan needs MODE=trial or MODE=production: the simulation service has no schedule feed',
    );
  }
  const resolver = createResolver(deps.config, league);
  const source = runSourceOf(resolver.source);
  const feed: PlanFeed = opts.season ? 'schedule' : 'daily_schedule';
  const run = await startRun(deps.db, {
    kind: 'poll_schedule',
    league,
    gameId: null,
    source,
    meta: { trialPlan: true, date: opts.date, season, feed },
  });
  const http = new SportradarHttp({
    db: deps.db,
    log: deps.log,
    league,
    product: deps.adapter.product,
    runId: run.id,
    resolver,
    // Slots are claimed from ingest.provider_rate_slots (rev 4.6): the watch this plan precedes
    // runs in another process and must not start inside this call's second.
    limiter: rateLimiterFor(deps.adapter.product, needsRateLimit(source) ? { db: deps.db } : {}),
    guard: deps.guard,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  let listed: GamesFilter = opts.date;
  let ingested = 0;
  try {
    const doc =
      feed === 'schedule'
        ? await http.getJson('schedule', SeasonScheduleDocumentSchema, {
            seasonYear: season.year,
            seasonType: season.type,
          })
        : await http.getJson('daily_schedule', DailyScheduleDocumentSchema, { date: opts.date });
    const ingester = new ReferenceIngester({
      db: deps.db,
      log: deps.log,
      league,
      source: 'rest',
      runSource: source,
      run,
    });
    const out = await ingester.process(feed, JSON.parse(doc.rawText), doc.requestedAt);
    ingested = out.games;
    // The daily feed decides what "that day" means (its boundary is unverified until the first live
    // call); list what it returned, not a UTC-date slice of the database.
    if (feed === 'daily_schedule') {
      listed = { providerGameIds: doc.data.games.map((g) => g.id) };
    }
    deps.log.info({ games: out.games, stale: out.stale, season, feed }, 'schedule ingested');
    await endRun(deps.db, run.id, 'ok');
  } catch (err) {
    await endRun(deps.db, run.id, 'error', (err as Error).message);
    throw err;
  }
  return {
    games: await gamesOn(deps.db, league, listed),
    season,
    calls: http.calls,
    feed,
    ingested,
  };
}

export interface GameRow {
  id: string;
  providerGameId: string;
  status: string;
  coverage: string;
  scheduledAt: Date;
}

/** `--game` accepts the games.id uuid or the provider game id. */
export async function resolveGame(
  db: Db,
  league: LeagueCode,
  ref: string,
): Promise<GameRow | null> {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref);
  const [row] = await db<GameRow[]>`
    select id, provider_game_id as "providerGameId", status::text as status, coverage::text as coverage,
           scheduled_at as "scheduledAt"
    from public.games
    where league = ${league}
      and (provider_game_id = ${ref} or (${isUuid} and id = ${isUuid ? ref : '00000000-0000-0000-0000-000000000000'}::uuid))
    order by (provider_game_id = ${ref}) desc
    limit 1`;
  return row ?? null;
}

export interface WatchPlan {
  profile: TrialProfile;
  cadence: Cadence;
  budget: Budget;
}

/**
 * The cadence and budget a game takes under a profile (defaulting the profile from coverage).
 * With `push` (M4, opt-in) the cadence is the 5-minute REST reconciliation and the budget
 * carries the stream connection allowance on top.
 */
export function planWatch(
  adapter: LeagueAdapter,
  source: RunSource,
  coverage: string | null,
  profile?: TrialProfile,
  push = false,
): WatchPlan {
  const chosen = profile ?? (coverage === 'full' ? 'full' : 'extended');
  // Trial profiles apply to every polled source; the simulation cadence is for `--recording`
  // replays without a profile (worker legacy path).
  const cadence = cadenceFor({
    source:
      source === 'simulation' || source === 'fixture' || source === 'rehearsal' ? 'trial' : source,
    capabilities: adapter.capabilities,
    coverage,
    profile: chosen,
    push,
  });
  const budget = budgetFor(cadence);
  return {
    profile: chosen,
    cadence,
    budget: push ? { ...budget, total: budget.total + PUSH_CONNECTION_ALLOWANCE } : budget,
  };
}

/**
 * Does a reconnect need a backfill? A REST pbp document covers everything up to its request time
 * and the stream everything after the reconnect, so only a 200 pbp call of this generation made
 * AT OR AFTER the reconnect moment covers the gap; anything earlier (even one fetched during the
 * outage) leaves the events between its request and the reconnect to the backfill. Pure, unit-tested.
 */
export function backfillNeeded(args: {
  lastPbpCalledAt: Date | null;
  /** null: the reconnect moment could not be read on the database clock; always backfill. */
  reconnectedAt: Date | null;
}): boolean {
  if (args.lastPbpCalledAt === null || args.reconnectedAt === null) return true;
  return args.lastPbpCalledAt.getTime() < args.reconnectedAt.getTime();
}

/** Push-mode knobs (tests compress the watchdog and the backoff; production uses the defaults). */
export interface PushWatchOptions {
  watchdogMs?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
}

export interface PushWatchOutcome {
  streams: PushStreamState[];
  ingest: PushIngestStats;
  backfills: number;
  /** Reconnects that needed no backfill: a pbp document of this generation was fetched at or after the reconnect. */
  backfillsSkipped: number;
  /** Connection attempts left of PUSH_CONNECTION_ALLOWANCE. */
  connectionBudgetLeft: number;
}

function hasPush(resolver: UrlResolver): resolver is UrlResolver & PushUrlResolver {
  return typeof (resolver as Partial<PushUrlResolver>).resolvePush === 'function';
}

export interface TrialWatchDeps {
  db: Db;
  log: Logger;
  config: Config;
  adapter: LeagueAdapter;
  guard: QuotaGuard;
  pulse: PulseSender | null;
  fault?: FaultInjector;
  onGameKnown?: (gameId: string) => void;
  isStopped: () => boolean;
  fetchImpl?: typeof fetch;
  /** Simulation session when MODE=sim (`--recording`): the trial flow against the simulation host. */
  sim?: { recordingId: string; sessionId: string };
}

export interface TrialWatchOptions {
  game: GameRow;
  profile?: TrialProfile;
  /** Rehearsal time scale against a fake provider; 1 for a live game. */
  speed?: number;
  note?: string | null;
  untilClosed?: boolean;
  /**
   * Opt-in push mode (M4): open the push events (and WNBA clock) streams as a push_stream
   * sub-run, reconcile with REST pbp every 5 minutes, backfill on every stream reconnect.
   * Default off: a trial watch polls exactly as before.
   */
  push?: boolean | PushWatchOptions;
}

export interface TrialWatchOutcome {
  runId: number;
  watchId: number | null;
  reservation: Reservation;
  budget: Budget;
  status: string | null;
  calls: number;
  refused: number;
  changes: number;
  stale: number;
  /** Present only in push mode. */
  push?: PushWatchOutcome;
}

/**
 * `pnpm trial watch --game <id> --profile full|extended|lean-full`: compute the
 * budget, reserve it (refused when `remaining - reserved < reserve`), open a
 * `watch_game` run bound to that reservation, and poll the game at the
 * profile's cadence through the ordinary GameWatcher (freshness, coverage gate
 * and clock_running derivation all happen inside applyChanges as usual). The
 * reservation is released when the watch ends.
 */
export async function runTrialWatch(
  deps: TrialWatchDeps,
  opts: TrialWatchOptions,
): Promise<TrialWatchOutcome> {
  const { adapter, config, db, log } = deps;
  const resolver = createResolver(config, adapter.league, deps.sim);
  const source = runSourceOf(resolver.source);
  const observationSource: ObservationSource = source === 'simulation' ? 'simulation' : 'rest';
  if (opts.game.status === 'closed') {
    throw new Error(`game ${opts.game.id} is already closed; nothing to watch`);
  }
  const pushOpts: PushWatchOptions | null =
    opts.push === undefined || opts.push === false ? null : opts.push === true ? {} : opts.push;
  if (pushOpts && !hasPush(resolver)) {
    throw new Error(
      'push mode needs a production-shaped host (trial, production or rehearsal); the simulation service has no push streams',
    );
  }
  const plan = planWatch(adapter, source, opts.game.coverage, opts.profile, pushOpts !== null);
  const speed = opts.speed ?? 1;
  assertSpeedAllowed(config, speed);
  const cadence = speed === 1 ? plan.cadence : scaleCadence(plan.cadence, speed);
  const reservation = await deps.guard.reserve({
    product: adapter.product,
    gameId: opts.game.id,
    profile: plan.profile,
    calls: plan.budget.total,
    source,
    note: opts.note ?? null,
  });
  const run = await startRun(db, {
    kind: 'watch_game',
    league: adapter.league,
    gameId: opts.game.id,
    source,
    meta: {
      trial: true,
      profile: plan.profile,
      budget: plan.budget,
      reservationId: reservation.id,
      speed,
      providerGameId: opts.game.providerGameId,
      push: pushOpts !== null,
      ...(deps.sim ? { recordingId: deps.sim.recordingId, sessionId: deps.sim.sessionId } : {}),
    },
  });
  await deps.guard.attachRun(reservation.id, run.id);
  log.info(
    {
      runId: run.id,
      watchId: run.watchId,
      gameId: opts.game.id,
      profile: plan.profile,
      budget: plan.budget,
      reservationId: reservation.id,
      coverage: opts.game.coverage,
      cadence,
      source,
    },
    'trial watch started',
  );
  const http = new SportradarHttp({
    db,
    log,
    league: adapter.league,
    product: adapter.product,
    runId: run.id,
    resolver,
    limiter: rateLimiterFor(adapter.product, needsRateLimit(source) ? { db } : {}),
    guard: deps.guard,
    reservationId: reservation.id,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  const docs = new HttpDocumentSource(http, observationSource, null, {
    gameId: opts.game.providerGameId,
  });
  const watcherDeps: WatcherDeps = {
    db,
    log,
    adapter,
    run,
    apply: { db, log, ...(deps.fault ? { fault: deps.fault } : {}) },
    pulse: deps.pulse,
    ...(deps.onGameKnown ? { onGameKnown: deps.onGameKnown } : {}),
  };
  const appliedPbp: AppliedPbp = { lastRequestedAt: null };
  // Push mode only: the tracking subclass; a polling watch keeps the plain GameWatcher.
  const watcher =
    pushOpts !== null
      ? new PbpTrackingWatcher(watcherDeps, appliedPbp)
      : new GameWatcher(watcherDeps);
  await watcher.attach(opts.game.id);
  let status: string | null = null;
  let pushOutcome: PushWatchOutcome | undefined;
  let push: Awaited<ReturnType<typeof openPushStreams>> | null = null;
  try {
    // Inside the try: a failure to open the streams must still end the run and release the budget.
    if (pushOpts !== null && hasPush(resolver)) {
      push = await openPushStreams({
        appliedPbp,
        db,
        log,
        adapter,
        run,
        game: opts.game,
        source,
        observationSource,
        resolver,
        guard: deps.guard,
        reservationId: reservation.id,
        apply: { db, log, ...(deps.fault ? { fault: deps.fault } : {}) },
        options: pushOpts,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      });
    }
    const out = await cadenceLoop(watcher, docs, log, cadence, {
      untilClosed: opts.untilClosed ?? true,
      isStopped: deps.isStopped,
    });
    status = out.status;
    if (push) pushOutcome = await push.close('ok');
    await endRun(db, run.id, deps.isStopped() ? 'aborted' : 'ok');
  } catch (err) {
    if (push) {
      try {
        pushOutcome = await push.close('error', (err as Error).message);
      } catch (closeErr) {
        log.error({ err: closeErr }, 'push streams did not close cleanly');
      }
    }
    await endRun(db, run.id, 'error', (err as Error).message);
    throw err;
  } finally {
    // This game's pulse timer ends with its watch (the scheduler watches many games); the caller
    // still sends the closing pulse (`sendOnce`) after its final drain.
    deps.pulse?.stop(opts.game.id);
    await deps.guard.release(reservation.id);
  }
  const final = (await deps.guard.reservation(reservation.id)) ?? reservation;
  log.info(
    {
      runId: run.id,
      reservationId: reservation.id,
      reserved: final.reservedCalls,
      used: final.usedCalls,
      refused: http.refused,
      status,
      changes: watcher.applied,
      stale: watcher.stale,
      push: pushOutcome ?? null,
    },
    'trial watch finished',
  );
  return {
    runId: run.id,
    watchId: run.watchId,
    reservation: final,
    budget: plan.budget,
    status,
    calls: http.calls,
    refused: http.refused,
    changes: watcher.applied,
    stale: watcher.stale,
    ...(pushOutcome ? { push: pushOutcome } : {}),
  };
}

interface OpenPushArgs {
  /** Newest applied pbp of this generation (cadence watcher + backfills), for the backfill decision. */
  appliedPbp: AppliedPbp;
  db: Db;
  log: Logger;
  adapter: LeagueAdapter;
  run: RunHandle;
  game: GameRow;
  source: RunSource;
  observationSource: ObservationSource;
  resolver: UrlResolver & PushUrlResolver;
  guard: QuotaGuard;
  reservationId: number;
  apply: Parameters<typeof runBackfill>[0]['apply'];
  options: PushWatchOptions;
  fetchImpl?: typeof fetch;
}

/**
 * Push mode wiring (plan §4): one push_stream sub-run of the watch generation,
 * a PushStream per feed the league offers (events; clock for WNBA), every line
 * routed through PushIngest -> applyChanges, and on every reconnect of the
 * EVENTS stream a backfill sub-run that fetches the full REST pbp (the clock
 * stream carries nothing a backfill could recover). Stream state is mirrored
 * into the sub-run's meta so `/health` (another process) can alert on a stream
 * disconnected for more than 60 s.
 */
async function openPushStreams(a: OpenPushArgs): Promise<{
  close(status: 'ok' | 'error' | 'aborted', error?: string): Promise<PushWatchOutcome>;
}> {
  const { db, log, adapter } = a;
  const ingest = new PushIngest({
    db,
    log,
    adapter,
    apply: a.apply,
    gameId: a.game.id,
    providerGameId: a.game.providerGameId,
    parentRun: a.run,
    source: a.source,
  });
  const subRun = await ingest.start();
  let backfills = 0;
  let backfillsSkipped = 0;
  const backfill = async (info: {
    connections: number;
    downMs: number;
    reconnectedAt: Date | null;
  }) => {
    // Only an APPLIED pbp document of this generation (REST reconciliation or an earlier backfill)
    // requested at or after the reconnect covers the gap; one requested during the outage still
    // leaves the events between its request and the reconnect missing, and a fetched document that
    // failed or was stale covers nothing. Both times are on the database clock (`requestedAt` is the
    // limiter slot, `reconnectedAt` the database now() at the reconnect). Only the events stream
    // carries this hook, so two streams reconnecting together cannot trigger two backfills.
    const lastApplied = a.appliedPbp.lastRequestedAt;
    const needed = backfillNeeded({
      lastPbpCalledAt: lastApplied,
      reconnectedAt: info.reconnectedAt,
    });
    if (!needed) {
      backfillsSkipped++;
      log.info(
        { ...info, gameId: a.game.id, lastAppliedPbpRequestedAt: lastApplied },
        'backfill skipped: an applied pbp document of this generation was requested at or after the reconnect',
      );
      return;
    }
    backfills++;
    const done = await runBackfill(
      {
        db,
        log,
        adapter,
        apply: a.apply,
        gameId: a.game.id,
        parentRun: a.run,
        source: a.source,
        observationSource: a.observationSource,
        makeSource: (r) =>
          new HttpDocumentSource(
            new SportradarHttp({
              db,
              log,
              league: adapter.league,
              product: adapter.product,
              runId: r.id,
              resolver: a.resolver,
              // A dedicated single-caller limiter on the same ledger: sharing the registry limiter
              // with the concurrently running cadence loop lets its in-process floor order the two
              // callers differently from the ledger, so one sends on the other's slot (a 429 with
              // correctly spaced recorded slots; validator M4 §2e, rate-limiter.ts is frozen).
              limiter: needsRateLimit(a.source)
                ? new RateLimiter({ store: new PgSlotStore(db), product: adapter.product })
                : rateLimiterFor(adapter.product),
              guard: a.guard,
              reservationId: a.reservationId,
              ...(a.fetchImpl ? { fetchImpl: a.fetchImpl } : {}),
            }),
            a.observationSource,
            null,
            { gameId: a.game.providerGameId },
          ),
      },
      'stream reconnect',
      info,
    );
    if (done.outcome?.result.outcome === 'applied')
      noteAppliedPbp(a.appliedPbp, done.pbpRequestedAt);
  };
  const feeds: PushFeed[] = [
    'push_events',
    ...(adapter.capabilities.pushClock ? ['push_clock' as const] : []),
  ];
  // PUSH_CONNECTION_ALLOWANCE is the cap for the whole watch: both streams draw on one budget and
  // stop for good when it is spent; the 5-minute REST cadence keeps the game moving.
  const attemptBudget = { remaining: PUSH_CONNECTION_ALLOWANCE };
  const states = new Map<PushFeed, PushStreamState>();
  let metaWrite: Promise<void> = Promise.resolve();
  const mirror = (state: PushStreamState) => {
    states.set(state.feed, state);
    const snapshot = Object.fromEntries(
      [...states.values()].map((s) => [
        s.feed,
        {
          status: s.status,
          connections: s.connections,
          reconnects: s.reconnects,
          disconnectedSince: s.disconnectedSince?.toISOString() ?? null,
          lastError: s.lastError,
          lastByteAt: s.lastByteAt?.toISOString() ?? null,
        },
      ]),
    );
    metaWrite = metaWrite
      .then(() => setRunMeta(db, subRun.id, { push: snapshot }))
      .catch((err) => log.warn({ err }, 'push state mirror failed'));
  };
  const streams: PushStream[] = feeds.map((feed) => {
    const deps: PushStreamDeps = {
      db,
      log,
      resolver: a.resolver,
      league: adapter.league,
      product: adapter.product,
      runId: subRun.id,
      reservationId: a.reservationId,
      limiter: rateLimiterFor(adapter.product, needsRateLimit(a.source) ? { db } : {}),
      guard: a.guard,
      feed,
      params: { providerGameId: a.game.providerGameId },
      onLine: (line, at) => ingest.handle(line, at).then(() => undefined),
      onStateChange: mirror,
      attemptBudget,
      ...(feed === 'push_events' ? { onReconnect: backfill } : {}),
      ...(a.options.watchdogMs !== undefined ? { watchdogMs: a.options.watchdogMs } : {}),
      ...(a.options.backoffMinMs !== undefined ? { backoffMinMs: a.options.backoffMinMs } : {}),
      ...(a.options.backoffMaxMs !== undefined ? { backoffMaxMs: a.options.backoffMaxMs } : {}),
      ...(a.fetchImpl ? { fetchImpl: a.fetchImpl } : {}),
    };
    return new PushStream(deps);
  });
  for (const s of streams) void s.start();
  log.info({ feeds, runId: subRun.id, watchId: subRun.watchId }, 'push streams opened');
  let closed: PushWatchOutcome | null = null;
  return {
    async close(status, error) {
      if (closed) return closed; // idempotent: an error path never ends the sub-run twice
      await Promise.all(streams.map((s) => s.stop()));
      await metaWrite;
      await ingest.end(status, error);
      closed = {
        streams: streams.map((s) => s.state),
        ingest: ingest.stats,
        backfills,
        backfillsSkipped,
        connectionBudgetLeft: attemptBudget.remaining,
      };
      return closed;
    },
  };
}

/* ---------------------------------------------------------------------- */
/* Held-profile impact (plan §7 M3, rev 4.5 checkpoint)                   */
/* ---------------------------------------------------------------------- */

export interface HeldProfileRow {
  holdId: string;
  league: string;
  reason: string;
  documentId: string | null;
  documentName: string | null;
  createdAt: Date;
  candidates: Array<{ id: string; fullName: string | null; mergedInto: string | null }>;
  /** Watched games (`games.watch_run_id` set) whose game_player_stats carry the document's own provider id. */
  documentInWatchedGames: string[];
  /** Watched games whose game_player_stats resolve to any candidate row. */
  candidatesInWatchedGames: string[];
}

export interface HeldProfileImpact {
  openHolds: number;
  affectedPlayers: number;
  inWatchedGame: number;
  rows: HeldProfileRow[];
}

/**
 * The open holds, the players they concern, and whether each appears in a
 * watched game's `game_player_stats`. The same SQL is in
 * test/integration/holds-impact.sql for `docker exec` evidence; a count of 0
 * is itself evidence, so the shape is returned even when there are no holds.
 */
export async function heldProfileImpact(db: Db): Promise<HeldProfileImpact> {
  const rows = await db<HeldProfileRow[]>`
    select h.id::text as "holdId", h.league::text as league, h.reason,
           h.trigger_document_id as "documentId",
           h.document->>'full_name' as "documentName",
           h.created_at as "createdAt",
           coalesce((select json_agg(json_build_object('id', p.id, 'fullName', p.full_name, 'mergedInto', p.merged_into) order by p.created_at)
                     from public.players p where p.id = any(h.candidate_ids)), '[]'::json) as candidates,
           coalesce((select array_agg(distinct s.game_id::text)
                     from public.game_player_stats s join public.games g on g.id = s.game_id
                     where g.watch_run_id is not null and g.league = h.league
                       and s.provider_player_id = h.trigger_document_id), '{}') as "documentInWatchedGames",
           coalesce((select array_agg(distinct s.game_id::text)
                     from public.game_player_stats s join public.games g on g.id = s.game_id
                     where g.watch_run_id is not null and s.player_id = any(h.candidate_ids)), '{}') as "candidatesInWatchedGames"
    from ingest.player_merge_holds h
    where h.status = 'open'
    order by h.created_at, h.id`;
  const players = new Set<string>();
  let inWatchedGame = 0;
  for (const r of rows) {
    players.add(`${r.league}:${r.documentId ?? r.holdId}`);
    for (const c of r.candidates) players.add(c.id);
    if (r.documentInWatchedGames.length > 0 || r.candidatesInWatchedGames.length > 0)
      inWatchedGame++;
  }
  return { openHolds: rows.length, affectedPlayers: players.size, inWatchedGame, rows };
}

/* ---------------------------------------------------------------------- */
/* Subscriber lag (plan §7 M3: "live changes reach subscriber with median  */
/* lag from wall_clock")                                                   */
/* ---------------------------------------------------------------------- */

export interface LagStats {
  /** Changes delivered by broadcast (live delivery). */
  changes: number;
  /**
   * receivedAt - event wallClock, for `event_insert` changes carrying a wallClock (provider time ->
   * subscriber, first report of a play). An `event_update` of an old play measures how late the
   * provider corrected it, not delivery, so it is left out.
   */
  wallClock: { n: number; medianMs: number | null; p95Ms: number | null };
  /**
   * receivedAt - the event's provider revision (`updated`, play_events.provider_updated_at), for
   * feeds without wall_clock (NCAAWB pbp carries none). Needs the game's play_events (`--game`).
   * Only the stored (current) revision is known, so each event is measured once, on its LAST
   * delivered change, when that change came by broadcast (`notBroadcast` counts the others);
   * `excluded` counts events whose stored revision is later than that receipt (re-stamped after
   * delivery), which would otherwise read as negative lag. `n` therefore covers only events not
   * re-stamped after delivery; a provider that re-stamps every event at finalization leaves n ~ 0.
   */
  providerUpdated: {
    n: number;
    medianMs: number | null;
    p95Ms: number | null;
    excluded: number;
    /** Events whose last change arrived by catch-up (measured on live delivery only). */
    notBroadcast: number;
  };
  /** receivedAt - change.ts (applyChanges commit -> subscriber): the pipeline's own lag. */
  pipeline: { n: number; medianMs: number | null; p95Ms: number | null };
  /** receivedAt - change.ts for changes the subscriber got by catch-up (/changes), not broadcast. */
  catchUp: { n: number; medianMs: number | null; p95Ms: number | null };
}

function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i] ?? null;
}

/** The provider revision time of each play event (`pnpm trial lag --game`), for feeds without wall_clock. */
export async function providerRevisions(db: Db, gameId: string): Promise<Map<string, string>> {
  const rows = await db<{ providerEventId: string; updatedAt: Date | null }[]>`
    select provider_event_id as "providerEventId", provider_updated_at as "updatedAt"
    from public.play_events where game_id = ${gameId}`;
  const out = new Map<string, string>();
  for (const r of rows) if (r.updatedAt) out.set(r.providerEventId, r.updatedAt.toISOString());
  return out;
}

/**
 * Lag statistics from `pnpm subscribe --record` lines (`{via, receivedAt, change}`).
 * `revisions` (provider event id -> `updated` ISO) enables the provider-revision lag.
 */
export function lagFromRecord(lines: string[], revisions?: Map<string, string>): LagStats {
  const wall: number[] = [];
  const pipe: number[] = [];
  const caught: number[] = [];
  /** Per provider event, the receipt of its last delivered event change (by seq, any path). */
  const lastReceipt = new Map<string, { seq: number; received: number; broadcast: boolean }>();
  let changes = 0;
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const parsed = JSON.parse(raw) as { via?: string; receivedAt?: string; change?: unknown };
    if (!parsed.receivedAt) continue;
    const change = GameChangeSchema.safeParse(parsed.change);
    if (!change.success) continue;
    const received = Date.parse(parsed.receivedAt);
    const c = change.data;
    if (parsed.via === 'catch-up') caught.push(received - Date.parse(c.ts));
    if ((c.type === 'event_insert' || c.type === 'event_update') && c.providerEventId) {
      const prev = lastReceipt.get(c.providerEventId);
      if (!prev || c.seq > prev.seq) {
        lastReceipt.set(c.providerEventId, {
          seq: c.seq,
          received,
          broadcast: parsed.via === 'broadcast',
        });
      }
    }
    if (parsed.via !== 'broadcast') continue;
    changes++;
    pipe.push(received - Date.parse(c.ts));
    const body = c.body as { wallClock?: string | null };
    if (c.type === 'event_insert' && typeof body.wallClock === 'string') {
      wall.push(received - Date.parse(body.wallClock));
    }
  }
  const revised: number[] = [];
  let excluded = 0;
  let notBroadcast = 0;
  for (const [providerEventId, { received, broadcast }] of lastReceipt) {
    const updated = revisions?.get(providerEventId);
    if (!updated) continue;
    if (!broadcast) {
      notBroadcast++;
      continue;
    }
    const lag = received - Date.parse(updated);
    if (lag < 0) excluded++;
    else revised.push(lag);
  }
  for (const xs of [wall, revised, pipe, caught]) xs.sort((a, b) => a - b);
  const stats = (xs: number[]) => ({
    n: xs.length,
    medianMs: quantile(xs, 0.5),
    p95Ms: quantile(xs, 0.95),
  });
  return {
    changes,
    wallClock: stats(wall),
    providerUpdated: { ...stats(revised), excluded, notBroadcast },
    pipeline: stats(pipe),
    catchUp: stats(caught),
  };
}
