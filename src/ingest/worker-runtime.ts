import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { createSessionDb, type SessionDb, tryAcquireWorkerLock } from '../db/session-client.js';
import type { LeagueCode } from '../leagues/codes.js';
import { OutboxPublisher } from '../live/outbox-publisher.js';
import { PulseSender } from '../live/pulse.js';
import { DbScoreboardSource, ScoreboardSender } from '../live/scoreboard.js';
import { SupabaseBroadcastTransport } from '../live/supabase-broadcast.js';
import { type LiveTransport, MemoryTransport } from '../live/transport.js';
import type { Logger } from '../logger.js';
import { createFaultInjector, type FaultInjector } from './fault.js';
import { QuotaGuard } from './quota-guard.js';
import { type GameRange, loadSchedulerGames, Scheduler, type SchedulerStats } from './scheduler.js';
import type { GameRow } from './trial-mode.js';

/**
 * The worker's lifecycle (plan §4 "Worker lifecycle"), shared by `pnpm dev:worker`
 * (src/bin/worker.ts) and `pnpm demo run` (src/bin/demo.ts, rev 4.15): the
 * session-mode connection and the single-ingester advisory lock (waiting a
 * bounded time for a killed predecessor's lock), the Broadcast transport, the
 * outbox publisher drained on start and on NOTIFY / 30 s, the pulse and
 * scoreboard senders, and the cleanup of runs a dead lock holder left
 * `running` (and their sub-runs and reservations). `runScheduler` is the
 * production scheduler loop with its tail (final drain, senders stopped).
 * Exit codes stay the callers' business.
 */
export interface WorkerRuntime {
  db: Db;
  session: SessionDb;
  transport: LiveTransport;
  publisher: OutboxPublisher;
  pulse: PulseSender;
  scoreboard: ScoreboardSender;
  fault: FaultInjector;
  /** Root runs a previous lock holder left running, now aborted. */
  orphanedIds: number[];
}

export interface OpenRuntimeOptions {
  db: Db;
  config: Config;
  log: Logger;
  /** How long to wait for a lingering lock (a kill -9'd worker's session). */
  lockWaitMs: number;
  /** Start the league:{code}:scores sender (the scheduler always; a single watch only with --scores). */
  scores: boolean;
  /** The session connection dropped (not called while `closeSession` ends it on purpose). */
  onSessionLost: () => void;
}

/** Null when another worker holds the lock (the session is closed again; callers exit 2). */
export async function openWorkerRuntime(o: OpenRuntimeOptions): Promise<WorkerRuntime | null> {
  const { db, config, log } = o;
  let ending = false;
  const session = createSessionDb(config.db.sessionUrl, () => {
    if (!ending) o.onSessionLost();
  });
  // After a kill -9 the previous worker's session lock lingers until Postgres notices the dead
  // socket; wait for it (bounded) instead of failing the restart.
  const lockStarted = Date.now();
  let locked = await tryAcquireWorkerLock(session);
  while (!locked && Date.now() - lockStarted < o.lockWaitMs) {
    log.warn(
      { waitedMs: Date.now() - lockStarted },
      'another worker holds the ingester lock; retrying',
    );
    await new Promise((r) => setTimeout(r, 1000));
    locked = await tryAcquireWorkerLock(session);
  }
  if (!locked) {
    ending = true;
    log.error('another worker holds the ingester lock; exiting');
    await session.end({ timeout: 2 });
    return null;
  }
  log.info({ mode: config.mode, pid: process.pid, fault: config.fault }, 'worker lock acquired');
  // `pnpm dev:worker` runs pnpm -> tsx -> node; signals sent to the wrappers do not reach this
  // process. Crash tests must target this pid.
  process.stdout.write(`WORKER_PID=${process.pid}\n`);

  let transport: LiveTransport;
  if (config.supabase.serviceRoleKey) {
    transport = new SupabaseBroadcastTransport({
      url: config.supabase.url,
      serviceRoleKey: config.supabase.serviceRoleKey,
      log,
    });
  } else {
    log.warn(
      'SUPABASE_SERVICE_ROLE_KEY not set: broadcasts go to an in-memory transport (nobody receives them)',
    );
    transport = new MemoryTransport();
  }
  const fault = createFaultInjector(config.fault, undefined, (m) => log.warn(m));
  const publisher = new OutboxPublisher({ db, log, transport, fault });
  await publisher.start(session);
  log.info('outbox drained on startup');
  const pulse = new PulseSender({ db, transport, log });
  // league:{code}:scores (plan §5): 5 s-coalesced scoreboard deltas, straight to the transport.
  const scoreboard = new ScoreboardSender({ transport, log, source: new DbScoreboardSource(db) });
  if (o.scores) scoreboard.start();

  const orphanedIds = await abortOrphanedRuns(db, log);
  return { db, session, transport, publisher, pulse, scoreboard, fault, orphanedIds };
}

/**
 * Called by the new lock holder: any root run still marked running belongs to a worker that died
 * (kill -9 never reaches endRun); mark it, its sub-runs and its reservations aborted / released.
 * Returns the aborted root runs. A `pnpm demo verify-slot` replay (meta `verifySlot`) is not a
 * lock holder's run and is left alone.
 */
