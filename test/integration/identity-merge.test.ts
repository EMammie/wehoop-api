import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/server.js';
import { loadConfig } from '../../src/config.js';
import { applyPlayerSeasonStats } from '../../src/ingest/apply-changes.js';
import {
  applyPlayerProfile,
  ensurePlayers,
  ensurePlayerTeamSeason,
  ensureSeason,
  ensureTeams,
  replayHeldDocument,
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
 * history; plan §2 rev 4.4: game_player_stats is keyed on the provider id, so
 * a merge repoints and never drops a row, and a client that folded the
 * provider-keyed changes agrees with a fresh snapshot). Every merge leaves a
 * provenance row in ingest.player_merges; references identity.ts will not act
 * on are held in ingest.player_merge_holds.
 *
 * The WNBA documents are the recorded simulation fixtures with every player
 * id suffixed per test; the "profiles" claiming two WNBA ids are one person
 * are synthetic test documents, not provider data.
 */
const db = testDb();
const deps = { db, log: silentLog };
const app = createApp({ db, config: loadConfig({ ...process.env, MODE: 'sim' }), log: silentLog });
const T0 = new Date('2026-07-01T01:00:00Z');
const later = (s: number) => new Date(T0.getTime() + s * 1000);
type League = 'wnba' | 'ncaawb' | 'unrivaled';

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

