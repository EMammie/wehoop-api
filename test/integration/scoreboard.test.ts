import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbScoreboardSource, ScoreboardSender } from '../../src/live/scoreboard.js';
import { MemoryTransport } from '../../src/live/transport.js';
import { leagueScoresChannel, ScoreboardSchema } from '../../src/model/scoreboard.js';
import {
  apply,
  observation,
  pbpQ1,
  replayRun,
  seedGame,
  silentLog,
  summaryQ1,
  testDb,
} from '../helpers/db.js';

/**
 * league:{code}:scores from the database (plan §5): a game whose row changed
 * since the previous tick appears once with its latest score, status, period,
 * clock and last_seq; an untouched game does not.
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

describe('DbScoreboardSource + ScoreboardSender', () => {
  it('publishes the changed game once per tick with its latest row, nothing for untouched games', async () => {
    const nd = pbpQ1();
    const { gameId } = await seedGame(db, nd);
    const other = await seedGame(db, nd);
    const run = await replayRun(db, gameId);
    const transport = new MemoryTransport();
    const sender = new ScoreboardSender({
      transport,
      log: silentLog,
      source: new DbScoreboardSource(db),
    });
    // Two writes inside one interval coalesce into one delta carrying the latest state.
    await apply(deps, gameId, nd, observation(run, nd, T0));
    const sum = summaryQ1();
    await apply(deps, gameId, sum, observation(run, sum, new Date(T0.getTime() + 1000)));
    await sender.tick();
    const mine = transport.published.filter((p) => p.channel === leagueScoresChannel('wnba'));
    expect(mine).toHaveLength(1);
    const msg = ScoreboardSchema.parse(mine[0]?.message.payload);
    const deltas = msg.deltas.filter((d) => d.gameId === gameId);
    expect(deltas).toHaveLength(1);
    expect(msg.deltas.some((d) => d.gameId === other.gameId)).toBe(false);
    const [g] = await db<{ home: number; away: number; lastSeq: string; clock: string | null }[]>`
      select home_points as home, away_points as away, last_seq::text as "lastSeq", clock
      from public.games where id = ${gameId}`;
    expect(deltas[0]).toMatchObject({
      status: 'inprogress',
      score: { home: g?.home, away: g?.away },
      latestSeq: Number(g?.lastSeq),
      clock: g?.clock,
    });
    expect(deltas[0]?.period?.sequence).toBe(1);
    // Nothing changed: nothing sent.
    const before = transport.published.length;
    await sender.tick();
    expect(transport.published.length).toBe(before);
  });
});
