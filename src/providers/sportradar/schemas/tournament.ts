import { z } from 'zod';
import { IsoDate, LeagueRefSchema, SeasonRefSchema } from './common.js';
import { ScheduleGameSchema } from './schedule.js';

/** One tournament of the tournament list (`/tournaments/{year}/{type}/schedule.json`). */
export const TournamentSummarySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    location: z.string().optional(),
    status: z.string().optional(),
    start_date: IsoDate.optional(),
    end_date: IsoDate.optional(),
    parent_id: z.string().optional(),
  })
  .loose();

export const TournamentListDocumentSchema = z
  .object({
    league: LeagueRefSchema.optional(),
    season: SeasonRefSchema,
    tournaments: z.array(TournamentSummarySchema).default([]),
  })
  .loose();
export type TournamentListDocument = z.infer<typeof TournamentListDocumentSchema>;

export const BracketSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    location: z.string().optional(),
    rank: z.int().optional(),
  })
  .loose();

export const TournamentRoundSchema = z
  .object({
    id: z.string().optional(),
    sequence: z.int().optional(),
    name: z.string().optional(),
    games: z.array(ScheduleGameSchema).default([]),
    bracketed: z
      .array(
        z
          .object({ bracket: BracketSchema, games: z.array(ScheduleGameSchema).default([]) })
          .loose(),
      )
      .default([]),
  })
  .loose();

/**
 * Tournament schedule (`/tournaments/{id}/schedule.json`). Unrivaled OOT games
 * come from here, not from the season schedule (plan §2).
 */
export const TournamentScheduleDocumentSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    location: z.string().optional(),
    status: z.string().optional(),
    parent_id: z.string().optional(),
    league: LeagueRefSchema.optional(),
    season: SeasonRefSchema,
    rounds: z.array(TournamentRoundSchema).default([]),
  })
  .loose();
export type TournamentScheduleDocument = z.infer<typeof TournamentScheduleDocumentSchema>;
