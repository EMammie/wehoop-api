import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlayerResponseSchema } from '../../src/api/routes/players.js';
import { createApp } from '../../src/api/server.js';
import { loadConfig } from '../../src/config.js';
import {
  applyPlayerProfile,
  ensurePlayers,
  externalIdsOf,
  playerIdFor,
  resolveCanonical,
} from '../../src/ingest/identity.js';
import {
  type PlayerProfileDocument,
  PlayerProfileDocumentSchema,
} from '../../src/providers/sportradar/schemas/profile.js';
import { silentLog, testDb } from '../helpers/db.js';
import { fixture } from '../helpers/fixtures.js';

/**
 * Identity (plan §2, M2 acceptance "one Unrivaled profile links WNBA + NCAAW ids
 * and /v1/players/:id returns all three"). The committed Boston fixtures are
 * used with every provider id suffixed per test run, so the test never collides
 * with the validator's replay of the real fixtures in the same database.
 */
const db = testDb();
const app = createApp({ db, config: loadConfig({ ...process.env, MODE: 'sim' }), log: silentLog });

beforeAll(async () => {
  await db`select 1`;
});
afterAll(async () => {
  await db.end();
});

/** The WNBA docs profile and the hand-assembled Unrivaled profile with every id suffixed. */
function bostonPair(suffix: string): {
  wnba: PlayerProfileDocument;
  unrivaled: PlayerProfileDocument;
} {
  const rewrite = (doc: unknown) =>
    JSON.parse(
      JSON.stringify(doc)
        .replaceAll('63dde7d8-0af8-4adb-a556-01e0d2395420', `wnba-${suffix}`)
        .replaceAll('54b8a881-27f7-4735-b499-0c3adf0286b0', `unr-${suffix}`)
        .replaceAll('ea798cfb-8765-4246-a428-3d451c9a935d', `sport-${suffix}`)
        .replaceAll('d8f2f455-ee4e-4061-8d1d-bd04131bd9a4', `ncaaw-${suffix}`)
        .replaceAll('1642286', `ext-${suffix}`),
    );
  return {
    wnba: PlayerProfileDocumentSchema.parse(
      rewrite(fixture('docs-player-profile-boston.json', 'wnba')),
    ),
    unrivaled: PlayerProfileDocumentSchema.parse(
      rewrite(fixture('hand-player-profile-boston.json', 'unrivaled')),
    ),
  };
}

async function snapshotOf(playerId: string) {
  const [p] = await db<{ id: string; mergedInto: string | null }[]>`
    select id, merged_into as "mergedInto" from public.players where id = ${playerId}`;
  const ids = await externalIdsOf(db, playerId);
  const [lines] = await db<{ n: number }[]>`
    select count(*)::int as n from public.player_season_stats where player_id = ${playerId}`;
  return {
    ...p,
    externalIds: ids.map((e) => `${e.league}:${e.externalId}:${e.idType}:${e.source}`),
    lines: lines?.n,
  };
}

