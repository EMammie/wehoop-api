import type { Db } from '../db/client.js';
import type { SessionDb } from '../db/session-client.js';
import type { FaultInjector } from '../ingest/fault.js';
import type { Logger } from '../logger.js';
import { type GameChange, gameChangeFromRow } from '../model/game-change.js';
import { gameChannel, type LiveTransport } from './transport.js';

interface PendingRow {
  changeId: string;
  gameId: string;
  seq: string;
  attempts: number;
  changeType: string;
  providerEventId: string | null;
  body: unknown;
  createdAt: Date;
}

export interface DrainResult {
  published: number;
  failed: number;
  skippedChannels: number;
}

/**
 * Outbox publisher (plan §4). Exactly one per process (the lock holder).
 * Per channel, publishes in seq order; a channel whose lowest unpublished seq
 * is not in this batch (its head is backing off) is skipped entirely, so a
 * stuck head blocks that channel, never the system. At-least-once: a crash
 * after the HTTP send and before `published_at` re-sends the same GameChange
 * with the same id; clients dedupe on id/seq. No HTTP call happens inside a
 * transaction.
 */
export class OutboxPublisher {
  private timer: NodeJS.Timeout | null = null;
  private draining: Promise<DrainResult> | null = null;
  private wanted = false;

  constructor(
    private readonly deps: {
      db: Db;
      log: Logger;
      transport: LiveTransport;
      fault?: FaultInjector;
      batchSize?: number;
      chunkSize?: number;
      maxAttempts?: number;
      intervalMs?: number;
    },
  ) {}

  /** Drain until nothing is publishable. Concurrent calls coalesce. */
  drain(): Promise<DrainResult> {
    if (this.draining) {
      this.wanted = true;
      return this.draining;
    }
    this.draining = (async () => {
      const total: DrainResult = { published: 0, failed: 0, skippedChannels: 0 };
      try {
        for (;;) {
          this.wanted = false;
          const r = await this.drainOnce();
          total.published += r.published;
          total.failed += r.failed;
          total.skippedChannels += r.skippedChannels;
          if (r.published === 0 && !this.wanted) break;
        }
      } finally {
        this.draining = null;
      }
      return total;
    })();
    return this.draining;
  }

  async drainOnce(): Promise<DrainResult> {
    const { db, log, transport } = this.deps;
    const limit = this.deps.batchSize ?? 200;
    const chunkSize = this.deps.chunkSize ?? 50;
    const maxAttempts = this.deps.maxAttempts ?? 10;
    const rows = await db<PendingRow[]>`
      select o.change_id as "changeId", o.game_id as "gameId", o.seq::text as seq, o.attempts,
             c.change_type as "changeType", c.provider_event_id as "providerEventId", c.body,
             c.created_at as "createdAt"
      from ingest.broadcast_outbox o
      join public.game_changes c on c.id = o.change_id
      where o.published_at is null and o.dead_at is null and o.next_attempt_at <= now()
      order by o.game_id, o.seq
      limit ${limit}`;
    const result: DrainResult = { published: 0, failed: 0, skippedChannels: 0 };
    if (rows.length === 0) return result;

    const byGame = new Map<string, PendingRow[]>();
    for (const r of rows) {
      const list = byGame.get(r.gameId) ?? [];
      list.push(r);
      byGame.set(r.gameId, list);
    }
    const heads = await db<{ gameId: string; seq: string }[]>`
      select game_id as "gameId", min(seq)::text as seq from ingest.broadcast_outbox
      where published_at is null and dead_at is null and game_id = any(${[...byGame.keys()]})
      group by game_id`;
    const headSeq = new Map(heads.map((h) => [h.gameId, h.seq]));

    for (const [gameId, list] of byGame) {
      const first = list[0];
      if (!first || headSeq.get(gameId) !== first.seq) {
        result.skippedChannels++;
        log.warn(
          { gameId, head: headSeq.get(gameId), batchFirst: first?.seq },
          'outbox: channel head not publishable, skipping channel',
        );
        continue;
      }
      const channel = gameChannel(gameId);
      for (let i = 0; i < list.length; i += chunkSize) {
        const chunk = list.slice(i, i + chunkSize);
        const changes: GameChange[] = chunk.map((r) =>
          gameChangeFromRow({
            id: r.changeId,
            gameId: r.gameId,
            seq: r.seq,
            changeType: r.changeType,
            providerEventId: r.providerEventId,
            body: r.body,
            createdAt: r.createdAt,
          }),
        );
        try {
          await transport.publish(
            channel,
            changes.map((c) => ({ event: 'change', payload: c })),
          );
        } catch (err) {
          result.failed += chunk.length;
          const ids = chunk.map((r) => r.changeId);
          const message = (err as Error).message.slice(0, 500);
          await db`update ingest.broadcast_outbox set
                     attempts = attempts + 1,
                     last_error = ${message},
                     next_attempt_at = now() + make_interval(secs => least(300, power(2, attempts + 1))),
                     dead_at = case when attempts + 1 >= ${maxAttempts} then now() else dead_at end
                   where change_id = any(${ids})`;
          log.error({ gameId, err: message, count: chunk.length }, 'outbox publish failed');
          break; // keep seq order: nothing later on this channel until the head succeeds
        }
        // Crash point (c): published over HTTP, published_at not yet written.
        const lastSeq = Number(chunk[chunk.length - 1]?.seq ?? 0);
        this.deps.fault?.maybeFire('after_publish', lastSeq);
        await db`update ingest.broadcast_outbox set published_at = now(), attempts = attempts + 1, last_error = null
                 where change_id = any(${chunk.map((r) => r.changeId)})`;
        result.published += chunk.length;
      }
    }
    return result;
  }

  /** Startup drain, LISTEN outbox as a wake-up hint, and a 30 s safety timer. */
  async start(session: SessionDb): Promise<void> {
    await this.drain();
    await session.listen('outbox', () => {
      void this.drain().catch((err) => this.deps.log.error({ err }, 'outbox drain failed'));
    });
    this.timer = setInterval(() => {
      void this.drain().catch((err) => this.deps.log.error({ err }, 'outbox drain failed'));
    }, this.deps.intervalMs ?? 30_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
