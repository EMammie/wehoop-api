import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type Config, loadConfig } from '../../../src/config.js';
import { createLogger } from '../../../src/logger.js';
import {
  assertDestination,
  DestinationRefusedError,
  lockDestination,
  lockedDestination,
  unlockDestinationForTests,
} from '../../../src/providers/sportradar/destination-guard.js';
import { SportradarHttp } from '../../../src/providers/sportradar/http.js';
import { PushStream } from '../../../src/providers/sportradar/push-client.js';
import { createResolver } from '../../../src/providers/sportradar/resolver.js';
import {
  ProdUrlResolver,
  type PushUrlResolver,
  type UrlResolver,
} from '../../../src/providers/sportradar/urls.js';

/**
 * Demo mode's "no Sportradar traffic" rows (plan rev 4.15 (4)): the HTTP client and the push
 * client refuse, BEFORE any network I/O, a request whose origin is not the demo host. The
 * `fetchImpl` stubs below count every attempt: a refused request must never reach them.
 */
const log = createLogger({ level: 'silent', pretty: false });
const DEMO = 'http://127.0.0.1:8790';

afterEach(() => unlockDestinationForTests());

function countingFetch() {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  return { calls, impl };
}

const simResolver = (url: string): UrlResolver => ({
  // A source with no limiter, guard or ledger so the test isolates the destination check.
  source: 'simulation',
  resolve: () => ({ url, headers: {} }),
});
const pushResolver = (url: string): PushUrlResolver => ({
  source: 'simulation',
  resolvePush: () => ({ url, headers: {} }),
});

describe('destination guard', () => {
  it('is a no-op until a process locks a destination, then refuses every other origin', () => {
    expect(lockedDestination()).toBeNull();
    expect(() => assertDestination('https://api.sportradar.com/wnba/x')).not.toThrow();
    lockDestination(`${DEMO}/`);
    expect(lockedDestination()).toBe(DEMO);
    expect(() => assertDestination(`${DEMO}/wnba/production/v8/en/games/x/pbp.json`)).not.toThrow();
    for (const url of [
      'https://api.sportradar.com/wnba/production/v8/en/games/x/pbp.json',
      'http://127.0.0.1:8791/wnba/x', // same host, other port
      'https://127.0.0.1:8790/wnba/x', // other scheme
      'not a url',
    ]) {
      expect(() => assertDestination(url, log), url).toThrow(DestinationRefusedError);
    }
    // One-way: a second, different lock is refused; the same origin is idempotent.
    expect(() => lockDestination('http://127.0.0.1:9999')).toThrow(/already locked/);
    expect(() => lockDestination(DEMO)).not.toThrow();
  });

  it('SportradarHttp refuses an off-host URL before any network I/O (no fetch, no call counted)', async () => {
    lockDestination(DEMO);
    const f = countingFetch();
    const http = new SportradarHttp({
      db: null,
      log,
      league: 'wnba',
      runId: null,
      resolver: simResolver('https://api.sportradar.com/wnba/production/v8/en/games/g/pbp.json'),
      fetchImpl: f.impl,
    });
    await expect(http.getJson('pbp', z.unknown(), { gameId: 'g' })).rejects.toBeInstanceOf(
      DestinationRefusedError,
    );
    expect(f.calls).toEqual([]);
    expect(http.calls).toBe(0);
    // The demo host itself goes through.
    const ok = new SportradarHttp({
      db: null,
      log,
      league: 'wnba',
      runId: null,
      resolver: simResolver(`${DEMO}/wnba/production/v8/en/games/g/pbp.json`),
      fetchImpl: f.impl,
    });
    await ok.getJson('pbp', z.unknown(), { gameId: 'g' });
    expect(f.calls).toEqual([`${DEMO}/wnba/production/v8/en/games/g/pbp.json`]);
  });

  it('an explicit allowedOrigin guards a client even without the process lock', async () => {
    const f = countingFetch();
    const http = new SportradarHttp({
      db: null,
      log,
      league: 'wnba',
      runId: null,
      resolver: simResolver('https://api.sportradar.com/x'),
      fetchImpl: f.impl,
      allowedOrigin: DEMO,
    });
    await expect(http.getJson('pbp', z.unknown())).rejects.toBeInstanceOf(DestinationRefusedError);
    expect(f.calls).toEqual([]);
  });

  it('PushStream refuses an off-host stream at construction, before any connection attempt', () => {
    lockDestination(DEMO);
    const f = countingFetch();
    const make = (url: string) =>
      new PushStream({
        db: null,
        log,
        resolver: pushResolver(url),
        league: 'wnba',
        runId: null,
        feed: 'push_events',
        fetchImpl: f.impl,
        onLine: () => undefined,
      });
    expect(() =>
      make('https://api.sportradar.com/wnba/production/stream/en/events/subscribe'),
    ).toThrow(DestinationRefusedError);
    expect(f.calls).toEqual([]);
    expect(() => make(`${DEMO}/wnba/production/stream/en/events/subscribe`)).not.toThrow();
  });

  it('a PushStream whose destination is refused after construction stops without connecting', async () => {
    const f = countingFetch();
    let url = `${DEMO}/wnba/production/stream/en/events/subscribe`;
    const stream = new PushStream({
      db: null,
      log,
      resolver: { source: 'simulation', resolvePush: () => ({ url, headers: {} }) },
      league: 'wnba',
      runId: null,
      feed: 'push_events',
      fetchImpl: f.impl,
      onLine: () => undefined,
      allowedOrigin: DEMO,
    });
    url = 'https://api.sportradar.com/wnba/production/stream/en/events/subscribe';
    await stream.start();
    expect(f.calls).toEqual([]);
    expect(stream.state.status).toBe('stopped');
    expect(stream.state.attempts).toBe(0);
    expect(stream.state.lastError).toMatch(/refused a provider request/);
  });

  it('createResolver in MODE=demo locks the process to the demo host and sends no real key', () => {
    const config = demoConfig();
    const r = createResolver(config, 'wnba');
    expect(lockedDestination()).toBe(DEMO);
    expect(r.source).toBe('rehearsal');
    expect(r).toBeInstanceOf(ProdUrlResolver);
    const { url, headers } = r.resolve('pbp', { gameId: 'replay-93ee7c68-202611061500' });
    expect(url).toBe(`${DEMO}/wnba/production/v8/en/games/replay-93ee7c68-202611061500/pbp.json`);
    expect(headers['x-api-key']).toBe('demo-mode-no-key');
  });
});

