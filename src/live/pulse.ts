import type { Db } from '../db/client.js';
import type { Logger } from '../logger.js';
import type { GameStatus } from '../model/live-event.js';
import { type Pulse, PulseSchema } from '../model/pulse.js';
import { gameChannel, type LiveTransport } from './transport.js';

/** Build a pulse from the games observation columns + last_seq. Null if the game is unknown. */
export async function buildPulse(
  db: Db,
  gameId: string,
  now: Date = new Date(),
): Promise<Pulse | null> {
  const [g] = await db<
    {
      lastSeq: string;
      status: GameStatus;
      clock: string | null;
      clockDecimal: string | null;
      clockRunning: boolean | null;
      clockAsOf: Date | null;
      observedAt: Date | null;
    }[]
  >`select last_seq::text as "lastSeq", status, clock, clock_decimal as "clockDecimal",
           clock_running as "clockRunning", clock_as_of as "clockAsOf", observed_at as "observedAt"
    from public.games where id = ${gameId}`;
  if (!g) return null;
  return PulseSchema.parse({
    v: 1,
    type: 'pulse',
    gameId,
    latestSeq: Number(g.lastSeq),
    status: g.status,
    clock: g.clock,
    ...(g.clockDecimal ? { clockDecimal: g.clockDecimal } : {}),
    clockRunning: g.clockRunning,
    clockAsOf: g.clockAsOf ? g.clockAsOf.toISOString() : null,
    observedAt: (g.observedAt ?? now).toISOString(),
  });
}

/**
 * Pulse sender (plan §4): every 10 s per live game and once on close, straight
 * to the transport. Loss is harmless; the next pulse supersedes.
 */
export class PulseSender {
  /** One timer per live game (the production scheduler watches several at once). */
  private readonly timers = new Map<string, NodeJS.Timeout>();
  constructor(
    private readonly deps: { db: Db; transport: LiveTransport; log: Logger; intervalMs?: number },
  ) {}

  async sendOnce(gameId: string): Promise<Pulse | null> {
    const pulse = await buildPulse(this.deps.db, gameId);
    if (!pulse) return null;
    try {
      await this.deps.transport.publish(gameChannel(gameId), [{ event: 'pulse', payload: pulse }]);
    } catch (err) {
      this.deps.log.warn({ err, gameId }, 'pulse publish failed (harmless)');
    }
    return pulse;
  }

  start(gameId: string): void {
    this.stop(gameId);
    this.timers.set(
      gameId,
      setInterval(() => void this.sendOnce(gameId), this.deps.intervalMs ?? 10_000),
    );
  }

  /** Stop one game's pulses, or every game's when no id is given. */
  stop(gameId?: string): void {
    if (gameId === undefined) {
      for (const t of this.timers.values()) clearInterval(t);
      this.timers.clear();
      return;
    }
    const t = this.timers.get(gameId);
    if (t) clearInterval(t);
    this.timers.delete(gameId);
  }

  /** Games currently pulsing. */
  get active(): string[] {
    return [...this.timers.keys()];
  }
}
