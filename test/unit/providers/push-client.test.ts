import { createServer, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { QuotaGuard } from '../../../src/ingest/quota-guard.js';
import { createLogger } from '../../../src/logger.js';
import {
  backoffDelayMs,
  classifyPushLine,
  type PushLine,
  PushStream,
} from '../../../src/providers/sportradar/push-client.js';
import { RateLimiter, type SlotStore } from '../../../src/providers/sportradar/rate-limiter.js';
import type { PushUrlResolver } from '../../../src/providers/sportradar/urls.js';
import { fixture } from '../../helpers/fixtures.js';

const log = createLogger({ level: 'silent', pretty: false });
const events = fixture('sim-93ee7c68-push-events-sample.json') as unknown[];
const clocks = fixture('sim-93ee7c68-push-clock-sample.json') as unknown[];

/** A loopback NDJSON server whose behaviour per connection is scripted by the test. */
function pushServer(
  onConnection: (res: ServerResponse, n: number) => void,
): Promise<{ server: Server; url: string; connections: () => number }> {
  let n = 0;
  const server = createServer((req, res) => {
    n++;
    res.writeHead(200, { 'content-type': 'application/json' });
    if (!req.headers['x-api-key']) throw new Error('key header missing');
    onConnection(res, n);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}`, connections: () => n });
    });
  });
}

const resolverFor = (url: string): PushUrlResolver => ({
  // A loopback host without a database: the simulation source needs no limiter, guard or ledger.
  source: 'simulation',
  resolvePush: (feed) => ({
    url: `${url}/stream/en/${feed}/subscribe`,
    headers: { 'x-api-key': 'k' },
  }),
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000) {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error('condition not met in time');
    await sleep(5);
  }
}

let server: Server | null = null;
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((r) => server?.close(() => r()));
    server = null;
  }
});

describe('classifyPushLine', () => {
  it('recognizes heartbeats, event messages and clock messages; anything else is null', () => {
    expect(classifyPushLine(events[0])).toEqual({ kind: 'heartbeat', interval: 5000 });
    const ev = classifyPushLine(events[1]);
    expect(ev?.kind).toBe('event');
    if (ev?.kind === 'event') expect(ev.message.payload.event.event_type).toBe('lineupchange');
    const ck = classifyPushLine(clocks[0]);
    expect(ck?.kind).toBe('clock');
    if (ck?.kind === 'clock') expect(ck.message.payload.clocks.running).toBe(false);
    expect(classifyPushLine({ hello: 'world' })).toBeNull();
    expect(classifyPushLine({ payload: { game: {} }, metadata: {} })).toBeNull();
    expect(classifyPushLine('x')).toBeNull();
  });
});

describe('backoffDelayMs', () => {
  it('is jittered exponential and clamped to [1 s, 30 s]', () => {
    expect(backoffDelayMs(1, () => 0.5)).toBe(1000);
    expect(backoffDelayMs(1, () => 0)).toBe(1000); // never below the floor
    expect(backoffDelayMs(2, () => 0.5)).toBe(2000);
    expect(backoffDelayMs(3, () => 0.999)).toBeLessThanOrEqual(4000 * 1.5);
    expect(backoffDelayMs(10, () => 0.9)).toBe(30_000);
    for (let i = 0; i < 50; i++) {
      const d = backoffDelayMs(1 + (i % 7), Math.random);
      expect(d).toBeGreaterThanOrEqual(1000);
      expect(d).toBeLessThanOrEqual(30_000);
    }
  });
});

describe('PushStream', () => {
  it('splits lines across chunks, counts heartbeats, skips unknown shapes and non-JSON, hands every known line to onLine with its receipt time', async () => {
    const lines = [
      JSON.stringify(events[0]),
      JSON.stringify(events[1]),
      '{"weird":true}',
      'not json at all',
      JSON.stringify(clocks[2]),
    ];
    const text = `${lines.join('\n')}\n`;
    const s = await pushServer((res) => {
      // Three awkward chunks: the first ends mid-line, the second ends mid-line too.
      const cut1 = Math.floor(text.length * 0.3);
      const cut2 = Math.floor(text.length * 0.7);
      res.write(text.slice(0, cut1));
      setTimeout(() => res.write(text.slice(cut1, cut2)), 10);
      setTimeout(() => res.write(text.slice(cut2)), 20);
      // keep the connection open; the test stops the stream
    });
    server = s.server;
    const received: Array<{ line: PushLine; at: Date }> = [];
    const stream = new PushStream({
      db: null,
      log,
      resolver: resolverFor(s.url),
      league: 'wnba',
      runId: null,
      feed: 'push_events',
      onLine: (line, at) => {
        received.push({ line, at });
      },
    });
    void stream.start();
    await until(() => received.length === 3);
    await stream.stop();
    expect(received.map((r) => r.line.kind)).toEqual(['heartbeat', 'event', 'clock']);
    expect(received.every((r) => r.at instanceof Date)).toBe(true);
    expect(stream.state).toMatchObject({
      status: 'stopped',
      connections: 1,
      reconnects: 0,
      lines: 5,
      heartbeats: 1,
      skipped: 2,
      handlerErrors: 0,
    });
    expect(stream.state.lastHeartbeatAt).toBeInstanceOf(Date);
    expect(stream.state.bytes).toBe(Buffer.byteLength(text));
  });

  it('a dropped connection backs off (jittered, within bounds), reconnects, and calls onReconnect with the outage length; handler errors never kill the stream', async () => {
    const s = await pushServer((res, n) => {
      res.write(`${JSON.stringify(events[1])}\n`);
      if (n === 1) setTimeout(() => res.destroy(), 10); // the drop
    });
    server = s.server;
    const reconnects: Array<{ connections: number; downMs: number }> = [];
    let handled = 0;
    const stream = new PushStream({
      db: null,
      log,
      resolver: resolverFor(s.url),
      league: 'wnba',
      runId: null,
      feed: 'push_events',
      backoffMinMs: 20,
      backoffMaxMs: 60,
      random: () => 0.5,
      onLine: () => {
        handled++;
        throw new Error('ingest exploded');
      },
      onReconnect: async (info) => {
        reconnects.push(info);
      },
    });
    void stream.start();
    await until(() => stream.state.connections === 2 && reconnects.length === 1);
    await stream.stop();
    expect(s.connections()).toBe(2);
    expect(stream.state.reconnects).toBe(1);
    expect(stream.state.handlerErrors).toBe(handled);
    expect(handled).toBeGreaterThanOrEqual(2);
    expect(reconnects[0]?.connections).toBe(2);
    expect(reconnects[0]?.downMs).toBeGreaterThanOrEqual(0);
    expect(stream.state.lastError).toBeNull(); // cleared on reconnect
    expect(stream.state.disconnectedSince).toBeNull();
  });

  it('the no-bytes watchdog aborts a silent connection and reconnects', async () => {
    const s = await pushServer((res, n) => {
      res.write(`${JSON.stringify(events[0])}\n`);
      if (n >= 2) {
        // keep alive with heartbeats faster than the watchdog: no further trips
        const t = setInterval(() => res.write(`${JSON.stringify(events[0])}\n`), 15);
        res.on('close', () => clearInterval(t));
      }
    });
    server = s.server;
    const stream = new PushStream({
      db: null,
      log,
      resolver: resolverFor(s.url),
      league: 'wnba',
      runId: null,
      feed: 'push_clock',
      watchdogMs: 60,
      backoffMinMs: 10,
      backoffMaxMs: 20,
      onLine: () => undefined,
    });
    void stream.start();
    await until(() => stream.state.connections === 2);
    await sleep(150);
    await stream.stop();
    expect(stream.state.watchdogTrips).toBe(1);
    expect(stream.state.connections).toBe(2);
    expect(stream.state.heartbeats).toBeGreaterThan(3);
  });

  it('a non-2xx answer is a failed attempt: logged, backed off, retried', async () => {
    let n = 0;
    const srv = createServer((_req, res) => {
      n++;
      if (n === 1) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end('{"message":"down"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write(`${JSON.stringify(events[0])}\n`);
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    server = srv;
    const addr = srv.address();
    const url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    const stream = new PushStream({
      db: null,
      log,
      resolver: resolverFor(url),
      league: 'wnba',
      runId: null,
      feed: 'push_events',
      backoffMinMs: 10,
      backoffMaxMs: 20,
      onLine: () => undefined,
    });
    void stream.start();
    await until(() => stream.state.connections === 1);
    await stream.stop();
    expect(stream.state.attempts).toBe(2);
    expect(n).toBe(2);
  });

  it('a connection that delivers no line keeps the backoff growing; the shared attempt budget stops the stream for good', async () => {
    const s = await pushServer((res) => {
      res.flushHeaders(); // accepts (200), then closes without a line
      setTimeout(() => res.destroy(), 5);
    });
    server = s.server;
    const delays: number[] = [];
    const budget = { remaining: 3 };
    const stream = new PushStream({
      db: null,
      log,
      resolver: resolverFor(s.url),
      league: 'wnba',
      runId: null,
      feed: 'push_events',
      backoffMinMs: 10,
      backoffMaxMs: 1000,
      random: () => 0.5,
      attemptBudget: budget,
      onLine: () => undefined,
      onStateChange: (st) => {
        if (st.status === 'backoff' && st.lastError) delays.push(Date.now());
      },
    });
    await stream.start();
    expect(stream.state.attempts).toBe(3);
    expect(budget.remaining).toBe(0);
    expect(stream.state.status).toBe('stopped');
    expect(stream.state.lastError).toMatch(/allowance exhausted/);
    expect(stream.state.connections).toBe(3); // every attempt connected (200) and was cut
    expect(s.connections()).toBe(3);
  });

  it('a line longer than 1 MiB without a newline aborts the connection (reconnect), never a parse', async () => {
    const s = await pushServer((res, n) => {
      if (n === 1) {
        res.write('x'.repeat(600 * 1024));
        setTimeout(() => res.write('y'.repeat(600 * 1024)), 5);
        return;
      }
      res.write(`${JSON.stringify(events[0])}\n`);
    });
    server = s.server;
    const stream = new PushStream({
      db: null,
      log,
      resolver: resolverFor(s.url),
      league: 'wnba',
      runId: null,
      feed: 'push_events',
      backoffMinMs: 10,
      backoffMaxMs: 20,
      onLine: () => undefined,
    });
    void stream.start();
    await until(() => stream.state.connections === 2);
    await stream.stop();
    expect(stream.state.lines).toBe(1);
    expect(s.connections()).toBe(2);
  });

  it('a send that would leave more than 200 ms after its slot re-claims a slot instead of sending late; nothing awaited between the slot and the send', async () => {
    // Fake clock: the first claimed slot is due now, but the process stalls 500 ms before it can
    // send (timer lateness / event-loop stall); the second claim is sent on time.
    let t = 1_000_000;
    const claims: Date[] = [];
    let stall = 500;
    const store: SlotStore = {
      claim: async () => {
        // every slot is due 100 ms after the claim
        const slotAt = new Date(t + 100);
        claims.push(slotAt);
        return { slotAt, delayMs: 100 };
      },
    };
    const limiter = new RateLimiter({ store, product: 'wnba' });
    const sends: number[] = [];
    let release: (() => void) | null = null;
    const fetchImpl = (async () => {
      sends.push(t);
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(`${JSON.stringify(events[0])}\n`));
          release = () => c.close();
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    const stream = new PushStream({
      db: null,
      log,
      resolver: {
        source: 'rehearsal',
        resolvePush: () => ({ url: 'http://127.0.0.1:1/stream/en/clock/subscribe', headers: {} }),
      },
      league: 'wnba',
      runId: null,
      feed: 'push_clock',
      limiter,
      fetchImpl,
      guard: { assertCall: async () => undefined } as unknown as QuotaGuard,
      now: () => t,
      sleep: async (ms) => {
        t += ms + stall;
        stall = 0;
      },
      onLine: () => undefined,
      onStateChange: (st) => {
        if (st.lastError) lastError = st.lastError;
      },
    });
    let lastError: string | null = null;
    void stream.start();
    await until(() => stream.state.connections === 1 || lastError !== null);
    expect(lastError).toBeNull();
    expect(claims).toHaveLength(2);
    expect(stream.state.slotReclaims).toBe(1);
    expect(sends).toHaveLength(1);
    // The request left on the second slot, not 500 ms after the first.
    expect(sends[0]).toBe(claims[1]?.getTime());
    (release as (() => void) | null)?.();
    await stream.stop();
  });

  it('reconnectedAt is the database clock read once the reconnect answered (stubbed), passed to onReconnect', async () => {
    const s = await pushServer((res, n) => {
      res.write(`${JSON.stringify(events[0])}\n`);
      if (n === 1) setTimeout(() => res.destroy(), 10);
    });
    server = s.server;
    const dbClock = new Date('2026-10-19T12:36:08.501Z');
    let dbReads = 0;
    const seen: Date[] = [];
    const stream = new PushStream({
      db: null,
      log,
      resolver: resolverFor(s.url),
      league: 'wnba',
      runId: null,
      feed: 'push_events',
      backoffMinMs: 10,
      backoffMaxMs: 20,
      dbNow: async () => {
        dbReads++;
        return dbClock;
      },
      onLine: () => undefined,
      onReconnect: (info) => {
        seen.push(info.reconnectedAt);
      },
    });
    void stream.start();
    await until(() => seen.length === 1);
    await stream.stop();
    expect(seen[0]?.toISOString()).toBe(dbClock.toISOString());
    expect(dbReads).toBe(1); // only the reconnect reads the clock, not the first connection
  });

  it('refuses a rate-limited source without limiter and guard, and a counted source without a database', () => {
    const base = {
      log,
      league: 'wnba' as const,
      runId: null,
      feed: 'push_events' as const,
      onLine: () => undefined,
    };
    const rehearsal: PushUrlResolver = {
      source: 'rehearsal',
      resolvePush: () => ({ url: 'http://127.0.0.1:1', headers: {} }),
    };
    const trial: PushUrlResolver = {
      source: 'trial',
      resolvePush: () => ({ url: 'http://127.0.0.1:1', headers: {} }),
    };
    expect(() => new PushStream({ ...base, db: null, resolver: rehearsal })).toThrow(
      /RateLimiter and a QuotaGuard/,
    );
    expect(() => new PushStream({ ...base, db: null, resolver: trial })).toThrow(
      /needs the database/,
    );
  });
});
