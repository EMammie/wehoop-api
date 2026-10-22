import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { heldProfileImpact } from '../../src/ingest/trial-mode.js';
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
 * Held-profile impact tooling (plan §7 M3 acceptance, rev 4.5 checkpoint):
 * `pnpm trial holds` / test/integration/holds-impact.sql list the open holds,
 * the affected players, and whether each appears in a watched game's
 * game_player_stats. Produces evidence when the count is 0, and the
 * two "appears" paths (document id, candidate row) are each proven once.
 */
const db = testDb();
const deps = { db, log: silentLog };
const SQL = readFileSync(new URL('./holds-impact.sql', import.meta.url), 'utf8');
const T0 = new Date('2026-06-30T23:50:00Z');
const holdIds: string[] = [];

beforeAll(async () => {
  await db`select 1`;
});
afterAll(async () => {
  if (holdIds.length > 0)
    await db`delete from ingest.player_merge_holds where id = any(${holdIds})`;
  await db.end();
});

describe('held-profile impact', () => {
  it('the function and the SQL file agree, and both work when there are no open holds', async () => {
    const before = await heldProfileImpact(db);
    const rows = await db.unsafe(SQL);
    expect(rows.length).toBe(before.openHolds);
    expect(before).toMatchObject({ rows: expect.any(Array) });
    expect(before.inWatchedGame).toBeLessThanOrEqual(before.openHolds);
    expect(before.affectedPlayers).toBeGreaterThanOrEqual(before.openHolds === 0 ? 0 : 1);
  });

  it('a hold whose document id, or whose candidate row, has a line in a watched game is flagged', async () => {
    // A watched WNBA game with player lines (watch_run_id set by the accepted generation).
    const nd = pbpQ1();
    const { gameId } = await seedGame(db, nd);
    const run = await replayRun(db, gameId);
    await apply(deps, gameId, nd, observation(run, nd, T0));
    const sum = summaryQ1();
    await apply(deps, gameId, sum, observation(run, sum, new Date(T0.getTime() + 1000)));
    const [line] = await db<{ providerPlayerId: string; playerId: string; name: string }[]>`
      select s.provider_player_id as "providerPlayerId", s.player_id as "playerId", s.full_name as name
      from public.game_player_stats s join public.games g on g.id = s.game_id
      where s.game_id = ${gameId} and g.watch_run_id is not null and s.player_id is not null limit 1`;
    if (!line) throw new Error('watched game has no player line');
    const [other] = await db<{ id: string }[]>`
      select id from public.players where id <> ${line.playerId} and merged_into is null limit 1`;
    if (!other) throw new Error('need a second player row');
    const before = await heldProfileImpact(db);
    const doc = { id: line.providerPlayerId, full_name: line.name, references: [] };
    const insert = async (documentId: string, candidates: string[], tag: string) => {
      const [h] = await db<{ id: string }[]>`
        insert into ingest.player_merge_holds (league, trigger_feed, trigger_document_id, trigger_reference, reason,
          candidate_ids, detail, document, document_observed_at, document_updated_at)
        values ('wnba', 'player_profile', ${documentId}, ${db.json({ test: tag } as never)}, 'conflicting_profiles',
          ${candidates}::uuid[], ${db.json({ synthetic: true } as never)}, ${db.json(doc as never)}, now(), now())
        returning id`;
      if (!h) throw new Error('hold insert failed');
      holdIds.push(h.id);
      return h.id;
    };
    const byDocument = await insert(line.providerPlayerId, [other.id], 'by-document');
    const byCandidate = await insert(`nope-${Date.now()}`, [line.playerId], 'by-candidate');
    const impact = await heldProfileImpact(db);
    expect(impact.openHolds).toBe(before.openHolds + 2);
    expect(impact.inWatchedGame).toBe(before.inWatchedGame + 2);
    const a = impact.rows.find((r) => r.holdId === byDocument);
    const b = impact.rows.find((r) => r.holdId === byCandidate);
    expect(a?.documentInWatchedGames).toContain(gameId);
    expect(a?.candidates.map((c) => c.id)).toEqual([other.id]);
    expect(a?.documentName).toBe(line.name);
    expect(b?.documentInWatchedGames).toEqual([]);
    expect(b?.candidatesInWatchedGames).toContain(gameId);
    const rows = await db.unsafe(SQL);
    expect(rows.length).toBe(impact.openHolds);
    const sqlA = rows.find((r) => r.hold_id === byDocument);
    expect(sqlA?.document_in_watched_games).toContain(gameId);
  });
});
