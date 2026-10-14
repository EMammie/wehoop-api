import type { Db } from '../db/client.js';
import type { SessionDb } from '../db/session-client.js';
import type { FaultInjector } from '../ingest/fault.js';
import type { Logger } from '../logger.js';
import { type GameChange, gameChangeFromRow } from '../model/game-change.js';
import { gameChannel, type LiveTransport, TransportRateLimitError } from './transport.js';

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
  /** Rows whose publish threw a non-rate-limit error (attempt counted, may dead-letter). */
  failed: number;
  /** Rows deferred by a 429 (attempt counted, backoff from Retry-After or 1 s doubling; never dead). */
  rateLimited: number;
  /**
   * Channels that had pending rows but whose head (lowest unpublished, non-dead
   * seq) was not publishable now (`next_attempt_at` in the future). They
   * contribute nothing to this batch and block only themselves.
   */
  skippedChannels: number;
}

/**
 * Outbox publisher (plan §4). Exactly one per process (the lock holder).
 * Per channel, publishes in seq order. Each drain is head-first and fair:
 *   1. `heads` = every channel's lowest unpublished, non-dead row;
 *   2. only channels whose head is publishable now (`next_attempt_at <= now()`) take part;
 *   3. up to `batchSize` rows are taken across those channels round-robin by
 *      position (`row_number() over (partition by game_id order by seq)`,
 *      ordered by that rank, then channel), so the limit is applied AFTER head
 *      exclusion and a channel with a blocked head or a long backlog can never
 *      fill the batch and starve the others;
 *   4. per channel the contiguous prefix from the head is published, in chunks,
 *      stopping at the first seq gap (a later row still backing off).
 * At-least-once: a crash after the HTTP send and before `published_at` re-sends
 * the same GameChange with the same id; clients dedupe on id/seq. No HTTP call
 * happens inside a transaction.
 */
