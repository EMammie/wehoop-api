import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { isDevStackUrl, loadConfig } from '../config.js';
import { createDb, type Db } from '../db/client.js';
import { createSessionDb, tryAcquireWorkerLock } from '../db/session-client.js';
import { GameWatcher, replayRecording } from '../ingest/game-watcher.js';
import { ReferenceIngester } from '../ingest/reference.js';
import { endRun, startRun } from '../ingest/runs.js';
import { fixturePath, replayGameId, SEED_EPOCH, SEED_MANIFEST } from '../ingest/seed-manifest.js';
import { type LeagueCode, LeagueCodeSchema } from '../leagues/codes.js';
import { adapterFor } from '../leagues/registry.js';
import { OutboxPublisher } from '../live/outbox-publisher.js';
import { SupabaseBroadcastTransport } from '../live/supabase-broadcast.js';
import { type LiveTransport, MemoryTransport } from '../live/transport.js';
import { createLogger } from '../logger.js';

/**
 * pnpm seed:dev [--league wnba|ncaawb|unrivaled]... [--force] [--dry-run] [--verbose]
 *   Load every committed fixture of the three leagues into the DEV stack (M5 B2,
 *   plan rev 4.10 (2)) so every app screen has data without a provider key:
 *   reference documents (hierarchy, schedules, standings, profiles, seasonal
 *   statistics, league leaders) through ReferenceIngester and the replay files
 *   (recorded and hand-assembled games) through GameWatcher → applyChanges, the
 *   same paths production uses. Nothing is inserted by hand, so identity, holds,
 *   the freshness policy and the outbox behave as they do live.
 *
 *   Re-running is safe: reference documents are idempotent and a replay whose
 *   game is already closed with durable history is skipped (`--force` replays it
 *   anyway as a new generation: 0 new changes, its pre-game documents logged
 *   `run_regresses_state`, as the M1 no-regression evidence shows).
 *
 *   Refuses anything but MODE=sim on the dev stack (127.0.0.1:54322): the trial
 *   stack is the quota ledger and production is fed by the scheduler. Holds the
 *   single-ingester lock while it runs (exit 2 if a worker holds it) and drains
 *   the outbox at the end (to Supabase Realtime when SUPABASE_SERVICE_ROLE_KEY
 *   is set, otherwise to an in-memory transport nobody receives, like the worker).
 * Exit codes: 0 ok; 1 a document failed; 2 lock held elsewhere; 64 usage; 65 wrong database.
 */

interface LeagueTotals {
  league: string;
  seasons: number;
  teams: number;
  players: number;
  games: number;
  closed: number;
  standings: number;
  seasonLines: number;
  leaders: number;
  changes: number;
  openHolds: number;
}

async function totals(db: Db): Promise<LeagueTotals[]> {
  return db<LeagueTotals[]>`
    select l.code::text as league,
      (select count(*) from public.seasons s where s.league = l.code)::int as seasons,
      (select count(*) from public.teams t where t.league = l.code)::int as teams,
      (select count(distinct x.player_id) from public.player_external_ids x where x.league = l.code)::int as players,
      (select count(*) from public.games g where g.league = l.code)::int as games,
      (select count(*) from public.games g where g.league = l.code and g.status = 'closed')::int as closed,
      (select count(*) from public.v_standings v where v.league = l.code)::int as standings,
      (select count(*) from public.v_player_seasons v where v.league = l.code)::int as "seasonLines",
      (select count(*) from public.v_leaders v where v.league = l.code)::int as leaders,
      (select count(*) from public.game_changes c join public.games g on g.id = c.game_id where g.league = l.code)::int as changes,
      (select count(*) from ingest.player_merge_holds h where h.league = l.code and h.status = 'open')::int as "openHolds"
    from public.leagues l order by l.code`;
}

function table(rows: LeagueTotals[]): string {
  const cols = Object.keys(rows[0] ?? {}) as (keyof LeagueTotals)[];
  const cells = rows.map((r) => cols.map((c) => String(r[c])));
  const widths = cols.map((c, i) => Math.max(c.length, ...cells.map((r) => r[i]?.length ?? 0)));
  const line = (vals: string[]) => vals.map((v, i) => v.padStart(widths[i] ?? 0)).join('  ');
  return [line(cols as string[]), ...cells.map(line)].join('\n');
}

