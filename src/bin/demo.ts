import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { isDevStackUrl, loadConfig } from '../config.js';
import { createDb } from '../db/client.js';
import { demoInit } from '../ingest/demo-init.js';
import { purgeReplayGames } from '../ingest/demo-purge.js';
import { assertEnvironment, EnvironmentRefusedError } from '../ingest/environment.js';
import { parseClosedBefore } from '../ingest/retention.js';
import { openWorkerRuntime, runScheduler } from '../ingest/worker-runtime.js';
import { type LeagueCode, LeagueCodeSchema } from '../leagues/codes.js';
import { createLogger } from '../logger.js';
import {
  DEFAULT_INTERVAL_MS,
  demoClock,
  epochFor,
  loadRecording,
  PgProvenanceStore,
  parseSlotId,
  rotationFor,
  SLOT_ORIGIN_MS,
  slotAt,
  slotRecording,
  startDemoHost,
} from '../providers/sportradar/demo-host.js';
import { lockDestination } from '../providers/sportradar/destination-guard.js';

/**
 * The demo environment (plan rev 4.15, M5 B4). Every subcommand runs with MODE=demo: no
 * Sportradar key (refused if one is set), provider requests locked to the in-process host.
 *
 *   pnpm demo run [--interval 180] [--include-synthetic] [--league wnba]... [--port 8790]
 *                 [--speed N [--epoch ISO]] [--lock-wait 60] [--drain-timeout 60]
 *     One process: the demo host (demo-host.ts) on 127.0.0.1:<port> serving the rotation (one
 *     replay every --interval minutes, today and tomorrow, US Eastern), and the production
 *     scheduler against it (single-ingester lock, outbox drain, pulses, league:*:scores, push
 *     with backfill for WNBA), the same lifecycle as `pnpm dev:worker` (worker-runtime.ts).
 *     Real time by default; --speed compresses the host's and the scheduler's clock around
 *     --epoch (default: now, printed as DEMO_EPOCH=...; a restart must pass the same value).
 *     Only on the dev stack or a database marked demo.
 *   pnpm demo init
 *     Mark an empty (or already demo) database `demo`, write the synthetic product limits, load
 *     the reference fixtures (demo-init.ts). Exit 65 when refused.
 *   pnpm demo purge --older-than 7d | --all [--dry-run]
 *     Delete closed replay games quiet for that long with every dependent row (demo-purge.ts).
 *     Demo databases and the dev stack only.
 *   pnpm demo epoch --speed N [--lead 12] [--league wnba]
 *     Print the --epoch that puts a compressed clock --lead demo minutes before the next slot
 *     (the restart rehearsal starts there; every process of it must use the same value).
 *   pnpm demo export-slot --slot <replay id | ISO tip-off> [--league wnba] [--game-id <id>]
 *                         [--interval 180] [--include-synthetic] --out <file.jsonl>
 *     DB-free: write the slot's shifted documents as a recording (requestedAt = when the host
 *     serves them), for a polling-only comparison replay (`pnpm dev:worker --replay-file`).
 *
 * SPORTRADAR_BASE_URL defaults to http://127.0.0.1:<port>; when set it must be that host.
 * Exit codes: 0 ok; 1 error; 2 lock held; 64 usage; 65 refused database / configuration;
 * 75 unpublished outbox rows left after the final drain.
 */
