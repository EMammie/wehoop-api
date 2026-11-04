import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFaultInjector } from '../../src/ingest/fault.js';
import { OutboxPublisher } from '../../src/live/outbox-publisher.js';
import { buildPulse } from '../../src/live/pulse.js';
import { gameChannel, MemoryTransport } from '../../src/live/transport.js';
import {
  apply,
  counts,
  observation,
  pbpClosed,
  pbpQ1,
  replayRun,
  seedGame,
  silentLog,
  summaryQ1,
  testDb,
} from '../helpers/db.js';

const db = testDb();
const deps = { db, log: silentLog };
const T0 = new Date('2026-06-30T23:40:00Z');

beforeAll(async () => {
  await db`select 1`;
});
afterAll(async () => {
  await db.end();
});

async function pendingFor(gameId: string) {
  const [r] = await db<{ pending: number; published: number; dead: number; maxAttempts: number }[]>`
    select count(*) filter (where published_at is null)::int as pending, count(published_at)::int as published,
           count(dead_at)::int as dead, coalesce(max(attempts), 0)::int as "maxAttempts"
    from ingest.broadcast_outbox where game_id = ${gameId}`;
  return r;
}

describe('outbox publisher', () => {
  it('startup drain publishes every unpublished change of a channel in seq order and marks published_at', async () => {
    const nd = pbpQ1();
    const { gameId } = await seedGame(db, nd);
    const run = await replayRun(db, gameId);
    await apply(deps, gameId, nd, observation(run, nd, T0));
    const transport = new MemoryTransport();
    const publisher = new OutboxPublisher({ db, log: silentLog, transport, chunkSize: 7 });
    const r = await publisher.drain();
    const c = await counts(db, gameId);
    const mine = transport.published.filter((p) => p.channel === gameChannel(gameId));
    expect(r.published).toBeGreaterThanOrEqual(c.changes);
    expect(mine.map((p) => (p.message.event === 'change' ? p.message.payload.seq : -1))).toEqual(
      mine.map((_p, i) => i + 1),
    );
    expect(await pendingFor(gameId)).toMatchObject({ pending: 0, published: c.changes, dead: 0 });
    // nothing left: a second drain is a no-op
    expect((await publisher.drain()).published).toBe(0);
  });

  it('a failing head blocks only its channel, retries with backoff, and never reorders', async () => {
    const a = pbpQ1();
    const ga = await seedGame(db, a);
    const gb = await seedGame(db, a);
    const runA = await replayRun(db, ga.gameId);
    const runB = await replayRun(db, gb.gameId);
    await apply(deps, ga.gameId, a, observation(runA, a, T0));
    await apply(deps, gb.gameId, a, observation(runB, a, T0));
    const transport = new MemoryTransport();
    transport.failIf = (channel) => channel === gameChannel(ga.gameId);
    const publisher = new OutboxPublisher({ db, log: silentLog, transport, chunkSize: 5 });
    const r = await publisher.drain();
    expect(r.failed).toBeGreaterThan(0);
    const pa = await pendingFor(ga.gameId);
    const pb = await pendingFor(gb.gameId);
    expect(pa?.published).toBe(0);
    expect(pa?.maxAttempts).toBe(1);
    expect(pb?.pending).toBe(0);
    // while A's head backs off (next_attempt_at in the future) a drain skips channel A entirely
    const r2 = await publisher.drain();
    expect(r2.published).toBe(0);
    // once the backoff elapses the channel resumes in order
    await db`update ingest.broadcast_outbox set next_attempt_at = now() where game_id = ${ga.gameId}`;
    transport.failIf = null;
    await publisher.drain();
    const seqs = transport.published
      .filter((p) => p.channel === gameChannel(ga.gameId))
      .map((p) => (p.message.event === 'change' ? p.message.payload.seq : -1));
    expect(seqs).toEqual(seqs.map((_s, i) => i + 1));
    expect(await pendingFor(ga.gameId)).toMatchObject({ pending: 0, dead: 0 });
  });

  it('fairness: a channel with a blocked head and 300 rows behind it never fills the batch; the other channel publishes fully in the first drain', async () => {
    const big = pbpClosed();
    const small = pbpQ1();
    const ga = await seedGame(db, big);
    const gb = await seedGame(db, small);
    await apply(deps, ga.gameId, big, observation(await replayRun(db, ga.gameId), big, T0));
    await apply(deps, gb.gameId, small, observation(await replayRun(db, gb.gameId), small, T0));
    expect((await pendingFor(ga.gameId))?.pending).toBeGreaterThanOrEqual(300);
    const bPending = (await pendingFor(gb.gameId))?.pending ?? 0;
    expect(bPending).toBeGreaterThan(0);
    // A's head is backing off for an hour
    await db`update ingest.broadcast_outbox set next_attempt_at = now() + interval '1 hour'
             where game_id = ${ga.gameId} and seq = (select min(seq) from ingest.broadcast_outbox where game_id = ${ga.gameId})`;
    const transport = new MemoryTransport();
    const publisher = new OutboxPublisher({ db, log: silentLog, transport, batchSize: 200 });
    const r = await publisher.drainOnce();
    expect(r.published).toBe(bPending);
    expect(r.skippedChannels).toBe(1); // A: pending rows, head not publishable now
    expect(await pendingFor(gb.gameId)).toMatchObject({ pending: 0 });
    expect((await pendingFor(ga.gameId))?.published).toBe(0);
    expect(transport.published.every((p) => p.channel === gameChannel(gb.gameId))).toBe(true);
    // clean up: release A so the validator's global invariants (no stuck rows) hold
    await db`update ingest.broadcast_outbox set next_attempt_at = now() where game_id = ${ga.gameId}`;
    await publisher.drain();
    expect(await pendingFor(ga.gameId)).toMatchObject({ pending: 0, dead: 0 });
  });

  it('fairness: with both heads ready, a 300-row channel and a 5-row channel both make progress in the first drain (the small one fully), each in seq order', async () => {
    const big = pbpClosed();
    const small = pbpQ1();
    const ga = await seedGame(db, big);
    const gb = await seedGame(db, small);
    await apply(deps, ga.gameId, big, observation(await replayRun(db, ga.gameId), big, T0));
    await apply(deps, gb.gameId, small, observation(await replayRun(db, gb.gameId), small, T0));
    const aPending = (await pendingFor(ga.gameId))?.pending ?? 0;
    const bPending = (await pendingFor(gb.gameId))?.pending ?? 0;
    expect(aPending).toBeGreaterThanOrEqual(300);
    const transport = new MemoryTransport();
    const publisher = new OutboxPublisher({ db, log: silentLog, transport, batchSize: 200 });
    const r = await publisher.drainOnce();
    expect(r.published).toBe(200);
    expect(r.skippedChannels).toBe(0);
    expect((await pendingFor(gb.gameId))?.pending).toBe(0);
    expect((await pendingFor(ga.gameId))?.published).toBe(200 - bPending);
    const seqsOf = (gameId: string) =>
      transport.published
        .filter((p) => p.channel === gameChannel(gameId))
        .map((p) => (p.message.event === 'change' ? p.message.payload.seq : -1));
    expect(seqsOf(gb.gameId)).toEqual(seqsOf(gb.gameId).map((_s, i) => i + 1));
    expect(seqsOf(ga.gameId)).toEqual(seqsOf(ga.gameId).map((_s, i) => i + 1));
    // the rest drains in later batches
    const rest = await publisher.drain();
    expect(rest.published).toBe(aPending - (200 - bPending));
    expect(await pendingFor(ga.gameId)).toMatchObject({ pending: 0, dead: 0 });
  });

  it('429 is retryable: two rate-limited rounds then success publishes every row, leaves attempts untouched, honours Retry-After, never dead-letters', async () => {
    const nd = pbpQ1();
    const { gameId } = await seedGame(db, nd);
    const run = await replayRun(db, gameId);
    await apply(deps, gameId, nd, observation(run, nd, T0));
    const total = (await counts(db, gameId)).changes;
    const transport = new MemoryTransport();
    let calls = 0;
    transport.rateLimitIf = (channel) => {
      if (channel !== gameChannel(gameId)) return false;
      calls++;
      return calls <= 2 ? 60 : false; // Retry-After 60 ms, twice (the publisher floors it at 50 ms)
    };
    const publisher = new OutboxPublisher({ db, log: silentLog, transport, maxAttempts: 2 });
    const r1 = await publisher.drainOnce();
    expect(r1).toMatchObject({ published: 0, failed: 0 });
    expect(r1.rateLimited).toBeGreaterThan(0);
    let p = await pendingFor(gameId);
    expect(p).toMatchObject({ published: 0, dead: 0, maxAttempts: 0 }); // 429 is not an attempt
    // not publishable until Retry-After elapses
    expect((await publisher.drainOnce()).published).toBe(0);
    await new Promise((r) => setTimeout(r, 90));
    const r2 = await publisher.drainOnce();
    expect(r2.published).toBe(0);
    expect(r2.rateLimited).toBeGreaterThan(0);
    p = await pendingFor(gameId);
    expect(p).toMatchObject({ dead: 0, maxAttempts: 0 }); // two 429s: attempts still 0, nothing dead
    // the bounded shutdown drain waits out the backoff and finishes
    const left = await publisher.drainUntilEmpty(5_000);
    expect(left).toMatchObject({ pending: 0, dead: 0 });
    expect(await pendingFor(gameId)).toMatchObject({
      pending: 0,
      published: total,
      dead: 0,
      maxAttempts: 1, // the one real (successful) publish
    });
    const seqs = transport.published
      .filter((x) => x.channel === gameChannel(gameId))
      .map((x) => (x.message.event === 'change' ? x.message.payload.seq : -1));
    expect(seqs).toEqual(seqs.map((_s, i) => i + 1));
    // with nothing pending the shutdown drain returns at once
    const started = Date.now();
    expect((await publisher.drainUntilEmpty(60_000)).pending).toBe(0);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('crash point (c): a fault after the HTTP publish and before published_at re-sends the same ids on restart (at-least-once)', async () => {
    const nd = summaryQ1();
    const { gameId } = await seedGame(db, nd);
    const run = await replayRun(db, gameId);
    await apply(
      deps,
      gameId,
      { ...nd, isComplete: false },
      { ...observation(run, nd, T0), isComplete: false },
    ); // 2 stats_team + status + period
    const transport = new MemoryTransport();
    const fault = createFaultInjector(
      { kind: 'after_publish', atSeq: 1 },
      () => {
        throw new Error('SIGKILL (simulated)');
      },
      () => undefined,
    );
    const crashing = new OutboxPublisher({ db, log: silentLog, transport, fault });
    await expect(crashing.drainOnce()).rejects.toThrow(/SIGKILL/);
    const sentBeforeCrash = transport.published.length;
    expect(sentBeforeCrash).toBeGreaterThan(0);
    expect((await pendingFor(gameId))?.published).toBe(0); // the HTTP send happened, the row was never marked
    const restarted = new OutboxPublisher({ db, log: silentLog, transport });
    await restarted.drain();
    const ids = transport.published.map((p) =>
      p.message.payload.v === 1 && 'id' in p.message.payload ? p.message.payload.id : '',
    );
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(dupes.length).toBe(sentBeforeCrash); // every pre-crash message was re-sent with the same id
    expect((await pendingFor(gameId))?.pending).toBe(0);
  });

  it('after 10 failed attempts a row is dead-lettered and the channel stays blocked until requeued', async () => {
    const nd = summaryQ1();
    const { gameId } = await seedGame(db, nd);
    const run = await replayRun(db, gameId);
    await apply(
      deps,
      gameId,
      { ...nd, isComplete: false },
      { ...observation(run, nd, T0), isComplete: false },
    );
    const transport = new MemoryTransport();
    transport.failIf = () => true;
    const publisher = new OutboxPublisher({ db, log: silentLog, transport, maxAttempts: 3 });
    for (let i = 0; i < 3; i++) {
      await db`update ingest.broadcast_outbox set next_attempt_at = now() where game_id = ${gameId}`;
      await publisher.drainOnce();
    }
    const p = await pendingFor(gameId);
    expect(p?.dead).toBeGreaterThan(0);
    // clean up so the global invariant (0 dead letters) holds for the validator's run
    await db`update ingest.broadcast_outbox set dead_at = null, attempts = 0, next_attempt_at = now(), last_error = null where game_id = ${gameId}`;
    transport.failIf = null;
    await publisher.drain();
    expect(await pendingFor(gameId)).toMatchObject({ pending: 0, dead: 0 });
  });

  it('pulse is built from the observation columns and last_seq, never from the change stream', async () => {
    const nd = pbpQ1();
    const { gameId } = await seedGame(db, nd);
    const run = await replayRun(db, gameId);
    const r = await apply(deps, gameId, nd, observation(run, nd, T0));
    const pulse = await buildPulse(db, gameId);
    expect(pulse).toMatchObject({
      v: 1,
      type: 'pulse',
      gameId,
      latestSeq: r.lastSeq,
      status: 'inprogress',
      clock: nd.gameView?.clock,
      observedAt: T0.toISOString(),
    });
    expect(pulse?.clockAsOf).toBe(T0.toISOString());
  });
  it('the outbox wake-up is sent at commit, never before it (rolled-back batch sends none)', async () => {
    const url = process.env.DATABASE_URL ?? '';
    const listener = postgres(url, { max: 1, onnotice: () => {} });
    const heard: Array<{ gameId: string; visible: number }> = [];
    try {
      await listener.listen('outbox', async (payload) => {
        // What the publisher would see at wake-up time, on another connection.
        const [r] = await db<{ n: number }[]>`
          select count(*)::int as n from ingest.broadcast_outbox where game_id = ${payload}`;
        heard.push({ gameId: payload, visible: r?.n ?? 0 });
      });
      // A batch that dies before COMMIT must not wake anyone.
      const rolledBack = pbpQ1();
      const rb = await seedGame(db, rolledBack);
      const rbRun = await replayRun(db, rb.gameId);
      const failBeforeCommit = {
        maybeFire(kind: string) {
          if (kind === 'before_commit') throw new Error('injected rollback');
        },
      };
      await expect(
        apply(
          { ...deps, fault: failBeforeCommit },
          rb.gameId,
          rolledBack,
          observation(rbRun, rolledBack, T0),
        ),
      ).rejects.toThrow('injected rollback');
      // A committed batch wakes the publisher with every row already visible.
      const nd = pbpQ1();
      const { gameId } = await seedGame(db, nd);
      const run = await replayRun(db, gameId);
      const r = await apply(deps, gameId, nd, observation(run, nd, T0));
      for (let i = 0; i < 50 && !heard.some((h) => h.gameId === gameId); i++) {
        await new Promise((res) => setTimeout(res, 20));
      }
      expect(heard.filter((h) => h.gameId === rb.gameId)).toEqual([]);
      expect(heard.filter((h) => h.gameId === gameId)).toEqual([
        { gameId, visible: r.changes.length },
      ]);
      expect((await counts(db, rb.gameId)).changes).toBe(0);
    } finally {
      await listener.end({ timeout: 2 });
    }
  });
});
