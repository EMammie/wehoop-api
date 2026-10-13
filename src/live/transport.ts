import type { GameChange } from '../model/game-change.js';
import type { Pulse } from '../model/pulse.js';

export type LiveMessage =
  | { event: 'change'; payload: GameChange }
  | { event: 'pulse'; payload: Pulse };

/**
 * LiveTransport (plan §1): the only thing the worker needs from a delivery
 * system. Supabase Broadcast today; custom SSE if measurements justify it.
 * `publish` must either deliver every message of the call or throw.
 */
export interface LiveTransport {
  publish(channel: string, messages: LiveMessage[]): Promise<void>;
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

  async publish(channel: string, messages: LiveMessage[]): Promise<void> {
    if (this.failIf?.(channel, messages))
      throw new Error('MemoryTransport: injected publish failure');
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
