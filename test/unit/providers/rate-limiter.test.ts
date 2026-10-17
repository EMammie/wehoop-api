import { describe, expect, it } from 'vitest';
import { RateLimiter, rateLimiterFor } from '../../../src/providers/sportradar/rate-limiter.js';

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
    expect(rateLimiterFor('unit-test-product').minIntervalMs).toBe(1050);
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
