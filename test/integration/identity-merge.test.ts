import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/server.js';
import { loadConfig } from '../../src/config.js';
import {
  applyPlayerProfile,
  ensurePlayers,
  ensureSeason,
  resolveCanonical,
} from '../../src/ingest/identity.js';
import { wnbaAdapter } from '../../src/leagues/wnba/adapter.js';
import { applyChange, canonicalState, stateFromSnapshot } from '../../src/model/game-state.js';
import { ChangesPageSchema, SnapshotSchema } from '../../src/model/snapshot.js';
import { PbpDocumentSchema } from '../../src/providers/sportradar/schemas/pbp.js';
import {
  type PlayerProfileDocument,
  PlayerProfileDocumentSchema,
} from '../../src/providers/sportradar/schemas/profile.js';
import { SummaryDocumentSchema } from '../../src/providers/sportradar/schemas/summary.js';
import {
  apply,
  counts,
  observation,
  R,
  replayRun,
  seedGame,
  silentLog,
  testDb,
} from '../helpers/db.js';
import { fixture } from '../helpers/fixtures.js';

/**
 * Identity merges against game state (plan §3, ratified 2026-10-14: canonical
 * uuids never enter a body or a content hash, so a merge never rewrites
 * history). The merge loser owns play_events and game_player_stats rows; the
 * repoint lives in apply-changes.ts (CLAUDE.md non-negotiable 2); after the
 * merge the identical summary is a no-op and a fold of /changes still equals
 * the snapshot.
 */
const db = testDb();
const deps = { db, log: silentLog };
const app = createApp({ db, config: loadConfig({ ...process.env, MODE: 'sim' }), log: silentLog });
const T0 = new Date('2026-07-01T01:00:00Z');
const later = (s: number) => new Date(T0.getTime() + s * 1000);

beforeAll(async () => {
  await db`select 1`;
});
afterAll(async () => {
  await db.end();
});

/**
 * The WNBA Q1 fixtures with every player id suffixed per test: these tests merge players, and a
 * merge of a real fixture player would change what every other suite (and the validator's
 * replays) sees for that person in the same database.
 */
function suffixedDocs(suffix: string) {
  const rawSum = JSON.stringify(fixture(`${R}-summary-q1.json`));
  const rawPbp = JSON.stringify(fixture(`${R}-pbp-q1.json`));
  const parsed = SummaryDocumentSchema.parse(JSON.parse(rawSum));
  const ids = [...(parsed.home.players ?? []), ...(parsed.away.players ?? [])].map((p) => p.id);
  const rewrite = (text: string) =>
    ids.reduce((t, id) => t.replaceAll(id, `${id}-${suffix}`), text);
  return {
    pbp: wnbaAdapter.normalizePbp(PbpDocumentSchema.parse(JSON.parse(rewrite(rawPbp)))),
    sum: wnbaAdapter.normalizeSummary(SummaryDocumentSchema.parse(JSON.parse(rewrite(rawSum)))),
  };
}

const gamePlayer = (league: string, providerPlayerId: string, fullName: string) =>
  ensurePlayers(db, league as 'wnba' | 'ncaawb' | 'unrivaled', [
    {
      providerPlayerId,
      providerTeamId: null,
      fullName,
      firstName: null,
      lastName: null,
      jersey: null,
      position: null,
    },
  ]);

const profile = (
  id: string,
  fullName: string,
  references: Array<{ source_id: string; scope: string; id_type: string }>,
): PlayerProfileDocument =>
  PlayerProfileDocumentSchema.parse({ id, full_name: fullName, references });

async function ownership(playerId: string) {
  const [row] = await db<{ events: number; lines: number; mergedInto: string | null }[]>`
    select (select count(*)::int from public.play_events where player_id = ${playerId}) as events,
           (select count(*)::int from public.game_player_stats where player_id = ${playerId}) as lines,
           (select merged_into from public.players where id = ${playerId}) as "mergedInto"`;
  if (!row) throw new Error('player missing');
  return row;
}