const gamePlayer = (league: League, providerPlayerId: string, fullName: string) =>
  ensurePlayers(db, league, [
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

interface MergeRow {
  survivorId: string;
  loserId: string;
  league: string;
  triggerFeed: string;
  triggerDocumentId: string | null;
  triggerSource: string;
  triggerReference: Record<string, unknown>;
  repoint: Record<string, unknown>;
  conflicts: Array<{ table: string; row: Record<string, unknown> }>;
}
async function mergeRowFor(loser: string): Promise<MergeRow | undefined> {
  const [row] = await db<MergeRow[]>`
    select survivor_id as "survivorId", loser_id as "loserId", league::text as league, trigger_feed as "triggerFeed",
           trigger_document_id as "triggerDocumentId", trigger_source as "triggerSource",
           trigger_reference as "triggerReference", repoint, conflicts
    from ingest.player_merges where loser_id = ${loser}`;
  return row;
}

interface HoldRow {
  reason: string;
  triggerFeed: string;
  triggerDocumentId: string;
  triggerReference: Record<string, unknown>;
  candidateIds: string[];
  status: string;
}
async function holdsFor(documentId: string): Promise<HoldRow[]> {
  return db<HoldRow[]>`
    select reason, trigger_feed as "triggerFeed", trigger_document_id as "triggerDocumentId",
           trigger_reference as "triggerReference", candidate_ids as "candidateIds", status
    from ingest.player_merge_holds where trigger_document_id = ${documentId} order by reason`;
}

interface HeldDocumentRow {
  id: string;
  reason: string;
  status: string;
  candidateIds: string[];
  detail: Record<string, unknown> | null;
  document: Record<string, unknown> | null;
  documentObservedAt: Date | null;
  /** epoch seconds with microseconds, so two writes a few ms apart compare strictly */
  documentUpdatedAt: number | null;
  runId: number | null;
}
/** The preserved document on every hold of one trigger document (plan §2 rev 4.5). */
async function heldDocuments(documentId: string): Promise<HeldDocumentRow[]> {
  return db<HeldDocumentRow[]>`
    select id, reason, status, candidate_ids as "candidateIds", detail, document,
           document_observed_at as "documentObservedAt",
           extract(epoch from document_updated_at)::float8 as "documentUpdatedAt",
           run_id::int as "runId"
    from ingest.player_merge_holds where trigger_document_id = ${documentId} order by reason, trigger_reference`;
}

/** What a skipped document's seasons[] must not have created: the season, its team, the roster row. */
async function seasonFootprint(providerSeasonId: string, providerTeamId: string) {
  const [row] = await db<{ seasons: number; teams: number; teamSeasons: number }[]>`
    select (select count(*)::int from public.seasons where provider_season_id = ${providerSeasonId}) as seasons,
           (select count(*)::int from public.teams where provider_team_id = ${providerTeamId}) as teams,
           (select count(*)::int from public.player_team_seasons pts
              join public.seasons s on s.id = pts.season_id
             where s.provider_season_id = ${providerSeasonId}) as "teamSeasons"`;
  return row;
}
const NO_FOOTPRINT = { seasons: 0, teams: 0, teamSeasons: 0 };

/** A document whose own attributes and season differ from everything stored, so a landing would show. */
const contradictingProfile = (
  id: string,
  suffix: string,
  references: Array<{ source_id: string; scope: string; id_type: string }>,
) =>
  PlayerProfileDocumentSchema.parse({
    id,
    full_name: 'Someone Else',
    position: 'C',
    references,
    seasons: [
      {
        id: `season-${suffix}`,
        year: 2997,
        type: 'REG',
        teams: [{ id: `team-${suffix}`, name: 'Held Team' }],
      },
    ],
  });

/**
 * Everything a conflicting profile must leave untouched, for a set of canonical rows: the player
 * rows (identity and attributes), every external id with its owner and source, and the merge
 * provenance rows involving them. Compared as decoded objects before and after.
 */
async function identityFingerprint(playerIds: string[]) {
  const players = await db<Record<string, unknown>[]>`
    select id, full_name, first_name, last_name, birthdate, height_in, weight_lb, position, college,
           jersey, status, merged_into
    from public.players where id = any(${playerIds}::uuid[]) order by id`;
  const externalIds = await db<Record<string, unknown>[]>`
    select league::text as league, external_id, id_type, source, player_id
    from public.player_external_ids where player_id = any(${playerIds}::uuid[])
    order by league, id_type, external_id`;
  const merges = await db<Record<string, unknown>[]>`
    select id, survivor_id, loser_id from ingest.player_merges
    where survivor_id = any(${playerIds}::uuid[]) or loser_id = any(${playerIds}::uuid[]) order by id`;
  return { players, externalIds, merges };
}

/** Durable game state a conflicting profile must leave untouched: the stream, the rows, the lines. */
async function gameFingerprint(gameId: string) {
  const c = await counts(db, gameId);
  const lines = await db<{ providerPlayerId: string; playerId: string; hash: string }[]>`
    select provider_player_id as "providerPlayerId", player_id as "playerId", content_hash as hash
    from public.game_player_stats where game_id = ${gameId} order by provider_player_id`;
  return { changes: c.changes, events: c.events, deleted: c.deleted, lastSeq: c.lastSeq, lines };
}

/** Lines of players that have both a play attribution and a box line in the Q1 fixtures. */
function attributedLines(docs: ReturnType<typeof suffixedDocs>) {
  const attributed = new Set(docs.pbp.batch.events.map((e) => e.playerProviderId));
  return docs.sum.batch.playerStats.filter((p) => attributed.has(p.providerPlayerId));
}

async function snapshotAndChanges(gameId: string, after = 0) {
  const snapRes = await app.request(`/v1/games/${gameId}/snapshot`);
  expect(snapRes.status).toBe(200);
  const snap = SnapshotSchema.parse(await snapRes.json());
  const page = ChangesPageSchema.parse(
    await (await app.request(`/v1/games/${gameId}/changes?after=${after}&limit=500`)).json(),
  );
  expect(page.hasMore).toBe(false);
  return { snap, page };
}

describe('identity merge against game state', () => {
  it("a merge repoints the loser's play_events and game_player_stats to the survivor, records its provenance, and the identical summary is then a no-op with fold == snapshot", async () => {
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
    const ref = { source_id: P, scope: 'WNBA', id_type: 'league_profile' };
    const res = await applyPlayerProfile(
      db,
      'unrivaled',
      profile(unrId, line.fullName, [ref]),
      silentLog,
    );
    expect(res.playerId).toBe(survivor);
    expect(res.mergedFrom).toEqual([loser]);
    expect(res.held).toEqual([]);
    expect(res.merges).toHaveLength(1);
    expect(res.merges[0]?.conflicts).toEqual([]);
    expect(res.merges[0]?.repoint).toEqual({
      playEvents: loserOwned.events,
      gamePlayerStats: { repointed: 1 },
      playerSeasonStats: { repointed: 0, dropped: 0 },
      playerTeamSeasons: { repointed: 0, dropped: 0 },
    });
    expect(await resolveCanonical(db, loser)).toBe(survivor);
    // Provenance: which document, which references[] entry, who survived, what moved.
    expect(await mergeRowFor(loser)).toEqual({
      survivorId: survivor,
      loserId: loser,
      league: 'unrivaled',
      triggerFeed: 'player_profile',
      triggerDocumentId: unrId,
      triggerSource: 'reference',
      triggerReference: ref,
      repoint: res.merges[0]?.repoint,
      conflicts: [],
    });
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

    // Re-applying the profile: no second merge row, no hold, nothing new.
    const again = await applyPlayerProfile(
      db,
      'unrivaled',
      profile(unrId, line.fullName, [ref]),
      silentLog,
    );
    expect(again).toMatchObject({ playerId: survivor, mergedFrom: [], merges: [], held: [] });

    // The snapshot keys the line on the provider id and a fold of /changes reproduces it.
    const { snap, page } = await snapshotAndChanges(gameId);
    const snapLine = snap.playerStats.find((p) => p.providerPlayerId === P);
    expect(snapLine).toMatchObject({ providerPlayerId: P, fullName: line.fullName });
    expect(Object.keys(snapLine ?? {})).not.toContain('playerId');
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

  it('two provider ids merged into one person keep two provider-keyed rows: [A,B] then [B,A] after the merge yields zero changes, a connected client and a fresh snapshot agree, and each line still changes independently', async () => {
    const suffix = randomUUID();
    const { sum } = suffixedDocs(suffix);
    const [p, q] = sum.batch.playerStats;
    if (!p || !q) throw new Error('fixture has fewer than two player lines');
    const A = p.providerPlayerId;
    const B = q.providerPlayerId;
    const { gameId } = await seedGame(db, sum);
    const run = await replayRun(db, gameId);
    const r1 = await apply(deps, gameId, sum, observation(run, sum, T0));
    expect(r1.outcome).toBe('applied');
    const changesBefore = (await counts(db, gameId)).changes;
    // A client connected before the merge: snapshot + the stream so far.
    const { snap: snapBefore } = await snapshotAndChanges(gameId);
    const client = stateFromSnapshot(snapBefore);
    expect(client.playerStats.size).toBe(sum.batch.playerStats.length);

    // A synthetic profile claiming both WNBA ids are one person (two game-sourced rows -> merge).
    const docId = `unr-${suffix}`;
    const res = await applyPlayerProfile(
      db,
      'unrivaled',
      profile(docId, p.fullName, [
        { source_id: A, scope: 'WNBA', id_type: 'league_profile' },
        { source_id: B, scope: 'WNBA', id_type: 'league_profile' },
      ]),
      silentLog,
    );
    expect(res.mergedFrom).toHaveLength(1);
    expect(res.held).toEqual([]);
    // Nothing dropped: both rows stay, both now point at the survivor.
    expect(res.merges[0]?.conflicts).toEqual([]);
    expect(res.merges[0]?.repoint.gamePlayerStats).toEqual({ repointed: 1 });
    const rows = await db<{ providerPlayerId: string; playerId: string }[]>`
      select provider_player_id as "providerPlayerId", player_id as "playerId" from public.game_player_stats
      where game_id = ${gameId} and provider_player_id in (${A}, ${B}) order by provider_player_id`;
    expect(rows.map((r) => r.providerPlayerId).sort()).toEqual([A, B].sort());
    expect(new Set(rows.map((r) => r.playerId))).toEqual(new Set([res.playerId]));
    expect((await counts(db, gameId)).changes).toBe(changesBefore);

    // Item 1: the same facts in the opposite order, observed later -> zero changes.
    const reversed = {
      ...sum,
      batch: { ...sum.batch, playerStats: [q, p, ...sum.batch.playerStats.slice(2)] },
    };
    const r2 = await apply(deps, gameId, reversed, observation(run, reversed, later(5)));
    if (r2.outcome !== 'applied') throw new Error('expected applied');
    expect(r2.changes).toEqual([]);
    expect(r2.counts.duplicateLines).toBe(0);
    expect(r2.counts.touchedStats).toBe(sum.batch.playerStats.length + sum.batch.teamStats.length);
    expect((await counts(db, gameId)).changes).toBe(changesBefore);

    // Each provider line is its own entity: a correction to B changes B only, in either order.
    const bumped = {
      ...sum,
      batch: {
        ...sum.batch,
        playerStats: [
          { ...q, stats: { ...q.stats, points: (q.stats.points ?? 0) + 1 } },
          p,
          ...sum.batch.playerStats.slice(2),
        ],
      },
    };
    const r3 = await apply(deps, gameId, bumped, observation(run, bumped, later(10)));
    if (r3.outcome !== 'applied') throw new Error('expected applied');
    expect(r3.changes.map((c) => c.type)).toEqual(['stats_player']);
    const only = r3.changes[0];
    expect(only?.type === 'stats_player' && only.body.providerPlayerId).toBe(B);
    expect((await counts(db, gameId)).changes).toBe(changesBefore + 1);

    // Item 2: the connected client folds what came after its snapshot; a fresh snapshot agrees.
    const { snap: snapAfter, page } = await snapshotAndChanges(gameId, snapBefore.seq);
    expect(page.changes).toHaveLength(1);
    for (const ch of page.changes) applyChange(client, ch);
    expect(canonicalState(client)).toBe(canonicalState(stateFromSnapshot(snapAfter)));
    expect(snapAfter.playerStats.map((l) => l.providerPlayerId)).toContain(A);
    expect(snapAfter.playerStats.map((l) => l.providerPlayerId)).toContain(B);
    // and the boxscore view shows both lines under one canonical player
    const view = await db<{ providerPlayerId: string }[]>`
      select provider_player_id as "providerPlayerId" from public.v_boxscore
      where game_id = ${gameId} and player_id = ${res.playerId ?? ''} order by 1`;
    expect(view.map((v) => v.providerPlayerId).sort()).toEqual([A, B].sort());
  });

  it('a document that repeats one provider id applies the first line and skips the repeat (counted), deterministically', async () => {
    const suffix = randomUUID();
    const { sum } = suffixedDocs(suffix);
    const [p] = sum.batch.playerStats;
    if (!p) throw new Error('fixture has no player line');
    const { gameId } = await seedGame(db, sum);
    const run = await replayRun(db, gameId);
    const doubled = {
      ...sum,
      batch: {
        ...sum.batch,
        playerStats: [
          ...sum.batch.playerStats,
          { ...p, stats: { ...p.stats, points: (p.stats.points ?? 0) + 5 } },
        ],
      },
    };
    const r1 = await apply(deps, gameId, doubled, observation(run, doubled, T0));
    if (r1.outcome !== 'applied') throw new Error('expected applied');
    expect(r1.counts.duplicateLines).toBe(1);
    expect(r1.changes.filter((c) => c.type === 'stats_player')).toHaveLength(
      sum.batch.playerStats.length,
    );
    const r2 = await apply(deps, gameId, doubled, observation(run, doubled, later(5)));
    if (r2.outcome !== 'applied') throw new Error('expected applied');
    expect(r2.changes).toEqual([]);
    expect(r2.counts.duplicateLines).toBe(1);
  });

  it('a merge whose loser owns a season line and a team season the survivor also owns keeps their full content in ingest.player_merges.conflicts', async () => {
    const suffix = randomUUID();
    const A = `wa-${suffix}`;
    const B = `wb-${suffix}`;
    const older = (await gamePlayer('wnba', A, 'Season Collision')).get(A) ?? '';
    const younger = (await gamePlayer('wnba', B, 'Season Collision')).get(B) ?? '';
    const [next] = await db<{ year: number }[]>`
      select coalesce(max(year), 2000)::int + 1 as year from public.seasons where league = 'wnba'`;
    const seasonId = await ensureSeason(
      db,
      'wnba',
      { providerSeasonId: `s-${suffix}`, year: next?.year ?? 2001, type: 'REG' },
      silentLog,
    );
    if (!seasonId) throw new Error('season not created');
    const teamId =
      (
        await ensureTeams(db, 'wnba', [
          { providerTeamId: `t-${suffix}`, name: 'T', market: null, alias: null },
        ])
      ).get(`t-${suffix}`) ?? '';
    for (const [playerId, points, jersey] of [
      [older, 10, '1'],
      [younger, 20, '2'],
    ] as const) {
      await ensurePlayerTeamSeason(db, { playerId, teamId, seasonId, jersey });
      await applyPlayerSeasonStats(db, [
        { playerId, seasonId, teamId, total: { games_played: 1, points }, average: null },
      ]);
    }
    const res = await applyPlayerProfile(
      db,
      'wnba',
      profile(A, 'Season Collision', [{ source_id: B, scope: 'WNBA', id_type: 'league_profile' }]),
      silentLog,
    );
    expect(res).toMatchObject({ playerId: older, mergedFrom: [younger], held: [] });
    const merge = await mergeRowFor(younger);
    expect(merge?.triggerSource).toBe('reference');
    expect(merge?.repoint).toEqual({
      playEvents: 0,
      gamePlayerStats: { repointed: 0 },
      playerSeasonStats: { repointed: 0, dropped: 1 },
      playerTeamSeasons: { repointed: 0, dropped: 1 },
    });
    expect(merge?.conflicts.map((c) => c.table).sort()).toEqual([
      'player_season_stats',
      'player_team_seasons',
    ]);
    const line = merge?.conflicts.find((c) => c.table === 'player_season_stats')?.row;
    expect(line).toMatchObject({
      player_id: younger,
      season_id: seasonId,
      team_id: teamId,
      points: 20,
    });
    const roster = merge?.conflicts.find((c) => c.table === 'player_team_seasons')?.row;
    expect(roster).toMatchObject({ player_id: younger, jersey: '2' });
    // the survivor's own line is the one kept
    const [kept] = await db<{ points: number; jersey: string | null }[]>`
      select pss.points, pts.jersey from public.player_season_stats pss
      join public.player_team_seasons pts on pts.player_id = pss.player_id and pts.team_id = pss.team_id and pts.season_id = pss.season_id
      where pss.player_id = ${older} and pss.season_id = ${seasonId}`;
    expect(kept).toEqual({ points: 10, jersey: '1' });
  });

  it('a second merge flattens earlier tombstones onto the new survivor (chains stay depth 1) and each merge has its own provenance row', async () => {
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
    // provenance: Z's row names Y as the survivor at the time, Y's names X; the current resolution is merged_into
    expect(await mergeRowFor(z)).toMatchObject({ survivorId: y, triggerDocumentId: `n-${suffix}` });
    expect(await mergeRowFor(y)).toMatchObject({ survivorId: x, triggerDocumentId: `w-${suffix}` });
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

describe('references identity.ts refuses to act on are held, never merged', () => {
  it('unknown scope and unknown id type: held with the reference entry, not linked; re-applying adds no second open hold', async () => {
    const suffix = randomUUID();
    const docId = `w-${suffix}`;
    const refs = [
      { source_id: `nba-${suffix}`, scope: 'NBA', id_type: 'league_profile' },
      { source_id: '7', scope: 'WNBA', id_type: 'jersey' },
      { source_id: `n-${suffix}`, scope: 'NCAAW', id_type: 'league_profile' },
    ];
    const res = await applyPlayerProfile(db, 'wnba', profile(docId, 'Held One', refs), silentLog);
    expect(res.playerId).toBeTruthy();
    expect(res.held.map((h) => h.reason).sort()).toEqual(['unknown_id_type', 'unknown_scope']);
    expect(res.externalIds.map((e) => `${e.league}:${e.externalId}`).sort()).toEqual([
      `ncaawb:n-${suffix}`,
      `wnba:w-${suffix}`,
    ]);
    const holds = await holdsFor(docId);
    expect(holds).toEqual([
      {
        reason: 'unknown_id_type',
        triggerFeed: 'player_profile',
        triggerDocumentId: docId,
        triggerReference: refs[1],
        candidateIds: [],
        status: 'open',
      },
      {
        reason: 'unknown_scope',
        triggerFeed: 'player_profile',
        triggerDocumentId: docId,
        triggerReference: refs[0],
        candidateIds: [],
        status: 'open',
      },
    ]);
    const again = await applyPlayerProfile(db, 'wnba', profile(docId, 'Held One', refs), silentLog);
    expect(again.held).toHaveLength(2);
    expect(await holdsFor(docId)).toHaveLength(2);
  });

  it('conflicting profiles: a reference to a row that already carries another provider profile of the same league is held, nothing merges, and the whole document is skipped (no id upgrade, no attributes, no seasons); the hold keeps the document', async () => {
    const suffix = randomUUID();
    const w1 = `w1-${suffix}`;
    const w2 = `w2-${suffix}`;
    const n = `n-${suffix}`;
    // Two WNBA profiles: W1 alone, W2 referencing NCAAW id N.
    const r1 = await applyPlayerProfile(db, 'wnba', profile(w1, 'Conflict A', []), silentLog);
    const r2 = await applyPlayerProfile(
      db,
      'wnba',
      profile(w2, 'Conflict B', [{ source_id: n, scope: 'NCAAW', id_type: 'league_profile' }]),
      silentLog,
    );
    expect(r1.playerId).not.toBe(r2.playerId);
    const rows = [r1.playerId ?? '', r2.playerId ?? ''];
    const idBefore = await identityFingerprint(rows);
    // The NCAAW profile N claims WNBA W1: the provider now says one person has WNBA profiles W1
    // and W2. N's own id resolves to W2's row (linked by W2's reference), so that row is the home
    // row and W1's row the contradicting candidate. The document also carries its own name,
    // position and a season: with no evidence for either row, none of it may land anywhere.
    const ref = { source_id: w1, scope: 'WNBA', id_type: 'league_profile' };
    const nDoc = contradictingProfile(n, suffix, [ref]);
    const r3 = await applyPlayerProfile(db, 'ncaawb', nDoc, silentLog, { observedAt: T0 });
    expect(r3).toEqual({
      playerId: null,
      mergedFrom: [],
      merges: [],
      held: [
        {
          reason: 'conflicting_profiles',
          reference: ref,
          candidateIds: [r2.playerId, r1.playerId],
          detail: {
            conflicts: [
              {
                theirs: { league: 'wnba', idType: 'league_profile', externalId: w1 },
                against: {
                  claim: { league: 'wnba', idType: 'league_profile', externalId: w2 },
                  owner: r2.playerId,
                },
              },
            ],
          },
        },
      ],
      externalIds: [],
      seasonLines: 0,
    });
    expect(await holdsFor(n)).toEqual([
      {
        reason: 'conflicting_profiles',
        triggerFeed: 'player_profile',
        triggerDocumentId: n,
        triggerReference: ref,
        candidateIds: [r2.playerId, r1.playerId],
        status: 'open',
      },
    ]);
    // The hold preserves the parsed document and the observation time the ingester tracked.
    const [held] = await heldDocuments(n);
    expect(held?.document).toEqual(JSON.parse(JSON.stringify(nDoc)));
    expect(held?.documentObservedAt?.toISOString()).toBe(T0.toISOString());
    expect(held?.documentUpdatedAt).toBeTruthy();
    // Nothing else was written: both rows canonical with the same claims and attributes, N's id
    // still the reference W2 linked (not upgraded to profile-owned), no season, team or roster row.
    expect(await identityFingerprint(rows)).toEqual(idBefore);
    expect(idBefore.externalIds).toContainEqual({
      league: 'ncaawb',
      external_id: n,
      id_type: 'league_profile',
      source: 'reference',
      player_id: r2.playerId,
    });
    expect(idBefore.players.find((p) => p.id === r1.playerId)).toMatchObject({
      full_name: 'Conflict A',
      position: null,
    });
    expect(idBefore.players.find((p) => p.id === r2.playerId)).toMatchObject({
      full_name: 'Conflict B',
      position: null,
    });
    expect(await seasonFootprint(`season-${suffix}`, `team-${suffix}`)).toEqual(NO_FOOTPRINT);
    const [w1Row] = await db<{ playerId: string }[]>`
      select player_id as "playerId" from public.player_external_ids where league = 'wnba' and external_id = ${w1}`;
    expect(w1Row?.playerId).toBe(r1.playerId);
    expect(await mergeRowFor(r1.playerId ?? '')).toBeUndefined();
    expect(await mergeRowFor(r2.playerId ?? '')).toBeUndefined();
  });

  it('an id already stored under another id_type is held (id_type_mismatch), not linked under the new type', async () => {
    const suffix = randomUUID();
    const ext = `ext-${suffix}`;
    // A WNBA profile stores `ext` as an external id.
    const a = await applyPlayerProfile(
      db,
      'wnba',
      profile(`wa-${suffix}`, 'Type A', [{ source_id: ext, scope: 'WNBA', id_type: 'external' }]),
      silentLog,
    );
    // Another profile claims the same string is a WNBA league_profile id.
    const ref = { source_id: ext, scope: 'WNBA', id_type: 'league_profile' };
    const b = await applyPlayerProfile(
      db,
      'unrivaled',
      profile(`u-${suffix}`, 'Type B', [ref]),
      silentLog,
    );
    expect(b.playerId).not.toBe(a.playerId);
    expect(b.mergedFrom).toEqual([]);
    expect(b.held).toMatchObject([
      { reason: 'id_type_mismatch', reference: ref, candidateIds: [a.playerId] },
    ]);
    const [stored] = await db<{ playerId: string; idType: string }[]>`
      select player_id as "playerId", id_type as "idType" from public.player_external_ids
      where league = 'wnba' and external_id = ${ext}`;
    expect(stored).toEqual({ playerId: a.playerId, idType: 'external' });
  });

  it('an id owned by a tombstone (a data inconsistency) is held as tombstone_owner and never followed', async () => {
    const suffix = randomUUID();
    const s = (await gamePlayer('wnba', `s-${suffix}`, 'Tomb Survivor')).get(`s-${suffix}`) ?? '';
    const t = (await gamePlayer('wnba', `t-${suffix}`, 'Tomb Loser')).get(`t-${suffix}`) ?? '';
    await applyPlayerProfile(
      db,
      'wnba',
      profile(`s-${suffix}`, 'Tomb Survivor', [
        { source_id: `t-${suffix}`, scope: 'WNBA', id_type: 'league_profile' },
      ]),
      silentLog,
    );
    expect(await resolveCanonical(db, t)).toBe(s);
    // Plant an external id on the tombstone directly (no code path does this); remove it after.
    const stray = `stray-${suffix}`;
    await db`insert into public.player_external_ids (provider, league, external_id, player_id, id_type, source)
             values ('sportradar', 'ncaawb', ${stray}, ${t}, 'league_profile', 'manual')`;
    try {
      const ref = { source_id: stray, scope: 'NCAAW', id_type: 'league_profile' };
      const res = await applyPlayerProfile(
        db,
        'unrivaled',
        profile(`u-${suffix}`, 'Tomb Ref', [ref]),
        silentLog,
      );
      expect(res.mergedFrom).toEqual([]);
      expect(res.held).toMatchObject([
        { reason: 'tombstone_owner', reference: ref, candidateIds: [t, s] },
      ]);
      expect(res.playerId).not.toBe(s);
    } finally {
      await db`delete from public.player_external_ids where league = 'ncaawb' and external_id = ${stray}`;
    }
  });
});

describe('conflicting profiles are held with their evidence and change nothing', () => {
  it('two different sport-wide ids on two rows (stored under different leagues): the merge is held, identities, claims, attributes and game state are unchanged, the replay adds nothing', async () => {
    const suffix = randomUUID();
    const docs = suffixedDocs(suffix);
    const line = attributedLines(docs)[0];
    if (!line) throw new Error('fixture has no player with both an event and a stats line');
    const P = line.providerPlayerId;
    const { gameId } = await seedGame(db, docs.pbp);
    const run = await replayRun(db, gameId);
    expect((await apply(deps, gameId, docs.pbp, observation(run, docs.pbp, T0))).outcome).toBe(
      'applied',
    );
    expect(
      (await apply(deps, gameId, docs.sum, observation(run, docs.sum, later(5)))).outcome,
    ).toBe('applied');
    // The WNBA profile of P carries sport-wide id S1; an NCAAW profile N carries S2.
    const s1 = `s1-${suffix}`;
    const s2 = `s2-${suffix}`;
    const n = `n-${suffix}`;
    const rP = await applyPlayerProfile(
      db,
      'wnba',
      profile(P, line.fullName, [{ source_id: s1, scope: 'WNBA', id_type: 'sport_profile' }]),
      silentLog,
    );
    const rN = await applyPlayerProfile(
      db,
      'ncaawb',
      profile(n, 'Sport Other', [{ source_id: s2, scope: 'NCAAW', id_type: 'sport_profile' }]),
      silentLog,
    );
    const rowP = rP.playerId ?? '';
    const rowN = rN.playerId ?? '';
    expect(rowP).toBeTruthy();
    expect(rowN).toBeTruthy();
    expect(rowP).not.toBe(rowN);
    const idBefore = await identityFingerprint([rowP, rowN]);
    const gameBefore = await gameFingerprint(gameId);
    expect(gameBefore.lines.find((l) => l.providerPlayerId === P)?.playerId).toBe(rowP);

    // An Unrivaled profile says P and N are one person: that person would own S1 and S2, the
    // provider contradicting itself across two leagues' id spaces. It carries its own name,
    // position and a season too: nothing may land on P's row (the oldest candidate) by tie-break.
    const refP = { source_id: P, scope: 'WNBA', id_type: 'league_profile' };
    const refN = { source_id: n, scope: 'NCAAW', id_type: 'league_profile' };
    const u = `u-${suffix}`;
    const unr = contradictingProfile(u, suffix, [refP, refN]);
    const res = await applyPlayerProfile(db, 'unrivaled', unr, silentLog);
    expect(res).toEqual({
      playerId: null,
      mergedFrom: [],
      merges: [],
      held: [
        {
          reason: 'conflicting_profiles',
          reference: refN,
          candidateIds: [rowP, rowN],
          detail: {
            conflicts: [
              {
                theirs: { league: 'ncaawb', idType: 'sport_profile', externalId: s2 },
                against: {
                  claim: { league: 'wnba', idType: 'sport_profile', externalId: s1 },
                  owner: rowP,
                },
              },
            ],
          },
        },
      ],
      externalIds: [],
      seasonLines: 0,
    });
    // The hold carries its evidence: feed, document, the references[] entry, both candidates.
    expect(await holdsFor(u)).toEqual([
      {
        reason: 'conflicting_profiles',
        triggerFeed: 'player_profile',
        triggerDocumentId: u,
        triggerReference: refN,
        candidateIds: [rowP, rowN],
        status: 'open',
      },
    ]);
    // Identities, existing claims and attributes are exactly as before; the Unrivaled document's
    // own id was linked nowhere, its name and position landed nowhere, its season created nothing.
    expect(await identityFingerprint([rowP, rowN])).toEqual(idBefore);
    const [uRow] = await db<{ n: number }[]>`
      select count(*)::int as n from public.player_external_ids where external_id = ${u}`;
    expect(uRow?.n).toBe(0);
    expect(idBefore.players.find((p) => p.id === rowP)).toMatchObject({
      full_name: line.fullName,
      position: null,
    });
    expect(await seasonFootprint(`season-${suffix}`, `team-${suffix}`)).toEqual(NO_FOOTPRINT);
    expect(await resolveCanonical(db, rowN)).toBe(rowN);
    expect(await mergeRowFor(rowN)).toBeUndefined();
    expect(await mergeRowFor(rowP)).toBeUndefined();
    // Game state: nothing moved, nothing deleted, and the identical summary is still a no-op.
    expect(await gameFingerprint(gameId)).toEqual(gameBefore);
    const r = await apply(deps, gameId, docs.sum, observation(run, docs.sum, later(10)));
    if (r.outcome !== 'applied') throw new Error('expected applied');
    expect(r.changes).toEqual([]);
    expect(await gameFingerprint(gameId)).toEqual(gameBefore);

    // Replaying the contradicting document: still one open hold, still nothing changed.
    const again = await applyPlayerProfile(db, 'unrivaled', unr, silentLog);
    expect(again.playerId).toBeNull();
    expect(again.mergedFrom).toEqual([]);
    expect(again.held).toHaveLength(1);
    expect(await holdsFor(u)).toHaveLength(1);
    expect(await identityFingerprint([rowP, rowN])).toEqual(idBefore);
    expect(await gameFingerprint(gameId)).toEqual(gameBefore);
    expect(await seasonFootprint(`season-${suffix}`, `team-${suffix}`)).toEqual(NO_FOOTPRINT);
  });

  it.each([
    {
      label: 'older provider revision received later',
      storedRevision: 20,
      incomingRevision: 10,
      incomingObservation: 30,
      accept: false,
    },
    {
      label: 'newer provider revision observed earlier',
      storedRevision: 20,
      incomingRevision: 30,
      incomingObservation: 10,
      accept: true,
    },
    {
      label: 'equal provider revision observed earlier',
      storedRevision: 20,
      incomingRevision: 20,
      incomingObservation: 10,
      accept: false,
    },
    {
      label: 'no revisions, older observation',
      storedRevision: null,
      incomingRevision: null,
      incomingObservation: 10,
      accept: false,
    },
    {
      label: 'no revisions, newer observation',
      storedRevision: null,
      incomingRevision: null,
      incomingObservation: 30,
      accept: true,
    },
    {
      label: 'one revision missing, older observation',
      storedRevision: 20,
      incomingRevision: null,
      incomingObservation: 10,
      accept: false,
    },
  ])(
    'held document freshness: $label',
    async ({ storedRevision, incomingRevision, incomingObservation, accept }) => {
      const suffix = randomUUID();
      const w = `w-${suffix}`;
      const n = `n-${suffix}`;
      const u = `u-${suffix}`;
      const a = await applyPlayerProfile(
        db,
        'wnba',
        profile(w, 'Original WNBA', [
          { source_id: `sport-a-${suffix}`, scope: 'WNBA', id_type: 'sport_profile' },
        ]),
        silentLog,
      );
      const b = await applyPlayerProfile(
        db,
        'ncaawb',
        profile(n, 'Original NCAA', [
          { source_id: `sport-b-${suffix}`, scope: 'NCAAW', id_type: 'sport_profile' },
        ]),
        silentLog,
      );
      if (!a.playerId || !b.playerId) throw new Error('candidate setup failed');
      const identityBefore = await identityFingerprint([a.playerId, b.playerId]);
      const doc = (name: string, revision: number | null) =>
        PlayerProfileDocumentSchema.parse({
          id: u,
          full_name: name,
          references: [
            { source_id: w, scope: 'WNBA', id_type: 'league_profile' },
            { source_id: n, scope: 'NCAAW', id_type: 'league_profile' },
          ],
          ...(revision === null ? {} : { updated: later(revision).toISOString() }),
          future_provider_field: { retained: name },
        });
      const stored = doc('Stored held name', storedRevision);
      expect(
        (await applyPlayerProfile(db, 'unrivaled', stored, silentLog, { observedAt: later(20) }))
          .playerId,
      ).toBeNull();
      const [before] =
        await db`select * from ingest.player_merge_holds where trigger_document_id = ${u}`;
      if (!before) throw new Error('hold missing');
      const incoming = doc('Incoming held name', incomingRevision);
      expect(
        (
          await applyPlayerProfile(db, 'unrivaled', incoming, silentLog, {
            observedAt: later(incomingObservation),
          })
        ).playerId,
      ).toBeNull();
      const rows =
        await db`select * from ingest.player_merge_holds where trigger_document_id = ${u}`;
      expect(rows).toHaveLength(1);
      const after = rows[0];
      if (!after) throw new Error('hold missing');
      if (accept) {
        expect(after.document).toEqual(JSON.parse(JSON.stringify(incoming)));
        expect(after.document_observed_at).toEqual(later(incomingObservation));
        expect(after.id).toBe(before.id);
        expect(after.created_at).toEqual(before.created_at);
      } else {
        // Reject the entire stale replacement: keep the matching evidence, run and timestamps too.
        expect(after).toEqual(before);
      }
      expect(await identityFingerprint([a.playerId, b.playerId])).toEqual(identityBefore);
      expect((await replayHeldDocument(db, after.id, silentLog)).playerId).toBeNull();
      expect((await heldDocuments(u))[0]?.document).toEqual(after.document);
      expect(await holdsFor(u)).toHaveLength(1);
    },
  );

  it('a held document is replayable from player_merge_holds.document alone: the replay reproduces the identical single open hold (same candidates and detail, body and document_updated_at refreshed) and changes nothing; a corrupted stored body is rejected by the schema', async () => {
    const suffix = randomUUID();
    const docs = suffixedDocs(suffix);
    const line = attributedLines(docs)[0];
    if (!line) throw new Error('fixture has no player with both an event and a stats line');
    const P = line.providerPlayerId;
    const { gameId } = await seedGame(db, docs.pbp);
    const run = await replayRun(db, gameId);
    expect((await apply(deps, gameId, docs.pbp, observation(run, docs.pbp, T0))).outcome).toBe(
      'applied',
    );
    expect(
      (await apply(deps, gameId, docs.sum, observation(run, docs.sum, later(5)))).outcome,
    ).toBe('applied');
    const s1 = `s1-${suffix}`;
    const s2 = `s2-${suffix}`;
    const n = `n-${suffix}`;
    const rowP =
      (
        await applyPlayerProfile(
          db,
          'wnba',
          profile(P, line.fullName, [{ source_id: s1, scope: 'WNBA', id_type: 'sport_profile' }]),
          silentLog,
        )
      ).playerId ?? '';
    const rowN =
      (
        await applyPlayerProfile(
          db,
          'ncaawb',
          profile(n, 'Sport Other', [{ source_id: s2, scope: 'NCAAW', id_type: 'sport_profile' }]),
          silentLog,
        )
      ).playerId ?? '';
    expect(rowP && rowN && rowP !== rowN).toBe(true);
    const idBefore = await identityFingerprint([rowP, rowN]);
    const gameBefore = await gameFingerprint(gameId);

    // Held and skipped, as the ingester would do it (observedAt is the fetch time it tracked).
    const refP = { source_id: P, scope: 'WNBA', id_type: 'league_profile' };
    const refN = { source_id: n, scope: 'NCAAW', id_type: 'league_profile' };
    const u = `u-${suffix}`;
    const unr = contradictingProfile(u, suffix, [refP, refN]);
    const first = await applyPlayerProfile(db, 'unrivaled', unr, silentLog, { observedAt: T0 });
    expect(first.playerId).toBeNull();
    expect(first.held).toHaveLength(1);
    const before = await heldDocuments(u);
    expect(before).toHaveLength(1);
    const h0 = before[0];
    if (!h0) throw new Error('unreachable');
    expect(h0).toMatchObject({
      reason: 'conflicting_profiles',
      status: 'open',
      candidateIds: [rowP, rowN],
      detail: {
        conflicts: [
          {
            theirs: { league: 'ncaawb', idType: 'sport_profile', externalId: s2 },
            against: {
              claim: { league: 'wnba', idType: 'sport_profile', externalId: s1 },
              owner: rowP,
            },
          },
        ],
      },
    });
    expect(h0.document).toEqual(JSON.parse(JSON.stringify(unr)));
    expect(h0.documentObservedAt?.toISOString()).toBe(T0.toISOString());
    expect(h0.documentUpdatedAt).toBeTruthy();
    expect(await seasonFootprint(`season-${suffix}`, `team-${suffix}`)).toEqual(NO_FOOTPRINT);

    expect(h0.runId).toBeNull();

    // Replay from the stored body only: same outcome, same hold row, refreshed body timestamp;
    // the run the replay is attributed to (the refreshed hold follows the replay option).
    const replay = await replayHeldDocument(db, h0.id, silentLog, { runId: run.id });
    expect(replay).toEqual(first);
    const after = await heldDocuments(u);
    expect(after).toHaveLength(1);
    const h1 = after[0];
    if (!h1) throw new Error('unreachable');
    expect(h1.id).toBe(h0.id);
    expect(h1.status).toBe('open');
    expect(h1.candidateIds).toEqual(h0.candidateIds);
    expect(h1.detail).toEqual(h0.detail);
    expect(h1.document).toEqual(h0.document);
    expect(h1.documentObservedAt?.toISOString()).toBe(T0.toISOString());
    expect(h1.documentUpdatedAt ?? 0).toBeGreaterThan(h0.documentUpdatedAt ?? 0);
    expect(h1.runId).toBe(run.id);
    // A replay without a run option keeps the hold's own run.
    expect((await replayHeldDocument(db, h0.id, silentLog)).playerId).toBeNull();
    expect((await heldDocuments(u))[0]?.runId).toBe(run.id);
    // Identities, claims, attributes, seasons and game-stat fingerprints: unchanged throughout.
    expect(await identityFingerprint([rowP, rowN])).toEqual(idBefore);
    expect(await gameFingerprint(gameId)).toEqual(gameBefore);
    expect(await seasonFootprint(`season-${suffix}`, `team-${suffix}`)).toEqual(NO_FOOTPRINT);
    const [uRow] = await db<{ n: number }[]>`
      select count(*)::int as n from public.player_external_ids where external_id = ${u}`;
    expect(uRow?.n).toBe(0);

    // The stored body is a provider payload at rest: it crosses the Zod boundary again on replay.
    await db`update ingest.player_merge_holds set document = '{"id": 1}'::jsonb where id = ${h0.id}`;
    try {
      await expect(replayHeldDocument(db, h0.id, silentLog)).rejects.toThrow();
    } finally {
      await db`update ingest.player_merge_holds set document = ${db.json(h0.document as never)} where id = ${h0.id}`;
    }
    expect(await identityFingerprint([rowP, rowN])).toEqual(idBefore);
    expect((await heldDocuments(u))[0]?.document).toEqual(h0.document);
  });

  it('own-id path: a third league merged two game-sourced ids of one league; the first profile upgrades its id, the second is held and writes nothing (no attributes, no seasons), game state unchanged, replay adds nothing', async () => {
    const suffix = randomUUID();
    const docs = suffixedDocs(suffix);
    const [l1, l2] = attributedLines(docs);
    if (!l1 || !l2) throw new Error('fixture has fewer than two players with an event and a line');
    const P1 = l1.providerPlayerId;
    const P2 = l2.providerPlayerId;
    const { gameId } = await seedGame(db, docs.pbp);
    const run = await replayRun(db, gameId);
    expect((await apply(deps, gameId, docs.pbp, observation(run, docs.pbp, T0))).outcome).toBe(
      'applied',
    );
    expect(
      (await apply(deps, gameId, docs.sum, observation(run, docs.sum, later(5)))).outcome,
    ).toBe('applied');
    // Two WNBA game-sourced rows; an Unrivaled profile says they are one person: the real-world
    // duplicate-record case, merged under the ratified rule with a provenance row.
    const u = `u-${suffix}`;
    const r0 = await applyPlayerProfile(
      db,
      'unrivaled',
      profile(u, l1.fullName, [
        { source_id: P1, scope: 'WNBA', id_type: 'league_profile' },
        { source_id: P2, scope: 'WNBA', id_type: 'league_profile' },
      ]),
      silentLog,
    );
    const survivor = r0.playerId ?? '';
    expect(survivor).toBeTruthy();
    expect(r0.mergedFrom).toHaveLength(1);
    expect(r0.held).toEqual([]);
    const loser = r0.mergedFrom[0] ?? '';
    expect(await mergeRowFor(loser)).toMatchObject({ survivorId: survivor, triggerDocumentId: u });
    // WNBA profile P1 arrives: its id is upgraded to profile-owned on the merged row, no hold.
    const p1 = await applyPlayerProfile(
      db,
      'wnba',
      PlayerProfileDocumentSchema.parse({
        id: P1,
        full_name: l1.fullName,
        first_name: 'First',
        position: 'G',
      }),
      silentLog,
    );
    expect(p1.playerId).toBe(survivor);
    expect(p1.held).toEqual([]);
    const idBefore = await identityFingerprint([survivor, loser]);
    expect(idBefore.externalIds).toEqual(
      expect.arrayContaining([
        {
          league: 'wnba',
          external_id: P1,
          id_type: 'league_profile',
          source: 'profile',
          player_id: survivor,
        },
        {
          league: 'wnba',
          external_id: P2,
          id_type: 'league_profile',
          source: 'game',
          player_id: survivor,
        },
      ]),
    );
    const gameBefore = await gameFingerprint(gameId);
    expect(
      gameBefore.lines
        .filter((l) => l.playerId === survivor)
        .map((l) => l.providerPlayerId)
        .sort(),
    ).toEqual([P1, P2].sort());

    // WNBA profile P2 arrives with its own attributes and a season: owning P2 on that row too
    // would give one person two WNBA profiles, so it is held before anything is written.
    const ownRef = { scope: 'wnba', id_type: 'league_profile', source_id: P2 };
    const seasonId = `season-${suffix}`;
    const p2Doc = PlayerProfileDocumentSchema.parse({
      id: P2,
      full_name: 'Someone Else',
      first_name: 'Other',
      position: 'C',
      seasons: [{ id: seasonId, year: 2998, type: 'REG', teams: [] }],
    });
    const p2 = await applyPlayerProfile(db, 'wnba', p2Doc, silentLog);
    expect(p2).toEqual({
      playerId: null,
      mergedFrom: [],
      merges: [],
      held: [
        {
          reason: 'conflicting_profiles',
          reference: ownRef,
          candidateIds: [survivor],
          detail: {
            conflicts: [
              {
                theirs: { league: 'wnba', idType: 'league_profile', externalId: P1 },
                against: {
                  claim: { league: 'wnba', idType: 'league_profile', externalId: P2 },
                  owner: 'document',
                },
              },
            ],
          },
        },
      ],
      externalIds: [],
      seasonLines: 0,
    });
    expect(await holdsFor(P2)).toEqual([
      {
        reason: 'conflicting_profiles',
        triggerFeed: 'player_profile',
        triggerDocumentId: P2,
        triggerReference: ownRef,
        candidateIds: [survivor],
        status: 'open',
      },
    ]);
    // Nothing written: identities, claims (P2 still game-sourced), attributes, merges, seasons.
    expect(await identityFingerprint([survivor, loser])).toEqual(idBefore);
    const [season] = await db<{ n: number }[]>`
      select count(*)::int as n from public.seasons where league = 'wnba' and provider_season_id = ${seasonId}`;
    expect(season?.n).toBe(0);
    // Game state: nothing moved, nothing deleted, and the identical summary is still a no-op.
    expect(await gameFingerprint(gameId)).toEqual(gameBefore);
    const r = await apply(deps, gameId, docs.sum, observation(run, docs.sum, later(10)));
    if (r.outcome !== 'applied') throw new Error('expected applied');
    expect(r.changes).toEqual([]);
    expect(await gameFingerprint(gameId)).toEqual(gameBefore);

    // Replaying the contradicting document: still one open hold, still nothing changed.
    const again = await applyPlayerProfile(db, 'wnba', p2Doc, silentLog);
    expect(again.playerId).toBeNull();
    expect(again.held).toHaveLength(1);
    expect(await holdsFor(P2)).toHaveLength(1);
    expect(await identityFingerprint([survivor, loser])).toEqual(idBefore);
    expect(await gameFingerprint(gameId)).toEqual(gameBefore);
  });

  it('three references, two agreeing and one contradicting the second: one hold names all three rows (home, the row owning the counter-claim, the candidate), the document is skipped', async () => {
    const suffix = randomUUID();
    const q = `q-${suffix}`;
    const pId = `p-${suffix}`;
    const n = `n-${suffix}`;
    const s1 = `s1-${suffix}`;
    const s2 = `s2-${suffix}`;
    // Oldest: a game-sourced WNBA row Q with no profile claims. Then WNBA profile P (sport S1) and
    // NCAAW profile N (sport S2).
    const rowQ = (await gamePlayer('wnba', q, 'Three Way')).get(q) ?? '';
    const rowP =
      (
        await applyPlayerProfile(
          db,
          'wnba',
          profile(pId, 'Three Way', [{ source_id: s1, scope: 'WNBA', id_type: 'sport_profile' }]),
          silentLog,
        )
      ).playerId ?? '';
    const rowN =
      (
        await applyPlayerProfile(
          db,
          'ncaawb',
          profile(n, 'Three Way', [{ source_id: s2, scope: 'NCAAW', id_type: 'sport_profile' }]),
          silentLog,
        )
      ).playerId ?? '';
    expect(new Set([rowQ, rowP, rowN]).size).toBe(3);
    const idBefore = await identityFingerprint([rowQ, rowP, rowN]);
    // An Unrivaled profile claims all three. Home = Q (oldest, no claims); P would be absorbed and
    // bring S1; N then contradicts S1 with S2. The row that holds S1 is P, not the home row.
    const refQ = { source_id: q, scope: 'WNBA', id_type: 'league_profile' };
    const refP = { source_id: pId, scope: 'WNBA', id_type: 'league_profile' };
    const refN = { source_id: n, scope: 'NCAAW', id_type: 'league_profile' };
    const u = `u-${suffix}`;
    const res = await applyPlayerProfile(
      db,
      'unrivaled',
      contradictingProfile(u, suffix, [refQ, refP, refN]),
      silentLog,
    );
    expect(res).toEqual({
      playerId: null,
      mergedFrom: [],
      merges: [],
      held: [
        {
          reason: 'conflicting_profiles',
          reference: refN,
          candidateIds: [rowQ, rowP, rowN],
          detail: {
            conflicts: [
              {
                theirs: { league: 'ncaawb', idType: 'sport_profile', externalId: s2 },
                against: {
                  claim: { league: 'wnba', idType: 'sport_profile', externalId: s1 },
                  owner: rowP,
                },
              },
            ],
          },
        },
      ],
      externalIds: [],
      seasonLines: 0,
    });
    const holds = await heldDocuments(u);
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({ candidateIds: [rowQ, rowP, rowN], status: 'open' });
    // Nothing merged (P was never absorbed), nothing linked, nothing written.
    expect(await identityFingerprint([rowQ, rowP, rowN])).toEqual(idBefore);
    for (const row of [rowQ, rowP, rowN]) expect(await resolveCanonical(db, row)).toBe(row);
    expect(await seasonFootprint(`season-${suffix}`, `team-${suffix}`)).toEqual(NO_FOOTPRINT);
  });

  it('two candidates that each contradict the document itself: two holds (one per reference), each naming the home row and its candidate, the document skipped once', async () => {
    const suffix = randomUUID();
    const u = `u-${suffix}`;
    const n = `n-${suffix}`;
    const w = `w-${suffix}`;
    const s0 = `s0-${suffix}`;
    const s1 = `s1-${suffix}`;
    const s2 = `s2-${suffix}`;
    // Oldest: the document's own id, game-sourced (the home row). Then NCAAW profile N (sport S1)
    // and WNBA profile W (sport S2).
    const rowU = (await gamePlayer('unrivaled', u, 'Two Ways')).get(u) ?? '';
    const rowN =
      (
        await applyPlayerProfile(
          db,
          'ncaawb',
          profile(n, 'Two Ways', [{ source_id: s1, scope: 'NCAAW', id_type: 'sport_profile' }]),
          silentLog,
        )
      ).playerId ?? '';
    const rowW =
      (
        await applyPlayerProfile(
          db,
          'wnba',
          profile(w, 'Two Ways', [{ source_id: s2, scope: 'WNBA', id_type: 'sport_profile' }]),
          silentLog,
        )
      ).playerId ?? '';
    expect(new Set([rowU, rowN, rowW]).size).toBe(3);
    const idBefore = await identityFingerprint([rowU, rowN, rowW]);
    // The Unrivaled profile carries sport id S0 of its own and references N and W: each of them
    // contradicts the document, independently of the other.
    const refS0 = { source_id: s0, scope: 'basketball', id_type: 'sport_profile' };
    const refN = { source_id: n, scope: 'NCAAW', id_type: 'league_profile' };
    const refW = { source_id: w, scope: 'WNBA', id_type: 'league_profile' };
    const doc = contradictingProfile(u, suffix, [refS0, refN, refW]);
    const res = await applyPlayerProfile(db, 'unrivaled', doc, silentLog);
    expect(res.playerId).toBeNull();
    expect(res.mergedFrom).toEqual([]);
    const againstDoc = {
      claim: { league: 'unrivaled', idType: 'sport_profile', externalId: s0 },
      owner: 'document',
    };
    expect(res.held).toEqual([
      {
        reason: 'conflicting_profiles',
        reference: refN,
        candidateIds: [rowU, rowN],
        detail: {
          conflicts: [
            {
              theirs: { league: 'ncaawb', idType: 'sport_profile', externalId: s1 },
              against: againstDoc,
            },
          ],
        },
      },
      {
        reason: 'conflicting_profiles',
        reference: refW,
        candidateIds: [rowU, rowW],
        detail: {
          conflicts: [
            {
              theirs: { league: 'wnba', idType: 'sport_profile', externalId: s2 },
              against: againstDoc,
            },
          ],
        },
      },
    ]);
    const holds = await heldDocuments(u);
    expect(holds).toHaveLength(2);
    expect(holds.map((h) => h.candidateIds).sort()).toEqual(
      [
        [rowU, rowN],
        [rowU, rowW],
      ].sort(),
    );
    expect(holds.every((h) => h.status === 'open' && h.document !== null)).toBe(true);
    // Skipped once: S0 linked nowhere, U still game-sourced, nothing else written.
    const [s0Row] = await db<{ n: number }[]>`
      select count(*)::int as n from public.player_external_ids where external_id = ${s0}`;
    expect(s0Row?.n).toBe(0);
    expect(await identityFingerprint([rowU, rowN, rowW])).toEqual(idBefore);
    expect(await seasonFootprint(`season-${suffix}`, `team-${suffix}`)).toEqual(NO_FOOTPRINT);
    // Re-applying: still two open holds, same candidates.
    const again = await applyPlayerProfile(db, 'unrivaled', doc, silentLog);
    expect(again.playerId).toBeNull();
    expect(again.held).toHaveLength(2);
    expect((await heldDocuments(u)).map((h) => h.candidateIds).sort()).toEqual(
      [
        [rowU, rowN],
        [rowU, rowW],
      ].sort(),
    );
  });

  it('a matching sport-wide id across leagues still merges normally with a provenance row, and re-ingesting the unchanged profile is a no-op', async () => {
    const suffix = randomUUID();
    const s = `s-${suffix}`;
    const w = `w-${suffix}`;
    const n = `n-${suffix}`;
    // A WNBA profile carrying sport id S, and an NCAAW game-sourced row for N.
    const rW = await applyPlayerProfile(
      db,
      'wnba',
      profile(w, 'Same Person', [{ source_id: s, scope: 'WNBA', id_type: 'sport_profile' }]),
      silentLog,
    );
    const rowW = rW.playerId ?? '';
    const rowN = (await gamePlayer('ncaawb', n, 'Same Person')).get(n) ?? '';
    expect(rowW).toBeTruthy();
    expect(rowN).toBeTruthy();
    // The NCAAW profile N carries the same sport id: the two rows are one person.
    const ref = { source_id: s, scope: 'NCAAW', id_type: 'sport_profile' };
    const doc = profile(n, 'Same Person', [ref]);
    const res = await applyPlayerProfile(db, 'ncaawb', doc, silentLog);
    expect(res.held).toEqual([]);
    expect(res.mergedFrom).toEqual([rowN]); // rowW is older
    expect(res.playerId).toBe(rowW);
    expect(await mergeRowFor(rowN)).toMatchObject({
      survivorId: rowW,
      loserId: rowN,
      league: 'ncaawb',
      triggerFeed: 'player_profile',
      triggerDocumentId: n,
      triggerSource: 'reference',
      triggerReference: ref,
    });
    expect(
      res.externalIds.map((e) => `${e.league}:${e.externalId}:${e.idType}:${e.source}`).sort(),
    ).toEqual([
      `ncaawb:${n}:league_profile:profile`,
      `ncaawb:${s}:sport_profile:reference`,
      `wnba:${s}:sport_profile:reference`,
      `wnba:${w}:league_profile:profile`,
    ]);
    expect(await holdsFor(n)).toEqual([]);
    // Unchanged profile again: no hold, no merge, no changed rows.
    const before = await identityFingerprint([rowW, rowN]);
    const again = await applyPlayerProfile(db, 'ncaawb', doc, silentLog);
    expect(again).toMatchObject({ playerId: rowW, mergedFrom: [], merges: [], held: [] });
    expect(await identityFingerprint([rowW, rowN])).toEqual(before);
    expect(await holdsFor(n)).toEqual([]);
  });
});
