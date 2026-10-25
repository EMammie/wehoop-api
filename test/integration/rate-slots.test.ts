import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createDb, type Db } from '../../src/db/client.js';
import { QuotaGuard } from '../../src/ingest/quota-guard.js';
import {
  type FakeProvider,
  startFakeProvider,
} from '../../src/providers/sportradar/fake-provider.js';
import { SportradarHttp } from '../../src/providers/sportradar/http.js';
import {
  DEFAULT_MIN_INTERVAL_MS,
  PgSlotStore,
  RateLimiter,
} from '../../src/providers/sportradar/rate-limiter.js';
import { ProdUrlResolver } from '../../src/providers/sportradar/urls.js';
import { silentLog, testDb } from '../helpers/db.js';

/**
 * Cross-process request spacing (plan rev 4.6, §4 "Rate/quota"; evidence M3
 * item 1c): the 1 req/s per product must hold across every process that
 * shares the database, not just inside one. Two independent SportradarHttp
 * clients, each with its own RateLimiter, its own PgSlotStore and its own
 * connection pool (two processes in all but the pid), fire concurrently at the
 * local fake provider, which answers 429 to anything closer than 1 s.
 */
const FULL = new URL('../../fixtures/ncaawb/sim-d9b71fe0-replay.compact.jsonl.gz', import.meta.url)
  .pathname;
const Doc = z.object({ id: z.string() }).loose();

const db = testDb();
const product = `m3-slots-${randomUUID().slice(0, 8)}`;
const url = process.env.DATABASE_URL ?? '';
let server: FakeProvider;

/** One "process": its own pool, limiter and slot store; nothing shared but the database. */
function processLike(): { db: Db; http: SportradarHttp; limiter: RateLimiter } {
  const own = createDb(url, { max: 2 });
  const limiter = new RateLimiter({ store: new PgSlotStore(own), product });
  const http = new SportradarHttp({
    db: own,
    log: silentLog,
    league: 'ncaawb',
    product,
    runId: null,
    resolver: new ProdUrlResolver({
      league: 'ncaawb',
      accessLevel: 'trial',
      apiKey: `rehearsal-${randomUUID()}`, // made up; the fake host accepts any value
      baseUrl: server.url,
    }),
    limiter,
    guard: new QuotaGuard({ db: own, log: silentLog }),
  });
  return { db: own, http, limiter };
}

async function gaps(): Promise<{ calledAt: Date; gapMs: number | null; status: number }[]> {
  return db<{ calledAt: Date; gapMs: number | null; status: number }[]>`
    select called_at as "calledAt", status,
           (extract(epoch from (called_at - lag(called_at) over (order by called_at, id))) * 1000)::int as "gapMs"
    from ingest.provider_calls
    where product = ${product} and source in ('trial', 'production', 'rehearsal')
    order by called_at, id`;
}

beforeAll(async () => {
  await db`select 1`;
  await db`insert into ingest.product_quotas (product, limit_30d, qps, reserve, note, verified_at)
           values (${product}, 1000, 1, 100, 'integration: cross-process spacing', now())`;
  server = await startFakeProvider({ replayFile: FULL, speed: 1000, minSpacingMs: 1000 });
});
afterAll(async () => {
  await server.close();
  await db`delete from ingest.product_quotas where product = ${product}`;
  await db.end();
});

describe('ingest.provider_rate_slots (shared slot ledger)', () => {
  it('PgSlotStore.claim hands out slots one interval apart on the database clock and creates the row on the fly', async () => {
    const store = new PgSlotStore(db);
    expect(
      await db`select 1 from ingest.provider_rate_slots where product = ${product}`,
    ).toHaveLength(0);
    const a = await store.claim(product, 1050);
    const b = await store.claim(product, 1050);
    expect(b.slotAt.getTime() - a.slotAt.getTime()).toBe(1050);
    expect(a.delayMs).toBeLessThanOrEqual(5); // idle product: now
    expect(b.delayMs).toBeGreaterThan(900); // the next second belongs to the first claimant
    const [row] = await db<{ nextSlotAt: Date }[]>`
      select next_slot_at as "nextSlotAt" from ingest.provider_rate_slots where product = ${product}`;
    expect(row?.nextSlotAt.getTime()).toBe(b.slotAt.getTime() + 1050);
    // Leave the ledger idle again for the next test (slots are never handed out early).
    await new Promise((r) => setTimeout(r, Math.max(0, b.delayMs) + 1100));
  });

  it('two independent clients (two processes) interleaving calls: 0 x 429, every called_at gap >= 1 s', async () => {
    const a = processLike();
    const b = processLike();
    const before = server.stats.requests;
    try {
      const burst = async (p: ReturnType<typeof processLike>, n: number) => {
        for (let i = 0; i < n; i++) {
          await p.http.getJson('summary', Doc, { gameId: server.providerGameId });
        }
      };
      // Both start inside the same millisecond, like `pnpm trial plan` and the watch it precedes.
      await Promise.all([burst(a, 3), burst(b, 3)]);
      expect(server.stats.requests - before).toBe(6);
      expect(server.stats.rejected429).toBe(0);
      expect(server.stats.rejected401).toBe(0);
      expect(a.http.calls + b.http.calls).toBe(6);
      expect(a.limiter.claimed).toBe(3);
      expect(b.limiter.claimed).toBe(3);
      const rows = await gaps();
      expect(rows).toHaveLength(6);
      for (const r of rows) expect(r.status).toBe(200);
      const measured = rows.map((r) => r.gapMs).filter((g): g is number => g !== null);
      expect(measured).toHaveLength(5);
      for (const g of measured) expect(g).toBeGreaterThanOrEqual(1000);
      // The ledger sits one interval past the newest call: the next process, whatever it is, waits.
      const [slot] = await db<{ nextSlotAt: Date }[]>`
        select next_slot_at as "nextSlotAt" from ingest.provider_rate_slots where product = ${product}`;
      const newest = rows.at(-1)?.calledAt.getTime() ?? 0;
      expect(slot?.nextSlotAt.getTime()).toBe(newest + DEFAULT_MIN_INTERVAL_MS);
      // The invariant the validator runs (`pnpm invariants`) over this product's rows.
      const [inv] = await db<{ n: number }[]>`
        select count(*)::int as n from ingest.provider_calls pc
        join ingest.provider_rate_slots s on s.product = pc.product
        where pc.product = ${product} and pc.source in ('trial', 'production', 'rehearsal')
          and pc.called_at > s.next_slot_at - interval '1 second'`;
      expect(inv?.n).toBe(0);
    } finally {
      await a.db.end();
      await b.db.end();
    }
  }, 30_000);

  it('removing the product removes its slot row (cascade), so a test or decommissioned product leaves nothing behind', async () => {
    const tmp = `m3-slots-tmp-${randomUUID().slice(0, 8)}`;
    await db`insert into ingest.product_quotas (product, limit_30d, qps, reserve, note)
             values (${tmp}, 10, 1, 1, 'integration: cascade')`;
    await new PgSlotStore(db).claim(tmp, 1050);
    expect(await db`select 1 from ingest.provider_rate_slots where product = ${tmp}`).toHaveLength(
      1,
    );
    await db`delete from ingest.product_quotas where product = ${tmp}`;
    expect(await db`select 1 from ingest.provider_rate_slots where product = ${tmp}`).toHaveLength(
      0,
    );
  });
});
