import { parseArgs } from 'node:util';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { createDb } from '../db/client.js';
import { TRIAL_PROFILES, type TrialProfile } from '../ingest/cadence.js';
import { assertEnvironment, EnvironmentRefusedError } from '../ingest/environment.js';
import {
  GameWatcher,
  HttpDocumentSource,
  pollLoop,
  replayRecording,
} from '../ingest/game-watcher.js';
import { QuotaGuard, QuotaRefusedError } from '../ingest/quota-guard.js';
import { ReferenceIngester } from '../ingest/reference.js';
import { endRun, startRun } from '../ingest/runs.js';
import {
  assertSpeedAllowed,
  resolveGame,
  runTrialWatch,
  type TrialWatchOutcome,
} from '../ingest/trial-mode.js';
import { openWorkerRuntime, runScheduler } from '../ingest/worker-runtime.js';
import { LeagueCodeSchema } from '../leagues/codes.js';
import { adapterFor } from '../leagues/registry.js';
import { createLogger } from '../logger.js';
import { SportradarHttp } from '../providers/sportradar/http.js';
import { SimulationClient } from '../providers/sportradar/simulation.js';
import { SimulationUrlResolver } from '../providers/sportradar/urls.js';

/**
 * Ingestion worker.
 *   pnpm dev:worker --mode sim --league wnba --recording <id> [--until closed]
 *     [--session <id> | --new-session] [--poll-interval 3000] [--summary-every 10]
 *     [--max-polls N] [--record-to <file.jsonl>]
 *   pnpm dev:worker --mode sim --league wnba --replay-file <file.jsonl> [--pace 0]
 *   pnpm dev:worker --mode trial --league ncaawb --game <uuid|providerId> --profile full|extended|lean-full
 *     [--speed N] [--note "..."] [--push]   (what `pnpm trial watch` runs: budget reservation + cadence loop;
 *                                            --push (M4, opt-in) opens the push streams and reconciles by REST
 *                                            every 5 min; needs a production-shaped host, never the simulation service)
 *   pnpm dev:worker --mode sim --league ncaawb --game <id> --profile full --recording <id>
 *                                           (the same trial flow against the simulation host; never counted)
 *   pnpm dev:worker --mode production          (no --game: the production scheduler, src/ingest/scheduler.ts:
 *                                            idle holding the lock, drain the outbox, poll the daily schedule
 *                                            per league with a key, start coverage-aware watches near tip-off)
 *   pnpm worker:rehearsal --schedule --speed N  (the same scheduler against the fake provider; MODE=trial needs
 *                                            the explicit flag and a loopback host, never the real one)
 *   [--scores]        publish league:{code}:scores every 5 s (always on with the scheduler; off for a single watch)
 *   [--lock-wait 60]  seconds to wait for the single-ingester lock (a killed worker's lock lingers briefly)
 *   [--drain-timeout 60]  seconds the final drain may wait for backing-off outbox rows before exiting
 *
 * Numeric flags must be integers (`--pace` >= 0, all others > 0); anything else
 * is a usage error (exit 64). SIGINT/SIGTERM stop the loop after the in-flight
 * document and run the normal tail (final drain, closing pulse); a SECOND signal
 * during the final drain shortens its remaining window to 3 s.
 *
 * Exit codes: 0 ok; 75 (EX_TEMPFAIL) replay finished but unpublished non-dead
 * outbox rows remain after the final drain (a restart publishes them); 64 usage;
 * 2 lock held elsewhere; 1 error.
 *
 * Holds the single-ingester advisory lock on a session-mode connection, drains
 * the outbox on start and on NOTIFY/30 s, sends pulses, and exits when the
 * game closes (`--until closed`, default). Restarting with the same arguments
 * is a new watch generation; the simulation session is resumed from the
 * crashed run's metadata so the replay continues where the recording is.
 */
