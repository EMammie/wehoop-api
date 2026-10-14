import { describe, expect, it } from 'vitest';
import { retryAfterMs, SupabaseBroadcastTransport } from '../../../src/live/supabase-broadcast.js';
import { TransportRateLimitError } from '../../../src/live/transport.js';
import { createLogger } from '../../../src/logger.js';

const log = createLogger({ level: 'silent', pretty: false });
const fakeFetch = (status: number, headers: Record<string, string> = {}): typeof fetch =>
  (async () => new Response('', { status, headers })) as typeof fetch;
const change = { event: 'pulse' as const, payload: {} as never };

describe('SupabaseBroadcastTransport', () => {
  it('429 throws TransportRateLimitError carrying Retry-After; other errors are plain', async () => {
    const limited = new SupabaseBroadcastTransport({
      url: 'http://localhost:54321',
      serviceRoleKey: 'k',
      log,
      fetchImpl: fakeFetch(429, { 'retry-after': '2' }),
    });
    const err = await limited.publish('game:x', [change]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportRateLimitError);
    expect((err as TransportRateLimitError).retryAfterMs).toBe(2000);
    const noHeader = new SupabaseBroadcastTransport({
      url: 'http://localhost:54321',
      serviceRoleKey: 'k',
      log,
      fetchImpl: fakeFetch(429),
    });
    const err2 = await noHeader.publish('game:x', [change]).catch((e: unknown) => e);
    expect((err2 as TransportRateLimitError).retryAfterMs).toBeNull();
    const down = new SupabaseBroadcastTransport({
      url: 'http://localhost:54321',
      serviceRoleKey: 'k',
      log,
      fetchImpl: fakeFetch(503),
    });
    await expect(down.publish('game:x', [change])).rejects.not.toBeInstanceOf(
      TransportRateLimitError,
    );
  });

  it('retryAfterMs parses delay-seconds and HTTP dates', () => {
    const now = Date.parse('2026-10-14T12:00:00Z');
    expect(retryAfterMs('3')).toBe(3000);
    expect(retryAfterMs('0.5')).toBe(500);
    expect(retryAfterMs('Wed, 14 Oct 2026 12:00:05 GMT', now)).toBe(5000);
    expect(retryAfterMs('Wed, 14 Oct 2026 11:00:00 GMT', now)).toBe(0);
    expect(retryAfterMs(null)).toBeNull();
    expect(retryAfterMs('soon')).toBeNull();
  });
});
