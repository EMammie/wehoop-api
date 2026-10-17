/**
 * RateLimiter (plan §4 "Rate/quota"): grants slots at least `minIntervalMs`
 * apart across concurrent callers. Modelled on the Wehoop iOS actor: slot
 * assignment is serialized, so N concurrent callers get t, t+1 s, t+2 s, ...
 * regardless of arrival order. Sportradar trial and production keys allow
 * 1 request/second per product; exceeding it returns HTTP 429.
 *
 * One limiter per product per process (`rateLimiterFor`), shared by every
 * SportradarHttp that talks to that product, so two watchers on one trial key
 * cannot overlap.
 */
/**
 * 1 s slots with a 50 ms margin: the provider measures spacing on arrival, and
 * two requests dispatched exactly 1 s apart can arrive a few ms closer once
 * the keep-alive connection is warm (seen against the local fake provider).
 * `provider_calls.called_at` spacing therefore stays >= 1 s with room to spare.
 */
export const DEFAULT_MIN_INTERVAL_MS = 1050;

export class RateLimiter {
  private nextSlot: number | null = null;
  readonly minIntervalMs: number;
  /** Slots granted so far (observability). */
  granted = 0;

  constructor(
    opts: {
      minIntervalMs?: number;
      now?: () => number;
      sleep?: (ms: number) => Promise<void>;
    } = {},
  ) {
    this.minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  /**
   * Resolves when the caller's slot has arrived, returning the slot time (ms
   * epoch). The slot is claimed synchronously, before any await, so concurrent
   * callers never share one.
   */
  async waitForSlot(): Promise<number> {
    const now = this.now();
    const slot = Math.max(this.nextSlot ?? now, now);
    this.nextSlot = slot + this.minIntervalMs;
    this.granted++;
    if (this.minIntervalMs <= 0) return slot;
    // Timers may fire a hair early; sleep until the wall clock has really reached the slot.
    for (let t = this.now(); t < slot; t = this.now()) await this.sleep(slot - t);
    return slot;
  }
}

const registry = new Map<string, RateLimiter>();

/** The process-wide limiter for one product (quota bucket). */
export function rateLimiterFor(
  product: string,
  minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
): RateLimiter {
  let limiter = registry.get(product);
  if (!limiter) {
    limiter = new RateLimiter({ minIntervalMs });
    registry.set(product, limiter);
  }
  return limiter;
}
