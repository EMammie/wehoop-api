import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import type { LeagueAdapter } from '../leagues/adapter.js';
import type { LeagueCode } from '../leagues/codes.js';
import type { PulseSender } from '../live/pulse.js';
import type { Logger } from '../logger.js';
import { GameChangeSchema } from '../model/game-change.js';
import { SportradarHttp } from '../providers/sportradar/http.js';
import { rateLimiterFor } from '../providers/sportradar/rate-limiter.js';
import { createResolver } from '../providers/sportradar/resolver.js';
import { SeasonScheduleDocumentSchema } from '../providers/sportradar/schemas/schedule.js';
import {
  type Budget,
  budgetFor,
  type Cadence,
  cadenceFor,
  scaleCadence,
  type TrialProfile,
} from './cadence.js';
import type { FaultInjector } from './fault.js';
import { cadenceLoop, GameWatcher, HttpDocumentSource } from './game-watcher.js';
import type { QuotaGuard, Reservation } from './quota-guard.js';
import { ReferenceIngester } from './reference.js';
import { endRun, type RunSource, startRun } from './runs.js';
import type { ObservationSource } from './types.js';

/**
 * Trial mode (plan §4): no automatic discovery. The operator plans a date (one
 * schedule call), reserves a budget for one game under a profile, and watches
 * it through the ordinary watcher at the profile's cadence. Daily
 * `changes(date)` polling does not exist here at all.
 */

/** The provider season a calendar date falls in. NCAAWB seasons are named by their first year. */
export function seasonFor(
  league: LeagueCode,
  date: Date,
  override?: { year?: number; type?: string },
): { year: number; type: string } {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1;
  const year = override?.year ?? (league === 'ncaawb' ? (m >= 8 ? y : y - 1) : y);
  return { year, type: override?.type ?? 'REG' };
}

export interface PlannedGame {
  id: string;
  providerGameId: string;
  scheduledAt: Date;
  status: string;
  coverage: string;
  home: string | null;
  away: string | null;
  profile: TrialProfile;
  budget: Budget;
}

