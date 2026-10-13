import { parseArgs } from 'node:util';
import { loadConfig } from '../config.js';
import { createDb } from '../db/client.js';
import { createSessionDb, tryAcquireWorkerLock } from '../db/session-client.js';
import { createFaultInjector } from '../ingest/fault.js';
import {
  GameWatcher,
  HttpDocumentSource,
  pollLoop,
  replayRecording,
} from '../ingest/game-watcher.js';
import { endRun, startRun } from '../ingest/runs.js';
import { LeagueCodeSchema } from '../leagues/codes.js';
import { adapterFor } from '../leagues/wnba/adapter.js';
import { OutboxPublisher } from '../live/outbox-publisher.js';
import { PulseSender } from '../live/pulse.js';
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
 *   [--lock-wait 60]  seconds to wait for the single-ingester lock (a killed worker's lock lingers briefly)
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
    },
    strict: true,
  });
  const env = args.mode ? { ...process.env, MODE: args.mode } : process.env;
  const config = loadConfig(env);
  const log = createLogger({ level: config.logLevel });
  const league = LeagueCodeSchema.parse(args.league);
  const adapter = adapterFor(league);
  if (config.mode !== 'sim' && !args['replay-file']) {
    log.error({ mode: config.mode }, 'only MODE=sim (simulation recordings) is supported until M3');
    process.exit(64);
  }
  if (!args.recording && !args['replay-file']) {
    log.error('one of --recording <id> or --replay-file <path> is required');
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
  const lockWaitMs = Number(args['lock-wait']) * 1000;
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

  // Run + source.
  const untilClosed = args.until === 'closed';
  let runMeta: Record<string, unknown> = {};
  let sessionId: string | null = null;
  const sim = new SimulationClient({ playbackUrl: config.sportradar.playbackUrl });
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
        where kind = 'replay' and source = 'simulation' and status = 'running'
          and meta->>'recordingId' = ${args.recording}
        order by id desc limit 1`;
      if (prev?.sessionId) {
        sessionId = prev.sessionId;
        await endRun(
          db,
          Number(prev.id),
          'aborted',
          'worker restarted; session resumed by a new generation',
        );
        log.warn(
          { previousRun: prev.id },
          'resuming simulation session of a crashed run as a new generation',
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

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      stopRequested = true;
      void (async () => {
        await endRun(db, run.id, 'aborted', signal);
        await shutdown(signal);
      })();
    });
  }

  let finalStatus: string | null = null;
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
        pollIntervalMs: Number(args['poll-interval']),
        summaryEvery: Math.max(1, Number(args['summary-every'])),
        maxPolls: args['max-polls'] ? Number(args['max-polls']) : null,
        untilClosed,
        isStopped: () => stopRequested,
      });
    } else if (args['replay-file']) {
      finalStatus = await replayRecording(watcher, args['replay-file'], log, {
        paceMs: Number(args.pace),
        untilClosed,
        isStopped: () => stopRequested,
        maxDocs: args['max-docs'] ? Number(args['max-docs']) : null,
      });
    }
    if (watcher.gameId) await pulse.sendOnce(watcher.gameId);
    pulse.stop();
    const drained = await publisher.drain();
    publisher.stop();
    await endRun(db, run.id, 'ok');
    log.info(
      {
        runId: run.id,
        gameId: watcher.gameId,
        finalStatus,
        batches: watcher.batches,
        changes: watcher.applied,
        stale: watcher.stale,
        drained,
      },
      'replay finished',
    );
    if (untilClosed || args['max-polls'] || args['replay-file']) {
      shuttingDown = true;
      await session.end({ timeout: 2 });
      await db.end({ timeout: 2 });
      process.exit(0);
    }
    await new Promise<void>(() => {
      /* keep publishing until signalled */
    });
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
