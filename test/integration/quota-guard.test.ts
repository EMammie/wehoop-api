import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QuotaGuard, QuotaRefusedError } from '../../src/ingest/quota-guard.js';
import { silentLog, testDb } from '../helpers/db.js';

/**
 * QuotaGuard (plan §4 "Rate/quota"): reads ingest.v_quota / product_quotas,
 * refuses a call or a reservation when remaining - reserved < reserve, refuses
 * everything while the limit is unverified unless a config override names the
 * product, and never refuses or counts simulation/fixture sources.
 */
const db = testDb();
const product = `m3-guard-${randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  await db`insert into ingest.product_quotas (product, limit_30d, qps, reserve, note)
           values (${product}, 100, 1, 30, 'integration test; unverified on purpose')`;
});
afterAll(async () => {
  // The watch runs stay (games.watch_run_id restricts their deletion), so their reservations stay
  // too and are re-homed under the seeded product; released, they count for nothing.
  await db`update ingest.budget_reservations set product = 'ncaawb', released_at = coalesce(released_at, now()),
             note = coalesce(note, '') || ' [integration product row removed]' where product = ${product}`;
  await db`delete from ingest.product_quotas where product = ${product}`;
  await db.end();
});

describe('QuotaGuard', () => {
  it('refuses trial calls and reservations while the console limit is unverified; sim is never refused', async () => {
    const guard = new QuotaGuard({ db, log: silentLog });
    expect(await guard.checkCall(product, 'trial')).toMatchObject({
      ok: false,
      reason: 'unverified',
    });
    expect(await guard.checkCall(product, 'simulation')).toMatchObject({ ok: true });
    await expect(
      guard.reserve({ product, gameId: null, profile: 'full', calls: 10, source: 'trial' }),
    ).rejects.toBeInstanceOf(QuotaRefusedError);
    expect(await guard.reservations({ product })).toEqual([]);
    expect(await guard.checkCall('no-such-product', 'trial')).toMatchObject({
      ok: false,
      reason: 'unknown_product',
    });
  });

  it('a config override stands in for the console limit; reservations are refused below reserve and serialized', async () => {
    const guard = new QuotaGuard({
      db,
      log: silentLog,
      overrides: { [product]: { limit30d: 100, reserve: 30 } },
    });
    const before = (await guard.status()).find((s) => s.product === product);
    expect(before).toMatchObject({
      overridden: true,
      limit30d: 100,
      reserve: 30,
      used30d: 0,
      remaining: 100,
      reserved: 0,
      spendable: 70,
    });
    const first = await guard.reserve({
      product,
      gameId: null,
      profile: 'full',
      calls: 50,
      source: 'trial',
    });
    expect(first).toMatchObject({
      reservedCalls: 50,
      usedCalls: 0,
      source: 'trial',
      releasedAt: null,
    });
    expect((await guard.status()).find((s) => s.product === product)).toMatchObject({
      reserved: 50,
      spendable: 20,
    });
    // remaining 100 - reserved 50 - reserve 30 = 20 < 25
    await expect(
      guard.reserve({ product, gameId: null, profile: 'extended', calls: 25, source: 'trial' }),
    ).rejects.toMatchObject({ reason: 'below_reserve' });
    const second = await guard.reserve({
      product,
      gameId: null,
      profile: 'lean-full',
      calls: 20,
      source: 'trial',
    });
    expect((await guard.status()).find((s) => s.product === product)?.spendable).toBe(0);
    // Below reserve for a new call outside a reservation, but a call under a live reservation is fine.
    expect(await guard.checkCall(product, 'trial')).toMatchObject({
      ok: false,
      reason: 'below_reserve',
    });
    expect(await guard.checkCall(product, 'trial', first.id)).toMatchObject({ ok: true });
    await guard.recordUse(first.id);
    await guard.recordUse(first.id);
    expect((await guard.reservation(first.id))?.usedCalls).toBe(2);
    // Outstanding = reserved - used, so using budget frees nothing until released...
    expect((await guard.status()).find((s) => s.product === product)?.reserved).toBe(68);
    await guard.release(first.id);
    expect((await guard.reservation(first.id))?.releasedAt).toBeInstanceOf(Date);
    expect((await guard.status()).find((s) => s.product === product)).toMatchObject({
      reserved: 20,
      spendable: 50,
    });
    // Simulation reservations are recorded (rehearsal evidence) but never counted or refused.
    const sim = await guard.reserve({
      product,
      gameId: null,
      profile: 'full',
      calls: 9999,
      source: 'simulation',
    });
    expect(sim.source).toBe('simulation');
    expect((await guard.status()).find((s) => s.product === product)?.reserved).toBe(20);
    await guard.release(second.id);
    await guard.release(sim.id);
    await expect(
      guard.reserve({ product, gameId: null, profile: 'full', calls: 0, source: 'trial' }),
    ).rejects.toThrow(/positive integer/);
  });

  it('stamping verified_at (pnpm trial quota) lets the guard spend without an override', async () => {
    await db`update ingest.product_quotas set verified_at = now(), note = 'console 2026-11-01' where product = ${product}`;
    const guard = new QuotaGuard({ db, log: silentLog });
    const s = (await guard.status()).find((x) => x.product === product);
    expect(s?.verifiedAt).toBeInstanceOf(Date);
    expect(s?.overridden).toBe(false);
    expect(await guard.checkCall(product, 'trial')).toMatchObject({ ok: true });
  });
});
