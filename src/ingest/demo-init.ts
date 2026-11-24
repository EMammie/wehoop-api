import { readFile } from 'node:fs/promises';
import type { Db } from '../db/client.js';
import type { LeagueCode } from '../leagues/codes.js';
import { adapterFor } from '../leagues/registry.js';
import type { Logger } from '../logger.js';
import { isGameFeed, type ReferenceFeed } from '../providers/sportradar/urls.js';
import { EnvironmentRefusedError, markEnvironment, readEnvironment } from './environment.js';
import { readRecording } from './recording.js';
import { ReferenceIngester } from './reference.js';
import { endRun, startRun } from './runs.js';
import { fixturePath, SEED_EPOCH, SEED_MANIFEST } from './seed-manifest.js';

/**
 * `pnpm demo init` (plan rev 4.15 (4)): turn a fresh database into the demo
 * environment.
 *   1. Refuse unless the database holds no game or is already marked `demo`
 *      (a database with real games is not made a demo by accident); refuse a
 *      database marked anything else, one with quota-counted provider calls, or
 *      one with an operator-verified limit that is not the demo row (an empty
 *      production project after the quiet deploy, which the production worker
 *      also marks `production` at start).
 *   2. Mark it `demo` (`ingest.environment`); refused when it is marked
 *      anything else.
 *   3. Synthetic product limits: every product gets a large, verified
 *      `ingest.product_quotas` row whose note says DEMO. Demo calls are source
 *      `rehearsal` and never quota-counted; the guard only needs a row to exist
 *      (and the limits are what /health and the admin view print), then reads
 *      them back to verify.
 *   4. The reference fixtures of the seed manifest (src/ingest/seed-manifest.ts)
 *      through ReferenceIngester, the normal ingest path: hierarchy (teams),
 *      standings, seasonal statistics, profiles, league leaders, tournament
 *      lists, including the reference lines carried inside replay files. NOT the
 *      replay games, and not the schedule feeds (season, daily, tournament
 *      schedules), which would create real-looking games no demo host serves;
 *      the rotation creates every game the demo shows.
 * Idempotent: a second run changes nothing.
 */
export const DEMO_QUOTA_LIMIT = 1_000_000;
export const DEMO_QUOTA_NOTE =
  'DEMO environment (rev 4.15): synthetic limit; demo calls are source rehearsal and never quota-counted';
const GAME_CREATING_FEEDS: ReadonlySet<ReferenceFeed> = new Set([
  'schedule',
  'daily_schedule',
  'tournament_schedule',
]);

/**
 * Whether a database may become the demo environment (pure; unit-tested). A database already
 * marked `demo` is re-initialized without these checks (its rows are the demo's own).
 *   - marked anything else: refused;
 *   - quota-counted provider calls, or an operator-verified limit that is not the demo row: a real
 *     deployment, even an empty one (the quiet deploy); marking it demo would overwrite its limits;
 *   - any game: refused (a database with real games is not made a demo by accident).
 */
export function demoInitProblem(s: {
  kind: string | null;
  games: number;
  countedCalls: number;
  verifiedProducts: readonly string[];
}): string | null {
  if (s.kind === 'demo') return null;
  if (s.kind !== null) return `demo init refuses a database marked ${s.kind}`;
  if (s.countedCalls > 0 || s.verifiedProducts.length > 0) {
    return `demo init refuses a database that looks like a real deployment: ${s.countedCalls} quota-counted provider call(s), operator-verified limits for [${s.verifiedProducts.join(', ')}]`;
  }
  if (s.games > 0) {
    return `demo init needs an empty database or one already marked demo; this one holds ${s.games} game(s) and is unmarked`;
  }
  return null;
}

export interface DemoInitResult {
  marked: 'demo';
  quotas: Array<{ product: string; limit30d: number; reserve: number; verified: boolean }>;
  references: Array<{ league: LeagueCode; feed: ReferenceFeed; file: string }>;
  skipped: Array<{ league: LeagueCode; file: string; reason: string }>;
}

