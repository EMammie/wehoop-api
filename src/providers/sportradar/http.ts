import type { ZodType } from 'zod';
import type { Db } from '../../db/client.js';
import type { LeagueCode } from '../../leagues/codes.js';
import type { Logger } from '../../logger.js';
import { type Feed, redactUrl, type UrlResolver } from './urls.js';

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
  /** Request start time: the document is at least this old (plan §4 `observedAt`). */
  requestedAt: Date;
  receivedAt: Date;
  bytes: number;
  rawText: string;
}

/**
 * One HTTP client for every Sportradar source. Every call is logged to
 * ingest.provider_calls; `quota_counted` is true only for trial/production
 * (CLAUDE.md non-negotiable 8). Keys never appear in the stored URL.
 * `db: null` is for DB-free tooling against the simulation service only
 * (`pnpm sim record`): calls are not logged, and the resolver must be a
 * simulation resolver so no quota-counted call can go unrecorded.
 */
export class SportradarHttp {
  constructor(
    private readonly deps: {
      db: Db | null;
      log: Logger;
      resolver: UrlResolver;
      league: LeagueCode;
      runId: number | null;
      fetchImpl?: typeof fetch;
      timeoutMs?: number;
    },
  ) {
    if (deps.db === null && deps.resolver.source !== 'simulation') {
      throw new Error('SportradarHttp without a database is only allowed for simulation sources');
    }
  }

  get source() {
    return this.deps.resolver.source;
  }

  async getJson<T>(
    feed: Feed,
    schema: ZodType<T>,
    params: { gameId?: string } = {},
  ): Promise<FetchedDocument<T>> {
    const { url, headers } = this.deps.resolver.resolve(feed, params);
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const requestedAt = new Date();
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
      await this.logCall(feed, url, status, Math.round(performance.now() - started), bytes);
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
  ) {
    if (this.deps.db === null) return;
    const source = this.deps.resolver.source;
    const quotaCounted = source === 'trial' || source === 'production';
    try {
      await this.deps.db`
        insert into ingest.provider_calls
          (run_id, source, product, league, feed, url, status, duration_ms, bytes, quota_counted)
        values (${this.deps.runId}, ${source}, ${this.deps.league}, ${this.deps.league}, ${feed},
                ${redactUrl(url)}, ${status || null}, ${durationMs}, ${bytes}, ${quotaCounted})`;
    } catch (err) {
      // Never let bookkeeping take down ingestion; the call itself already happened.
      this.deps.log.error({ err, feed }, 'provider_calls insert failed');
    }
  }
}
