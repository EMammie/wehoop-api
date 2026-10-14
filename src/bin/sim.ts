import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { createDb } from '../db/client.js';
import { applyChanges } from '../ingest/apply-changes.js';
import {
  appendRecordedDocument,
  compactRecording,
  toRecordedDocument,
} from '../ingest/recording.js';
import { endRun, startRun } from '../ingest/runs.js';
import type { NormalizedBatch } from '../ingest/types.js';
import { type LeagueCode, LeagueCodeSchema } from '../leagues/codes.js';
import { normalizeEvent } from '../leagues/sportradar-basketball/normalize.js';
import { adapterFor } from '../leagues/wnba/adapter.js';
import { createLogger, type Logger } from '../logger.js';
import type { PeriodType } from '../model/live-event.js';
import { SportradarHttp } from '../providers/sportradar/http.js';
import { BoxscoreDocumentSchema } from '../providers/sportradar/schemas/boxscore.js';
import { PbpDocumentSchema, PbpEventSchema } from '../providers/sportradar/schemas/pbp.js';
import { SummaryDocumentSchema } from '../providers/sportradar/schemas/summary.js';
import { SimulationClient } from '../providers/sportradar/simulation.js';
import { type Feed, SimulationUrlResolver } from '../providers/sportradar/urls.js';

/**
 * pnpm sim list --league wnba                 recordings and their feeds (no API key)
 * pnpm sim show --recording <id>              one recording's details
 * pnpm sim session --recording <id>           create a replay session, print its id
 * pnpm sim inject --game <uuid> --mutate-event <providerEventId>
 * pnpm sim inject --game <uuid> --delete-event <providerEventId>
 *   Corrections injected as a `fixture` batch inside the game's current watch
 *   generation (a backfill sub-run), through applyChanges like any other batch.
 * pnpm sim record --league wnba --recording <id> --out <file.jsonl>
 *     [--poll-interval 3000] [--summary-every 10] [--max-polls N]
 *   DB-free natural-pace recorder: creates a simulation session and polls the
 *   replay REST feeds the way the worker does in sim mode (pbp every poll,
 *   summary + boxscore every Nth poll), appending one `RecordedDocument` line per
 *   document (the `--record-to` / `--replay-file` format). Stops after the first
 *   `closed` pbp plus one final summary and boxscore. Never opens Postgres.
 * pnpm sim compact --in <full.jsonl> --out <file.jsonl.gz>
 *     [--every-pbp 50] [--every-summary 10] [--target-mb 4]
 *   Deterministic down-sampler producing the committed replay fixture. A
 *   document is kept when ANY of: (1) it is the first or last of its feed;
 *   (2) its `status` or `quarter` differs from the previously KEPT document of
 *   the same feed; (3) (pbp) its `deleted_events` id set differs from the
 *   previously kept pbp; (4) its index within its feed is a multiple of the
 *   stride (`--every-pbp` for pbp, `--every-summary` for summary and boxscore);
 *   (5) it is the last document before, or the first after, a status or period
 *   change between consecutive documents of its feed. Hence every boxscore
 *   whose status or period changed, plus the final one, is kept. Kept lines are
 *   written byte-identical, gzip level 9. Exits 3 if the output exceeds
 *   `--target-mb`. The rule lives in `selectCompact` (src/ingest/recording.ts).
 */
