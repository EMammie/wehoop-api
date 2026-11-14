import { describe, expect, it } from 'vitest';
import type { Db } from '../../../src/db/client.js';
import {
  claimSlot,
  RateLimiter,
  rateLimiterFor,
  type SlotClaim,
  SlotClaimTimeoutError,
  type SlotStore,
} from '../../../src/providers/sportradar/rate-limiter.js';

/** A fake clock whose sleep advances time, so slot spacing is checked without waiting. */
function fakeClock(start = 1_000_000) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('RateLimiter (slots per product)', () => {
  it('spaces concurrent callers one interval apart regardless of arrival order', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ minIntervalMs: 1000, now: clock.now, sleep: clock.sleep });
    const slots = await Promise.all([
      limiter.waitForSlot(),
      limiter.waitForSlot(),
      limiter.waitForSlot(),
    ]);
    expect(slots).toEqual([1_000_000, 1_001_000, 1_002_000]);
    expect(limiter.granted).toBe(3);
  });

  it('grants immediately when the last slot is older than the interval', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ minIntervalMs: 1000, now: clock.now, sleep: clock.sleep });
    await limiter.waitForSlot();
    clock.advance(5_000);
    expect(await limiter.waitForSlot()).toBe(1_005_000);
    expect(clock.sleeps).toEqual([]);
  });

  it('waits until the wall clock has really reached the slot (timers may fire early)', async () => {
    let t = 0;
    let calls = 0;
    const limiter = new RateLimiter({
      minIntervalMs: 1000,
      now: () => t,
      sleep: async (ms) => {
        calls++;
        t += Math.max(1, ms - 1); // fires 1 ms early (a real timer still advances at least 1 ms)
      },
    });
    await limiter.waitForSlot();
    const slot = await limiter.waitForSlot();
    expect(slot).toBe(1000);
    expect(t).toBeGreaterThanOrEqual(1000);
    expect(calls).toBe(2);
  });

  it('a zero interval never waits; the registry shares one limiter per product', async () => {
    const limiter = new RateLimiter({ minIntervalMs: 0 });
    await Promise.all([limiter.waitForSlot(), limiter.waitForSlot()]);
    expect(limiter.granted).toBe(2);
    expect(rateLimiterFor('unit-test-product')).toBe(rateLimiterFor('unit-test-product'));
    expect(rateLimiterFor('unit-test-product').minIntervalMs).toBe(2000);
    expect(rateLimiterFor('unit-test-product').product).toBe('unit-test-product');
    expect(rateLimiterFor('unit-test-product').shared).toBe(false);
    expect(rateLimiterFor('unit-test-other')).not.toBe(rateLimiterFor('unit-test-product'));
  });

  it('real timers: two slots are at least 1 s apart on the wall clock', async () => {
    const limiter = new RateLimiter({ minIntervalMs: 200 });
    const a = await limiter.waitForSlot();
    const b = await limiter.waitForSlot();
    expect(b - a).toBeGreaterThanOrEqual(200);
    expect(Date.now()).toBeGreaterThanOrEqual(b);
  });
});

/**
 * A SlotStore standing in for ingest.provider_rate_slots: one ledger shared by
 * several RateLimiter instances (several processes), on its own clock.
 */
function fakeStore(storeClock: () => number, skewMs = 0) {
  const next = new Map<string, number>();
  const claims: Array<{ product: string; slotAt: number }> = [];
  const store: SlotStore = {
    async claim(product, minIntervalMs): Promise<SlotClaim> {
      const now = storeClock() + skewMs;
      const slot = Math.max(next.get(product) ?? now, now);
      next.set(product, slot + minIntervalMs);
      claims.push({ product, slotAt: slot });
      return { slotAt: new Date(slot), delayMs: slot - now };
    },
  };
  return { store, claims, next };
}

