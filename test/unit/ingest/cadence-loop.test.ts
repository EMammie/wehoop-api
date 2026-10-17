import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import {
  cadenceLoop,
  type DocumentSource,
  type GameWatcher,
} from '../../../src/ingest/game-watcher.js';
import { QuotaRefusedError } from '../../../src/ingest/quota-guard.js';
import { createLogger } from '../../../src/logger.js';
import type { FetchedDocument } from '../../../src/providers/sportradar/http.js';

/** A source that fails once with a transient error, then is refused by the quota guard. */
function source(script: Array<'ok' | 'transient' | 'refused'>): DocumentSource & { calls: number } {
  const log = { calls: 0 };
  return {
    observationSource: 'rest',
    get calls() {
      return log.calls;
    },
    async fetch<T>(_feed: string, _schema: ZodType<T>): Promise<FetchedDocument<T>> {
      const step = script[log.calls++] ?? 'ok';
      if (step === 'transient') throw new Error('HTTP 503');
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
});
