import { z } from 'zod';
import { LeagueRefSchema, SeasonRefSchema } from './common.js';

export const StandingRecordSchema = z
  .object({
    record_type: z.string(),
    wins: z.int(),
    losses: z.int(),
    win_pct: z.number().optional(),
  })
  .loose();

/** One team's standing line. Strict on what public.standings persists. */
export const StandingTeamSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    market: z.string().optional(),
    alias: z.string().optional(),
    wins: z.int(),
    losses: z.int(),
    win_pct: z.number().optional(),
    points_for: z.number().optional(),
    points_against: z.number().optional(),
    point_diff: z.number().optional(),
    games_behind: z
      .object({
        league: z.number().optional(),
        conference: z.number().optional(),
        division: z.number().optional(),
      })
      .loose()
      .optional(),
    streak: z.object({ kind: z.string(), length: z.int() }).loose().optional(),
    calc_rank: z
      .object({
        league_rank: z.int().optional(),
        conf_rank: z.int().optional(),
        div_rank: z.int().optional(),
      })
      .loose()
      .optional(),
    /** NCAAWB spells the conference rank at the top level. */
    conference_rank: z.int().optional(),
    records: z.array(StandingRecordSchema).optional(),
  })
  .loose();
export type StandingTeam = z.infer<typeof StandingTeamSchema>;

export const StandingDivisionSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    alias: z.string().optional(),
    teams: z.array(StandingTeamSchema).default([]),
  })
  .loose();

export const StandingConferenceSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    alias: z.string().optional(),
    teams: z.array(StandingTeamSchema).optional(),
    divisions: z.array(StandingDivisionSchema).optional(),
  })
  .loose();

/** Standings (`/seasons/{year}/{type}/standings.json`). */
export const StandingsDocumentSchema = z
  .object({
    league: LeagueRefSchema.optional(),
    season: SeasonRefSchema,
    conferences: z.array(StandingConferenceSchema).default([]),
  })
  .loose();
export type StandingsDocument = z.infer<typeof StandingsDocumentSchema>;