async function main() {
  const { values: args } = parseArgs({
    options: {
      mode: { type: 'string' },
      league: { type: 'string', default: 'wnba' },
      recording: { type: 'string' },
      session: { type: 'string' },
      'new-session': { type: 'boolean', default: false },
      until: { type: 'string', default: 'closed' },
      'poll-interval': { type: 'string', default: '3000' },
      'summary-every': { type: 'string', default: '10' },
      'max-polls': { type: 'string' },
      'record-to': { type: 'string' },
      'replay-file': { type: 'string' },
      pace: { type: 'string', default: '0' },
      'max-docs': { type: 'string' },
      'lock-wait': { type: 'string', default: '60' },
      'drain-timeout': { type: 'string', default: '60' },
      game: { type: 'string' },
      profile: { type: 'string' },
      speed: { type: 'string' },
      note: { type: 'string' },
      push: { type: 'boolean', default: false },
      schedule: { type: 'boolean', default: false },
      scores: { type: 'boolean', default: false },
    },
    strict: true,
  });
  const env = args.mode ? { ...process.env, MODE: args.mode } : process.env;
  const config = loadConfig(env);
  const log = createLogger({ level: config.logLevel });
  if (config.mode === 'demo') {
    // The demo worker runs inside `pnpm demo run`, next to the host it is locked to.
    log.error(
      'MODE=demo runs through `pnpm demo run` (the demo host + this scheduler, one process)',
    );
    process.exit(64);
  }
  /** Integer flags; `min` 0 for --pace, 1 otherwise. Usage error (64) on anything else. */
  const intArg = (name: string, value: string | undefined, min: number): number | null => {
    if (value === undefined) return null;
    const parsed = z.coerce.number().int().min(min).safeParse(value);
    if (!parsed.success) {
      log.error({ flag: `--${name}`, value }, `--${name} must be an integer >= ${min}`);
      process.exit(64);
    }
    return parsed.data;
  };
  const pollIntervalMs = intArg('poll-interval', args['poll-interval'], 1) ?? 3000;
  const summaryEvery = intArg('summary-every', args['summary-every'], 1) ?? 10;
  const maxPolls = intArg('max-polls', args['max-polls'], 1);
  const paceMs = intArg('pace', args.pace, 0) ?? 0;
  const maxDocs = intArg('max-docs', args['max-docs'], 1);
  const lockWaitMs = (intArg('lock-wait', args['lock-wait'], 1) ?? 60) * 1000;
  const drainTimeoutMs = (intArg('drain-timeout', args['drain-timeout'], 1) ?? 60) * 1000;
  const league = LeagueCodeSchema.parse(args.league);
  const adapter = adapterFor(league);
  const speed = intArg('speed', args.speed, 1) ?? 1;
  try {
    assertSpeedAllowed(config, speed);
  } catch (err) {
    log.error({ speed }, (err as Error).message);
    process.exit(64);
  }
  const profile = args.profile as TrialProfile | undefined;
  if (profile && !(TRIAL_PROFILES as readonly string[]).includes(profile)) {
    log.error({ profile }, `--profile must be one of ${TRIAL_PROFILES.join('|')}`);
    process.exit(64);
  }
  const trialWatch = args.game !== undefined;
  if (args.push && (!trialWatch || config.mode === 'sim')) {
    log.error(
      { mode: config.mode },
      '--push needs a planned game (--game) against a production-shaped host (MODE=trial|production, or a rehearsal host); the simulation service has no push streams',
    );
    process.exit(64);
  }
  // The scheduler (plan §4) is the production default; in trial mode it exists only for a
  // rehearsal against a loopback host (`--schedule`), never against api.sportradar.com: a trial
  // key watches exactly the one game the operator planned.
  const scheduler =
    !trialWatch &&
    !args['replay-file'] &&
    !args.recording &&
    (config.mode === 'production' ||
      (args.schedule && config.mode === 'trial' && config.rehearsal));
  if (args.schedule && !scheduler) {
    log.error(
      { mode: config.mode, rehearsal: config.rehearsal },
      '--schedule runs the production scheduler: MODE=production, or MODE=trial against a loopback rehearsal host; not with --game / --replay-file / --recording',
    );
    process.exit(64);
  }
  if (config.mode !== 'sim' && !args['replay-file'] && !trialWatch && !scheduler) {
    log.error(
      { mode: config.mode },
      `MODE=${config.mode} watches one planned game: --game <id> --profile <p> (pnpm trial watch); no automatic discovery (the scheduler runs in MODE=production, or with --schedule on a rehearsal host)`,
    );
    process.exit(64);
  }
  if (config.mode === 'sim' && !args.recording && !args['replay-file']) {
    log.error('one of --recording <id> or --replay-file <path> is required in MODE=sim');
    process.exit(64);
  }

  const db = createDb(config.db.url);
  // Rev 4.15 (4): a production worker never ingests into a database marked demo.
  try {
    await assertEnvironment(db, config);
  } catch (err) {
    if (!(err instanceof EnvironmentRefusedError)) throw err;
    log.error(err.message);
    await db.end({ timeout: 2 });
    process.exit(65);
  }
  let shuttingDown = false;
  let stopRequested = false;
  /**
   * Set once a trial watch has failed: the exit code the process owes (69 quota refusal, 1
   * otherwise). A session loss during the error tail exits with it instead of a plain 1.
   */
  let watchExitCode: number | null = null;
  const shutdown = async (reason: string, code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ reason }, 'worker stopping');
    process.exit(code);
  };
  // Lock, transport, publisher (drained on start), pulse and scoreboard senders, orphan cleanup:
  // the same lifecycle `pnpm demo run` uses (src/ingest/worker-runtime.ts). The scoreboard runs
  // only with the scheduler (production) or `--scores`: a single-game trial watch keeps its
  // behaviour and does not query public.games every 5 s.
  const rt = await openWorkerRuntime({
    db,
    config,
    log,
    lockWaitMs,
    scores: scheduler || args.scores,
    onSessionLost: () => {
      if (!shuttingDown) {
        log.error('session connection lost; stopping ingestion');
        void shutdown('session_connection_lost', watchExitCode ?? 1);
      }
    },
  });
  if (!rt) {
    shuttingDown = true;
    process.exit(2);
  }
  const { session, publisher, pulse, scoreboard, fault, orphanedIds } = rt;
  // Run + source.
  const untilClosed = args.until === 'closed';
  let runMeta: Record<string, unknown> = {};
  let sessionId: string | null = null;
  const sim = new SimulationClient({ playbackUrl: config.sportradar.playbackUrl });
  if (args.recording && config.mode !== 'sim') {
    log.error({ mode: config.mode }, '--recording is only meaningful in MODE=sim');
    process.exit(64);
  }
  if (args.recording) {
    const rec = await sim.getRecording(args.recording);
    if (!rec) {
      log.error({ recording: args.recording }, 'recording not found');
      process.exit(66);
    }
    sessionId = args.session ?? null;
    if (!sessionId && !args['new-session']) {
      const [prev] = await db<{ id: string; sessionId: string | null }[]>`
        select id::text, meta->>'sessionId' as "sessionId" from ingest.ingestion_runs
        where kind = 'replay' and source = 'simulation' and id = any(${orphanedIds})
          and meta->>'recordingId' = ${args.recording}
        order by id desc limit 1`;
      if (prev?.sessionId) {
        sessionId = prev.sessionId;
        log.warn(
          { previousRun: Number(prev.id) },
          'resuming the simulation session of the crashed run as a new generation',
        );
      }
    }
    if (!sessionId) sessionId = await sim.createSession(args.recording);
    runMeta = {
      recordingId: args.recording,
      sessionId,
      title: rec.title,
      providerGameId: rec.meta?.gameId,
    };
  } else {
    runMeta = { replayFile: args['replay-file'] };
  }
  // A signal stops the loop; the normal tail (final drain, closing pulse, run end) still runs.
  // A second signal shortens whatever remains of the final drain window to 3 s.
  let stoppedBy: string | null = null;
  let wakeIdle: (() => void) | null = null;
  let drainDeadline = Number.POSITIVE_INFINITY;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (stoppedBy) {
        drainDeadline = Math.min(drainDeadline, Date.now() + 3_000);
        log.warn({ signal }, 'second signal; final drain window shortened to 3 s');
        return;
      }
      stopRequested = true;
      stoppedBy = signal;
      log.warn({ signal }, 'stop requested; finishing the in-flight document, then draining');
      wakeIdle?.();
    });
  }
  const finalDrain = () =>
    publisher.drainUntilEmpty(drainTimeoutMs, { deadline: () => drainDeadline });
  const exitAfterTail = async (left: { pending: number; dead: number }) => {
    shuttingDown = true;
    await session.end({ timeout: 2 });
    await db.end({ timeout: 2 });
    if (left.pending > 0) {
      log.error(
        { pending: left.pending, dead: left.dead, drainTimeoutMs },
        'exiting with unpublished outbox rows (EX_TEMPFAIL 75); a restart publishes them',
      );
      process.exit(75);
    }
    process.exit(0);
  };

  if (scheduler) {
    const leagues = (['wnba', 'ncaawb', 'unrivaled'] as const).filter(
      (l) => config.sportradar.keys[l] !== undefined,
    );
    let outcome: Awaited<ReturnType<typeof runScheduler>>;
    try {
      outcome = await runScheduler(rt, {
        config,
        log,
        leagues: [...leagues],
        speed,
        isStopped: () => stopRequested,
        onSleep: (wake) => {
          wakeIdle = wake;
        },
        drainTimeoutMs,
        drainDeadline: () => drainDeadline,
      });
    } catch (err) {
      log.error({ err }, 'scheduler failed');
      process.exit(1);
    }
    log.info({ stats: outcome.stats, unpublished: outcome.left, stoppedBy }, 'scheduler finished');
    await exitAfterTail(outcome.left);
    return;
  }

  if (trialWatch) {
    // Trial / production watch of ONE planned game (plan §4 "Trial mode"): the game row comes
    // from `pnpm trial plan`; the budget is reserved before the first call; calls are
    // rate-limited, quota-guarded and counted (never in MODE=sim).
    const guard = new QuotaGuard({ db, log, overrides: config.quotaOverrides });
    const game = await resolveGame(db, league, args.game ?? '');
    if (!game) {
      log.error({ game: args.game, league }, 'game not found; run `pnpm trial plan` first');
      process.exit(66);
    }
    let gameIdKnown: string | null = null;
    let outcome: TrialWatchOutcome | null = null;
    let failure: unknown = null;
    // Only runTrialWatch's own errors take the error path; each path runs its tail once.
    try {
      outcome = await runTrialWatch(
        {
          db,
          log,
          config,
          adapter,
          guard,
          pulse,
          fault,
          isStopped: () => stopRequested,
          onGameKnown: (gameId) => {
            gameIdKnown = gameId;
            console.log(`GAME_ID=${gameId}`);
          },
          ...(sessionId && args.recording
            ? { sim: { recordingId: args.recording, sessionId } }
            : {}),
        },
        {
          game,
          ...(profile ? { profile } : {}),
          speed,
          note: args.note ?? null,
          untilClosed,
          push: args.push,
        },
      );
    } catch (err) {
      failure = err;
    }
    if (outcome) {
      pulse.stop();
      const left = await finalDrain();
      if (gameIdKnown) await pulse.sendOnce(gameIdKnown);
      publisher.stop();
      scoreboard.stop();
      if (scheduler || args.scores) await scoreboard.tick().catch(() => undefined);
      log.info(
        {
          runId: outcome.runId,
          gameId: game.id,
          reservationId: outcome.reservation.id,
          reserved: outcome.reservation.reservedCalls,
          used: outcome.reservation.usedCalls,
          refused: outcome.refused,
          finalStatus: outcome.status,
          changes: outcome.changes,
          stale: outcome.stale,
          push: outcome.push ?? null,
          retries: outcome.retries,
          unpublished: left,
          stoppedBy,
        },
        'trial watch finished',
      );
      await exitAfterTail(left);
      return;
    }
    const code = failure instanceof QuotaRefusedError ? 69 : 1;
    watchExitCode = code;
    if (failure instanceof QuotaRefusedError) {
      log.error(
        { product: failure.product, reason: failure.reason, status: failure.status },
        failure.message,
      );
    } else {
      log.error({ err: failure }, 'trial watch failed');
    }
    // The changes already committed still reach subscribers: the same tail as a clean end (final
    // drain, then the closing pulse and the last scoreboard tick), best effort, and the exit code
    // stays the watch's own. runTrialWatch has already closed any push streams and stopped this
    // game's pulse timer before it threw.
    try {
      pulse.stop();
      const left = await finalDrain();
      if (gameIdKnown) await pulse.sendOnce(gameIdKnown);
      publisher.stop();
      scoreboard.stop();
      if (scheduler || args.scores) await scoreboard.tick().catch(() => undefined);
      if (left.pending > 0) {
        log.error(
          { pending: left.pending, dead: left.dead, drainTimeoutMs },
          'exiting with unpublished outbox rows; a restart publishes them',
        );
      }
    } catch (tailErr) {
      log.error({ err: tailErr }, 'final drain after a failed watch failed');
    }
    shuttingDown = true;
    await session.end({ timeout: 2 }).catch(() => undefined);
    await db.end({ timeout: 2 }).catch(() => undefined);
    process.exit(code);
  }

  const run = await startRun(db, {
    kind: 'replay',
    league,
    gameId: null,
    source: args.recording ? 'simulation' : 'fixture',
    meta: runMeta,
  });
  log.info(
    {
      runId: run.id,
      watchId: run.watchId,
      recording: args.recording ?? null,
      replayFile: args['replay-file'] ?? null,
    },
    'replay run started',
  );

  const watcher = new GameWatcher({
    db,
    log,
    adapter,
    run,
    apply: { db, log, fault },
    pulse,
    onGameKnown: (gameId) => {
      // The subscriber and the validator need this id; print it plainly.
      console.log(`GAME_ID=${gameId}`);
    },
  });

  let finalStatus: string | null = null;
  let replayedDocs: number | null = null;
  try {
    if (args.recording && sessionId) {
      const http = new SportradarHttp({
        db,
        log,
        league,
        runId: run.id,
        resolver: new SimulationUrlResolver({
          playbackUrl: config.sportradar.playbackUrl,
          league,
          recordingId: args.recording,
          sessionId,
        }),
      });
      const source = new HttpDocumentSource(http, 'simulation', args['record-to'] ?? null);
      finalStatus = await pollLoop(watcher, source, log, {
        pollIntervalMs,
        summaryEvery,
        maxPolls,
        untilClosed,
        isStopped: () => stopRequested,
      });
    } else if (args['replay-file']) {
      const replay = await replayRecording(watcher, args['replay-file'], log, {
        paceMs,
        isStopped: () => stopRequested,
        maxDocs,
        reference: new ReferenceIngester({
          db,
          log,
          league,
          source: 'fixture',
          runSource: 'fixture',
        }),
      });
      finalStatus = replay.status;
      replayedDocs = replay.docs;
    }
    pulse.stop();
    // Final drain (bounded), then the closing pulse so its latestSeq is published state.
    const left = await finalDrain();
    if (watcher.gameId) await pulse.sendOnce(watcher.gameId);
    publisher.stop();
    scoreboard.stop();
    if (scheduler || args.scores) await scoreboard.tick().catch(() => undefined);
    await endRun(db, run.id, stoppedBy ? 'aborted' : 'ok', stoppedBy ?? undefined);
    log.info(
      {
        runId: run.id,
        gameId: watcher.gameId,
        finalStatus,
        docs: replayedDocs,
        batches: watcher.batches,
        changes: watcher.applied,
        stale: watcher.stale,
        unpublished: left,
        stoppedBy,
      },
      'replay finished',
    );
    if (untilClosed || args['max-polls'] || args['replay-file'] || stoppedBy) {
      await exitAfterTail(left);
    }
    await new Promise<void>((resolve) => {
      wakeIdle = resolve; // keep publishing until signalled
    });
    const rest = await finalDrain();
    publisher.stop();
    scoreboard.stop();
    shuttingDown = true;
    await session.end({ timeout: 2 });
    await db.end({ timeout: 2 });
    process.exit(rest.pending > 0 ? 75 : 0);
  } catch (err) {
    log.error({ err }, 'replay failed');
    await endRun(db, run.id, 'error', (err as Error).message);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
