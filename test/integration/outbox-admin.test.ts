import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  gameIdOfChannel,
  outboxLag,
  outboxStatus,
  parseSince,
  requeueDead,
} from '../../src/live/outbox-admin.js';
import { OutboxPublisher } from '../../src/live/outbox-publisher.js';
import { gameChannel, MemoryTransport } from '../../src/live/transport.js';
import {
  apply,
  counts,
  observation,
  pbpQ1,
  replayRun,
  seedGame,
  silentLog,
  testDb,
} from '../helpers/db.js';

/**
 * Dead-letter recovery and the lag measure (plan §4 "Outbox publisher",
 * §7 M4 "outbox lag p95"): rows dead-lettered after 10 failures do not publish
 * until `requeue` clears them; after it they publish in order; `lag` reports
 * p50/p95 of published_at - created_at from the database.
 */
const db = testDb();
const deps = { db, log: silentLog };
const T0 = new Date('2026-06-30T23:40:00Z');

beforeAll(async () => {
  await db`select 1`;
});
afterAll(async () => {
  await db.end();
});

describe('outbox admin', () => {
  it('dead rows stay dead through a drain; requeue clears them and they publish in seq order; status and lag read from the DB', async () => {
    const nd = pbpQ1();
    const { gameId } = await seedGame(db, nd);
    const run = await replayRun(db, gameId);
    await apply(deps, gameId, nd, observation(run, nd, T0));
    const c = await counts(db, gameId);
    expect(c.changes).toBeGreaterThan(5);
    // Drive the channel to dead letters: a transport that always fails, attempts forced to the limit.
    const failing = new MemoryTransport();
    failing.failIf = (channel) => channel === gameChannel(gameId);
    const publisher = new OutboxPublisher({
      db,
      log: silentLog,
      transport: failing,
      maxAttempts: 2,
    });
    await publisher.drain();
    await db`update ingest.broadcast_outbox set next_attempt_at = now() where game_id = ${gameId}`;
    await publisher.drain();
    const status = await outboxStatus(db);
    const mine = status.channels.find((ch) => ch.gameId === gameId);
    expect(mine).toBeDefined();
    // the head chunk (<= 50 rows) died after 2 attempts; nothing published
    expect(mine?.dead).toBeGreaterThan(0);
    expect(mine?.maxAttempts).toBe(2);
    expect(mine?.headSeq).toBe(1);
    expect(mine?.lastError).toContain('injected publish failure');
    expect(status.dead).toBeGreaterThanOrEqual(mine?.dead ?? 0);

    // A healthy transport cannot publish past dead heads.
    const healthy = new MemoryTransport();
    const fixed = new OutboxPublisher({ db, log: silentLog, transport: healthy });
    await db`update ingest.broadcast_outbox set next_attempt_at = now() where game_id = ${gameId}`;
    await fixed.drain();
    expect(healthy.published.filter((p) => p.channel === gameChannel(gameId))).toHaveLength(0);

    // requeue: dead_at cleared, attempts reset, then everything publishes in order.
    const r = await requeueDead(db, { gameId });
    expect(r.requeued).toBe(mine?.dead);
    expect(r.channels).toEqual([gameChannel(gameId)]);
    const [after] = await db<{ dead: number; attempts: number; errors: number }[]>`
      select count(dead_at)::int as dead, max(attempts)::int as attempts, count(last_error)::int as errors
      from ingest.broadcast_outbox where game_id = ${gameId}`;
    expect(after).toEqual({ dead: 0, attempts: 0, errors: 0 });
    await fixed.drain();
    const seqs = healthy.published
      .filter((p) => p.channel === gameChannel(gameId))
      .map((p) => (p.message.event === 'change' ? p.message.payload.seq : -1));
    expect(seqs).toEqual(seqs.map((_s, i) => i + 1));
    expect(seqs).toHaveLength(c.changes);
    const [done] = await db<{ pending: number; dead: number }[]>`
      select count(*) filter (where published_at is null)::int as pending, count(dead_at)::int as dead
      from ingest.broadcast_outbox where game_id = ${gameId}`;
    expect(done).toEqual({ pending: 0, dead: 0 });

    // lag over the window that contains these rows
    const lag = await outboxLag(db, parseSince('1h'));
    expect(lag.n).toBeGreaterThanOrEqual(c.changes);
    expect(lag.p50Ms).not.toBeNull();
    expect(lag.p95Ms).not.toBeNull();
    expect((lag.p95Ms ?? 0) >= (lag.p50Ms ?? 0)).toBe(true);
    expect((lag.maxMs ?? 0) >= (lag.p95Ms ?? 0)).toBe(true);
    const none = await outboxLag(db, new Date(Date.now() + 3_600_000));
    expect(none).toMatchObject({ n: 0, p50Ms: null, p95Ms: null, maxMs: null });
  });

  it('requeue --all touches only dead rows; channel parsing is strict; since parsing accepts durations and ISO', async () => {
    const before = await outboxStatus(db);
    const r = await requeueDead(db, { all: true });
    expect(r.requeued).toBe(before.dead);
    expect((await outboxStatus(db)).dead).toBe(0);
    expect(gameIdOfChannel('game:11111111-1111-4111-8111-111111111111')).toBe(
      '11111111-1111-4111-8111-111111111111',
    );
    expect(() => gameIdOfChannel('league:wnba:scores')).toThrow(/game:<uuid>/);
    const now = new Date('2026-10-18T12:00:00Z');
    expect(parseSince('24h', now).toISOString()).toBe('2026-10-17T12:00:00.000Z');
    expect(parseSince('30m', now).toISOString()).toBe('2026-10-18T11:30:00.000Z');
    expect(parseSince('2026-10-01T00:00:00Z').toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(() => parseSince('yesterday')).toThrow(/--since/);
  });
});