describe('identity: canonical players and cross-league external ids', () => {
  it('ensurePlayers creates a row per new provider id with source=game and is idempotent', async () => {
    const a = `p-${randomUUID()}`;
    const b = `p-${randomUUID()}`;
    const players = [
      {
        providerPlayerId: a,
        providerTeamId: null,
        fullName: 'A Player',
        firstName: 'A',
        lastName: 'Player',
        jersey: '1',
        position: 'G',
      },
      {
        providerPlayerId: b,
        providerTeamId: null,
        fullName: null,
        firstName: 'B',
        lastName: 'Player',
        jersey: null,
        position: null,
      },
    ];
    const first = await ensurePlayers(db, 'ncaawb', players);
    const second = await ensurePlayers(db, 'ncaawb', players);
    expect([...second.entries()].sort()).toEqual([...first.entries()].sort());
    const ids = await externalIdsOf(db, first.get(a) ?? '');
    expect(ids).toEqual([
      {
        provider: 'sportradar',
        league: 'ncaawb',
        externalId: a,
        idType: 'league_profile',
        source: 'game',
      },
    ]);
    const [row] = await db<{ fullName: string }[]>`
      select full_name as "fullName" from public.players where id = ${first.get(b) ?? ''}`;
    expect(row?.fullName).toBe('B Player');
  });

  it('WNBA profile then Unrivaled profile: one canonical player with ids in three leagues and season lines from two', async () => {
    const suffix = randomUUID();
    const { wnba, unrivaled } = bostonPair(suffix);
    const w = await applyPlayerProfile(db, 'wnba', wnba, silentLog);
    expect(w.mergedFrom).toEqual([]);
    expect(w.seasonLines).toBe(4);
    const u = await applyPlayerProfile(db, 'unrivaled', unrivaled, silentLog);
    // Every reference already resolves to the WNBA row: no second row is created, nothing merges.
    expect(u.mergedFrom).toEqual([]);
    expect(u.playerId).toBe(w.playerId);
    const snap = await snapshotOf(u.playerId);
    expect(snap.mergedInto).toBeNull();
    expect([...snap.externalIds].sort()).toEqual([
      `ncaawb:ncaaw-${suffix}:league_profile:reference`,
      `unrivaled:sport-${suffix}:sport_profile:reference`,
      `unrivaled:unr-${suffix}:league_profile:profile`,
      `wnba:ext-${suffix}:external:reference`,
      `wnba:sport-${suffix}:sport_profile:reference`,
      `wnba:wnba-${suffix}:league_profile:profile`,
    ]);
    expect(snap.lines).toBe(5); // 4 WNBA + 1 Unrivaled
    // every provider id resolves to the one row
    expect(await playerIdFor(db, 'unrivaled', `unr-${suffix}`)).toBe(u.playerId);
    expect(await playerIdFor(db, 'ncaawb', `ncaaw-${suffix}`)).toBe(u.playerId);

    // idempotent: re-applying both profiles creates no players, ids or lines
    const before = await db<{ players: number; ids: number; lines: number }[]>`
      select (select count(*)::int from public.players) as players,
             (select count(*)::int from public.player_external_ids) as ids,
             (select count(*)::int from public.player_season_stats) as lines`;
    const w2 = await applyPlayerProfile(db, 'wnba', wnba, silentLog);
    const u2 = await applyPlayerProfile(db, 'unrivaled', unrivaled, silentLog);
    expect([w2.playerId, u2.playerId]).toEqual([u.playerId, u.playerId]);
    expect(w2.mergedFrom.concat(u2.mergedFrom)).toEqual([]);
    expect(w2.seasonLines + u2.seasonLines).toBe(0);
    const after = await db<{ players: number; ids: number; lines: number }[]>`
      select (select count(*)::int from public.players) as players,
             (select count(*)::int from public.player_external_ids) as ids,
             (select count(*)::int from public.player_season_stats) as lines`;
    expect(after).toEqual(before);
  });

  it('is deterministic: the opposite arrival order yields the same linkage, with the older row surviving', async () => {
    const suffix = randomUUID();
    const { wnba, unrivaled } = bostonPair(suffix);
    const u = await applyPlayerProfile(db, 'unrivaled', unrivaled, silentLog);
    expect(u.mergedFrom).toEqual([]);
    const w = await applyPlayerProfile(db, 'wnba', wnba, silentLog);
    // The Unrivaled references already registered the WNBA id on the Unrivaled row, so the
    // WNBA profile finds its own id and no second row is ever created: nothing to merge.
    expect(w.playerId).toBe(u.playerId);
    expect(w.mergedFrom).toEqual([]);
    const snap = await snapshotOf(w.playerId);
    expect(snap.externalIds).toHaveLength(6);
    expect(snap.lines).toBe(5);
  });

  it('the first profile for a player already known from another league adopts that row: no junk row, no merge', async () => {
    const suffix = randomUUID();
    const { wnba } = bostonPair(suffix);
    // A game feed named the NCAAW id first (no profile ever seen for that league).
    const fromGame = await ensurePlayers(db, 'ncaawb', [
      {
        providerPlayerId: `ncaaw-${suffix}`,
        providerTeamId: null,
        fullName: 'A. Boston',
        firstName: null,
        lastName: null,
        jersey: null,
        position: null,
      },
    ]);
    const [before] = await db<{ players: number }[]>`
      select count(*)::int as players from public.players`;
    const w = await applyPlayerProfile(db, 'wnba', wnba, silentLog);
    // The reference resolves before anything is written: the profile lands on the game-sourced row.
    expect(w.playerId).toBe(fromGame.get(`ncaaw-${suffix}`));
    expect(w.mergedFrom).toEqual([]);
    const [after] = await db<{ players: number }[]>`
      select count(*)::int as players from public.players`;
    expect(after?.players).toBe(before?.players);
    expect(await playerIdFor(db, 'ncaawb', `ncaaw-${suffix}`)).toBe(w.playerId);
    expect(await playerIdFor(db, 'wnba', `wnba-${suffix}`)).toBe(w.playerId);
    const [p] = await db<{ fullName: string; college: string | null }[]>`
      select full_name as "fullName", college from public.players where id = ${w.playerId}`;
    expect(p).toEqual({ fullName: 'Aliyah Boston', college: 'South Carolina' }); // the profile is the authority
  });

  it('two game-sourced rows in two leagues are merged by the first profile that references both; the older row survives', async () => {
    const suffix = randomUUID();
    const { wnba } = bostonPair(suffix);
    const player = (league: 'wnba' | 'ncaawb', id: string) =>
      ensurePlayers(db, league, [
        {
          providerPlayerId: id,
          providerTeamId: null,
          fullName: 'A. Boston',
          firstName: null,
          lastName: null,
          jersey: null,
          position: null,
        },
      ]);
    const older = (await player('wnba', `wnba-${suffix}`)).get(`wnba-${suffix}`);
    const younger = (await player('ncaawb', `ncaaw-${suffix}`)).get(`ncaaw-${suffix}`);
    const w = await applyPlayerProfile(db, 'wnba', wnba, silentLog);
    expect(w.playerId).toBe(older);
    expect(w.mergedFrom).toEqual([younger]);
    expect(await resolveCanonical(db, younger ?? '')).toBe(older);
    // the merged row is a tombstone that owns nothing
    const [tomb] = await db<{ ids: number; lines: number; mergedInto: string | null }[]>`
      select (select count(*)::int from public.player_external_ids where player_id = ${younger ?? ''}) as ids,
             (select count(*)::int from public.player_season_stats where player_id = ${younger ?? ''}) as lines,
             (select merged_into from public.players where id = ${younger ?? ''}) as "mergedInto"`;
    expect(tomb).toEqual({ ids: 0, lines: 0, mergedInto: older });
    expect((await snapshotOf(w.playerId)).lines).toBe(4);
  });
});

