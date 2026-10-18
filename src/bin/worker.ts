import { parseArgs } from 'node:util';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { createDb } from '../db/client.js';
import { createSessionDb, tryAcquireWorkerLock } from '../db/session-client.js';
import { TRIAL_PROFILES, type TrialProfile } from '../ingest/cadence.js';
import { createFaultInjector } from '../ingest/fault.js';
import {
  GameWatcher,
  HttpDocumentSource,
  pollLoop,
  replayRecording,
} from '../ingest/game-watcher.js';
import { QuotaGuard, QuotaRefusedError } from '../ingest/quota-guard.js';
import { ReferenceIngester } from '../ingest/reference.js';
import { endRun, startRun } from '../ingest/runs.js';
import { assertSpeedAllowed, resolveGame, runTrialWatch } from '../ingest/trial-mode.js';
import { LeagueCodeSchema } from '../leagues/codes.js';
import { adapterFor } from '../leagues/registry.js';
import { OutboxPublisher } from '../live/outbox-publisher.js';
import { PulseSender } from '../live/pulse.js';
import { DbScoreboardSource, ScoreboardSender } from '../live/scoreboard.js';
import { SupabaseBroadcastTransport } from '../live/supabase-broadcast.js';
import { type LiveTransport, MemoryTransport } from '../live/transport.js';
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
    },
    strict: true,
  });
  const env = args.mode ? { ...process.env, MODE: args.mode } : process.env;
  const config = loadConfig(env);
  const log = createLogger({ level: config.logLevel });
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
  if (config.mode !== 'sim' && !args['replay-file'] && !trialWatch) {
    log.error(
      { mode: config.mode },
      `MODE=${config.mode} watches one planned game: --game <id> --profile <p> (pnpm trial watch); no automatic discovery`,
    );
    process.exit(64);
  }
  if (config.mode === 'sim' && !args.recording && !args['replay-file']) {
    log.error('one of --recording <id> or --replay-file <path> is required in MODE=sim');
    process.exit(64);
  }

  const db = createDb(config.db.url);
  let shuttingDown = false;
  let stopRequested = false;
  const shutdown = async (reason: string, code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ reason }, 'worker stopping');
    process.exit(code);
  };
  const session = createSessionDb(config.db.sessionUrl, () => {
    if (!shuttingDown) {
      log.error('session connection lost; stopping ingestion');
      void shutdown('session_connection_lost', 1);
    }
  });
  // After a kill -9 the previous worker's session lock lingers until Postgres notices the dead
  // socket; wait for it (bounded) instead of failing the restart.
  const lockStarted = Date.now();
  let locked = await tryAcquireWorkerLock(session);
  while (!locked && Date.now() - lockStarted < lockWaitMs) {
    log.warn(
      { waitedMs: Date.now() - lockStarted },
      'another worker holds the ingester lock; retrying',
    );
    await new Promise((r) => setTimeout(r, 1000));
    locked = await tryAcquireWorkerLock(session);
  }
  if (!locked) {
    shuttingDown = true;
    log.error('another worker holds the ingester lock; exiting');
    await session.end({ timeout: 2 });
    process.exit(2);
  }
  log.info({ mode: config.mode, pid: process.pid, fault: config.fault }, 'worker lock acquired');
  // `pnpm dev:worker` runs pnpm -> tsx -> node; signals sent to the wrappers do not reach this
  // process. Crash tests must target this pid.
  console.log(`WORKER_PID=${process.pid}`);

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
  // league:{code}:scores: 5 s-coalesced scoreboard deltas, straight to the transport (plan §5).
  const scoreboard = new ScoreboardSender({ transport, log, source: new DbScoreboardSource(db) });
  scoreboard.start();

  // This process holds the single-ingester lock, so any root run still marked running belongs
  // to a worker that died (kill -9 never reaches endRun). Close them before opening ours.
  const orphaned = await db<{ id: string }[]>`
    update ingest.ingestion_runs set status = 'aborted', ended_at = now(),
      error = coalesce(error, 'worker died; marked aborted by the next lock holder')
    where status = 'running' and kind in ('replay', 'watch_game') returning id::text`;
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
    try {
      const outcome = await runTrialWatch(
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
      pulse.stop();
      const left = await finalDrain();
      if (gameIdKnown) await pulse.sendOnce(gameIdKnown);
      publisher.stop();
      scoreboard.stop();
      await scoreboard.tick().catch(() => undefined);
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
          unpublished: left,
          stoppedBy,
        },
        'trial watch finished',
      );
      await exitAfterTail(left);
    } catch (err) {
      if (err instanceof QuotaRefusedError) {
        log.error({ product: err.product, reason: err.reason, status: err.status }, err.message);
        shuttingDown = true;
        await session.end({ timeout: 2 });
        await db.end({ timeout: 2 });
        process.exit(69);
      }
      log.error({ err }, 'trial watch failed');
      process.exit(1);
    }
    return;
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
    await scoreboard.tick().catch(() => undefined);
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