describe('RateLimiter with a shared SlotStore (cross-process spacing, plan rev 4.6)', () => {
  it('two limiters (two processes) on one store never get slots closer than the interval', async () => {
    const clock = fakeClock();
    const { store, claims } = fakeStore(clock.now);
    const a = new RateLimiter({
      minIntervalMs: 1000,
      store,
      product: 'ncaawb',
      now: clock.now,
      sleep: clock.sleep,
    });
    const b = new RateLimiter({
      minIntervalMs: 1000,
      store,
      product: 'ncaawb',
      now: clock.now,
      sleep: clock.sleep,
    });
    // "plan" in process A, then "watch" in process B within the same second.
    const first = await a.waitForSlot();
    clock.advance(400);
    const second = await b.waitForSlot();
    expect(first).toBe(1_000_000);
    expect(second).toBe(1_001_000);
    expect(clock.now()).toBeGreaterThanOrEqual(1_001_000); // B really waited
    expect(claims.map((c) => c.slotAt)).toEqual([1_000_000, 1_001_000]);
    expect(a.shared && b.shared).toBe(true);
    expect(a.claimed + b.claimed).toBe(2);
    expect(a.granted + b.granted).toBe(2);
  });

  it('concurrent claimants across two limiters are serialized by the store, not by arrival', async () => {
    const clock = fakeClock();
    const { store } = fakeStore(clock.now);
    const mk = () =>
      new RateLimiter({
        minIntervalMs: 1000,
        store,
        product: 'wnba',
        now: clock.now,
        sleep: clock.sleep,
      });
    const a = mk();
    const b = mk();
    const slots = await Promise.all([a.waitForSlot(), b.waitForSlot(), a.waitForSlot()]);
    expect([...slots].sort((x, y) => x - y)).toEqual([1_000_000, 1_001_000, 1_002_000]);
  });

  it('concurrent callers of ONE limiter leave an interval apart even when their store claims finish out of order', async () => {
    // Real clock, slow first claim: without chaining, caller A took local floor t0 and caller B
    // t0+200, B's claim finished first (store slot t0) and A's second (t0+200); B slept to its
    // floor t0+200 and A to its store slot t0+200, so both requests left together.
    const interval = 200;
    let next = 0;
    const latencies = [30, 0];
    const store: SlotStore = {
      async claim(_product, minIntervalMs): Promise<SlotClaim> {
        const latency = latencies.shift() ?? 0;
        await new Promise((r) => setTimeout(r, latency));
        const now = Date.now();
        const slot = Math.max(next, now);
        next = slot + minIntervalMs;
        return { slotAt: new Date(slot), delayMs: slot - now };
      },
    };
    const limiter = new RateLimiter({ minIntervalMs: interval, store, product: 'wnba' });
    const departures: number[] = [];
    const call = async () => {
      const slot = await limiter.waitForSlot();
      departures.push(Date.now());
      return slot;
    };
    const slots = await Promise.all([call(), call()]);
    expect(slots[1] - slots[0]).toBeGreaterThanOrEqual(interval); // store order = call order
    departures.sort((a, b) => a - b);
    expect((departures[1] ?? 0) - (departures[0] ?? 0)).toBeGreaterThanOrEqual(interval - 30);
  });

  it('a rejected store claim reaches its own caller and does not poison later callers', async () => {
    const clock = fakeClock();
    const { store: inner } = fakeStore(clock.now);
    let n = 0;
    const store: SlotStore = {
      async claim(product, minIntervalMs) {
        n++;
        if (n === 2) throw new Error('db down');
        return inner.claim(product, minIntervalMs);
      },
    };
    const limiter = new RateLimiter({
      minIntervalMs: 1000,
      store,
      product: 'wnba',
      now: clock.now,
      sleep: clock.sleep,
    });
    const results = await Promise.allSettled([
      limiter.waitForSlot(),
      limiter.waitForSlot(),
      limiter.waitForSlot(),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect((results[1] as PromiseRejectedResult).reason).toEqual(new Error('db down'));
    const [a, , c] = results as PromiseFulfilledResult<number>[];
    expect((c?.value ?? 0) - (a?.value ?? 0)).toBe(1000);
    expect(limiter.granted).toBe(3);
    expect(limiter.claimed).toBe(2);
    await limiter.waitForSlot();
    expect(limiter.claimed).toBe(3);
  });

  it('a claim that never answers times out for its caller; later callers of the limiter still get slots', async () => {
    const clock = fakeClock();
    const { store: inner } = fakeStore(clock.now);
    let n = 0;
    const store: SlotStore = {
      claim(product, minIntervalMs) {
        n++;
        if (n === 1) return new Promise<SlotClaim>(() => undefined); // hung connection
        return inner.claim(product, minIntervalMs);
      },
    };
    await expect(claimSlot(store, 'wnba', 1000, 20)).rejects.toEqual(
      new SlotClaimTimeoutError('wnba', 20),
    );
    n = 0;
    const limiter = new RateLimiter({
      minIntervalMs: 1000,
      store,
      product: 'wnba',
      now: clock.now,
      sleep: clock.sleep,
      claimTimeoutMs: 20,
    });
    const results = await Promise.allSettled([limiter.waitForSlot(), limiter.waitForSlot()]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled']);
    expect((results[0] as PromiseRejectedResult).reason).toBeInstanceOf(SlotClaimTimeoutError);
    expect(limiter.claimed).toBe(1);
  });

  it('the delay is taken on the store clock: a process clock ahead of the database still waits the full gap', async () => {
    // Process clock reads 5 s AHEAD of the store clock. A naive `sleep(slotAt - localNow)` would
    // not wait at all; the limiter sleeps `delayMs` as the store measured it.
    const clock = fakeClock(1_000_000);
    const { store } = fakeStore(clock.now, -5_000);
    const a = new RateLimiter({
      minIntervalMs: 1000,
      store,
      product: 'p',
      now: clock.now,
      sleep: clock.sleep,
    });
    const b = new RateLimiter({
      minIntervalMs: 1000,
      store,
      product: 'p',
      now: clock.now,
      sleep: clock.sleep,
    });
    const first = await a.waitForSlot();
    const second = await b.waitForSlot();
    expect(first).toBe(995_000); // store clock
    expect(second).toBe(996_000);
    expect(clock.sleeps.reduce((x, y) => x + y, 0)).toBe(1000); // B slept the store's delay
  });

  it('the local schedule stays a floor: a permissive store never grants earlier than the in-process slot', async () => {
    const clock = fakeClock();
    const store: SlotStore = {
      // Always "now": the in-process spacing still holds.
      async claim(): Promise<SlotClaim> {
        return { slotAt: new Date(clock.now()), delayMs: -500 };
      },
    };
    const limiter = new RateLimiter({
      minIntervalMs: 1000,
      store,
      product: 'p',
      now: clock.now,
      sleep: clock.sleep,
    });
    await limiter.waitForSlot();
    await limiter.waitForSlot();
    expect(clock.now()).toBeGreaterThanOrEqual(1_001_000);
  });

  it('a store needs a product; the registry upgrades a limiter in place once a db is known', () => {
    expect(() => new RateLimiter({ store: fakeStore(() => 0).store })).toThrow(/product/);
    const limiter = rateLimiterFor('unit-test-upgrade');
    expect(limiter.shared).toBe(false);
    limiter.useStore(fakeStore(() => 0).store);
    expect(limiter.shared).toBe(true);
    expect(rateLimiterFor('unit-test-upgrade')).toBe(limiter);
  });

  it('the registry binds the store to the db instance: the same db keeps it, a different one replaces it', () => {
    const dbA = { tag: 'a' } as unknown as Db;
    const dbB = { tag: 'b' } as unknown as Db;
    const limiter = rateLimiterFor('unit-test-rebind', { db: dbA });
    expect(limiter.shared).toBe(true);
    const storeA = limiter.slotStore;
    expect(rateLimiterFor('unit-test-rebind', { db: dbA }).slotStore).toBe(storeA);
    expect(rateLimiterFor('unit-test-rebind').slotStore).toBe(storeA); // no db: keep what we have
    const storeB = rateLimiterFor('unit-test-rebind', { db: dbB }).slotStore;
    expect(storeB).not.toBe(storeA);
    expect(rateLimiterFor('unit-test-rebind', { db: dbB }).slotStore).toBe(storeB);
  });
});