export async function demoInit(
  db: Db,
  log: Logger,
  opts: { leagues?: LeagueCode[] } = {},
): Promise<DemoInitResult> {
  const leagues: LeagueCode[] = opts.leagues ?? ['wnba', 'ncaawb', 'unrivaled'];
  const kind = await readEnvironment(db);
  if (kind !== 'demo') {
    const [state] = await db<{ games: number; counted: number; verified: string[] }[]>`
      select (select count(*)::int from public.games) as games,
             (select count(*)::int from ingest.provider_calls where quota_counted) as counted,
             coalesce((select array_agg(product order by product) from ingest.product_quotas
                       where verified_at is not null and note is distinct from ${DEMO_QUOTA_NOTE}), '{}') as verified`;
    const problem = demoInitProblem({
      kind,
      games: state?.games ?? 0,
      countedCalls: state?.counted ?? 0,
      verifiedProducts: state?.verified ?? [],
    });
    if (problem) throw new EnvironmentRefusedError(problem);
  }
  await markEnvironment(db, 'demo', 'pnpm demo init');

  const products = [...new Set(leagues.map((l) => adapterFor(l).product))];
  for (const product of products) {
    await db`
      insert into ingest.product_quotas (product, limit_30d, qps, reserve, note, verified_at)
      values (${product}, ${DEMO_QUOTA_LIMIT}, 1, 0, ${DEMO_QUOTA_NOTE}, now())
      on conflict (product) do update
        set limit_30d = excluded.limit_30d, reserve = excluded.reserve, note = excluded.note,
            verified_at = coalesce(ingest.product_quotas.verified_at, excluded.verified_at)`;
  }
  const quotaRows = await db<
    { product: string; limit30d: number; reserve: number; verified: boolean; note: string | null }[]
  >`
    select product, limit_30d as "limit30d", reserve, verified_at is not null as verified, note
    from ingest.product_quotas where product = any(${products}) order by product`;
  for (const q of quotaRows) {
    if (
      q.limit30d !== DEMO_QUOTA_LIMIT ||
      q.reserve !== 0 ||
      !q.verified ||
      q.note !== DEMO_QUOTA_NOTE
    )
      throw new Error(
        `demo init: product_quotas row for ${q.product} is not the synthetic demo row`,
      );
  }
  if (quotaRows.length !== products.length)
    throw new Error('demo init: missing product_quotas rows');

  const result: DemoInitResult = {
    marked: 'demo',
    quotas: quotaRows.map(({ note: _n, ...q }) => q),
    references: [],
    skipped: [],
  };
  // Manifest order (WNBA before Unrivaled: the Unrivaled Boston profile references her WNBA ids).
  for (const league of leagues) {
    const run = await startRun(db, {
      kind: 'poll_schedule',
      league,
      gameId: null,
      source: 'fixture',
      meta: { demoInit: true },
    });
    const reference = new ReferenceIngester({
      db,
      log,
      league,
      source: 'fixture',
      runSource: 'fixture',
      run,
    });
    try {
      for (const step of SEED_MANIFEST[league]) {
        const path = fixturePath(league, step.file);
        if (step.kind === 'reference') {
          if (GAME_CREATING_FEEDS.has(step.feed)) {
            result.skipped.push({ league, file: step.file, reason: `${step.feed} creates games` });
            continue;
          }
          const body: unknown = JSON.parse(await readFile(path, 'utf8'));
          await reference.process(step.feed, body, SEED_EPOCH);
          result.references.push({ league, feed: step.feed, file: step.file });
          continue;
        }
        // A replay file: only its reference lines, at their own request times (as seed:dev).
        let carried = 0;
        for await (const line of readRecording(path)) {
          if (isGameFeed(line.feed)) continue;
          const feed = line.feed as ReferenceFeed;
          if (GAME_CREATING_FEEDS.has(feed)) continue;
          await reference.process(feed, line.body, new Date(line.requestedAt));
          result.references.push({ league, feed, file: step.file });
          carried++;
        }
        if (carried === 0)
          result.skipped.push({ league, file: step.file, reason: 'replay game only' });
      }
      await endRun(db, run.id, 'ok');
    } catch (err) {
      await endRun(db, run.id, 'error', (err as Error).message);
      throw err;
    }
  }
  log.info(
    { references: result.references.length, skipped: result.skipped.length, products },
    'demo init done',
  );
  return result;
}
