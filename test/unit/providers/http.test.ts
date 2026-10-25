import { describe, expect, it } from 'vitest';
import type { Db } from '../../../src/db/client.js';
import type { QuotaGuard } from '../../../src/ingest/quota-guard.js';
import { createLogger } from '../../../src/logger.js';
import { SportradarHttp } from '../../../src/providers/sportradar/http.js';
import { RateLimiter, type SlotStore } from '../../../src/providers/sportradar/rate-limiter.js';
import { ProdUrlResolver, SimulationUrlResolver } from '../../../src/providers/sportradar/urls.js';

const log = createLogger({ level: 'silent', pretty: false });
const db = {} as unknown as Db; // never queried: construction only
const guard = {} as unknown as QuotaGuard;
const store: SlotStore = { claim: async () => ({ slotAt: new Date(), delayMs: 0 }) };
const resolver = new ProdUrlResolver({
  league: 'ncaawb',
  accessLevel: 'trial',
  apiKey: 'unit-test-key',
  baseUrl: 'http://127.0.0.1:8787', // rehearsal source: rate-limited like trial
});

describe('SportradarHttp construction (plan §4 Rate/quota, rev 4.6)', () => {
  it('a rate-limited source refuses a per-process limiter: slots must come from the shared ledger', () => {
    expect(
      () =>
        new SportradarHttp({
          db,
          log,
          league: 'ncaawb',
          runId: null,
          resolver,
          limiter: new RateLimiter({ product: 'ncaawb' }),
          guard,
        }),
    ).toThrow(/ingest\.provider_rate_slots.*rateLimiterFor/);
    expect(
      () =>
        new SportradarHttp({
          db,
          log,
          league: 'ncaawb',
          runId: null,
          resolver,
          limiter: new RateLimiter({ product: 'ncaawb', store }),
          guard,
        }),
    ).not.toThrow();
  });

  it('a simulation source needs neither limiter nor guard and may run without a database', () => {
    const sim = new SimulationUrlResolver({
      playbackUrl: 'https://playback.sportradar.com',
      league: 'wnba',
      recordingId: 'r',
      sessionId: 's',
    });
    expect(
      () => new SportradarHttp({ db: null, log, league: 'wnba', runId: null, resolver: sim }),
    ).not.toThrow();
    expect(
      () => new SportradarHttp({ db: null, log, league: 'ncaawb', runId: null, resolver }),
    ).toThrow(/only allowed for simulation/);
  });
});
