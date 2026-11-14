import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type FakeProvider,
  startFakeProvider,
} from '../../../src/providers/sportradar/fake-provider.js';
import { clockToPushDigits } from '../../../src/providers/sportradar/fake-push.js';
import { classifyPushLine } from '../../../src/providers/sportradar/push-client.js';

/**
 * The fake provider's push streams (M4): pbp deltas as NDJSON lines, no history
 * before the connection, heartbeats, the drop fault (scheduled and on demand).
 */
const FIXTURE = new URL(
  '../../../fixtures/wnba/sim-93ee7c68-replay.compact.jsonl.gz',
  import.meta.url,
).pathname;
const H = { headers: { 'x-api-key': 'rehearsal-not-a-key' } };

let server: FakeProvider;
let t = 0;
beforeAll(async () => {
  server = await startFakeProvider({
    replayFile: FIXTURE,
    speed: 1,
    minSpacingMs: 0,
    heartbeatMs: 30,
    now: () => t,
    pushDrop: { afterMs: 70 * 60_000, forMs: 5_000 },
  });
});
afterAll(async () => {
  await server.close();
});

/** Read lines from a streaming response until `n` arrive or `ms` pass. */
async function readLines(res: Response, n: number, ms = 2000): Promise<unknown[]> {
  const out: unknown[] = [];
  if (!res.body) return out;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + ms;
  while (out.length < n && Date.now() < deadline) {
    const next = await Promise.race([
      reader.read().catch(() => null), // a cut socket ends the read, like a real drop
      new Promise<null>((r) => setTimeout(() => r(null), deadline - Date.now())),
    ]);
    if (next === null || next.done) break;
    buf += decoder.decode(next.value, { stream: true });
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      out.push(JSON.parse(buf.slice(0, nl)));
      buf = buf.slice(nl + 1);
      nl = buf.indexOf('\n');
    }
  }
  await reader.cancel().catch(() => undefined);
  return out;
}

describe('clockToPushDigits', () => {
  it('is the inverse of normalizePushClock for the forms the feeds use', () => {
    expect(clockToPushDigits('10:00')).toBe('1000');
    expect(clockToPushDigits('9:38')).toBe('0938');
    expect(clockToPushDigits('00:25')).toBe('0025');
    expect(clockToPushDigits('00:25.4')).toBe('0025.4');
    expect(clockToPushDigits(undefined)).toBeUndefined();
  });
});

describe('fake provider push streams', () => {
  it('derives insert/update/delete event lines and clock lines from the recording, every one a known push shape', () => {
    expect(server.pushLines.events).toBeGreaterThan(400); // 408 final events + updates + 5 deletes
    expect(server.pushLines.clocks).toBeGreaterThanOrEqual(50);
  });

  it('events stream: 401 without a key; with one, only lines AFTER the connection moment, then heartbeats', async () => {
    const url = `${server.url}/wnba/trial/stream/en/events/subscribe?match=sd:match:${server.providerGameId}`;
    expect((await fetch(url)).status).toBe(401);
    t = 60_000; // one minute in: the game has not tipped (first events at +24 s... already past)
    const res = await fetch(url, H);
    expect(res.status).toBe(200);
    // Nothing from the past is replayed: the first lines are heartbeats until time advances.
    const first = await readLines(res, 1, 500);
    expect(first.every((l) => classifyPushLine(l)?.kind === 'heartbeat')).toBe(true);
    const res2 = await fetch(url, H);
    t = 3 * 60_000; // +3 min: the 14:07:51 pbp document (11 events) is now due
    const lines = await readLines(res2, 8, 2000);
    const kinds = lines.map((l) => classifyPushLine(l)?.kind ?? 'unknown');
    expect(kinds).not.toContain('unknown');
    expect(kinds.filter((k) => k === 'event').length).toBeGreaterThanOrEqual(7);
    const ev = lines.find((l) => classifyPushLine(l)?.kind === 'event');
    expect(ev).toMatchObject({
      metadata: { match: `sd:match:${server.providerGameId}`, operation: 'insert' },
    });
    expect(server.stats.pushConnections).toBeGreaterThanOrEqual(2);
  });

  it('clock stream: lines carry digits clocks and running; delete markers appear on the events stream when deleted_events grow', async () => {
    const res = await fetch(`${server.url}/wnba/trial/stream/en/clock/subscribe`, H);
    t = 5.5 * 60_000; // the 14:10:21 document (+300 s) is due; heartbeats interleave
    const lines = await readLines(res, 40, 1500);
    const ck = lines.map((l) => classifyPushLine(l)).find((l) => l?.kind === 'clock');
    expect(ck?.kind).toBe('clock');
    if (ck?.kind === 'clock') {
      expect(ck.message.payload.clocks.game).toMatch(/^\d{4}$/);
      expect(typeof ck.message.payload.clocks.running).toBe('boolean');
      expect(ck.message.payload.period?.sequence).toBe(1);
    }
    const ev = await fetch(`${server.url}/wnba/trial/stream/en/events/subscribe`, H);
    t = 51 * 60_000; // the 14:55:13 document deletes an event whose body an earlier document carried
    const evLines = await readLines(ev, 600, 2500);
    const ops = evLines.map(
      (l) => (l as { metadata?: { operation?: string } }).metadata?.operation,
    );
    expect(ops).toContain('delete');
  });

  it('statistics stream is not mocked (404); the drop fault refuses connections during its window, scheduled or on demand', async () => {
    expect((await fetch(`${server.url}/wnba/trial/stream/en/statistics/subscribe`, H)).status).toBe(
      404,
    );
    t = 70 * 60_000 + 500; // inside the scheduled window [70 min, 70 min + 5 s)
    await expect(fetch(`${server.url}/wnba/trial/stream/en/events/subscribe`, H)).rejects.toThrow();
    expect(server.stats.pushDrops).toBeGreaterThanOrEqual(1);
    t = 70 * 60_000 + 6_000; // window over
    const ok = await fetch(`${server.url}/wnba/trial/stream/en/events/subscribe`, H);
    expect(ok.status).toBe(200);
    const ctl = await fetch(`${server.url}/_fault/push-drop?for=2000`, { method: 'POST' });
    expect(ctl.status).toBe(200);
    // the open stream was cut
    const rest = await readLines(ok, 1000, 500);
    expect(rest.length).toBeLessThan(1000);
    await expect(fetch(`${server.url}/wnba/trial/stream/en/clock/subscribe`, H)).rejects.toThrow();
    t = 70 * 60_000 + 9_000;
    expect((await fetch(`${server.url}/wnba/trial/stream/en/clock/subscribe`, H)).status).toBe(200);
  });
});
