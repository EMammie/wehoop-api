import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFaultInjector } from '../../src/ingest/fault.js';
import { OutboxPublisher } from '../../src/live/outbox-publisher.js';
import { buildPulse } from '../../src/live/pulse.js';
import { gameChannel, MemoryTransport } from '../../src/live/transport.js';
import {
  apply,
  counts,
  observation,
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
});
