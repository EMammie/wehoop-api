import type { Db } from '../../db/client.js';

/**
 * RateLimiter (plan §4 "Rate/quota"): grants slots at least `minIntervalMs`
 * apart across concurrent callers. Modelled on the Wehoop iOS actor: slot
 * assignment is serialized, so N concurrent callers get t, t+2 s, t+4 s, ...
 * regardless of arrival order. Sportradar trial and production keys allow
 * 1 request/second per product (the floor; slots are 2 s, see below);
 * exceeding it returns HTTP 429.
 *
 * The limit is per product KEY, not per process. `pnpm trial plan` (a CLI
 * process) followed within 1 s by `pnpm trial watch` (which spawns the worker)
 * produced a 595 ms gap and a 429 while the limiter lived in one process
 * (evidence M3 item 1c). With a `SlotStore` (plan rev 4.6) every
 * `waitForSlot()` claims its slot from `ingest.provider_rate_slots`, one row
 * per product on the database clock, so every process sharing the database
 * (CLI + worker, two watchers back to back) is spaced together. The in-process
 * schedule stays as a local floor and as the whole mechanism when no store is
 * given (simulation / fixture sources, `db: null`).
 */
/**
 * 2 s slots. The provider measures spacing on ARRIVAL, while slots are dispatch
 * times: a request leaves late by the timer, the database round trip and, for a
 * process's first request, the cold connection setup, so two slots 1 s apart can
 * arrive closer than 1 s. 1050 ms failed in the M3 corrective rehearsal (999 ms
 * on arrival, one 429). 1200 ms failed on the first live run (2026-10-19, WNBA
 * Finals G2): 8 of the 28 summary calls sent 1.200 s after a pbp call got HTTP
 * 429 on a warm connection, every pbp 30 s apart passed. Sportradar's exact rule
 * is unknown, so the margin is a full second; it costs nothing live (cadences
 * are 30-60 s, and only a call due together with another waits) and a residual
 * 429 is retried by the watcher. `provider_calls.called_at` spacing is >= 2 s.
 */
export const DEFAULT_MIN_INTERVAL_MS = 2000;

/** A claimed slot: when the request may start, and how long the claimant must wait for it. */
export interface SlotClaim {
  /** The slot on the store's clock; logged as `provider_calls.called_at`. */
  slotAt: Date;
  /** How far in the future the slot is, measured on the store's clock (<= 0: now). */
  delayMs: number;
}

/**
 * Shared slot ledger for one product across processes. `claim` must be atomic:
 * two concurrent claimants never receive slots closer than `minIntervalMs`.
 */
export interface SlotStore {
  claim(product: string, minIntervalMs: number): Promise<SlotClaim>;
}

/**
 * How long one store claim may take before the caller gives up. A claim is one short update; a
 * claim that has not answered in this time is a hung connection or a lock held elsewhere, and
 * without a bound every later claim of the process would queue behind it (claims are chained).
 * A claim that completes after the timeout only wastes its slot.
 */
export const DEFAULT_CLAIM_TIMEOUT_MS = 10_000;

export class SlotClaimTimeoutError extends Error {
  constructor(
    readonly product: string,
    readonly timeoutMs: number,
  ) {
    super(`rate slot claim for ${product} did not answer within ${timeoutMs} ms`);
    this.name = 'SlotClaimTimeoutError';
  }
}