async function main() {
  const { values: args, positionals } = parseArgs({
    options: {
      league: { type: 'string', default: 'wnba' },
      recording: { type: 'string' },
      game: { type: 'string' },
      'mutate-event': { type: 'string' },
      'delete-event': { type: 'string' },
      json: { type: 'boolean', default: false },
      out: { type: 'string' },
      in: { type: 'string' },
      'poll-interval': { type: 'string', default: '3000' },
      'summary-every': { type: 'string', default: '10' },
      'max-polls': { type: 'string' },
      'every-pbp': { type: 'string', default: '50' },
      'every-summary': { type: 'string', default: '10' },
      'target-mb': { type: 'string', default: '4' },
    },
    allowPositionals: true,
    strict: true,
  });
  const cmd = positionals[0];
  /** Numeric flags: positive integers only; anything else is a usage error (exit 64). */
  const intArg = (
    name: string,
    value: string | undefined,
    fallback: number | null,
  ): number | null => {
    if (value === undefined) return fallback;
    const parsed = z.coerce.number().int().positive().safeParse(value);
    if (!parsed.success) {
      console.error(`--${name} must be a positive integer, got ${JSON.stringify(value)}`);
      process.exit(64);
    }
    return parsed.data;
  };
  const config = loadConfig();
  const sim = new SimulationClient({ playbackUrl: config.sportradar.playbackUrl });

  if (cmd === 'record') {
    if (!args.recording) throw new Error('--recording is required');
    if (!args.out) throw new Error('--out <file.jsonl> is required');
    if (existsSync(args.out)) throw new Error(`${args.out} exists; refusing to append to it`);
    const league = LeagueCodeSchema.parse(args.league);
    // Usage errors before any network call.
    const pollIntervalMs = intArg('poll-interval', args['poll-interval'], 3000) ?? 3000;
    const summaryEvery = intArg('summary-every', args['summary-every'], 10) ?? 10;
    const maxPolls = intArg('max-polls', args['max-polls'], null);
    const log = createLogger({ level: config.logLevel });
    const rec = await sim.getRecording(args.recording);
    if (!rec) throw new Error(`recording ${args.recording} not found`);
    const sessionId = await sim.createSession(args.recording);
    log.info(
      { recording: rec.id, title: rec.title, sessionId, out: args.out },
      'simulation session created; recording at natural pace',
    );
    const http = new SportradarHttp({
      db: null,
      log,
      league,
      runId: null,
      resolver: new SimulationUrlResolver({
        playbackUrl: config.sportradar.playbackUrl,
        league,
        recordingId: args.recording,
        sessionId,
      }),
    });
    const docs = await recordSession(http, log, {
      league,
      out: args.out,
      pollIntervalMs,
      summaryEvery,
      maxPolls,
    });
    console.log(`RECORDED ${docs} documents -> ${args.out}`);
    return;
  }
  if (cmd === 'compact') {
    if (!args.in) throw new Error('--in <full.jsonl> is required');
    if (!args.out) throw new Error('--out <file.jsonl.gz> is required');
    const targetMb = intArg('target-mb', args['target-mb'], 4) ?? 4;
    const targetBytes = targetMb * 1024 * 1024;
    const result = await compactRecording(args.in, args.out, {
      everyPbp: intArg('every-pbp', args['every-pbp'], 50) ?? 50,
      everySummary: intArg('every-summary', args['every-summary'], 10) ?? 10,
      warn: (m) => console.error(`warning: ${m}`),
    });
    for (const [feed, c] of Object.entries(result.perFeed)) {
      console.log(`${feed.padEnd(9)} kept ${String(c.kept).padStart(5)} / ${c.total}`);
    }
    const size = statSync(args.out).size;
    const sha = await sha256File(args.out);
    console.log(`total     kept ${String(result.kept).padStart(5)} / ${result.total}`);
    console.log(
      `${args.out}: ${size} bytes (${(size / 1024 / 1024).toFixed(2)} MB), sha256 ${sha}`,
    );
    if (size > targetBytes) {
      console.error(`output exceeds --target-mb ${targetMb}; raise the strides`);
      process.exit(3);
    }
    return;
  }

  if (cmd === 'list') {
    const league = LeagueCodeSchema.parse(args.league);
    const recordings = await sim.listRecordings(league);
    if (args.json) {
      console.log(JSON.stringify(recordings, null, 2));
      return;
    }
    const withFeeds = recordings.filter((r) => r.apis.length > 0);
    console.log(`${recordings.length} ${league} recordings, ${withFeeds.length} with feeds\n`);
    console.log(
      `${'recording id'.padEnd(38)} ${'scheduled'.padEnd(22)} ${'rest'.padEnd(22)} ${'push'.padEnd(26)} title`,
    );
    for (const r of withFeeds) {
      const rest = r.apis
        .filter((a) => a.apiType !== 'push')
        .map((a) => a.name)
        .join(',');
      const push = r.apis
        .filter((a) => a.apiType === 'push')
        .map((a) => a.name)
        .join(',');
      console.log(
        `${r.id.padEnd(38)} ${(r.scheduled ?? '').slice(0, 20).padEnd(22)} ${rest.padEnd(22)} ${(push || '-').padEnd(26)} ${r.title ?? ''}`,
      );
    }
    return;
  }
  if (cmd === 'show') {
    if (!args.recording) throw new Error('--recording is required');
    console.log(JSON.stringify(await sim.getRecording(args.recording), null, 2));
    return;
  }
  if (cmd === 'session') {
    if (!args.recording) throw new Error('--recording is required');
    console.log(await sim.createSession(args.recording));
    return;
  }
  if (cmd === 'inject') {
    if (!args.game) throw new Error('--game <uuid> is required');
    const providerEventId = args['mutate-event'] ?? args['delete-event'];
    if (!providerEventId) throw new Error('--mutate-event <id> or --delete-event <id> is required');
    const log = createLogger({ level: config.logLevel });
    const db = createDb(config.db.url, { max: 2 });
    const [g] = await db<
      { id: string; league: 'wnba' | 'ncaawb' | 'unrivaled'; watchRunId: string | null }[]
    >`
      select id, league, watch_run_id::text as "watchRunId" from public.games where id = ${args.game}`;
    if (!g) throw new Error(`game ${args.game} not found`);
    const [pe] = await db<
      {
        id: string;
        periodNumber: number | null;
        periodType: PeriodType | null;
        periodSequence: number | null;
        providerUpdatedAt: Date | null;
        raw: unknown;
      }[]
    >`
      select p.id, p.period_number as "periodNumber", p.period_type as "periodType", p.period_sequence as "periodSequence",
             p.provider_updated_at as "providerUpdatedAt", r.raw
      from public.play_events p left join ingest.play_event_raw r on r.play_event_id = p.id
      where p.game_id = ${g.id} and p.provider_event_id = ${providerEventId}`;
    if (!pe) throw new Error(`event ${providerEventId} not found in game ${g.id}`);
    const adapter = adapterFor(g.league);
    const parentRunId = g.watchRunId === null ? null : Number(g.watchRunId);
    const run = await startRun(db, {
      kind: parentRunId === null ? 'replay' : 'backfill',
      league: adapter.league,
      gameId: g.id,
      source: 'fixture',
      parentRunId,
      meta: { inject: args['mutate-event'] ? 'mutate' : 'delete', providerEventId },
    });
    let batch: NormalizedBatch;
    if (args['mutate-event']) {
      const raw = PbpEventSchema.parse(pe.raw);
      const prevUpdated =
        raw.updated ?? pe.providerUpdatedAt?.toISOString() ?? new Date().toISOString();
      const bumped = new Date(Date.parse(prevUpdated) + 1000)
        .toISOString()
        .replace(/\.\d{3}Z$/, '+00:00');
      const mutated = {
        ...raw,
        description: `${raw.description ?? ''} [corrected]`.trim(),
        updated: bumped,
      };
      const period = {
        number: pe.periodNumber ?? 0,
        type: pe.periodType ?? 'quarter',
        sequence: pe.periodSequence ?? 0,
      };
      batch = { events: [normalizeEvent(mutated, period)], deletedEvents: [], teamStats: [] };
    } else {
      batch = { events: [], deletedEvents: [{ providerEventId, updatedAt: null }], teamStats: [] };
    }
    const result = await applyChanges({ db, log }, g.id, batch, {
      source: 'fixture',
      runId: run.id,
      watchId: run.watchId,
      observedAt: new Date(),
      isComplete: false,
      gameView: null,
    });
    await endRun(db, run.id, 'ok');
    await db.end();
    console.log(
      JSON.stringify(
        result.outcome === 'applied'
          ? {
              outcome: 'applied',
              runId: run.id,
              watchId: run.watchId,
              changes: result.changes.map((c) => ({
                seq: c.seq,
                type: c.type,
                providerEventId: 'providerEventId' in c ? c.providerEventId : null,
              })),
              counts: result.counts,
            }
          : { outcome: 'stale', reason: result.reason, detail: result.detail },
        null,
        2,
      ),
    );
    return;
  }
  console.error('usage: pnpm sim <list|show|session|inject|record|compact> [options]');
  process.exit(64);
}

