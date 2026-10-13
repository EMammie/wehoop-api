import { parseArgs } from 'node:util';
import { loadConfig } from '../config.js';
import { createDb } from '../db/client.js';
import { applyChanges } from '../ingest/apply-changes.js';
import { endRun, startRun } from '../ingest/runs.js';
import type { NormalizedBatch } from '../ingest/types.js';
import { LeagueCodeSchema } from '../leagues/codes.js';
import { normalizeEvent } from '../leagues/sportradar-basketball/normalize.js';
import { adapterFor } from '../leagues/wnba/adapter.js';
import { createLogger } from '../logger.js';
import type { PeriodType } from '../model/live-event.js';
import { PbpEventSchema } from '../providers/sportradar/schemas/pbp.js';
import { SimulationClient } from '../providers/sportradar/simulation.js';

/**
 * pnpm sim list --league wnba                 recordings and their feeds (no API key)
 * pnpm sim show --recording <id>              one recording's details
 * pnpm sim session --recording <id>           create a replay session, print its id
 * pnpm sim inject --game <uuid> --mutate-event <providerEventId>
 * pnpm sim inject --game <uuid> --delete-event <providerEventId>
 *   Corrections injected as a `fixture` batch inside the game's current watch
 *   generation (a backfill sub-run), through applyChanges like any other batch.
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
    },
    allowPositionals: true,
    strict: true,
  });
  const cmd = positionals[0];
  const config = loadConfig();
  const sim = new SimulationClient({ playbackUrl: config.sportradar.playbackUrl });

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
      batch = { events: [normalizeEvent(mutated, period)], deletedEventIds: [], teamStats: [] };
    } else {
      batch = { events: [], deletedEventIds: [providerEventId], teamStats: [] };
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
  console.error('usage: pnpm sim <list|show|session|inject> [options]');
  process.exit(64);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