/** `store.claim` bounded by `timeoutMs`; rejects with SlotClaimTimeoutError when it runs out. */
export async function claimSlot(
  store: SlotStore,
  product: string,
  minIntervalMs: number,
  timeoutMs: number = DEFAULT_CLAIM_TIMEOUT_MS,
): Promise<SlotClaim> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SlotClaimTimeoutError(product, timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([store.claim(product, minIntervalMs), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `ingest.provider_rate_slots` as the SlotStore. One statement per claim: the
 * row lock serializes claimants, `next_slot_at` only ever moves forward, and
 * `delay_ms` is computed on the DATABASE clock, so process clock skew can
 * neither shrink the spacing on the wire nor the spacing recorded in
 * `provider_calls`. A product without a row gets one on the fly (insert ...
 * on conflict do nothing, then claim), so a product new to this database never
 * breaks; it still needs its `ingest.product_quotas` row (FK), which the
 * QuotaGuard already requires before any call.
 */
export class PgSlotStore implements SlotStore {
  constructor(private readonly db: Db) {}

  async claim(product: string, minIntervalMs: number): Promise<SlotClaim> {
    const secs = Math.max(0, minIntervalMs) / 1000;
    let row = await this.update(product, secs);
    if (!row) {
      await this.db`insert into ingest.provider_rate_slots (product) values (${product})
                    on conflict (product) do nothing`;
      row = await this.update(product, secs);
      if (!row)
        throw new Error(`no ingest.provider_rate_slots row could be created for ${product}`);
    }
    return { slotAt: row.slotAt, delayMs: Number(row.delayMs) };
  }

  private async update(product: string, secs: number) {
    const [row] = await this.db<{ slotAt: Date; delayMs: string | number }[]>`
      update ingest.provider_rate_slots
         set next_slot_at = greatest(next_slot_at, clock_timestamp()) + make_interval(secs => ${secs})
       where product = ${product}
       returning next_slot_at - make_interval(secs => ${secs}) as "slotAt",
                 extract(epoch from (next_slot_at - make_interval(secs => ${secs}) - clock_timestamp())) * 1000 as "delayMs"`;
    return row;
  }
}

export class RateLimiter {
  private nextSlot: number | null = null;
  readonly minIntervalMs: number;
  /** The product whose slots are claimed from the store (required when a store is given). */
  readonly product: string | null;
  /** Slots granted so far (observability). */
  granted = 0;
  /** Slots claimed through the shared store (observability). */
  claimed = 0;

  constructor(
    opts: {
      minIntervalMs?: number;
      /** Cross-process ledger; with it every slot is claimed from the store (plan rev 4.6). */
      store?: SlotStore;
      product?: string;
      now?: () => number;
      sleep?: (ms: number) => Promise<void>;
      /** Bound on one store claim (DEFAULT_CLAIM_TIMEOUT_MS). */
      claimTimeoutMs?: number;
    } = {},
  ) {
    this.minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.claimTimeoutMs = opts.claimTimeoutMs ?? DEFAULT_CLAIM_TIMEOUT_MS;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.product = opts.product ?? null;
    if (opts.store && this.product === null) {
      throw new Error('RateLimiter with a SlotStore needs the product whose slots it claims');
    }
    this.store = opts.store ?? null;
  }

  private readonly now: () => number;
  private readonly claimTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private store: SlotStore | null;
  /** Store claims of this process, in call order (see waitForSlot). */
  private claimChain: Promise<void> = Promise.resolve();

  /** Whether slots are claimed from a shared store (cross-process) or only in this process. */
  get shared(): boolean {
    return this.store !== null;
  }

  /** The shared ledger in use, if any (observability, registry bookkeeping). */
  get slotStore(): SlotStore | null {
    return this.store;
  }

  /** Attach the shared ledger after construction (a registry limiter created before the db was known). */
  useStore(store: SlotStore): void {
    if (this.product === null) {
      throw new Error('RateLimiter with a SlotStore needs the product whose slots it claims');
    }
    this.store = store;
  }

  /**
   * Resolves when the caller's slot has arrived, returning the slot time (ms
   * epoch). Without a store the local slot is claimed synchronously, before any
   * await, so concurrent callers in this process never share one. With a store,
   * claims are chained: each caller claims its store slot and derives its local
   * floor only after the previous caller has, so store order and local order
   * agree. (Claiming the local floor first and the store slot after an await let
   * two concurrent callers receive store slots in the opposite order; one then
   * slept past its own slot to the other's floor and both left together.)
   */
  async waitForSlot(): Promise<number> {
    this.granted++;
    const store = this.store;
    const product = this.product;
    if (store === null || product === null) {
      const now = this.now();
      const localSlot = Math.max(this.nextSlot ?? now, now);
      this.nextSlot = localSlot + this.minIntervalMs;
      if (this.minIntervalMs <= 0) return localSlot;
      await this.sleepUntil(localSlot);
      return localSlot;
    }
    const ticket = this.claimChain.then(async () => {
      // Bounded, so one hung claim fails its caller instead of stalling every later claim.
      const claim = await claimSlot(store, product, this.minIntervalMs, this.claimTimeoutMs);
      this.claimed++;
      // Sleep on the store's delay (its clock), never shorter than the local floor.
      const now = this.now();
      const target = Math.max(this.nextSlot ?? now, now + Math.max(0, claim.delayMs));
      this.nextSlot = target + this.minIntervalMs;
      return { slotAt: claim.slotAt.getTime(), target };
    });
    this.claimChain = ticket.then(
      () => undefined,
      () => undefined,
    );
    const { slotAt, target } = await ticket;
    await this.sleepUntil(target);
    return slotAt;
  }

  private async sleepUntil(t: number): Promise<void> {
    // Timers may fire a hair early; sleep until the wall clock has really reached the slot.
    for (let now = this.now(); now < t; now = this.now()) await this.sleep(t - now);
  }
}

const registry = new Map<string, RateLimiter>();
/** Which Db instance each registry limiter's PgSlotStore is bound to. */
const registryDb = new WeakMap<RateLimiter, Db>();

/**
 * The process-wide limiter for one product (quota bucket). With `db`, its
 * slots are claimed from `ingest.provider_rate_slots`, shared by every process
 * on this database; a limiter created earlier without a db is upgraded in
 * place, and a different `db` instance (a pool that was closed and reopened)
 * replaces the store, so a claim never goes through a dead connection.
 */
export function rateLimiterFor(
  product: string,
  opts: { db?: Db | null; minIntervalMs?: number } = {},
): RateLimiter {
  const minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  let limiter = registry.get(product);
  if (!limiter) {
    limiter = new RateLimiter({ minIntervalMs, product });
    registry.set(product, limiter);
  }
  if (opts.db && (!limiter.shared || registryDb.get(limiter) !== opts.db)) {
    limiter.useStore(new PgSlotStore(opts.db));
    registryDb.set(limiter, opts.db);
  }
  return limiter;
}