describe('identity merge against game state', () => {
  it("a merge repoints the loser's play_events and game_player_stats to the survivor; the identical summary is then a no-op and fold == snapshot", async () => {
    const suffix = randomUUID();
    const { pbp, sum } = suffixedDocs(suffix);
    // A player with both a play attribution and a box line in the Q1 fixtures.
    const attributed = new Set(pbp.batch.events.map((e) => e.playerProviderId));
    const line = sum.batch.playerStats.find((p) => attributed.has(p.providerPlayerId));
    if (!line) throw new Error('fixture has no player with both an event and a stats line');
    const P = line.providerPlayerId;

    // The older row: an Unrivaled game named this person first, so it will survive the merge.
    const unrId = `unr-${suffix}`;
    const survivor = (await gamePlayer('unrivaled', unrId, line.fullName)).get(unrId) ?? '';
    expect(survivor).toBeTruthy();

    // The WNBA game creates a second row for P (source=game) and writes its events and stats.
    const { gameId } = await seedGame(db, pbp);
    const run = await replayRun(db, gameId);
    const r1 = await apply(deps, gameId, pbp, observation(run, pbp, T0));
    expect(r1.outcome).toBe('applied');
    const r2 = await apply(deps, gameId, sum, observation(run, sum, later(5)));
    if (r2.outcome !== 'applied') throw new Error('expected applied');
    expect(r2.changes.filter((c) => c.type === 'stats_player')).toHaveLength(
      sum.batch.playerStats.length,
    );
    const [before] = await db<{ loser: string; providerPlayerId: string; hash: string }[]>`
      select player_id as loser, provider_player_id as "providerPlayerId", content_hash as hash
      from public.game_player_stats where game_id = ${gameId} and provider_player_id = ${P}`;
    if (!before) throw new Error('stats row missing');
    const loser = before.loser;
    expect(loser).not.toBe(survivor);
    const loserOwned = await ownership(loser);
    expect(loserOwned.events).toBeGreaterThan(0);
    expect(loserOwned.lines).toBe(1);
    const changesBefore = (await counts(db, gameId)).changes;

    // An Unrivaled profile for the older row references the WNBA id: two existing rows -> merge.
    const res = await applyPlayerProfile(
      db,
      'unrivaled',
      profile(unrId, line.fullName, [{ source_id: P, scope: 'WNBA', id_type: 'league_profile' }]),
      silentLog,
    );
    expect(res.playerId).toBe(survivor);
    expect(res.mergedFrom).toEqual([loser]);
    expect(res.dropped).toEqual({ gamePlayerStats: 0, playerSeasonStats: 0, playerTeamSeasons: 0 });
    expect(await resolveCanonical(db, loser)).toBe(survivor);
    // Everything the loser owned now belongs to the survivor; the row keeps its provider id and hash.
    expect(await ownership(loser)).toEqual({ events: 0, lines: 0, mergedInto: survivor });
    const survivorOwned = await ownership(survivor);
    expect(survivorOwned.events).toBe(loserOwned.events);
    expect(survivorOwned.lines).toBe(1);
    const [after] = await db<{ playerId: string; hash: string }[]>`
      select player_id as "playerId", content_hash as hash
      from public.game_player_stats where game_id = ${gameId} and provider_player_id = ${P}`;
    expect(after).toEqual({ playerId: survivor, hash: before.hash });
    // History was not rewritten.
    expect((await counts(db, gameId)).changes).toBe(changesBefore);

    // The identical summary, observed later: nothing changed, every line only confirmed.
    const r3 = await apply(deps, gameId, sum, observation(run, sum, later(10)));
    if (r3.outcome !== 'applied') throw new Error('expected applied');
    expect(r3.changes).toEqual([]);
    expect(r3.counts.touchedStats).toBe(sum.batch.playerStats.length + sum.batch.teamStats.length);
    expect((await counts(db, gameId)).changes).toBe(changesBefore);

    // The snapshot keys the line on the provider id and a fold of /changes reproduces it.
    const snapRes = await app.request(`/v1/games/${gameId}/snapshot`);
    expect(snapRes.status).toBe(200);
    const snap = SnapshotSchema.parse(await snapRes.json());
    const snapLine = snap.playerStats.find((p) => p.providerPlayerId === P);
    expect(snapLine).toMatchObject({ providerPlayerId: P, fullName: line.fullName });
    expect(Object.keys(snapLine ?? {})).not.toContain('playerId');
    const page = ChangesPageSchema.parse(
      await (await app.request(`/v1/games/${gameId}/changes?limit=500`)).json(),
    );
    expect(page.hasMore).toBe(false);
    const folded = stateFromSnapshot({
      ...snap,
      events: [],
      periods: [],
      teamStats: [],
      playerStats: [],
      game: { ...snap.game, status: 'scheduled', score: { home: 0, away: 0 }, period: null },
    });
    for (const ch of page.changes) applyChange(folded, ch);
    expect(canonicalState(folded)).toBe(canonicalState(stateFromSnapshot(snap)));
  });

  it("a merge whose loser already has a line in a game the survivor also has one in drops the loser's row and reports it; the next summary skips the duplicate line", async () => {
    const suffix = randomUUID();
    const { sum } = suffixedDocs(suffix);
    const [p, q] = sum.batch.playerStats;
    if (!p || !q) throw new Error('fixture has fewer than two player lines');
    const { gameId } = await seedGame(db, sum);
    const run = await replayRun(db, gameId);
    const r1 = await apply(deps, gameId, sum, observation(run, sum, T0));
    expect(r1.outcome).toBe('applied');
    const changesBefore = (await counts(db, gameId)).changes;
    // A (nonsense) profile claiming both WNBA ids are one person.
    const res = await applyPlayerProfile(
      db,
      'unrivaled',
      profile(`unr-${suffix}`, p.fullName, [
        { source_id: p.providerPlayerId, scope: 'WNBA', id_type: 'league_profile' },
        { source_id: q.providerPlayerId, scope: 'WNBA', id_type: 'league_profile' },
      ]),
      silentLog,
    );
    expect(res.mergedFrom).toHaveLength(1);
    expect(res.dropped).toEqual({ gamePlayerStats: 1, playerSeasonStats: 0, playerTeamSeasons: 0 });
    const rows = await db<{ providerPlayerId: string }[]>`
      select provider_player_id as "providerPlayerId" from public.game_player_stats
      where game_id = ${gameId} and player_id = ${res.playerId}`;
    expect(rows).toHaveLength(1); // the survivor's line, whichever row was older
    const kept = rows[0]?.providerPlayerId;
    expect([p.providerPlayerId, q.providerPlayerId]).toContain(kept);
    // Re-apply: the kept line is confirmed, the other now resolves to the same player and is skipped.
    const ordered = {
      ...sum,
      batch: {
        ...sum.batch,
        playerStats: [...sum.batch.playerStats].sort((a, b) =>
          a.providerPlayerId === kept ? -1 : b.providerPlayerId === kept ? 1 : 0,
        ),
      },
    };
    const r2 = await apply(deps, gameId, ordered, observation(run, ordered, later(5)));
    if (r2.outcome !== 'applied') throw new Error('expected applied');
    expect(r2.changes).toEqual([]);
    expect(r2.counts.duplicatePlayers).toBe(1);
    expect((await counts(db, gameId)).changes).toBe(changesBefore);
  });

  it('a second merge flattens earlier tombstones onto the new survivor (chains stay depth 1)', async () => {
    const suffix = randomUUID();
    const x = (await gamePlayer('wnba', `w-${suffix}`, 'Chain Test')).get(`w-${suffix}`) ?? '';
    const y = (await gamePlayer('ncaawb', `n-${suffix}`, 'Chain Test')).get(`n-${suffix}`) ?? '';
    const z = (await gamePlayer('unrivaled', `u-${suffix}`, 'Chain Test')).get(`u-${suffix}`) ?? '';
    // NCAAW profile links the Unrivaled id: Y (older) survives, Z -> Y.
    const first = await applyPlayerProfile(
      db,
      'ncaawb',
      profile(`n-${suffix}`, 'Chain Test', [
        { source_id: `u-${suffix}`, scope: 'UNRIVALED', id_type: 'league_profile' },
      ]),
      silentLog,
    );
    expect(first).toMatchObject({ playerId: y, mergedFrom: [z] });
    // WNBA profile links the NCAAW id: X (oldest) survives, Y -> X, and Z must now point at X too.
    const second = await applyPlayerProfile(
      db,
      'wnba',
      profile(`w-${suffix}`, 'Chain Test', [
        { source_id: `n-${suffix}`, scope: 'NCAAW', id_type: 'league_profile' },
      ]),
      silentLog,
    );
    expect(second).toMatchObject({ playerId: x, mergedFrom: [y] });
    const rows = await db<{ id: string; mergedInto: string | null }[]>`
      select id, merged_into as "mergedInto" from public.players where id in (${x}, ${y}, ${z}) order by created_at`;
    expect(rows).toEqual([
      { id: x, mergedInto: null },
      { id: y, mergedInto: x },
      { id: z, mergedInto: x },
    ]);
    // the invariant `merged_players_point_at_canonical_survivors`, scoped to these rows
    const [chain] = await db<{ n: number }[]>`
      select count(*)::int as n from public.players l join public.players s on s.id = l.merged_into
      where l.id in (${y}, ${z}) and s.merged_into is not null`;
    expect(chain?.n).toBe(0);
    for (const ext of [`w-${suffix}`, `n-${suffix}`, `u-${suffix}`]) {
      const [e] = await db<{ playerId: string }[]>`
        select player_id as "playerId" from public.player_external_ids where external_id = ${ext}`;
      expect(e?.playerId).toBe(x);
    }
  });

  it('ensureSeason: the same (league, year, type) under another provider id is a clash and is not linked', async () => {
    const [next] = await db<{ year: number }[]>`
      select coalesce(max(year), 2000)::int + 1 as year from public.seasons where league = 'unrivaled'`;
    const year = next?.year ?? 2001;
    const a = await ensureSeason(
      db,
      'unrivaled',
      { providerSeasonId: `sa-${randomUUID()}`, year, type: 'REG' },
      silentLog,
    );
    expect(a).toBeTruthy();
    const b = await ensureSeason(
      db,
      'unrivaled',
      { providerSeasonId: `sb-${randomUUID()}`, year, type: 'REG' },
      silentLog,
    );
    expect(b).toBeNull();
    const again = await ensureSeason(
      db,
      'unrivaled',
      { providerSeasonId: `sa-${randomUUID()}`, year, type: 'REG' },
      silentLog,
    );
    expect(again).toBeNull(); // a different id again; only the stored provider id resolves
    const [row] = await db<{ n: number }[]>`
      select count(*)::int as n from public.seasons where league = 'unrivaled' and year = ${year} and type = 'REG'`;
    expect(row?.n).toBe(1);
  });
});
