import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import { budgetFor, PROFILE_CADENCE } from '../../../src/ingest/cadence.js';
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
    expect(out).toMatchObject({ status: 'closed', failed: 0, retried429: 3, okFetches: 3 });
  });

  it('a closing fetch retries any other failure twice (timeout, 5xx, parse), each through the next slot', async () => {
    const closed = {
      process: async () => ({ gameId: 'g', status: 'closed', result: { outcome: 'applied' } }),
    } as unknown as GameWatcher;
    // pbp says closed | summary: 503, 503, 503 (gives up after 2 retries) | boxscore: 503, ok.
    const src = source(['ok', 'transient', 'transient', 'transient', 'transient', 'ok']);
    const out = await cadenceLoop(
      closed,
      src,
      silent,
      { ...cadence, closing: ['summary', 'boxscore'] },
      { untilClosed: true, isStopped: () => false },
    );
    expect(src.feeds).toEqual(['pbp', 'summary', 'summary', 'summary', 'boxscore', 'boxscore']);
    expect(out).toMatchObject({
      status: 'closed',
      okFetches: 2,
      failed: 1,
      retried429: 0,
      retriedClosing: 3,
    });
  });

  it('a quota refusal during the closing set is not retried; it ends the watch', async () => {
    const closed = {
      process: async () => ({ gameId: 'g', status: 'closed', result: { outcome: 'applied' } }),
    } as unknown as GameWatcher;
    const src = source(['ok', 'refused', 'ok']);
    await expect(
      cadenceLoop(
        closed,
        src,
        silent,
        { ...cadence, closing: ['summary', 'boxscore'] },
        { untilClosed: true, isStopped: () => false },
      ),
    ).rejects.toBeInstanceOf(QuotaRefusedError);
    expect(src.feeds).toEqual(['pbp', 'summary']);
  });

  it("a cadence fetch keeps today's rule: a non-429 failure waits for its next due time", async () => {
    const src = source(['transient', 'refused']);
    await expect(
      cadenceLoop(watcher, src, silent, cadence, { untilClosed: false, isStopped: () => false }),
    ).rejects.toBeInstanceOf(QuotaRefusedError);
    expect(src.feeds).toEqual(['pbp', 'pbp']); // the second pbp is the next due time, not a retry
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
    expect(out).toMatchObject({ okFetches: 0, failed: 1, retried429: 0 });
  });
});