async function main() {
  const { values: args, positionals } = parseArgs({
    options: {
      interval: { type: 'string' },
      'include-synthetic': { type: 'boolean', default: false },
      league: { type: 'string', multiple: true },
      port: { type: 'string', default: '8790' },
      speed: { type: 'string' },
      epoch: { type: 'string' },
      'lock-wait': { type: 'string', default: '60' },
      'drain-timeout': { type: 'string', default: '60' },
      'older-than': { type: 'string' },
      all: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      slot: { type: 'string' },
      'game-id': { type: 'string' },
      out: { type: 'string' },
      lead: { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  });
  const cmd = positionals[0];
  const usage = (message: string): never => {
    console.error(`demo: ${message}`);
    process.exit(64);
  };
  const intArg = (name: string, value: string | undefined, min: number): number | null => {
    if (value === undefined) return null;
    const parsed = z.coerce.number().int().min(min).safeParse(value);
    if (!parsed.success) usage(`--${name} must be an integer >= ${min}`);
    return parsed.data ?? null;
  };
  const port = intArg('port', args.port, 1) ?? 8790;
  const intervalMs =
    (intArg('interval', args.interval, 1) ?? DEFAULT_INTERVAL_MS / 60_000) * 60_000;
  const leagues: LeagueCode[] | undefined = args.league?.map((l) => LeagueCodeSchema.parse(l));
  const rotation = rotationFor({
    includeSynthetic: args['include-synthetic'],
    ...(leagues ? { leagues } : {}),
  });

  if (cmd === 'export-slot') {
    if (!args.slot || !args.out) usage('export-slot needs --slot <id|ISO> and --out <file.jsonl>');
    const slotArg = args.slot ?? '';
    let slot = parseSlotId(slotArg, rotation, intervalMs);
    if (!slot) {
      const t = Date.parse(slotArg);
      const k = (t - SLOT_ORIGIN_MS) / intervalMs;
      if (Number.isNaN(t) || !Number.isInteger(k))
        usage(`--slot ${slotArg} is neither a slot id of this rotation nor a tip-off on its grid`);
      slot = slotAt(k, rotation, intervalMs);
    }
    const rec = await loadRecording(slot.entry);
    const lines = slotRecording(rec, slot, args['game-id'] ?? slot.providerGameId);
    await writeFile(
      args.out ?? '',
      lines
        .map((l) => JSON.stringify(l))
        .join('\n')
        .concat('\n'),
    );
    console.log(
      `export-slot: ${slot.providerGameId} (${slot.entry.league}, tip-off ${new Date(slot.tipOffMs).toISOString()}, shift ${slot.tipOffMs - rec.recordedTipOffMs} ms) -> ${args.out} (${lines.length} documents${args['game-id'] ? `, game id ${args['game-id']}` : ''})`,
    );
    return;
  }
  if (cmd === 'epoch') {
    // Rehearsal helper: the --epoch at which a compressed clock reads `--lead` demo minutes before
    // the next slot of the rotation (pass the printed value to every `demo run` of the rehearsal).
    const speed = intArg('speed', args.speed, 2) ?? usage('epoch needs --speed N (N >= 2)');
    const leadMin = intArg('lead', args.lead, 0) ?? 12;
    const now = Date.now();
    const k = Math.floor((now - SLOT_ORIGIN_MS) / intervalMs) + 1;
    const slot = slotAt(k, rotation, intervalMs);
    const epoch = epochFor(slot.tipOffMs - leadMin * 60_000, now, speed);
    console.log(`DEMO_EPOCH=${new Date(epoch).toISOString()}`);
    console.log(
      `next slot ${slot.providerGameId} (${slot.entry.league}) tips off at ${new Date(slot.tipOffMs).toISOString()} demo time, ${leadMin} demo min after this moment at --speed ${speed}`,
    );
    return;
  }
  if (cmd !== 'run' && cmd !== 'init' && cmd !== 'purge') {
    usage('usage: pnpm demo run|init|purge|epoch|export-slot (see src/bin/demo.ts)');
  }

  // `pnpm demo` is demo mode by definition, whatever MODE the shell exported (.env says sim).
  const env: Record<string, string | undefined> = {
    ...process.env,
    MODE: 'demo',
    SPORTRADAR_BASE_URL: process.env.SPORTRADAR_BASE_URL || `http://127.0.0.1:${port}`,
  };
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(env);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(65);
  }
  const log = createLogger({ level: config.logLevel });
  if (new URL(config.sportradar.baseUrl).port !== String(port)) {
    log.error(
      { baseUrl: config.sportradar.baseUrl, port },
      'SPORTRADAR_BASE_URL must be the demo host this process starts (http://127.0.0.1:<--port>)',
    );
    process.exit(65);
  }
  // Before any client exists: every provider request of this process goes to the demo host.
  lockDestination(config.sportradar.baseUrl);
  const db = createDb(config.db.url);

  if (cmd === 'init') {
    try {
      const out = await demoInit(db, log, leagues ? { leagues } : {});
      for (const q of out.quotas)
        console.log(
          `quota   ${q.product.padEnd(10)} limit ${q.limit30d} reserve ${q.reserve} verified ${q.verified} (DEMO, never counted)`,
        );
      for (const r of out.references)
        console.log(`loaded  ${r.league.padEnd(10)} ${r.feed.padEnd(19)} ${r.file}`);
      for (const s of out.skipped)
        console.log(`skipped ${s.league.padEnd(10)} ${s.file}  (${s.reason})`);
      console.log(`demo init: database marked demo, ${out.references.length} reference documents`);
    } catch (err) {
      if (!(err instanceof EnvironmentRefusedError)) throw err;
      console.error(`demo init refused: ${err.message}`);
      await db.end({ timeout: 2 });
      process.exit(65);
    }
    await db.end({ timeout: 2 });
    return;
  }

  try {
    await assertEnvironment(db, config);
  } catch (err) {
    if (!(err instanceof EnvironmentRefusedError)) throw err;
    log.error(err.message);
    await db.end({ timeout: 2 });
    process.exit(65);
  }

  if (cmd === 'purge') {
    if (!args.all && !args['older-than']) usage('purge needs --older-than <7d|ISO> or --all');
    const olderThan = args.all ? null : parseClosedBefore(args['older-than'] ?? '');
    const out = await purgeReplayGames(db, log, { olderThan, dryRun: args['dry-run'] });
    const verb = out.dryRun ? 'would purge' : 'purged';
    for (const g of out.purged) {
      const parts = Object.entries(g.deleted)
        .map(([t, n]) => `${t} ${n}`)
        .join(', ');
      console.log(`${verb} ${g.providerGameId} (${g.gameId}): ${parts}`);
    }
    for (const s of out.skipped)
      console.log(`skipped ${s.providerGameId} (${s.gameId}): ${s.reason}`);
    console.log(
      `demo purge${out.dryRun ? ' --dry-run' : ''}: ${out.candidates} closed replay game(s) ${olderThan ? `quiet since ${olderThan.toISOString()}` : '(--all)'}, ${out.purged.length} ${verb}, ${out.skipped.length} skipped, ${out.orphanSlots} provenance row(s) without a game ${out.dryRun ? 'would be ' : ''}removed${isDevStackUrl(config.db.url) ? ' [dev stack]' : ''}`,
    );
    await db.end({ timeout: 2 });
    return;
  }

  // run
  const speed = intArg('speed', args.speed, 1) ?? 1;
  let epochMs = 0;
  if (speed > 1) {
    epochMs = args.epoch ? Date.parse(args.epoch) : Math.floor(Date.now() / 60_000) * 60_000;
    if (Number.isNaN(epochMs)) usage('--epoch must be an ISO timestamp');
    // A restarted process must use the same epoch and speed to serve the same documents.
    console.log(`DEMO_EPOCH=${new Date(epochMs).toISOString()}`);
  } else if (args.epoch) {
    usage('--epoch only applies with --speed > 1');
  }
  const clock = demoClock(speed, epochMs);
  const lockWaitMs = (intArg('lock-wait', args['lock-wait'], 1) ?? 60) * 1000;
  const drainTimeoutMs = (intArg('drain-timeout', args['drain-timeout'], 1) ?? 60) * 1000;

  let shuttingDown = false;
  const rt = await openWorkerRuntime({
    db,
    config,
    log,
    lockWaitMs,
    scores: true,
    onSessionLost: () => {
      if (shuttingDown) return;
      shuttingDown = true;
      log.error('session connection lost; stopping the demo');
      process.exit(1);
    },
  });
  if (!rt) {
    shuttingDown = true;
    process.exit(2);
  }
  let host: Awaited<ReturnType<typeof startDemoHost>>;
  try {
    host = await startDemoHost({
      rotation,
      intervalMs,
      clock,
      provenance: new PgProvenanceStore(db),
      port,
      host: new URL(config.sportradar.baseUrl).hostname,
      log,
    });
  } catch (err) {
    log.error({ err }, 'demo host failed to start');
    shuttingDown = true;
    process.exit(1);
  }
  // Provenance of today's and tomorrow's slots up front (the host also writes it on demand).
  for (const s of host.slotsNow()) await host.ensureProvenance(s);
  console.log(`DEMO_HOST=${host.url}`);

  let stopRequested = false;
  let stoppedBy: string | null = null;
  let wakeIdle: (() => void) | null = null;
  let drainDeadline = Number.POSITIVE_INFINITY;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (stoppedBy) {
        drainDeadline = Math.min(drainDeadline, Date.now() + 3_000);
        return;
      }
      stopRequested = true;
      stoppedBy = signal;
      log.warn({ signal }, 'stop requested; finishing the in-flight documents, then draining');
      wakeIdle?.();
    });
  }
  const scheduled = [...new Set(rotation.map((e) => e.league))];
  let outcome: Awaited<ReturnType<typeof runScheduler>>;
  try {
    outcome = await runScheduler(rt, {
      config,
      log,
      leagues: scheduled,
      speed,
      watchSpeed: speed,
      isStopped: () => stopRequested,
      onSleep: (wake) => {
        wakeIdle = wake;
      },
      drainTimeoutMs,
      drainDeadline: () => drainDeadline,
      now: () => new Date(clock.now()),
      replayOnly: true,
    });
  } catch (err) {
    log.error({ err }, 'scheduler failed');
    process.exit(1);
  }
  await host.close();
  log.info(
    { stats: outcome.stats, host: host.stats, unpublished: outcome.left, stoppedBy },
    'demo finished',
  );
  shuttingDown = true;
  await rt.session.end({ timeout: 2 });
  await db.end({ timeout: 2 });
  process.exit(outcome.left.pending > 0 ? 75 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
