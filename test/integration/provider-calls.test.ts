import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { QuotaGuard } from '../../src/ingest/quota-guard.js';
import { SportradarHttp } from '../../src/providers/sportradar/http.js';
import { PgSlotStore, RateLimiter } from '../../src/providers/sportradar/rate-limiter.js';
import {
  ProdUrlResolver,
  redactUrl,
  SimulationUrlResolver,
} from '../../src/providers/sportradar/urls.js';
import { silentLog, testDb } from '../helpers/db.js';

const db = testDb();
beforeAll(async () => {
  await db`select 1`;
});
afterAll(async () => {
  // The trial call below is quota-counted; left behind it would lower ingest.v_quota.remaining
  // for schema.test.ts ("seeds a quota row per product") depending on file order.
  await db`delete from ingest.provider_calls where quota_counted and run_id is null and url like '%/games/g1/summary.json'`;
  await db.end();
});

const fakeFetch = (status = 200, body: unknown = { ok: true }): typeof fetch =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

describe('provider_calls accounting (CLAUDE.md non-negotiable 8)', () => {
  it('simulation calls are logged with quota_counted=false; trial calls with quota_counted=true and product', async () => {
    const sim = new SportradarHttp({
      db,
      log: silentLog,
      league: 'wnba',
      runId: null,
      fetchImpl: fakeFetch(),
      resolver: new SimulationUrlResolver({
        playbackUrl: 'https://playback.sportradar.com',
        league: 'wnba',
        recordingId: 'rec-1',
        sessionId: 'sess-1',
      }),
    });
    const doc = await sim.getJson('pbp', z.object({ ok: z.boolean() }));
    expect(doc.data.ok).toBe(true);
    expect(doc.requestedAt.getTime()).toBeLessThanOrEqual(doc.receivedAt.getTime());
    const resolver = new ProdUrlResolver({
      league: 'wnba',
      accessLevel: 'trial',
      apiKey: 'not-a-real-key',
    });
    // A counted source must be rate-limited and quota-guarded by construction.
    expect(
      () => new SportradarHttp({ db, log: silentLog, league: 'wnba', runId: null, resolver }),
    ).toThrow(/RateLimiter and a QuotaGuard/);
    const trial = new SportradarHttp({
      db,
      log: silentLog,
      league: 'wnba',
      runId: null,
      fetchImpl: fakeFetch(),
      resolver,
      // A rate-limited source claims its slot from the shared ledger (rev 4.6), even at interval 0.
      limiter: new RateLimiter({ minIntervalMs: 0, store: new PgSlotStore(db), product: 'wnba' }),
      // The seeded wnba row is unverified; the config override stands in for the console limit.
      guard: new QuotaGuard({
        db,
        log: silentLog,
        overrides: { wnba: { limit30d: 1000, reserve: 100 } },
      }),
    });
    await trial.getJson('summary', z.object({ ok: z.boolean() }), { gameId: 'g1' });
    const rows = await db<
      {
        source: string;
        feed: string;
        quotaCounted: boolean;
        product: string | null;
        url: string;
        status: number;
      }[]
    >`
      select source::text as source, feed, quota_counted as "quotaCounted", product, url, status
      from ingest.provider_calls where url like '%rec-1%' or url like '%/games/g1/%' order by id desc limit 2`;
    const bySource = Object.fromEntries(rows.map((r) => [r.source, r]));
    expect(bySource.simulation).toMatchObject({ feed: 'pbp', quotaCounted: false, status: 200 });
    expect(bySource.trial).toMatchObject({
      feed: 'summary',
      quotaCounted: true,
      product: 'wnba',
      status: 200,
    });
    expect(bySource.trial?.url).not.toContain('not-a-real-key');
  });

  it('a failed call is logged with its status and the schema rejects a malformed body', async () => {
    const http = new SportradarHttp({
      db,
      log: silentLog,
      league: 'wnba',
      runId: null,
      fetchImpl: fakeFetch(503, { error: 'down' }),
      resolver: new SimulationUrlResolver({
        playbackUrl: 'https://playback.sportradar.com',
        league: 'wnba',
        recordingId: 'rec-503',
        sessionId: 's',
      }),
    });
    await expect(http.getJson('pbp', z.object({ ok: z.boolean() }))).rejects.toThrow(/HTTP 503/);
    const [row] = await db<
      { status: number }[]
    >`select status from ingest.provider_calls where url like '%rec-503%' order by id desc limit 1`;
    expect(row?.status).toBe(503);
    const bad = new SportradarHttp({
      db,
      log: silentLog,
      league: 'wnba',
      runId: null,
      fetchImpl: fakeFetch(200, { ok: 'yes' }),
      resolver: new SimulationUrlResolver({
        playbackUrl: 'https://playback.sportradar.com',
        league: 'wnba',
        recordingId: 'rec-bad',
        sessionId: 's',
      }),
    });
    await expect(bad.getJson('pbp', z.object({ ok: z.boolean() }))).rejects.toThrow(
      /schema mismatch/,
    );
  });

  it('a request that never connects is one provider_calls row: null status, counted once, error propagated', async () => {
    // Live run 2026-11-02, call 1201: a connect timeout before any response. Sportradar's console
    // did not count it, but the ledger must (it cannot know); the reservation is charged once.
    const product = `never-${randomUUID().slice(0, 8)}`;
    await db`insert into ingest.product_quotas (product, limit_30d, qps, reserve, note, verified_at)
             values (${product}, 1000, 1, 100, 'integration: never-connected call', now())`;
    try {
      const guard = new QuotaGuard({ db, log: silentLog });
      const reservation = await guard.reserve({
        product,
        gameId: null,
        profile: 'full',
        calls: 5,
        source: 'trial',
      });
      const connectTimeout = new TypeError('fetch failed', {
        cause: Object.assign(new Error('Connect Timeout Error'), {
          code: 'UND_ERR_CONNECT_TIMEOUT',
        }),
      });
      const http = new SportradarHttp({
        db,
        log: silentLog,
        league: 'ncaawb',
        product,
        runId: null,
        resolver: new ProdUrlResolver({
          league: 'ncaawb',
          accessLevel: 'trial',
          apiKey: 'not-a-real-key',
        }),
        limiter: new RateLimiter({ minIntervalMs: 0, store: new PgSlotStore(db), product }),
        guard,
        reservationId: reservation.id,
        fetchImpl: (async () => {
          throw connectTimeout;
        }) as typeof fetch,
      });
      await expect(http.getJson('pbp', z.object({}), { gameId: 'g-never' })).rejects.toBe(
        connectTimeout,
      );
      const rows = await db<
        { status: number | null; quotaCounted: boolean; bytes: number; reservationId: string }[]
      >`
        select status, quota_counted as "quotaCounted", bytes, reservation_id::text as "reservationId"
        from ingest.provider_calls where product = ${product}`;
      expect(rows).toEqual([
        { status: null, quotaCounted: true, bytes: 0, reservationId: String(reservation.id) },
      ]);
      expect({ calls: http.calls, refused: http.refused }).toEqual({ calls: 1, refused: 0 });
      expect((await guard.reservation(reservation.id))?.usedCalls).toBe(1);
      await guard.release(reservation.id);
    } finally {
      await db`delete from ingest.provider_calls where product = ${product}`;
      await db`delete from ingest.budget_reservations where product = ${product}`;
      await db`delete from ingest.provider_rate_slots where product = ${product}`;
      await db`delete from ingest.product_quotas where product = ${product}`;
    }
  });

  it('redactUrl strips credential-looking query parameters', () => {
    expect(redactUrl('https://api.sportradar.com/wnba/trial/v8/en/x.json?api_key=abc&foo=1')).toBe(
      'https://api.sportradar.com/wnba/trial/v8/en/x.json?api_key=redacted&foo=1',
    );
  });
});
