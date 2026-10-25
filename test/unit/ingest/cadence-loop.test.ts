import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import { budgetFor } from '../../../src/ingest/cadence.js';
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

  it('a 429 while the watch is stopping is not retried', async () => {
    let stopped = false;
    const src = source(['429']);
    const stopping = {
      ...src,
      observationSource: src.observationSource,
      fetch: ((...a: Parameters<DocumentSource['fetch']>) => {
        stopped = true; // the operator stops the watch while this call is in flight
        return src.fetch(...a);
      }) as DocumentSource['fetch'],
    } as DocumentSource;
    const out = await cadenceLoop(watcher, stopping, silent, cadence, {
      untilClosed: false,
      isStopped: () => stopped,
    });
    expect(src.calls).toBe(1);
    expect(out).toMatchObject({ calls: 0, failed: 1, retried429: 0 });
  });
});

describe('cadenceLoop pacing (rev 4.9)', () => {
  /** A fake clock: sleep advances it; the provider status follows the clock. */
  function clocked(statusAt: (t: number) => string) {
    let t = 0;
    const calls: Array<{ feed: string; at: number }> = [];
    const src: DocumentSource = {
      observationSource: 'rest',
      async fetch<T>(feed: string, _schema: ZodType<T>): Promise<FetchedDocument<T>> {
        calls.push({ feed, at: t });
        const d = new Date(t);
        return { data: {} as T, requestedAt: d, receivedAt: d, bytes: 2, rawText: '{}' };
      },
    };
    const w = {
      process: async () => ({ gameId: 'g', status: statusAt(t), result: { outcome: 'applied' } }),
    } as unknown as GameWatcher;
    const opts = {
      untilClosed: true,
      isStopped: () => false,
      now: () => t,
      sleep: async (ms: number) => {
        t += Math.max(ms, 1);
      },
    };
    return { src, w, opts, calls };
  }
  const MIN = 60_000;
  const paced = {
    pbpMs: 30_000,
    summaryMs: 5 * MIN,
    boxscoreMs: null,
    boxscoreAtMs: [],
    horizonMs: 150 * MIN,
    closing: [] as never[],
    summaryOffsetMs: 15_000,
    afterCompleteMs: 5 * MIN,
  };

  it('the first summary leaves at its offset, never 2 s after a pbp', async () => {
    const { src, w, opts, calls } = clocked((t) => (t >= 10 * MIN ? 'closed' : 'inprogress'));
    await cadenceLoop(w, src, silent, paced, opts);
    const pbpAt = calls.filter((c) => c.feed === 'pbp').map((c) => c.at);
    const sumAt = calls.filter((c) => c.feed === 'summary').map((c) => c.at);
    expect(sumAt[0]).toBe(15_000);
    for (const s of sumAt) {
      const gap = Math.min(...pbpAt.map((p) => Math.abs(p - s)));
      expect(gap).toBeGreaterThanOrEqual(15_000);
    }
  });

  it('while complete waits for closed, every feed polls at most every 5 min', async () => {
    // inprogress until 20 min, complete until 50 min, closed after.
    const { src, w, opts, calls } = clocked((t) =>
      t >= 50 * MIN ? 'closed' : t >= 20 * MIN ? 'complete' : 'inprogress',
    );
    await cadenceLoop(w, src, silent, paced, opts);
    const pbpAt = calls.filter((c) => c.feed === 'pbp').map((c) => c.at);
    const before = pbpAt.filter((t) => t <= 20 * MIN);
    expect(before.length).toBe(41); // every 30 s from 0 through 20 min
    const after = pbpAt.filter((t) => t > 20 * MIN);
    for (let i = 1; i < after.length; i++) {
      expect((after[i] ?? 0) - (after[i - 1] ?? 0)).toBeGreaterThanOrEqual(5 * MIN);
    }
    expect(after.length).toBeLessThanOrEqual(7); // 30 min at 5 min, plus the slot already due
  });
  it('leaving complete (the summary re-opened play) pulls the slow-booked pbp slot back to its 30 s grid', async () => {
    // complete from 10:00 to 15:10; the summary at 15:15 sees inprogress again; closed at 25 min.
    const { src, w, opts, calls } = clocked((t) =>
      t >= 25 * MIN ? 'closed' : t >= 10 * MIN && t < 15 * MIN + 10_000 ? 'complete' : 'inprogress',
    );
    await cadenceLoop(w, src, silent, paced, opts);
    const pbpAt = calls.filter((c) => c.feed === 'pbp').map((c) => c.at);
    // pbp at 15:00 (complete) booked 20:00; after the summary at 15:15 it is 15:30 again.
    expect(pbpAt).toContain(15 * MIN);
    expect(pbpAt).toContain(15 * MIN + 30_000);
    expect(pbpAt.filter((t) => t > 10 * MIN && t < 15 * MIN)).toEqual([]);
    expect(pbpAt.every((t) => t % 30_000 === 0)).toBe(true); // still on the pbp grid
  });

  it('a 150-min game with a 30-min complete -> closed wait makes exactly the budgeted calls', async () => {
    const budgeted = { ...paced, closeWaitMs: 30 * MIN };
    const { src, w, opts, calls } = clocked((t) =>
      t >= 180 * MIN ? 'closed' : t >= 150 * MIN ? 'complete' : 'inprogress',
    );
    await cadenceLoop(w, src, silent, budgeted, opts);
    const b = budgetFor(budgeted);
    expect(b).toMatchObject({ pbp: 301, summary: 30, afterComplete: 12, closing: 0, retries: 0 });
    expect(calls.length).toBe(b.total);
  });

  it('the closing pair waits the summary offset after the pbp that reported closed', async () => {
    const { src, w, opts, calls } = clocked((t) => (t >= 60_000 ? 'closed' : 'inprogress'));
    await cadenceLoop(w, src, silent, { ...paced, closing: ['summary', 'boxscore'] }, opts);
    const closing = calls.slice(-2);
    const lastPbp = calls.filter((c) => c.feed === 'pbp').at(-1)?.at ?? 0;
    expect(closing.map((c) => c.feed)).toEqual(['summary', 'boxscore']);
    expect((closing[0]?.at ?? 0) - lastPbp).toBeGreaterThanOrEqual(15_000);
  });
});
