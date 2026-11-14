import type { Db } from '../db/client.js';

/**
 * Operator views and repairs on `ingest.broadcast_outbox` (plan §4 "Outbox
 * publisher": "Recovery: `pnpm outbox requeue --channel game:<id>`"). Nothing
 * here publishes: the worker's publisher does, woken by the NOTIFY.
 */

export interface OutboxChannelStatus {
  channel: string;
  gameId: string;
  pending: number;
  dead: number;
  /** Lowest unpublished seq (dead or not). */
  headSeq: number | null;
  nextAttemptAt: Date | null;
  lastError: string | null;
  maxAttempts: number;
}

export interface OutboxStatus {
  pending: number;
  dead: number;
  published: number;
  /** Age of the oldest live pending row, ms. */
  oldestPendingMs: number | null;
  channels: OutboxChannelStatus[];
}

export async function outboxStatus(db: Db): Promise<OutboxStatus> {
  const [totals] = await db<
    { pending: number; dead: number; published: number; oldestPendingMs: number | null }[]
  >`
    select count(*) filter (where published_at is null and dead_at is null)::int as pending,
           count(dead_at)::int as dead,
           count(published_at)::int as published,
           (extract(epoch from (now() - min(created_at) filter (where published_at is null and dead_at is null))) * 1000)::bigint::int as "oldestPendingMs"
    from ingest.broadcast_outbox`;
  const channels = await db<
    {
      channel: string;
      gameId: string;
      pending: number;
      dead: number;
      headSeq: string | null;
      nextAttemptAt: Date | null;
      lastError: string | null;
      maxAttempts: number;
    }[]
  >`
    select channel, game_id as "gameId",
           count(*) filter (where dead_at is null)::int as pending,
           count(dead_at)::int as dead,
           min(seq)::text as "headSeq",
           min(next_attempt_at) filter (where dead_at is null) as "nextAttemptAt",
           (array_agg(last_error order by seq))[1] as "lastError",
           max(attempts)::int as "maxAttempts"
    from ingest.broadcast_outbox
    where published_at is null
    group by channel, game_id
    order by min(created_at)`;
  return {
    pending: totals?.pending ?? 0,
    dead: totals?.dead ?? 0,
    published: totals?.published ?? 0,
    oldestPendingMs: totals?.oldestPendingMs ?? null,
    channels: channels.map((c) => ({
      ...c,
      headSeq: c.headSeq === null ? null : Number(c.headSeq),
    })),
  };
}

/** `game:<uuid>` -> the uuid; anything else is a usage error. */
export function gameIdOfChannel(channel: string): string {
  const m = /^game:([0-9a-f-]{36})$/i.exec(channel);
  if (!m?.[1]) throw new Error(`channel must be game:<uuid>, got ${channel}`);
  return m[1];
}

/**
 * Clear `dead_at`, reset `attempts` and `next_attempt_at`, drop the last error
 * and wake the publisher. Dead rows only: live rows are already the
 * publisher's business. Returns the channels touched.
 */
export async function requeueDead(
  db: Db,
  target: { gameId: string } | { all: true },
): Promise<{ requeued: number; channels: string[] }> {
  const rows = await db<{ channel: string }[]>`
    update ingest.broadcast_outbox
       set dead_at = null, attempts = 0, next_attempt_at = now(), last_error = null
     where dead_at is not null and published_at is null
       and ${'all' in target ? db`true` : db`game_id = ${target.gameId}`}
     returning channel`;
  const channels = [...new Set(rows.map((r) => r.channel))].sort();
  for (const channel of channels) await db.notify('outbox', gameIdOfChannel(channel));
  return { requeued: rows.length, channels };
}

export interface OutboxLag {
  /** Rows published in the window. */
  n: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  since: Date | null;
}

/** p50 / p95 / max of `published_at - created_at` over rows published after `since` (all rows when null). */
export async function outboxLag(db: Db, since: Date | null): Promise<OutboxLag> {
  const [row] = await db<
    { n: number; p50: number | null; p95: number | null; max: number | null }[]
  >`
    select count(*)::int as n,
           (percentile_cont(0.5) within group (order by extract(epoch from (published_at - created_at))) * 1000)::float8 as p50,
           (percentile_cont(0.95) within group (order by extract(epoch from (published_at - created_at))) * 1000)::float8 as p95,
           (max(extract(epoch from (published_at - created_at))) * 1000)::float8 as max
    from ingest.broadcast_outbox
    where published_at is not null
      and ${since === null ? db`true` : db`published_at > ${since}`}`;
  const r = (v: number | null) => (v === null ? null : Math.round(v));
  return {
    n: row?.n ?? 0,
    p50Ms: r(row?.p50 ?? null),
    p95Ms: r(row?.p95 ?? null),
    maxMs: r(row?.max ?? null),
    since,
  };
}

/** `24h`, `30m`, `7d`, `90s` relative to `now`, or an ISO timestamp. */
export function parseSince(text: string, now: Date = new Date()): Date {
  const m = /^(\d+)([smhd])$/.exec(text.trim());
  if (m) {
    const n = Number(m[1]);
    const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
      m[2] as 's' | 'm' | 'h' | 'd'
    ];
    return new Date(now.getTime() - n * unit);
  }
  const t = Date.parse(text);
  if (Number.isNaN(t))
    throw new Error(`--since must be like 24h, 30m, 7d or an ISO timestamp, got ${text}`);
  return new Date(t);
}
