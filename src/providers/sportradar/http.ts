import type { ZodType } from 'zod';
import type { Db } from '../../db/client.js';
import { countsTowardQuota, needsRateLimit, type QuotaGuard } from '../../ingest/quota-guard.js';
import type { LeagueCode } from '../../leagues/codes.js';
import type { Logger } from '../../logger.js';
import type { RateLimiter } from './rate-limiter.js';
import { type Feed, type FeedParams, redactUrl, type UrlResolver } from './urls.js';

export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    readonly feed: Feed,
    readonly bodySnippet: string,
  ) {
    super(`sportradar ${feed} -> HTTP ${status}: ${bodySnippet.slice(0, 200)}`);
  }
}

export interface FetchedDocument<T> {
  data: T;
  /**
   * Request start time: the document is at least this old (plan §4 `observedAt`). For rate-limited
   * sources (trial, production, rehearsal) it is the slot claimed on the database clock, a lower
   * bound on the actual send (slot + timer lateness + one DB round trip); `provider_calls.called_at`
   * is the same instant.
   */
  requestedAt: Date;
  receivedAt: Date;
  bytes: number;
  rawText: string;
}

export interface SportradarHttpDeps {
  db: Db | null;
  log: Logger;
  resolver: UrlResolver;
  league: LeagueCode;
  /** Sportradar product = quota bucket (`adapter.product`); defaults to the league code. */
  product?: string;
  runId: number | null;
  /**
   * Required for trial/production resolvers (plan §4 "Rate/quota"): one shared rate-slot limiter (2 s slots)
   * per product and the guard that refuses below reserve. Ignored for simulation sources.
   */
  limiter?: RateLimiter;
  guard?: QuotaGuard;
  /** The budget reservation these calls spend (trial watch); null for discovery calls. */
  reservationId?: number | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * One HTTP client for every Sportradar source. Every call is logged to
 * ingest.provider_calls; `quota_counted` is true only for trial/production
 * (CLAUDE.md non-negotiable 8). Keys never appear in the stored URL.
 * `db: null` is for DB-free tooling against the simulation service only
 * (`pnpm sim record`): calls are not logged, and the resolver must be a
 * simulation resolver so no quota-counted call can go unrecorded.
 *
 * For trial/production resolvers every call is, in order: quota-guarded
 * (refused calls never reach the provider and are not logged as calls),
 * rate-limited (the slot time is the logged `called_at`), made, logged, and
 * counted against its reservation.
 */
export class SportradarHttp {
  readonly product: string;
  /** Calls refused by the quota guard (never sent). */
  refused = 0;
  calls = 0;

  constructor(private readonly deps: SportradarHttpDeps) {
    if (deps.db === null && deps.resolver.source !== 'simulation') {
      throw new Error('SportradarHttp without a database is only allowed for simulation sources');
    }
    if (needsRateLimit(deps.resolver.source) && (!deps.limiter || !deps.guard)) {
      throw new Error(
        `SportradarHttp for a ${deps.resolver.source} source needs a RateLimiter and a QuotaGuard`,
      );
    }
    // A per-process limiter alone reproduces the M3 1c bug (two processes, one key, a 429).
    if (needsRateLimit(deps.resolver.source) && deps.db !== null && !deps.limiter?.shared) {
      throw new Error(
        'rate-limited sources must claim slots from ingest.provider_rate_slots (rateLimiterFor(product, { db }))',
      );
    }
    this.product = deps.product ?? deps.league;
  }

  get source() {
    return this.deps.resolver.source;
  }

  async getJson<T>(
    feed: Feed,
    schema: ZodType<T>,
    params: FeedParams = {},
  ): Promise<FetchedDocument<T>> {
    const { url, headers } = this.deps.resolver.resolve(feed, params);
    const source = this.deps.resolver.source;
    // `rehearsal` (local stand-in host) is limited and guarded like trial but never counted.
    const counted = countsTowardQuota(source);
    const limited = needsRateLimit(source);
    const reservationId = this.deps.reservationId ?? null;
    if (limited && this.deps.guard) {
      try {
        await this.deps.guard.assertCall(this.product, source, reservationId);
      } catch (err) {
        this.refused++;
        throw err;
      }
    }
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    let requestedAt = new Date();
    if (limited && this.deps.limiter) requestedAt = new Date(await this.deps.limiter.waitForSlot());
    const started = performance.now();
    let status = 0;
    let bytes = 0;
    let text = '';
    try {
      const res = await fetchImpl(url, {
        headers: { accept: 'application/json', ...headers },
        signal: AbortSignal.timeout(this.deps.timeoutMs ?? 20_000),
      });
      status = res.status;
      text = await res.text();
      bytes = Buffer.byteLength(text);
      if (!res.ok) throw new ProviderHttpError(res.status, feed, text);
    } finally {
      this.calls++;
      await this.logCall(
        feed,
        url,
        status,
        Math.round(performance.now() - started),
        bytes,
        requestedAt,
        counted,
        reservationId,
      );
    }
    const receivedAt = new Date();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (err) {
      throw new Error(`sportradar ${feed}: response is not JSON (${(err as Error).message})`);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      throw new Error(`sportradar ${feed}: schema mismatch: ${issues}`);
    }
    return { data: parsed.data, requestedAt, receivedAt, bytes, rawText: text };
  }

  private async logCall(
    feed: Feed,
    url: string,
    status: number,
    durationMs: number,
    bytes: number,
    calledAt: Date,
    quotaCounted: boolean,
    reservationId: number | null,
  ) {
    if (this.deps.db === null) return;
    const source = this.deps.resolver.source;
    try {
      await this.deps.db`
        insert into ingest.provider_calls
          (run_id, source, product, league, feed, url, status, duration_ms, bytes, quota_counted,
           called_at, reservation_id)
        values (${this.deps.runId}, ${source}, ${this.product}, ${this.deps.league}, ${feed},
                ${redactUrl(url)}, ${status || null}, ${durationMs}, ${bytes}, ${quotaCounted},
                ${calledAt}, ${reservationId})`;
      if (reservationId !== null && this.deps.guard) await this.deps.guard.recordUse(reservationId);
    } catch (err) {
      // Never let bookkeeping take down ingestion; the call itself already happened.
      this.deps.log.error({ err, feed }, 'provider_calls insert failed');
    }
  }
}
