import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Config, loadConfig } from '../../src/config.js';
import type { Db } from '../../src/db/client.js';
import { QuotaGuard, QuotaRefusedError } from '../../src/ingest/quota-guard.js';
import { RetryReportSchema, resolveGame, runTrialWatch } from '../../src/ingest/trial-mode.js';
import { wnbaAdapter } from '../../src/leagues/wnba/adapter.js';
import { pbpQ1, R, seedGame, silentLog, testDb } from '../helpers/db.js';
import { fixture } from '../helpers/fixtures.js';
import { relabelDoc, scriptedProvider } from '../helpers/scripted-provider.js';

/**
 * Review should 2 (M4 merge): a push watch's non-happy exits (trial-mode.ts runTrialWatch catch /
 * finally), against a scripted provider (fetchImpl on a loopback base URL: source `rehearsal`,
 * rate-limited and guarded, never counted; dev stack only). (a) a quota refusal inside the cadence
 * loop; (b) the game turning postponed / cancelled mid-watch. Both must stop the push streams, end
 * the push_stream sub-run, store `meta.retries` on the watch run and release the reservation.
 */
const REAL_ID = '40bea3f6-68c0-4f3b-96fa-336dfb7a9034';
const SPEED = 300;

const db = testDb();
const log = silentLog;
const product = `m4-push-exit-${randomUUID().slice(0, 8)}`;
const adapter = { ...wnbaAdapter, product };

/** Refuses every guard check after the first `allowed` (the in-loop refusal path). */
class RefusingGuard extends QuotaGuard {
  seen = 0;
  constructor(
    db: Db,
    private readonly allowed: number,
  ) {
    super({ db, log });
  }
  override async assertCall(
    p: string,
    source: Parameters<QuotaGuard['assertCall']>[1],
    reservationId: number | null = null,
  ) {
    if (++this.seen > this.allowed) {
      throw new QuotaRefusedError(p, 'below_reserve', null, 'injected: budget exhausted');
    }
    return super.assertCall(p, source, reservationId);
  }
}

const config: Config = loadConfig({
  DATABASE_URL: process.env.DATABASE_URL,
  DATABASE_SESSION_URL: process.env.DATABASE_URL,
  SUPABASE_URL: process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321',
  SUPABASE_SERVICE_ROLE_KEY: 'not-used-here',
  MODE: 'trial',
  SPORTRADAR_WNBA_KEY: 'push-exit-made-up-key',
  SPORTRADAR_BASE_URL: 'http://127.0.0.1:9', // loopback shape; fetchImpl answers, nothing listens
});

/** A seeded live game and its documents (the recording's Q1, relabelled; one tip-off everywhere). */
async function liveGame(status = 'inprogress') {
  const { gameId, providerGameId } = await seedGame(db, pbpQ1());
  const tipOff = new Date(Date.now() - 30 * 60_000).toISOString();
  await db`update public.games set scheduled_at = ${tipOff} where id = ${gameId}`;
  const doc = (feed: string, s = status) => ({
    ...(relabelDoc(fixture(`${R}-${feed}-q1.json`), REAL_ID, providerGameId) as Record<
      string,
      unknown
    >),
    scheduled: tipOff,
    status: s,
  });
  const game = await resolveGame(db, 'wnba', providerGameId);
  if (!game) throw new Error('seeded game missing');
  return { game, gameId, doc };
}

async function watchRows(runId: number) {
  const [run] = await db<{ status: string; error: string | null; retries: unknown }[]>`
    select status, error, meta->'retries' as retries from ingest.ingestion_runs where id = ${runId}`;
  const subs = await db<
    {
      kind: string;
      status: string;
      error: string | null;
      push: Record<string, { status: string }>;
    }[]
  >`
    select kind, status, error, meta->'push' as push from ingest.ingestion_runs
    where parent_run_id = ${runId} order by id`;
  const [res] = await db<{ releasedAt: Date | null; used: number }[]>`
    select released_at as "releasedAt", used_calls as used
    from ingest.budget_reservations where run_id = ${runId}`;
  return { run, subs, res };
}

beforeAll(async () => {
  await db`select 1`;
  await db`insert into ingest.product_quotas (product, limit_30d, qps, reserve, note, verified_at)
           values (${product}, 1000, 1, 100, 'push exit integration', now())`;
});
afterAll(async () => {
  await db`update ingest.budget_reservations set product = 'wnba', released_at = coalesce(released_at, now()),
             note = coalesce(note, '') || ' [integration product row removed]' where product = ${product}`;
  await db`delete from ingest.product_quotas where product = ${product}`;
  await db.end();
});