async function main() {
  const { values: args } = parseArgs({
    options: {
      league: { type: 'string', multiple: true },
      force: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
    },
    strict: true,
  });
  const leagues: LeagueCode[] = args.league?.length
    ? args.league.map((l) => LeagueCodeSchema.parse(l))
    : ['wnba', 'ncaawb', 'unrivaled'];

  const config = loadConfig(process.env);
  if (
    config.mode !== 'sim' ||
    !isDevStackUrl(config.db.url) ||
    !isDevStackUrl(config.db.sessionUrl)
  ) {
    console.error(
      `seed:dev loads fixtures into the DEV stack only (MODE=sim, DATABASE_URL at 127.0.0.1:54322); got MODE=${config.mode}. Never the trial stack (the quota ledger) and never production (the scheduler feeds it).`,
    );
    process.exit(65);
  }

  if (args['dry-run']) {
    for (const league of leagues) {
      for (const step of SEED_MANIFEST[league]) {
        console.log(
          `${league.padEnd(9)} ${step.kind === 'reference' ? step.feed.padEnd(19) : 'replay'.padEnd(19)} ${step.file}`,
        );
      }
    }
    return;
  }

  // Per-document failures are printed below (and by replayRecording at error level); the
  // publisher's per-batch backoff warnings while 2,000 rows drain are noise here.
  const log = createLogger({ level: args.verbose ? 'info' : 'error' });
  const db = createDb(config.db.url);
  let lost = false;
  const session = createSessionDb(config.db.sessionUrl, () => {
    lost = true;
  });
  if (!(await tryAcquireWorkerLock(session))) {
    console.error('seed:dev: another worker holds the ingester lock; stop it first (exit 2)');
    await session.end({ timeout: 2 });
    await db.end({ timeout: 2 });
    process.exit(2);
  }

  let transport: LiveTransport;
  if (config.supabase.serviceRoleKey) {
    transport = new SupabaseBroadcastTransport({
      url: config.supabase.url,
      serviceRoleKey: config.supabase.serviceRoleKey,
      log,
    });
  } else {
    console.log(
      'seed:dev: SUPABASE_SERVICE_ROLE_KEY not set; outbox rows drain to an in-memory transport',
    );
    transport = new MemoryTransport();
  }
  const publisher = new OutboxPublisher({ db, log, transport });
  await publisher.start(session);

  const started = Date.now();
  let failed = 0;
  for (const league of leagues) {
    const adapter = adapterFor(league);
    const referenceRun = await startRun(db, {
      kind: 'poll_schedule',
      league,
      gameId: null,
      source: 'fixture',
      meta: { seed: true },
    });
    const reference = new ReferenceIngester({
      db,
      log,
      league,
      source: 'fixture',
      runSource: 'fixture',
      run: referenceRun,
    });
    for (const step of SEED_MANIFEST[league]) {
      const path = fixturePath(league, step.file);
      const label = `${league.padEnd(9)} ${step.kind === 'reference' ? step.feed.padEnd(19) : 'replay'.padEnd(19)} ${step.file}`;
      const t0 = Date.now();
      try {
        if (step.kind === 'reference') {
          const body: unknown = JSON.parse(await readFile(path, 'utf8'));
          const out = await reference.process(step.feed, body, SEED_EPOCH);
          const parts = Object.entries(out)
            .filter(([k, v]) => k !== 'feed' && v !== 0)
            .map(([k, v]) => `${k} ${v}`);
          console.log(`${label}  ${parts.join(', ') || 'nothing new'}  (${Date.now() - t0} ms)`);
          continue;
        }
        const providerGameId = await replayGameId(path);
        if (providerGameId && !args.force) {
          const [row] = await db<{ status: string; lastSeq: string }[]>`
            select status::text as status, last_seq::text as "lastSeq" from public.games
            where league = ${league} and provider_game_id = ${providerGameId}`;
          if (row && row.status === 'closed' && Number(row.lastSeq) > 0) {
            console.log(
              `${label}  already seeded (closed, last_seq ${row.lastSeq}); skipped (--force replays it)`,
            );
            continue;
          }
        }
        const run = await startRun(db, {
          kind: 'replay',
          league,
          gameId: null,
          source: 'fixture',
          meta: { seed: true, replayFile: `fixtures/${league}/${step.file}` },
        });
        const watcher = new GameWatcher({ db, log, adapter, run, apply: { db, log }, pulse: null });
        const out = await replayRecording(watcher, path, log, {
          paceMs: 0,
          isStopped: () => lost,
          maxDocs: null,
          reference,
        });
        await endRun(db, run.id, 'ok');
        console.log(
          `${label}  docs ${out.docs} (reference ${out.referenceDocs}), game ${watcher.gameId ?? 'none'}${
            out.status ? ` ${out.status}` : ''
          }, changes ${watcher.applied}, stale ${watcher.stale}  (${Date.now() - t0} ms)`,
        );
      } catch (err) {
        failed++;
        console.error(`${label}  FAILED: ${(err as Error).message}`);
      }
    }
    await endRun(db, referenceRun.id, 'ok');
  }

  const left = await publisher.drainUntilEmpty(60_000);
  publisher.stop();
  console.log(`\noutbox after drain: pending ${left.pending}, dead ${left.dead}`);
  console.log(table(await totals(db)));
  console.log(
    `\nseed:dev: ${failed === 0 ? 'done' : `${failed} document(s) FAILED`} in ${Math.round((Date.now() - started) / 1000)} s`,
  );
  await session.end({ timeout: 2 });
  await db.end({ timeout: 2 });
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
