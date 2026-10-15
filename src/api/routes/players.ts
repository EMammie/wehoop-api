import { Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { externalIdsOf, playerIdFor, resolveCanonical } from '../../ingest/identity.js';
import { LeagueCodeSchema } from '../../leagues/codes.js';
import type { AppEnv } from '../server.js';

/**
 * GET /v1/players/:id (plan §5): canonical player + external ids + per-league
 * season lines. `:id` is the canonical uuid, or `<league>:<provider id>`
 * (e.g. `unrivaled:fd8d4b11-...`) which is resolved through
 * player_external_ids. A merged (tombstoned) id resolves to its survivor; the
 * response always carries the survivor's `id`.
 */
export const PlayerResponseSchema = z.object({
  player: z.object({
    id: z.uuid(),
    fullName: z.string(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    birthdate: z.string().nullable(),
    heightIn: z.int().nullable(),
    weightLb: z.int().nullable(),
    position: z.string().nullable(),
    college: z.string().nullable(),
    jersey: z.string().nullable(),
    status: z.string().nullable(),
    headshotUrl: z.string().nullable(),
  }),
  externalIds: z.array(
    z.object({
      provider: z.string(),
      league: LeagueCodeSchema,
      externalId: z.string(),
      idType: z.string().nullable(),
      source: z.string(),
    }),
  ),
  /** Canonical ids that were merged into this player (tombstones). */
  mergedIds: z.array(z.uuid()),
  seasons: z.array(
    z.object({
      league: LeagueCodeSchema,
      seasonId: z.uuid(),
      seasonYear: z.int(),
      seasonType: z.string(),
      teamId: z.uuid(),
      providerTeamId: z.string(),
      teamName: z.string(),
      teamMarket: z.string().nullable(),
      teamAlias: z.string().nullable(),
      gamesPlayed: z.int().nullable(),
      gamesStarted: z.int().nullable(),
      minutes: z.number().nullable(),
      points: z.int().nullable(),
      rebounds: z.int().nullable(),
      assists: z.int().nullable(),
      steals: z.int().nullable(),
      blocks: z.int().nullable(),
      turnovers: z.int().nullable(),
      fgm: z.int().nullable(),
      fga: z.int().nullable(),
      tpm: z.int().nullable(),
      tpa: z.int().nullable(),
      ftm: z.int().nullable(),
      fta: z.int().nullable(),
      averages: z.record(z.string(), z.unknown()).nullable(),
      extra: z.record(z.string(), z.unknown()).nullable(),
    }),
  ),
});
export type PlayerResponse = z.infer<typeof PlayerResponseSchema>;

const ExternalRef = z.string().regex(/^[a-z]+:.+$/);

export function playersRoutes() {
  const r = new Hono<AppEnv>();

  r.get('/v1/players/:id', async (c) => {
    const raw = c.req.param('id');
    const { db } = c.get('deps');
    let playerId: string | null = null;
    if (z.uuid().safeParse(raw).success) {
      playerId = raw;
    } else if (ExternalRef.safeParse(raw).success) {
      const idx = raw.indexOf(':');
      const league = LeagueCodeSchema.safeParse(raw.slice(0, idx));
      if (!league.success) return c.json({ error: 'invalid_player_id' }, 400);
      playerId = await playerIdFor(db, league.data, raw.slice(idx + 1));
    } else {
      return c.json({ error: 'invalid_player_id' }, 400);
    }
    if (!playerId) return c.json({ error: 'not_found' }, 404);
    const player = await loadPlayer(db, playerId);
    if (!player) return c.json({ error: 'not_found' }, 404);
    c.header('cache-control', 'public, max-age=300');
    return c.json(player);
  });

  return r;
}

export async function loadPlayer(db: Db, id: string): Promise<PlayerResponse | null> {
  const [exists] = await db<{ id: string }[]>`select id from public.players where id = ${id}`;
  if (!exists) return null;
  const canonical = await resolveCanonical(db, id);
  const [p] = await db<
    {
      id: string;
      fullName: string;
      firstName: string | null;
      lastName: string | null;
      birthdate: string | null;
      heightIn: number | null;
      weightLb: number | null;
      position: string | null;
      college: string | null;
      jersey: string | null;
      status: string | null;
      headshotUrl: string | null;
    }[]
  >`select id, full_name as "fullName", first_name as "firstName", last_name as "lastName",
           birthdate::text as birthdate, height_in as "heightIn", weight_lb as "weightLb", position, college,
           jersey, status, headshot_url as "headshotUrl"
    from public.players where id = ${canonical}`;
  if (!p) return null;
  const externalIds = await externalIdsOf(db, canonical);
  const merged = await db<{ id: string }[]>`
    select id from public.players where merged_into = ${canonical} order by id`;
  const seasons = await db<
    {
      league: string;
      seasonId: string;
      seasonYear: number;
      seasonType: string;
      teamId: string;
      providerTeamId: string;
      teamName: string;
      teamMarket: string | null;
      teamAlias: string | null;
      gamesPlayed: number | null;
      gamesStarted: number | null;
      minutes: string | null;
      points: number | null;
      rebounds: number | null;
      assists: number | null;
      steals: number | null;
      blocks: number | null;
      turnovers: number | null;
      fgm: number | null;
      fga: number | null;
      tpm: number | null;
      tpa: number | null;
      ftm: number | null;
      fta: number | null;
      averages: Record<string, unknown> | null;
      extra: Record<string, unknown> | null;
    }[]
  >`select s.league::text as league, pss.season_id as "seasonId", s.year as "seasonYear", s.type::text as "seasonType",
           pss.team_id as "teamId", t.provider_team_id as "providerTeamId", t.name as "teamName", t.market as "teamMarket",
           t.alias as "teamAlias", pss.games_played as "gamesPlayed", pss.games_started as "gamesStarted",
           pss.minutes::text as minutes, pss.points, pss.rebounds, pss.assists, pss.steals, pss.blocks, pss.turnovers,
           pss.fgm, pss.fga, pss.tpm, pss.tpa, pss.ftm, pss.fta, pss.averages, pss.extra
    from public.player_season_stats pss
    join public.seasons s on s.id = pss.season_id
    join public.teams t on t.id = pss.team_id
    where pss.player_id = ${canonical}
    order by s.year desc, s.league, s.type, t.name`;
  return PlayerResponseSchema.parse({
    player: p,
    externalIds,
    mergedIds: merged.map((m) => m.id),
    seasons: seasons.map((s) => ({
      ...s,
      minutes: s.minutes === null ? null : Number(s.minutes),
    })),
  });
}
