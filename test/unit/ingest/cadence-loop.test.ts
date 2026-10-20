import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import {
  cadenceLoop,
  type DocumentSource,
  type GameWatcher,
} from '../../../src/ingest/game-watcher.js';
import { QuotaRefusedError } from '../../../src/ingest/quota-guard.js';
import { createLogger } from '../../../src/logger.js';
import { type FetchedDocument, ProviderHttpError } from '../../../src/providers/sportradar/http.js';

/** A source that fails once with a transient error, then is refused by the quota guard. */
function source(
  script: Array<'ok' | 'transient' | 'refused' | '429'>,
): DocumentSource & { calls: number; feeds: string[] } {
  const log = { calls: 0, feeds: [] as string[] };
  return {
    observationSource: 'rest',
    get calls() {
      return log.calls;
    },
    get feeds() {
      return log.feeds;
    },
    async fetch<T>(feed: string, _schema: ZodType<T>): Promise<FetchedDocument<T>> {
      log.feeds.push(feed);
      const step = script[log.calls++] ?? 'ok';
      if (step === 'transient') throw new Error('HTTP 503');
      if (step === '429')
        throw new ProviderHttpError(429, feed as 'summary', '{"message":"Too Many Requests"}');
      if (step === 'refused')
        throw new QuotaRefusedError('ncaawb', 'below_reserve', null, 'spendable 0 < 1');
      const now = new Date();
      return { data: {} as T, requestedAt: now, receivedAt: now, bytes: 2, rawText: '{}' };
    },
  };
}

const watcher = {
  process: async () => ({ gameId: 'g', status: 'inprogress', result: { outcome: 'applied' } }),
} as unknown as GameWatcher;
const silent = createLogger({ level: 'silent', pretty: false });
const cadence = {
  pbpMs: 10,
  summaryMs: null,
  boxscoreMs: null,
  boxscoreAtMs: [],
  horizonMs: 10_000,
  closing: [],
};

describe('cadenceLoop and the quota guard', () => {
  it('retries transient fetch errors at the next due time but stops on QuotaRefusedError', async () => {
    const src = source(['ok', 'transient', 'ok', 'refused', 'ok']);
    await expect(
      cadenceLoop(watcher, src, silent, cadence, { untilClosed: false, isStopped: () => false }),
    ).rejects.toBeInstanceOf(QuotaRefusedError);
    expect(src.calls).toBe(4); // the refusal ends the loop; nothing after it is fetched
  });

  it('retries an HTTP 429 once at the next rate slot; a second 429 waits for the next due time', async () => {
    const src = source(['ok', '429', 'ok', '429', '429', 'refused']);
    await expect(
      cadenceLoop(watcher, src, silent, cadence, { untilClosed: false, isStopped: () => false }),
    ).rejects.toBeInstanceOf(QuotaRefusedError);
    // ok | 429 -> retry ok | 429 -> retry 429 (gives up) | next due: refused
    expect(src.calls).toBe(6);
  });

  it('the closing summary and boxscore retry a 429 twice (they have no next due time)', async () => {
    const closed = {
      process: async () => ({ gameId: 'g', status: 'closed', result: { outcome: 'applied' } }),
    } as unknown as GameWatcher;
    const src = source(['ok', '429', '429', 'ok', '429', 'ok']);
    const out = await cadenceLoop(
      closed,
      src,
      silent,
      { ...cadence, closing: ['summary', 'boxscore'] },
      { untilClosed: true, isStopped: () => false },
    );
    expect(src.feeds).toEqual(['pbp', 'summary', 'summary', 'summary', 'boxscore', 'boxscore']);
    expect(out).toMatchObject({ status: 'closed', failed: 0, retried429: 3, calls: 3 });
  });
});
