import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/server.js';
import { loadConfig } from '../../src/config.js';
import { GameChangeSchema } from '../../src/model/game-change.js';
import { canonicalState, stateFromSnapshot } from '../../src/model/game-state.js';
import { ChangesPageSchema, SnapshotSchema } from '../../src/model/snapshot.js';
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
const app = createApp({ db, config: loadConfig({ ...process.env, MODE: 'sim' }), log: silentLog });
const T0 = new Date('2026-06-30T23:50:00Z');

beforeAll(async () => {
  await db`select 1`;
});
afterAll(async () => {
  await db.end();
});

const get = async (path: string) => {
  const res = await app.request(path);
  return { status: res.status, json: (await res.json()) as unknown, headers: res.headers };
};

describe('GET /v1/games/:id/snapshot and /changes', () => {
  it('validates ids and 404s unknown games', async () => {
    expect((await get('/v1/games/nope/snapshot')).status).toBe(400);
    expect((await get('/v1/games/00000000-0000-4000-8000-000000000000/snapshot')).status).toBe(404);
    expect((await get('/v1/games/nope/changes')).status).toBe(400);
    expect(
      (await get('/v1/games/00000000-0000-4000-8000-000000000000/changes?limit=9999')).status,
    ).toBe(400);
  });

  it('empty game: snapshot seq 0; changes latestSeq=0, retainedFrom=1, hasMore=false', async () => {
    const { gameId } = await seedGame(db, pbpQ1());
    const snap = SnapshotSchema.parse((await get(`/v1/games/${gameId}/snapshot`)).json);
    expect(snap.seq).toBe(0);
    expect(snap.events).toEqual([]);
    expect(Object.keys(snap.game)).not.toContain('watchRunId');
    const page = ChangesPageSchema.parse((await get(`/v1/games/${gameId}/changes`)).json);
    expect(page).toEqual({
      changes: [],
      nextAfter: 0,
      latestSeq: 0,
      hasMore: false,
      retainedFrom: 1,
    });
  });

  it('pages changes in seq order with limit/hasMore/nextAfter, and the pages decode-equal what applyChanges numbered', async () => {
    const nd = pbpQ1();
    const { gameId } = await seedGame(db, nd);
    const run = await replayRun(db, gameId);
    const r = await apply(deps, gameId, nd, observation(run, nd, T0));
    if (r.outcome !== 'applied') throw new Error('expected applied');
    const sum = summaryQ1();
    const r2 = await apply(deps, gameId, sum, observation(run, sum, new Date(T0.getTime() + 1000)));
    if (r2.outcome !== 'applied') throw new Error('expected applied');
    const expected = [...r.changes, ...r2.changes];
    const collected = [];
    let after = 0;
    let pages = 0;
    for (;;) {
      const page = ChangesPageSchema.parse(
        (await get(`/v1/games/${gameId}/changes?after=${after}&limit=10`)).json,
      );
      pages++;
      collected.push(...page.changes);
      expect(page.latestSeq).toBe(expected.length);
      if (!page.hasMore) break;
      after = page.nextAfter;
    }
    expect(pages).toBe(Math.ceil(expected.length / 10));
    expect(collected.map((c) => c.seq)).toEqual(expected.map((_c, i) => i + 1));
    expect(collected).toEqual(expected.map((c) => GameChangeSchema.parse(c)));
    // after beyond the head
    const tail = ChangesPageSchema.parse(
      (await get(`/v1/games/${gameId}/changes?after=${expected.length}`)).json,
    );
    expect(tail).toMatchObject({ changes: [], hasMore: false, nextAfter: expected.length });
  });

  it('snapshot is consistent with the stream: folding /changes from seq 0 reproduces the snapshot state and seq', async () => {
    const nd = pbpQ1();
    const { gameId } = await seedGame(db, nd);
    const run = await replayRun(db, gameId);
    await apply(deps, gameId, nd, observation(run, nd, T0));
    const sum = summaryQ1();
    await apply(deps, gameId, sum, observation(run, sum, new Date(T0.getTime() + 1000)));
    const snap = SnapshotSchema.parse((await get(`/v1/games/${gameId}/snapshot`)).json);
    const c = await counts(db, gameId);
    expect(snap.seq).toBe(c.lastSeq);
    expect(snap.events.length).toBe(c.events);
    expect(snap.game.score).toEqual({ home: c.home, away: c.away });
    expect(snap.game.clockRunning === null || typeof snap.game.clockRunning === 'boolean').toBe(
      true,
    );
    const page = ChangesPageSchema.parse((await get(`/v1/games/${gameId}/changes?limit=500`)).json);
    const empty = SnapshotSchema.parse((await get(`/v1/games/${gameId}/snapshot`)).json);
    const folded = stateFromSnapshot({
      ...empty,
      events: [],
      periods: [],
      teamStats: [],
      game: { ...empty.game, status: 'scheduled', score: { home: 0, away: 0 }, period: null },
    });
    const { applyChange } = await import('../../src/model/game-state.js');
    for (const ch of page.changes) applyChange(folded, ch);
    expect(canonicalState(folded)).toBe(canonicalState(stateFromSnapshot(snap)));
  });

  it('retention: after < retainedFrom-1 returns 200 with no changes and retainedFrom, so the client re-snapshots', async () => {
    const nd = pbpQ1();
    const { gameId } = await seedGame(db, nd);
    const run = await replayRun(db, gameId);
    await apply(deps, gameId, nd, observation(run, nd, T0));
    await db`update public.games set retained_from_seq = 5 where id = ${gameId}`;
    const page = ChangesPageSchema.parse((await get(`/v1/games/${gameId}/changes?after=0`)).json);
    expect(page).toMatchObject({ changes: [], retainedFrom: 5, hasMore: false });
    const ok = ChangesPageSchema.parse(
      (await get(`/v1/games/${gameId}/changes?after=4&limit=3`)).json,
    );
    expect(ok.changes.map((c) => c.seq)).toEqual([5, 6, 7]);
    const snap = SnapshotSchema.parse((await get(`/v1/games/${gameId}/snapshot`)).json);
    expect(snap.retainedFrom).toBe(5);
  });
});
