import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Config, loadConfig } from '../../src/config.js';
import {
  budgetFor,
  PUSH_CONNECTION_ALLOWANCE,
  PUSH_RECONCILE_CADENCE,
} from '../../src/ingest/cadence.js';
import { QuotaGuard } from '../../src/ingest/quota-guard.js';
import { resolveGame, runTrialWatch, type TrialWatchOutcome } from '../../src/ingest/trial-mode.js';
import { wnbaAdapter } from '../../src/leagues/wnba/adapter.js';
import { PgSlotStore } from '../../src/providers/sportradar/rate-limiter.js';
import { pbpQ1, R, seedGame, silentLog, testDb } from '../helpers/db.js';
import { fixture } from '../helpers/fixtures.js';
import { relabelDoc, scriptedProvider } from '../helpers/scripted-provider.js';

/**
 * Owner verification (M4 merge review): the REST pbp a push watch fetches on a stream reconnect
 * (`runBackfill`, built in trial-mode.ts openPushStreams) is accounted like every other call:
 * (1) its slot is claimed from the shared `ingest.provider_rate_slots` ledger, so a claim by
 * another process pushes it back; (2) the QuotaGuard is consulted first and refuses it below
 * reserve (never sent, never logged); (3) it is logged in `ingest.provider_calls` with
 * `quota_counted` true for a trial source; (4) it is counted in the watch reservation's
 * `used_calls`, which `budgetFor` + PUSH_CONNECTION_ALLOWANCE do not size for; (5) its 429 retry
 * is not in `meta.retries`.
 *
 * The source must be `trial` for (3), so the config is MODE=trial on the production-shaped host
 * (api.sportradar.com URLs) with a made-up key, on the DEV stack (TRIAL_ALLOW_DEV_DB=1, a test
 * product row). Nothing reaches the network: every request of the watch (REST, push streams,
 * backfills) goes through the scripted `fetchImpl`.
 */
const REAL_ID = '40bea3f6-68c0-4f3b-96fa-336dfb7a9034';

const db = testDb();
/** A second pool: another process sharing the database (and the rate-slot ledger). */
const otherProcess = testDb();
const log = silentLog;
const product = `m4-backfill-${randomUUID().slice(0, 8)}`;
const adapter = { ...wnbaAdapter, product };

const config: Config = loadConfig({
  DATABASE_URL: process.env.DATABASE_URL,
  DATABASE_SESSION_URL: process.env.DATABASE_URL,
  SUPABASE_URL: process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321',
  SUPABASE_SERVICE_ROLE_KEY: 'not-used-here',
  MODE: 'trial',
  SPORTRADAR_WNBA_KEY: 'backfill-accounting-made-up-key',
  TRIAL_ALLOW_DEV_DB: '1',
});

async function liveGame() {
  const { gameId, providerGameId } = await seedGame(db, pbpQ1());
  const tipOff = new Date(Date.now() - 30 * 60_000).toISOString();
  await db`update public.games set scheduled_at = ${tipOff} where id = ${gameId}`;
  const doc = (feed: string) => ({
    ...(relabelDoc(fixture(`${R}-${feed}-q1.json`), REAL_ID, providerGameId) as Record<
      string,
      unknown
    >),
    scheduled: tipOff,
  });
  const game = await resolveGame(db, 'wnba', providerGameId);
  if (!game) throw new Error('seeded game missing');
  return {
    game,
    gameId,
    docs: { pbp: doc('pbp'), summary: doc('summary'), boxscore: doc('boxscore') },
  };
}

/**
 * After the cadence's t=0 pbp has been served (so it is pbp #1 and the next pbp is the backfill's),
 * cut the events stream as soon as its first connection is open: the reconnect needs a backfill.
 */
function dropEventsAfterFirstPbp(provider: ReturnType<typeof scriptedProvider>) {
  const state = { pbps: 0, dropped: false };
  provider.onServe = (feed) => {
    if (feed !== 'pbp' || ++state.pbps !== 1) return;
    let tries = 0;
    const t = setInterval(() => {
      if (provider.dropStreams('push_events') > 0) state.dropped = true;
      if (state.dropped || ++tries > 300) clearInterval(t);
    }, 100);
  };
  return state;
}

