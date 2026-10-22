import type { GameChange } from '../model/game-change.js';
import type { Pulse } from '../model/pulse.js';
import type { Scoreboard } from '../model/scoreboard.js';

export type LiveMessage =
  | { event: 'change'; payload: GameChange }
  | { event: 'pulse'; payload: Pulse }
  /** `league:{code}:scores` only (plan §5); never on a game channel, never through the outbox. */
  | { event: 'scores'; payload: Scoreboard };

/**
 * LiveTransport (plan §1): the only thing the worker needs from a delivery
 * system. Supabase Broadcast today; custom SSE if measurements justify it.
 * `publish` must either deliver every message of the call or throw.
 */
export interface LiveTransport {
  publish(channel: string, messages: LiveMessage[]): Promise<void>;
}

/**
 * The transport was rate-limited (HTTP 429). Retryable: the publisher backs
 * off (honouring `retryAfterMs` when the server gave one) and never
 * dead-letters a row for rate limiting alone.
 */
export class TransportRateLimitError extends Error {
  constructor(
    readonly channel: string,
    readonly retryAfterMs: number | null,
  ) {
    super(
      `broadcast ${channel}: rate limited (429)${retryAfterMs === null ? '' : `, retry after ${retryAfterMs} ms`}`,
    );
    this.name = 'TransportRateLimitError';
  }
}

export type ClientHandler = (msg: LiveMessage) => void;

/**
 * In-memory transport for tests and the reference client contract. Supports
 * fault hooks: `dropIf` silently loses a message (the "missing final change"
 * case) and `failIf` makes publish throw (outbox retry path).
 */
export class MemoryTransport implements LiveTransport {
  readonly published: Array<{ channel: string; message: LiveMessage }> = [];
  private readonly handlers = new Map<string, Set<ClientHandler>>();
  dropIf: ((channel: string, msg: LiveMessage) => boolean) | null = null;
  failIf: ((channel: string, msgs: LiveMessage[]) => boolean) | null = null;
  /** Returns the Retry-After to report (ms, or null for none) to simulate a 429; `false` = not limited. */
  rateLimitIf: ((channel: string, msgs: LiveMessage[]) => number | null | false) | null = null;

  async publish(channel: string, messages: LiveMessage[]): Promise<void> {
    if (this.failIf?.(channel, messages))
      throw new Error('MemoryTransport: injected publish failure');
    const limited = this.rateLimitIf?.(channel, messages);
    if (limited !== undefined && limited !== false)
      throw new TransportRateLimitError(channel, limited);
    for (const message of messages) {
      this.published.push({ channel, message });
      if (this.dropIf?.(channel, message)) continue;
      for (const h of this.handlers.get(channel) ?? []) h(message);
    }
  }

  subscribe(channel: string, handler: ClientHandler): () => void {
    let set = this.handlers.get(channel);
    if (!set) {
      set = new Set();
      this.handlers.set(channel, set);
    }
    set.add(handler);
    return () => set?.delete(handler);
  }
}

export function gameChannel(gameId: string): string {
  return `game:${gameId}`;
}
