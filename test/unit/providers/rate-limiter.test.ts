import { describe, expect, it } from 'vitest';
import {
  RateLimiter,
  rateLimiterFor,
  type SlotClaim,
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

describe('RateLimiter (1 s slots per product)', () => {
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
    expect(rateLimiterFor('unit-test-product').minIntervalMs).toBe(1200);
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
});
