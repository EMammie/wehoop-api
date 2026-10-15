import { z } from 'zod';
import {
  IsoDate,
  IsoDateTime,
  LeagueRefSchema,
  SeasonAveragesSchema,
  SeasonTotalsSchema,
} from './common.js';

/**
 * One entry of a profile's `references[]`. Verified on the Unrivaled docs sample
 * (and the WNBA one): `scope` is a league alias ("WNBA", "NCAAW") with
 * `id_type = "league_profile"`, or "basketball" with `id_type = "sport_profile"`,
 * or a league alias with `id_type = "external"` (the league's own numeric id).
 */
export const PlayerReferenceSchema = z
  .object({
    source_id: z.string(),
    scope: z.string(),
    id_type: z.string(),
  })
  .loose();
export type PlayerReference = z.infer<typeof PlayerReferenceSchema>;

export const ProfileSeasonTeamSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    market: z.string().optional(),
    alias: z.string().optional(),
    total: SeasonTotalsSchema.optional(),
    average: SeasonAveragesSchema.optional(),
  })
  .loose();

export const ProfileSeasonSchema = z
  .object({
    id: z.string(),
    year: z.int(),
    type: z.string(),
    teams: z.array(ProfileSeasonTeamSchema).default([]),
  })
  .loose();

/** Player profile (`/players/{id}/profile.json`). Strict on what players / player_season_stats persist. */
export const PlayerProfileDocumentSchema = z
  .object({
    id: z.string(),
    status: z.string().optional(),
    full_name: z.string(),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    abbr_name: z.string().optional(),
    height: z.int().optional(),
    weight: z.int().optional(),
    position: z.string().optional(),
    primary_position: z.string().optional(),
    jersey_number: z.string().optional(),
    college: z.string().optional(),
    high_school: z.string().optional(),
    birth_place: z.string().optional(),
    birthdate: IsoDate.optional(),
    updated: IsoDateTime.optional(),
    league: LeagueRefSchema.optional(),
    team: z
      .object({
        id: z.string(),
        name: z.string(),
        market: z.string().optional(),
        alias: z.string().optional(),
      })
      .loose()
      .optional(),
    references: z.array(PlayerReferenceSchema).optional(),
    seasons: z.array(ProfileSeasonSchema).optional(),
  })
  .loose();
export type PlayerProfileDocument = z.infer<typeof PlayerProfileDocumentSchema>;