/** Resolves once the game's first backfill sub-run has ended (ok or error). */
async function backfillEnded(gameId: string, timeoutMs = 40_000): Promise<string> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const [r] = await db<{ status: string }[]>`
      select status from ingest.ingestion_runs
      where game_id = ${gameId} and kind = 'backfill' and status <> 'running' order by id limit 1`;
    if (r) return r.status;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error('no backfill ended in time');
}

/** Watch with push until the first backfill has ended, then stop (the cadence loop is 5-min). */
async function watchUntilBackfill(
  gameId: string,
  game: NonNullable<Awaited<ReturnType<typeof resolveGame>>>,
  provider: ReturnType<typeof scriptedProvider>,
  guard: QuotaGuard,
): Promise<TrialWatchOutcome> {
  let stop = false;
  const watching = runTrialWatch(
    {
      db,
      log,
      config,
      adapter,
      guard,
      pulse: null,
      isStopped: () => stop,
      fetchImpl: provider.fetchImpl,
    },
    { game, profile: 'full', push: { backoffMinMs: 100, backoffMaxMs: 200 } },
  );
  try {
    await backfillEnded(gameId);
  } finally {
    stop = true;
  }
  return watching;
}

beforeAll(async () => {
  await db`select 1`;
  await db`insert into ingest.product_quotas (product, limit_30d, qps, reserve, note, verified_at)
           values (${product}, 1000, 1, 100, 'backfill accounting integration (dev stack)', now())`;
});
afterAll(async () => {
  await db`update ingest.budget_reservations set product = 'wnba', released_at = coalesce(released_at, now()),
             note = coalesce(note, '') || ' [integration product row removed]' where product = ${product}`;
  await db`delete from ingest.product_quotas where product = ${product}`;
  await otherProcess.end();
  await db.end();
});