const devStack = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const demoEnv = {
  MODE: 'demo',
  DATABASE_URL: devStack,
  DATABASE_SESSION_URL: devStack,
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_SERVICE_ROLE_KEY: 'x',
  SPORTRADAR_BASE_URL: DEMO,
};
function demoConfig(over: Record<string, string> = {}): Config {
  return loadConfig({ ...demoEnv, ...over });
}

describe('MODE=demo configuration', () => {
  it('starts with no Sportradar key, on the loopback demo host, as a rehearsal source', () => {
    const c = demoConfig();
    expect(c.mode).toBe('demo');
    expect(c.sportradar.keys).toEqual({});
    expect(c.rehearsal).toBe(true);
    expect(c.sportradar.baseUrl).toBe(DEMO);
  });

  it('refuses any SPORTRADAR_*_KEY', () => {
    for (const k of ['SPORTRADAR_WNBA_KEY', 'SPORTRADAR_NCAAWB_KEY', 'SPORTRADAR_UNRIVALED_KEY'])
      expect(() => demoConfig({ [k]: 'a-key' }), k).toThrow(
        new RegExp(`MODE=demo refuses to start with a Sportradar key set \\(${k}\\)`),
      );
  });

  it('refuses api.sportradar.com, an unset base URL, and anything but http://<loopback>:<port>', () => {
    expect(() => demoConfig({ SPORTRADAR_BASE_URL: 'https://api.sportradar.com' })).toThrow(
      /MODE=demo needs SPORTRADAR_BASE_URL = the in-process demo host/,
    );
    const { SPORTRADAR_BASE_URL: _u, ...unset } = demoEnv;
    expect(() => loadConfig(unset)).toThrow(/never api\.sportradar\.com/);
    for (const url of [
      'http://example.com:8790',
      'https://127.0.0.1:8790',
      'http://127.0.0.1',
      'http://127.0.0.1:8790/wnba',
    ]) {
      expect(() => demoConfig({ SPORTRADAR_BASE_URL: url }), url).toThrow(/MODE=demo/);
    }
  });

  it('still needs the service-role key and a session URL (it publishes and holds the lock)', () => {
    const { SUPABASE_SERVICE_ROLE_KEY: _k, DATABASE_SESSION_URL: _s, ...bare } = demoEnv;
    expect(() => loadConfig(bare)).toThrow(/SUPABASE_SERVICE_ROLE_KEY[\s\S]*DATABASE_SESSION_URL/);
  });
});