describe('GET /v1/players/:id', () => {
  it('returns the canonical player with all three league ids and per-league season lines, by uuid or by league:providerId, and resolves a merged id', async () => {
    const suffix = randomUUID();
    const { wnba, unrivaled } = bostonPair(suffix);
    // Game feeds named the NCAAW id and then the WNBA id before any profile: the WNBA profile
    // resolves both rows and merges them (the older NCAAW row survives, the WNBA row is the
    // tombstone the route must resolve).
    const player = (league: 'wnba' | 'ncaawb', id: string) =>
      ensurePlayers(db, league, [
        {
          providerPlayerId: id,
          providerTeamId: null,
          fullName: 'A. Boston',
          firstName: null,
          lastName: null,
          jersey: null,
          position: null,
        },
      ]);
    const fromNcaaw = (await player('ncaawb', `ncaaw-${suffix}`)).get(`ncaaw-${suffix}`);
    const fromWnba = (await player('wnba', `wnba-${suffix}`)).get(`wnba-${suffix}`);
    const w = await applyPlayerProfile(db, 'wnba', wnba, silentLog);
    expect(w).toMatchObject({ playerId: fromNcaaw, mergedFrom: [fromWnba] });
    const u = await applyPlayerProfile(db, 'unrivaled', unrivaled, silentLog);
    expect(u).toMatchObject({ playerId: fromNcaaw, mergedFrom: [] });
    const byUuid = await app.request(`/v1/players/${u.playerId}`);
    expect(byUuid.status).toBe(200);
    const body = PlayerResponseSchema.parse(await byUuid.json());
    expect(body.player).toMatchObject({
      id: u.playerId,
      fullName: 'Aliyah Boston',
      college: 'South Carolina',
      heightIn: 77,
    });
    expect(new Set(body.externalIds.map((e) => e.league))).toEqual(
      new Set(['wnba', 'ncaawb', 'unrivaled']),
    );
    expect(body.externalIds.map((e) => e.externalId)).toContain(`ncaaw-${suffix}`);
    expect(body.mergedIds).toEqual([fromWnba]);
    expect(new Set(body.seasons.map((s) => s.league))).toEqual(new Set(['wnba', 'unrivaled']));
    expect(body.seasons.find((s) => s.league === 'unrivaled')).toMatchObject({
      seasonYear: 2026,
      seasonType: 'REG',
      teamName: 'Phantom',
      gamesPlayed: 4,
    });
    expect(body.seasons).toHaveLength(5);
    // by provider id, from each league
    for (const ref of [
      `unrivaled:unr-${suffix}`,
      `wnba:wnba-${suffix}`,
      `ncaawb:ncaaw-${suffix}`,
    ]) {
      const res = await app.request(`/v1/players/${ref}`);
      expect(res.status).toBe(200);
      expect(PlayerResponseSchema.parse(await res.json()).player.id).toBe(u.playerId);
    }
    // the tombstoned uuid resolves to the survivor
    const merged = await app.request(`/v1/players/${fromWnba}`);
    expect(merged.status).toBe(200);
    expect(PlayerResponseSchema.parse(await merged.json()).player.id).toBe(u.playerId);
    expect((await app.request('/v1/players/nope')).status).toBe(400);
    expect((await app.request('/v1/players/nba:1')).status).toBe(400);
    expect((await app.request(`/v1/players/wnba:missing-${suffix}`)).status).toBe(404);
    expect((await app.request('/v1/players/00000000-0000-4000-8000-000000000000')).status).toBe(
      404,
    );
  });
});