export class OutboxPublisher {
  private timer: NodeJS.Timeout | null = null;
  private draining: Promise<DrainResult> | null = null;
  private wanted = false;
  /**
   * Consecutive 429s per channel in this process, for the backoff when the server
   * sends no Retry-After (1 s doubling, capped at 5 min). Kept in memory on
   * purpose: `attempts` stays the count of REAL failures so "dead after 10
   * attempts" (plan §4) keeps its meaning, and a restart simply starts at 1 s.
   */
  private readonly rateLimitStreak = new Map<string, number>();

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
      const total: DrainResult = { published: 0, failed: 0, rateLimited: 0, skippedChannels: 0 };
      try {
        for (;;) {
          this.wanted = false;
          const r = await this.drainOnce();
          total.published += r.published;
          total.failed += r.failed;
          total.rateLimited += r.rateLimited;
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
    const [blocked] = await db<{ n: number }[]>`
      with heads as (
        select distinct on (game_id) game_id, next_attempt_at
        from ingest.broadcast_outbox
        where published_at is null and dead_at is null
        order by game_id, seq)
      select count(*)::int as n from heads where next_attempt_at > now()`;
    const rows = await db<PendingRow[]>`
      with heads as (
        select distinct on (game_id) game_id, seq, next_attempt_at
        from ingest.broadcast_outbox
        where published_at is null and dead_at is null
        order by game_id, seq),
      ready as (select game_id from heads where next_attempt_at <= now()),
      pending as (
        select o.change_id, o.game_id, o.seq, o.attempts,
               row_number() over (partition by o.game_id order by o.seq) as rn
        from ingest.broadcast_outbox o
        join ready r on r.game_id = o.game_id
        where o.published_at is null and o.dead_at is null and o.next_attempt_at <= now())
      select p.change_id as "changeId", p.game_id as "gameId", p.seq::text as seq, p.attempts,
             c.change_type::text as "changeType", c.provider_event_id as "providerEventId", c.body,
             c.created_at as "createdAt"
      from pending p
      join public.game_changes c on c.id = p.change_id
      order by p.rn, p.game_id, p.seq
      limit ${limit}`;
    const result: DrainResult = {
      published: 0,
      failed: 0,
      rateLimited: 0,
      skippedChannels: blocked?.n ?? 0,
    };
    if (result.skippedChannels > 0) {
      log.warn(
        { channels: result.skippedChannels },
        'outbox: channels with a blocked head skipped',
      );
    }
    if (rows.length === 0) return result;

    const byGame = new Map<string, PendingRow[]>();
    for (const r of rows) {
      const list = byGame.get(r.gameId) ?? [];
      list.push(r);
      byGame.set(r.gameId, list);
    }

    for (const [gameId, rowsOfGame] of byGame) {
      // rn ordering guarantees the head (rn = 1) is present; publish only the contiguous prefix.
      const sorted = rowsOfGame.sort((a, b) => Number(a.seq) - Number(b.seq));
      const list: PendingRow[] = [];
      for (const r of sorted) {
        const prev = list[list.length - 1];
        if (prev && Number(r.seq) !== Number(prev.seq) + 1) {
          log.warn(
            { gameId, afterSeq: prev.seq, nextSeq: r.seq },
            'outbox: seq gap inside a channel (a row still backing off); stopping at the prefix',
          );
          break;
        }
        list.push(r);
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
          const ids = chunk.map((r) => r.changeId);
          const message = (err as Error).message.slice(0, 500);
          if (err instanceof TransportRateLimitError) {
            // 429: retryable and NOT a failure: `attempts` is untouched (never dead-letters), only
            // last_error and next_attempt_at move. Backoff = Retry-After when given, else
            // 2^streak seconds (1, 2, 4, ... capped at 300) from the in-memory per-channel streak.
            result.rateLimited += chunk.length;
            const streak = this.rateLimitStreak.get(gameId) ?? 0;
            this.rateLimitStreak.set(gameId, streak + 1);
            const retrySecs =
              err.retryAfterMs === null
                ? Math.min(300, 2 ** streak)
                : Math.max(0.05, err.retryAfterMs / 1000);
            await db`update ingest.broadcast_outbox set
                       last_error = ${message},
                       next_attempt_at = now() + make_interval(secs => ${retrySecs}::float8)
                     where change_id = any(${ids})`;
            log.warn(
              {
                gameId,
                retryAfterMs: err.retryAfterMs,
                streak: streak + 1,
                retrySecs,
                count: chunk.length,
              },
              'outbox publish rate limited (429); backing off',
            );
            break;
          }
          result.failed += chunk.length;
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
        this.rateLimitStreak.delete(gameId);
        result.published += chunk.length;
      }
    }
    return result;
  }

  /** Unpublished rows: how many are still live (non-dead), how many are dead, and the earliest retry. */
  async pendingSummary(): Promise<{ pending: number; dead: number; nextAttemptAt: Date | null }> {
    const [r] = await this.deps.db<{ pending: number; dead: number; nextAttemptAt: Date | null }[]>`
      select count(*) filter (where dead_at is null)::int as pending,
             count(dead_at)::int as dead,
             min(next_attempt_at) filter (where dead_at is null) as "nextAttemptAt"
      from ingest.broadcast_outbox where published_at is null`;
    return r ?? { pending: 0, dead: 0, nextAttemptAt: null };
  }

  /**
   * Shutdown drain: loop drain -> pendingSummary until nothing live is pending,
   * `timeoutMs` elapses, or `opts.deadline()` (epoch ms, re-read every round, so
   * a caller can shorten it) passes; sleeps until the earliest retry (max 1 s)
   * between rounds. Returns immediately when nothing is pending. The waiting
   * warning is logged at most once per second, or when the pending count changes.
   */
  async drainUntilEmpty(
    timeoutMs: number,
    opts: { deadline?: () => number } = {},
  ): Promise<{ pending: number; dead: number }> {
    const started = Date.now();
    let lastWarnAt = 0;
    let lastWarnPending = -1;
    for (;;) {
      await this.drain();
      const p = await this.pendingSummary();
      const now = Date.now();
      const until = Math.min(started + timeoutMs, opts.deadline?.() ?? Number.POSITIVE_INFINITY);
      if (p.pending === 0 || now >= until) return p;
      const wait = Math.min(
        1000,
        until - now,
        Math.max(50, (p.nextAttemptAt?.getTime() ?? now) - now),
      );
      if (p.pending !== lastWarnPending || now - lastWarnAt >= 1000) {
        lastWarnAt = now;
        lastWarnPending = p.pending;
        this.deps.log.warn(
          { pending: p.pending, dead: p.dead, retryInMs: wait, remainingMs: until - now },
          'outbox not fully published; waiting for backoff before exit',
        );
      }
      await new Promise((r) => setTimeout(r, wait));
    }
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
