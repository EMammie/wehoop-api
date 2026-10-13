import type { Logger } from '../logger.js';
import type { LiveMessage, LiveTransport } from './transport.js';

/**
 * Publishes through Supabase Realtime's REST broadcast endpoint with the
 * service-role key on PRIVATE channels. The worker never holds a socket.
 * Clients can only receive: realtime.messages has no insert policy (0001).
 */
export class SupabaseBroadcastTransport implements LiveTransport {
  constructor(
    private readonly opts: {
      url: string;
      serviceRoleKey: string;
      log: Logger;
      fetchImpl?: typeof fetch;
      timeoutMs?: number;
    },
  ) {}

  async publish(channel: string, messages: LiveMessage[]): Promise<void> {
    if (messages.length === 0) return;
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const res = await fetchImpl(new URL('/realtime/v1/api/broadcast', this.opts.url), {
      method: 'POST',
      headers: {
        apikey: this.opts.serviceRoleKey,
        authorization: `Bearer ${this.opts.serviceRoleKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        messages: messages.map((m) => ({
          topic: channel,
          event: m.event,
          payload: m.payload,
          private: true,
        })),
      }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`broadcast ${channel}: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
  }
}