describe('push watch non-happy exits (review should 2)', () => {
  it('(a) an in-loop quota refusal: streams stop, push_stream sub-run ends error, retries stored, reservation released', async () => {
    const { game, doc } = await liveGame();
    const provider = scriptedProvider();
    provider.docs = { pbp: doc('pbp'), summary: doc('summary'), boxscore: doc('boxscore') };
    // Guard checks in order: push_events, push_clock (both opened before the loop), the t=0 pbp;
    // the fourth (the summary half an interval later) is refused inside the cadence loop.
    const guard = new RefusingGuard(db, 3);
    await expect(
      runTrialWatch(
        {
          db,
          log,
          config,
          adapter,
          guard,
          pulse: null,
          isStopped: () => false,
          fetchImpl: provider.fetchImpl,
        },
        { game, profile: 'full', speed: SPEED, push: true },
      ),
    ).rejects.toMatchObject({ reason: 'below_reserve' });
    expect(guard.seen).toBe(4);
    // Never sent: the refused summary reached no provider (the t=0 pbp did; a stream that passed
    // the guard but was still waiting for its slot when the watch failed is stopped unsent).
    const sent = provider.requests.map((r) => r.feed);
    expect(sent).toContain('pbp');
    expect(sent.filter((f) => f !== 'pbp' && f !== 'push_events' && f !== 'push_clock')).toEqual(
      [],
    );
    expect(sent.filter((f) => f === 'pbp')).toHaveLength(1);
    expect(provider.openStreams).toBe(0);
    const [last] = (await guard.reservations({ product })).slice(-1);
    if (!last?.runId) throw new Error('no reservation for the watch');
    const { run, subs, res } = await watchRows(last.runId);
    expect(run).toMatchObject({ status: 'error', error: expect.stringMatching(/quota refused/) });
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({
      kind: 'push_stream',
      status: 'error',
      error: expect.stringMatching(/quota refused/),
    });
    expect(subs[0]?.push.push_events?.status).toBe('stopped');
    expect(subs[0]?.push.push_clock?.status).toBe('stopped');
    expect(RetryReportSchema.parse(run?.retries)).toEqual({
      used: 0,
      allowance: 6,
      retried429: 0,
      retriedClosing: 0,
    });
    expect(res?.releasedAt).toBeInstanceOf(Date);
    const [logged] = await db<{ n: number }[]>`
      select count(*)::int as n from ingest.provider_calls where reservation_id = ${last.id}`;
    expect(res?.used).toBe(logged?.n);
    expect(res?.used).toBe(sent.length);
  }, 60_000);

  for (const terminal of ['postponed', 'cancelled'] as const) {
    it(`(b) the game turns ${terminal} mid-watch: closing set minus the reporter, streams stop, the watch returns, retries stored, reservation released`, async () => {
      const { game, gameId, doc } = await liveGame();
      const provider = scriptedProvider();
      provider.docs = { pbp: doc('pbp'), summary: doc('summary'), boxscore: doc('boxscore') };
      // After the first (live) pbp every feed reports the terminal status; the summary half an
      // interval later is the first to say so.
      let switched = false;
      provider.onServe = (feed) => {
        if (feed === 'pbp' && !switched) {
          switched = true;
          provider.docs = {
            pbp: doc('pbp', terminal),
            summary: doc('summary', terminal),
            boxscore: doc('boxscore', terminal),
          };
        }
      };
      const guard = new QuotaGuard({ db, log });
      const out = await runTrialWatch(
        {
          db,
          log,
          config,
          adapter,
          guard,
          pulse: null,
          isStopped: () => false,
          fetchImpl: provider.fetchImpl,
        },
        { game, profile: 'full', speed: SPEED, push: true },
      );
      expect(out.status).toBe(terminal);
      // pbp (live) -> summary reports the terminal status -> the closing set without the summary.
      expect(
        provider.requests
          .map((r) => r.feed)
          .filter((f) => f !== 'push_events' && f !== 'push_clock'),
      ).toEqual(['pbp', 'summary', 'pbp', 'boxscore']);
      expect(provider.openStreams).toBe(0);
      expect(provider.tooClose).toBe(0);
      expect(out.push?.streams.map((s) => s.status)).toEqual(['stopped', 'stopped']);
      expect(out.push?.backfills).toBe(0);
      const { run, subs, res } = await watchRows(out.runId);
      expect(run?.status).toBe('ok');
      expect(subs).toEqual([
        expect.objectContaining({ kind: 'push_stream', status: 'ok', error: null }),
      ]);
      expect(RetryReportSchema.parse(run?.retries)).toEqual(out.retries);
      expect(out.retries).toEqual({ used: 0, allowance: 6, retried429: 0, retriedClosing: 0 });
      expect(res?.releasedAt).toBeInstanceOf(Date);
      expect(res?.used).toBe(6); // 2 stream connections + pbp + summary + closing pbp + boxscore
      expect(out.reservation.usedCalls).toBe(6);
      const [g] = await db<{ status: string }[]>`
        select status::text as status from public.games where id = ${gameId}`;
      expect(g?.status).toBe(terminal);
    }, 60_000);
  }
});