export async function abortOrphanedRuns(db: Db, log: Logger): Promise<number[]> {
  // This process holds the single-ingester lock, so any root run still marked running belongs
  // to a worker that died (kill -9 never reaches endRun). Close them before opening ours.
  const orphaned = await db<{ id: string }[]>`
    update ingest.ingestion_runs set status = 'aborted', ended_at = now(),
      error = coalesce(error, 'worker died; marked aborted by the next lock holder')
    where status = 'running' and kind in ('replay', 'watch_game')
      -- A \`pnpm demo verify-slot\` replay belongs to that CLI, not to a dead lock holder: it
      -- takes no lock, so a worker (re)start must not abort it (demo-verify.ts).
      and not (meta ? 'verifySlot')
    returning id::text`;
  const orphanedIds = orphaned.map((r) => Number(r.id));
  // Their push_stream / backfill sub-runs died with them (and any sub-run whose parent is no longer running).
  const orphanedSubRuns = await db<{ id: string }[]>`
    update ingest.ingestion_runs s set status = 'aborted', ended_at = now(),
      error = coalesce(s.error, 'parent watch run is not running; marked aborted by the next lock holder')
    where s.status = 'running' and s.parent_run_id is not null
      and not exists (select 1 from ingest.ingestion_runs p where p.id = s.parent_run_id and p.status = 'running')
    returning s.id::text`;
  if (orphanedSubRuns.length > 0)
    log.warn({ runs: orphanedSubRuns.map((r) => Number(r.id)) }, 'aborted orphaned sub-runs');
  if (orphanedIds.length > 0) {
    log.warn({ runs: orphanedIds }, 'aborted orphaned runs');
    // Their budget reservations never reached runTrialWatch's release (kill -9, host restart).
    const released = await db<{ id: string }[]>`
      update ingest.budget_reservations set released_at = now(),
        note = coalesce(note, '') || ' [released by the next lock holder: watch run died]'
      where run_id = any(${orphanedIds}) and released_at is null returning id::text`;
    if (released.length > 0)
      log.warn(
        { reservations: released.map((r) => Number(r.id)) },
        'released orphaned reservations',
      );
  }
  return orphanedIds;
}

export interface RunSchedulerOptions {
  config: Config;
  log: Logger;
  leagues: LeagueCode[];
  /** Rehearsal / demo time scale: the tick shortens to 60 s / speed on a rehearsal host. */
  speed: number;
  /**
   * Time scale passed to every watch's cadence (demo: the host's speed). Omitted = 1, which is
   * what `worker:rehearsal --schedule --speed N` has always done (only its tick is scaled).
   */
  watchSpeed?: number;
  isStopped: () => boolean;
  /** Receives the function that interrupts the between-tick sleep (a signal calls it). */
  onSleep: (wake: () => void) => void;
  /** Final drain bound and its (signal-shortened) deadline. */
  drainTimeoutMs: number;
  drainDeadline: () => number;
  /** The scheduler's clock (demo: the host's compressed clock). Default the wall clock. */
  now?: () => Date;
  /** Demo: only games labelled `replay` (the only games the demo host has documents for). */
  replayOnly?: boolean;
}

export interface SchedulerOutcome {
  stats: SchedulerStats;
  left: { pending: number; dead: number };
}

/**
 * The production scheduler (src/ingest/scheduler.ts) on a runtime, until `isStopped`, then the
 * tail: pulses stopped, final drain, publisher and scoreboard stopped. A scheduler that throws
 * propagates (the caller exits 1).
 */
export async function runScheduler(
  rt: WorkerRuntime,
  o: RunSchedulerOptions,
): Promise<SchedulerOutcome> {
  const db = rt.db;
  const log = o.log;
  const guard = new QuotaGuard({ db, log, overrides: o.config.quotaOverrides });
  const loadGames = o.replayOnly
    ? async (league: LeagueCode, range: GameRange): Promise<GameRow[]> =>
        loadSchedulerGames(db, league, range, { replayOnly: true })
    : undefined;
  const sched = new Scheduler({
    db,
    log,
    config: o.config,
    guard,
    pulse: rt.pulse,
    fault: rt.fault,
    leagues: o.leagues,
    isStopped: o.isStopped,
    // A signal interrupts the between-tick sleep so shutdown does not wait for the next tick.
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ms);
        o.onSleep(() => {
          clearTimeout(t);
          resolve();
        });
      }),
    ...(o.watchSpeed !== undefined ? { watchSpeed: o.watchSpeed } : {}),
    ...(o.now ? { now: o.now } : {}),
    ...(loadGames ? { loadGames } : {}),
    // A rehearsal ticks faster so the fake provider's compressed game is noticed in time.
    ...(o.config.rehearsal ? { tickMs: Math.max(1000, Math.round(60_000 / o.speed)) } : {}),
  });
  log.info(
    { leagues: o.leagues, mode: o.config.mode, rehearsal: o.config.rehearsal },
    'scheduler mode',
  );
  await sched.run();
  rt.pulse.stop();
  const left = await rt.publisher.drainUntilEmpty(o.drainTimeoutMs, { deadline: o.drainDeadline });
  rt.publisher.stop();
  rt.scoreboard.stop();
  return { stats: sched.stats, left };
}