interface RecordOptions {
  league: LeagueCode;
  out: string;
  pollIntervalMs: number;
  summaryEvery: number;
  maxPolls: number | null;
}

/**
 * Natural-pace polling loop of the recorder. Mirrors the worker's `pollLoop`
 * cadence (pbp every poll; summary and boxscore on poll 1, 1+N, 1+2N, ...),
 * then one final summary + boxscore after the first `closed` pbp. SIGINT /
 * SIGTERM stop the loop after the in-flight poll; every line is already on
 * disk (synchronous append), so the file is a valid prefix at any moment.
 */
async function recordSession(http: SportradarHttp, log: Logger, opts: RecordOptions) {
  let docs = 0;
  let bytes = 0;
  let polls = 0;
  let failures = 0;
  let stop: string | null = null;
  let wake: (() => void) | null = null;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      stop = signal;
      log.warn({ signal, docs }, 'stopping after the in-flight poll; file is a valid prefix');
      wake?.();
    });
  }
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      wake = resolve;
      setTimeout(resolve, ms);
    });
  const record = async <T>(
    feed: Feed,
    schema: Parameters<typeof http.getJson<T>>[1],
  ): Promise<T> => {
    const doc = await http.getJson(feed, schema);
    bytes += appendRecordedDocument(opts.out, toRecordedDocument(feed, doc));
    docs++;
    return doc.data;
  };
  const sideFeeds = async () => {
    await record('summary', SummaryDocumentSchema);
    await record('boxscore', BoxscoreDocumentSchema);
  };

  while (stop === null) {
    const started = Date.now();
    polls++;
    try {
      const pbp = await record('pbp', PbpDocumentSchema);
      if ((polls - 1) % opts.summaryEvery === 0) await sideFeeds();
      failures = 0;
      if (polls % 20 === 0 || pbp.status === 'closed') {
        log.info(
          {
            polls,
            docs,
            status: pbp.status,
            period: pbp.quarter ?? null,
            clock: pbp.clock ?? null,
            score: `${pbp.away.points ?? 0}-${pbp.home.points ?? 0}`,
            bytes,
          },
          'recording',
        );
      }
      if (pbp.status === 'closed') {
        await sideFeeds();
        log.info({ polls, docs, bytes }, 'game closed; final summary and boxscore recorded');
        break;
      }
    } catch (err) {
      failures++;
      log.error({ err, polls, failures }, 'poll failed; retrying');
      if (failures >= 20) throw new Error('20 consecutive poll failures; giving up');
    }
    if (opts.maxPolls !== null && polls >= opts.maxPolls) {
      log.info({ polls, docs }, 'max polls reached');
      break;
    }
    if (stop !== null) break;
    await sleep(Math.max(0, opts.pollIntervalMs - (Date.now() - started)));
  }
  log.info({ docs, bytes, polls, stoppedBy: stop ?? 'completion', out: opts.out }, 'recorder done');
  return docs;
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => h.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