describe('cadenceLoop pacing (rev 4.9)', () => {
  /** A fake clock: sleep advances it; the provider status follows the clock. */
  function clocked(statusAt: (t: number, feed: string) => string) {
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
      process: async (feed: string) => ({
        gameId: 'g',
        status: statusAt(t, feed),
        result: { outcome: 'applied' },
      }),
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

  it('a 150-min game with a 30-min complete -> closed wait stays inside the budget', async () => {
    const budgeted = { ...paced, closeWaitMs: 30 * MIN };
    const { src, w, opts, calls } = clocked((t) =>
      t >= 180 * MIN ? 'closed' : t >= 150 * MIN ? 'complete' : 'inprogress',
    );
    await cadenceLoop(w, src, silent, budgeted, opts);
    const b = budgetFor(budgeted);
    expect(b).toMatchObject({ pbp: 301, summary: 30, afterComplete: 14, closing: 0, retries: 0 });
    expect(calls.length).toBeLessThanOrEqual(b.total);
    expect(calls.length).toBe(b.total - 2); // each feed's inclusive last wait slot falls after closed
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

describe('cadenceLoop slow phases (rev 4.12)', () => {
  const MIN = 60_000;
  function clocked(
    statusAt: (t: number, feed: string) => string,
    lastStatus: string | null = null,
  ) {
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
      lastStatus,
      process: async (feed: string) => ({
        gameId: 'g',
        status: statusAt(t, feed),
        result: { outcome: 'applied' },
      }),
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
  const at = (calls: Array<{ feed: string; at: number }>, feed: string) =>
    calls.filter((c) => c.feed === feed).map((c) => c.at);
  const minGap = (a: number[], b: number[]) =>
    Math.min(...a.flatMap((x) => b.map((y) => Math.abs(x - y))));

  it('before play only the pbp polls, every 5 min; the first inprogress restores both live grids', async () => {
    // Tip 27 min late (NCAAWB 2026-11-01): created until 27:00, inprogress until 60 min, closed by the pbp.
    const { src, w, opts, calls } = clocked((t) =>
      t >= 60 * MIN ? 'closed' : t >= 27 * MIN ? 'inprogress' : 'created',
    );
    await cadenceLoop(w, src, silent, PROFILE_CADENCE.full, opts);
    const pbp = at(calls, 'pbp');
    const summary = at(calls, 'summary');
    // pbp at 0, 5, 10, 15, 20, 25, then 30:00 sees play (the 5-min slot after 25:00).
    expect(pbp.filter((x) => x < 30 * MIN)).toEqual([0, 5, 10, 15, 20, 25].map((m) => m * MIN));
    expect(summary.filter((x) => x <= 30 * MIN)).toEqual([]); // the summary sat out the pre-game
    expect(pbp).toContain(30 * MIN + 30_000); // back on the 30 s grid
    expect(summary[0]).toBe(30 * MIN + 15_000); // first summary slot of its own grid after play started
    expect(minGap(pbp, summary)).toBeGreaterThanOrEqual(15_000);
    expect(pbp.every((x) => x % 30_000 === 0)).toBe(true);
    expect(calls.filter((c) => c.at < 30 * MIN).length).toBe(6); // the live cadence would make 60
  });

  it('after complete only the summary polls; when it reports closed the closing set is the pbp and the boxscore', async () => {
    // inprogress until 20 min; complete; the summary says closed from 60 min, the pbp never does.
    const { src, w, opts, calls } = clocked((t, feed) =>
      t >= 20 * MIN ? (feed === 'summary' && t >= 60 * MIN ? 'closed' : 'complete') : 'inprogress',
    );
    await cadenceLoop(w, src, silent, PROFILE_CADENCE.full, opts);
    const pbp = at(calls, 'pbp');
    const summary = at(calls, 'summary');
    const closedAt = summary.find((x) => x >= 60 * MIN) ?? 0;
    expect(closedAt).toBe(60 * MIN + 15_000);
    // While complete: no pbp until the closing one; summaries 5 min apart.
    expect(pbp.filter((x) => x > 20 * MIN && x <= closedAt)).toEqual([]);
    const waiting = summary.filter((x) => x > 20 * MIN);
    for (let i = 1; i < waiting.length; i++)
      expect((waiting[i] ?? 0) - (waiting[i - 1] ?? 0)).toBe(5 * MIN);
    // Closing: the pbp 15 s after the summary that said closed, then the boxscore; no second summary.
    expect(calls.slice(-2)).toEqual([
      { feed: 'pbp', at: closedAt + 15_000 },
      { feed: 'boxscore', at: closedAt + 15_000 },
    ]);
    expect(summary.at(-1)).toBe(closedAt);
  });

  it('when the pbp reports closed the closing set is the summary and the boxscore, as before', async () => {
    const { src, w, opts, calls } = clocked((t) => (t >= 10 * MIN ? 'closed' : 'inprogress'));
    await cadenceLoop(w, src, silent, PROFILE_CADENCE.full, opts);
    expect(calls.slice(-2).map((c) => c.feed)).toEqual(['summary', 'boxscore']);
    expect(at(calls, 'pbp').at(-1)).toBe(10 * MIN);
  });

  it('a 150-min game with a 120-min complete -> closed wait stays inside the full budget', async () => {
    const { src, w, opts, calls } = clocked((t, feed) =>
      t >= 150 * MIN
        ? feed === 'summary' && t >= 270 * MIN
          ? 'closed'
          : 'complete'
        : 'inprogress',
    );
    await cadenceLoop(w, src, silent, PROFILE_CADENCE.full, opts);
    const b = budgetFor(PROFILE_CADENCE.full);
    expect(calls.length).toBeLessThanOrEqual(b.total - b.retries);
    expect(calls.filter((c) => c.at > 150 * MIN && c.feed === 'pbp').length).toBe(1); // the closing pbp
  });

  it('a watch attached to a game stored as complete starts in the slow phase: no pbp before closed', async () => {
    // Stored complete; the summary reports closed from 30 min (the real watcher then reports the
    // stored closed for every later document, the closing pbp included).
    const { src, w, opts, calls } = clocked(
      (t, feed) =>
        t >= 30 * MIN && (feed === 'summary' || t > 30 * MIN + 15_000) ? 'closed' : 'complete',
      'complete',
    );
    const out = await cadenceLoop(w, src, silent, PROFILE_CADENCE.full, opts);
    expect(calls[0]).toEqual({ feed: 'summary', at: 15_000 });
    const closedAt = 30 * MIN + 15_000;
    expect(at(calls, 'pbp')).toEqual([closedAt + 15_000]); // only the closing pbp
    expect(at(calls, 'summary')).toEqual([0, 5, 10, 15, 20, 25, 30].map((m) => m * MIN + 15_000));
    expect(out.status).toBe('closed');
  });
});

describe('cadenceLoop non-played statuses (postponed, cancelled, unnecessary)', () => {
  const MIN = 60_000;
  function clocked(statusAt: (t: number, feed: string) => string, untilClosed = true) {
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
      process: async (feed: string) => ({
        gameId: 'g',
        status: statusAt(t, feed),
        result: { outcome: 'applied' },
      }),
    } as unknown as GameWatcher;
    const opts = {
      untilClosed,
      isStopped: () => false,
      now: () => t,
      sleep: async (ms: number) => {
        t += Math.max(ms, 1);
      },
    };
    return { src, w, opts, calls };
  }
  const at = (calls: Array<{ feed: string; at: number }>, feed: string) =>
    calls.filter((c) => c.feed === feed).map((c) => c.at);

  it('postponed: only the summary polls, every 5 min, and the watch stops at the horizon', async () => {
    // Live until 10 min; the pbp at 10:00 reports postponed and nothing changes after.
    const { src, w, opts, calls } = clocked((t) => (t >= 10 * MIN ? 'postponed' : 'inprogress'));
    const out = await cadenceLoop(w, src, silent, PROFILE_CADENCE.full, opts);
    expect(out.status).toBe('postponed');
    expect(out.elapsedMs).toBeGreaterThanOrEqual(150 * MIN);
    expect(out.elapsedMs).toBeLessThan(150 * MIN + 15_000); // stopped at the horizon, no extra slot
    expect(at(calls, 'pbp').at(-1)).toBe(10 * MIN); // the pbp that reported it was the last one
    const waiting = at(calls, 'summary').filter((x) => x > 10 * MIN);
    expect(waiting[0]).toBe(10 * MIN + 15_000);
    for (let i = 1; i < waiting.length; i++)
      expect((waiting[i] ?? 0) - (waiting[i - 1] ?? 0)).toBe(5 * MIN);
    expect(waiting.at(-1)).toBe(145 * MIN + 15_000);
    expect(calls.some((c) => c.feed === 'boxscore')).toBe(false); // no closing set
  });

  it("postponed stays inside every profile's reservation (postponed before play and mid-game)", async () => {
    for (const profile of ['full', 'extended', 'lean-full'] as const) {
      for (const from of [0, 60 * MIN]) {
        const { src, w, opts, calls } = clocked((t) => (t >= from ? 'postponed' : 'inprogress'));
        const out = await cadenceLoop(w, src, silent, PROFILE_CADENCE[profile], opts);
        expect(out.status).toBe('postponed');
        const b = budgetFor(PROFILE_CADENCE[profile]);
        expect(calls.length).toBeLessThanOrEqual(b.total - b.retries - b.closing - b.afterComplete);
      }
    }
  });

  it('postponed -> inprogress again restores the live cadence by the existing rules', async () => {
    // Postponed (reported by the pbp at 10:00) until the summary at 40:15 sees play again;
    // closed by the pbp at 60 min.
    const { src, w, opts, calls } = clocked((t) =>
      t >= 60 * MIN
        ? 'closed'
        : t >= 10 * MIN && t < 40 * MIN + 10_000
          ? 'postponed'
          : 'inprogress',
    );
    const out = await cadenceLoop(w, src, silent, PROFILE_CADENCE.full, opts);
    const pbp = at(calls, 'pbp');
    expect(pbp.filter((x) => x > 10 * MIN && x <= 40 * MIN + 15_000)).toEqual([]);
    expect(pbp).toContain(40 * MIN + 30_000); // back on the 30 s grid
    expect(pbp.filter((x) => x > 40 * MIN && x <= 60 * MIN).length).toBe(40);
    expect(out.status).toBe('closed');
    expect(calls.slice(-2).map((c) => c.feed)).toEqual(['summary', 'boxscore']);
  });

  it('cancelled: the closing set (minus the feed that reported it) runs, then the watch returns', async () => {
    const { src, w, opts, calls } = clocked((t) => (t >= 10 * MIN ? 'cancelled' : 'inprogress'));
    const out = await cadenceLoop(w, src, silent, PROFILE_CADENCE.full, opts);
    expect(out.status).toBe('cancelled');
    expect(at(calls, 'pbp').at(-1)).toBe(10 * MIN);
    expect(calls.slice(-2)).toEqual([
      { feed: 'summary', at: 10 * MIN + 15_000 },
      { feed: 'boxscore', at: 10 * MIN + 15_000 },
    ]);
  });

  it('unnecessary reported by the summary of an extended watch: the boxscore closes it, even without --until closed', async () => {
    const { src, w, opts, calls } = clocked(() => 'unnecessary', false);
    const out = await cadenceLoop(w, src, silent, PROFILE_CADENCE.extended, opts);
    expect(out.status).toBe('unnecessary');
    expect(calls).toEqual([
      { feed: 'summary', at: 0 },
      { feed: 'boxscore', at: 0 },
    ]);
  });
});