describe('a reconnect backfill is rate-limited on the shared ledger, guarded, logged and counted', () => {
  it('(1) shared slot, (3) logged quota_counted, (4) counted in used_calls but not sized, (5) its 429 retry is not in meta.retries', async () => {
    const { game, gameId, docs } = await liveGame();
    const provider = scriptedProvider();
    provider.docs = docs;
    const drop = dropEventsAfterFirstPbp(provider);
    // The backfill's first attempt draws a 429 (retried once at the next slot).
    provider.fault = (feed) =>
      feed === 'pbp' && drop.pbps === 2
        ? new Response('{"message":"Too Many Requests"}', { status: 429 })
        : undefined;
    // While the events stream reconnects, another process claims the next two slots of the product.
    const external: Date[] = [];
    provider.onStream = async (feed, n) => {
      if (feed !== 'push_events' || n !== 2) return;
      const store = new PgSlotStore(otherProcess);
      for (let i = 0; i < 2; i++) external.push((await store.claim(product, 2000)).slotAt);
    };
    const guard = new QuotaGuard({ db, log });
    const out = await watchUntilBackfill(gameId, game, provider, guard);
    expect(out.push).toMatchObject({ backfills: 1, backfillsFailed: 0, backfillsSkipped: 0 });

    const [bf] = await db<{ id: string; status: string }[]>`
      select id::text, status from ingest.ingestion_runs
      where parent_run_id = ${out.runId} and kind = 'backfill'`;
    expect(bf?.status).toBe('ok');
    // (3) Logged: the 429 attempt and its retry, both trial, quota-counted, under the reservation.
    const bfCalls = await db<
      {
        feed: string;
        status: number;
        source: string;
        counted: boolean;
        reservationId: string;
        calledAt: Date;
      }[]
    >`
      select feed, status, source::text as source, quota_counted as counted,
             reservation_id::text as "reservationId", called_at as "calledAt"
      from ingest.provider_calls where run_id = ${bf?.id ?? 0} order by called_at`;
    expect(bfCalls.map(({ calledAt: _, ...c }) => c)).toEqual([
      {
        feed: 'pbp',
        status: 429,
        source: 'trial',
        counted: true,
        reservationId: String(out.reservation.id),
      },
      {
        feed: 'pbp',
        status: 200,
        source: 'trial',
        counted: true,
        reservationId: String(out.reservation.id),
      },
    ]);
    // (1) Shared ledger: both backfill sends come after the other process's two claims, and every
    // slot of the product (this watch's calls + the other process's claims) is >= 2 s apart.
    const lastExternal = Math.max(...external.map((d) => d.getTime()));
    expect(external).toHaveLength(2);
    for (const c of bfCalls)
      expect(c.calledAt.getTime() - lastExternal).toBeGreaterThanOrEqual(1990);
    const all = await db<{ calledAt: Date }[]>`
      select called_at as "calledAt" from ingest.provider_calls where product = ${product}`;
    const slots = [
      ...all.map((r) => r.calledAt.getTime()),
      ...external.map((d) => d.getTime()),
    ].sort((a, b) => a - b);
    for (let i = 1; i < slots.length; i++)
      expect((slots[i] ?? 0) - (slots[i - 1] ?? 0)).toBeGreaterThanOrEqual(1990);
    const [ledger] = await db<{ next: Date }[]>`
      select next_slot_at as next from ingest.provider_rate_slots where product = ${product}`;
    expect((ledger?.next.getTime() ?? 0) - Math.max(...slots)).toBeGreaterThanOrEqual(1990);
    expect(provider.tooClose).toBe(0);

    // (4) Every call of the watch, the backfill's included, is in used_calls; the reservation is
    // the REST budget plus the connection allowance, with no backfill term.
    const [n] = await db<{ n: number }[]>`
      select count(*)::int as n from ingest.provider_calls where reservation_id = ${out.reservation.id}`;
    expect(out.reservation.usedCalls).toBe(n?.n);
    expect(out.reservation.reservedCalls).toBe(out.budget.total);
    expect(out.budget.total).toBe(
      budgetFor(PUSH_RECONCILE_CADENCE).total + PUSH_CONNECTION_ALLOWANCE,
    );
    // (5) The backfill's 429 retry is a counted call but not part of the retry report.
    expect(out.retries).toEqual({ used: 0, allowance: 6, retried429: 0, retriedClosing: 0 });
  }, 90_000);

  it('(2) the guard is consulted before the backfill: below reserve it is refused, never sent and never logged', async () => {
    const { game, gameId, docs } = await liveGame();
    const provider = scriptedProvider();
    provider.docs = docs;
    dropEventsAfterFirstPbp(provider);
    // The reconnect itself passes the guard; before it answers, the reservation is spent and the
    // product sits at its reserve, so the backfill that follows is refused.
    provider.onStream = async (feed, n) => {
      if (feed !== 'push_events' || n !== 2) return;
      await db`update ingest.budget_reservations set used_calls = reserved_calls
               where game_id = ${gameId} and released_at is null`;
      await db`update ingest.product_quotas q set limit_30d = q.reserve +
                 (select count(*)::int from ingest.provider_calls c where c.product = q.product and c.quota_counted)
               where q.product = ${product}`;
    };
    const guard = new QuotaGuard({ db, log });
    const out = await watchUntilBackfill(gameId, game, provider, guard);
    expect(out.push).toMatchObject({ backfills: 0, backfillsFailed: 1 });
    const [bf] = await db<{ id: string; status: string; error: string | null }[]>`
      select id::text, status, error from ingest.ingestion_runs
      where parent_run_id = ${out.runId} and kind = 'backfill'`;
    expect(bf).toMatchObject({
      status: 'error',
      error: expect.stringMatching(/quota refused.*below_reserve/),
    });
    const [logged] = await db<{ n: number }[]>`
      select count(*)::int as n from ingest.provider_calls where run_id = ${bf?.id ?? 0}`;
    expect(logged?.n).toBe(0);
    // Only the cadence's t=0 pbp reached the provider.
    expect(provider.requests.filter((r) => r.feed === 'pbp')).toHaveLength(1);
    await db`update ingest.product_quotas set limit_30d = 1000 where product = ${product}`;
  }, 90_000);
});