/** Games stored for a league on a UTC date, with the profile and budget each would take. */
export async function gamesOn(db: Db, league: LeagueCode, date: string): Promise<PlannedGame[]> {
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
           h.market || ' ' || h.name as home, a.market || ' ' || a.name as away
    from public.games g
    left join public.teams h on h.id = g.home_team_id
    left join public.teams a on a.id = g.away_team_id
    where g.league = ${league} and (g.scheduled_at at time zone 'utc')::date = ${date}::date
    order by g.scheduled_at, g.id`;
  return rows.map((r) => {
    const profile: TrialProfile = r.coverage === 'full' ? 'full' : 'extended';
    return {
      ...r,
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

/**
 * `pnpm trial plan --league ncaawb --date 2026-11-08`: exactly one schedule
 * call for the season containing the date, ingested as a generation-less
 * batch (ReferenceIngester), then the day's games from the database.
 */
export async function planDay(
  deps: PlanDeps,
  opts: { date: string; seasonYear?: number; seasonType?: string },
): Promise<{ games: PlannedGame[]; season: { year: number; type: string }; calls: number }> {
  const league = deps.adapter.league;
  const season = seasonFor(league, new Date(`${opts.date}T00:00:00Z`), {
    ...(opts.seasonYear !== undefined ? { year: opts.seasonYear } : {}),
    ...(opts.seasonType !== undefined ? { type: opts.seasonType } : {}),
  });
  const source: RunSource = deps.config.mode === 'sim' ? 'simulation' : deps.config.mode;
  if (source === 'simulation') {
    throw new Error(
      'trial plan needs MODE=trial or MODE=production: the simulation service has no schedule feed',
    );
  }
  const run = await startRun(deps.db, {
    kind: 'poll_schedule',
    league,
    gameId: null,
    source,
    meta: { trialPlan: true, date: opts.date, season },
  });
  const http = new SportradarHttp({
    db: deps.db,
    log: deps.log,
    league,
    product: deps.adapter.product,
    runId: run.id,
    resolver: createResolver(deps.config, league),
    limiter: rateLimiterFor(deps.adapter.product),
    guard: deps.guard,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  try {
    const doc = await http.getJson('schedule', SeasonScheduleDocumentSchema, {
      seasonYear: season.year,
      seasonType: season.type,
    });
    const ingester = new ReferenceIngester({
      db: deps.db,
      log: deps.log,
      league,
      source: 'rest',
      runSource: source,
      run,
    });
    const out = await ingester.process('schedule', JSON.parse(doc.rawText), doc.requestedAt);
    deps.log.info({ games: out.games, stale: out.stale, season }, 'schedule ingested');
    await endRun(deps.db, run.id, 'ok');
  } catch (err) {
    await endRun(deps.db, run.id, 'error', (err as Error).message);
    throw err;
  }
  return { games: await gamesOn(deps.db, league, opts.date), season, calls: http.calls };
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

/** The cadence and budget a game takes under a profile (defaulting the profile from coverage). */
export function planWatch(
  adapter: LeagueAdapter,
  source: RunSource,
  coverage: string | null,
  profile?: TrialProfile,
): WatchPlan {
  const chosen = profile ?? (coverage === 'full' ? 'full' : 'extended');
  // Trial profiles apply to every polled source; the simulation cadence is for `--recording`
  // replays without a profile (worker legacy path).
  const cadence = cadenceFor({
    source: source === 'simulation' || source === 'fixture' ? 'trial' : source,
    capabilities: adapter.capabilities,
    coverage,
    profile: chosen,
  });
  return { profile: chosen, cadence, budget: budgetFor(cadence) };
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
  const source: RunSource = config.mode === 'sim' ? 'simulation' : config.mode;
  const observationSource: ObservationSource = source === 'simulation' ? 'simulation' : 'rest';
  if (opts.game.status === 'closed') {
    throw new Error(`game ${opts.game.id} is already closed; nothing to watch`);
  }
  const plan = planWatch(adapter, source, opts.game.coverage, opts.profile);
  const speed = opts.speed ?? 1;
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
    resolver: createResolver(config, adapter.league, deps.sim),
    limiter: rateLimiterFor(adapter.product),
    guard: deps.guard,
    reservationId: reservation.id,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  const docs = new HttpDocumentSource(http, observationSource, null, {
    gameId: opts.game.providerGameId,
  });
  const watcher = new GameWatcher({
    db,
    log,
    adapter,
    run,
    apply: { db, log, ...(deps.fault ? { fault: deps.fault } : {}) },
    pulse: deps.pulse,
    ...(deps.onGameKnown ? { onGameKnown: deps.onGameKnown } : {}),
  });
  await watcher.attach(opts.game.id);
  let status: string | null = null;
  try {
    const out = await cadenceLoop(watcher, docs, log, cadence, {
      untilClosed: opts.untilClosed ?? true,
      isStopped: deps.isStopped,
    });
    status = out.status;
    await endRun(db, run.id, deps.isStopped() ? 'aborted' : 'ok');
  } catch (err) {
    await endRun(db, run.id, 'error', (err as Error).message);
    throw err;
  } finally {
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
  changes: number;
  /** receivedAt - event wallClock, for event changes carrying a wallClock (provider time -> subscriber). */
  wallClock: { n: number; medianMs: number | null; p95Ms: number | null };
  /** receivedAt - change.ts (applyChanges commit -> subscriber): the pipeline's own lag. */
  pipeline: { n: number; medianMs: number | null; p95Ms: number | null };
}

function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i] ?? null;
}

/** Lag statistics from `pnpm subscribe --record` lines (`{via, receivedAt, change}`). */
export function lagFromRecord(lines: string[]): LagStats {
  const wall: number[] = [];
  const pipe: number[] = [];
  let changes = 0;
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const parsed = JSON.parse(raw) as { via?: string; receivedAt?: string; change?: unknown };
    if (!parsed.receivedAt || parsed.via !== 'broadcast') continue;
    const change = GameChangeSchema.safeParse(parsed.change);
    if (!change.success) continue;
    changes++;
    const received = Date.parse(parsed.receivedAt);
    pipe.push(received - Date.parse(change.data.ts));
    const body = change.data.body as { wallClock?: string | null };
    if (
      (change.data.type === 'event_insert' || change.data.type === 'event_update') &&
      typeof body.wallClock === 'string'
    ) {
      wall.push(received - Date.parse(body.wallClock));
    }
  }
  wall.sort((a, b) => a - b);
  pipe.sort((a, b) => a - b);
  return {
    changes,
    wallClock: { n: wall.length, medianMs: quantile(wall, 0.5), p95Ms: quantile(wall, 0.95) },
    pipeline: { n: pipe.length, medianMs: quantile(pipe, 0.5), p95Ms: quantile(pipe, 0.95) },
  };
}
