import { z } from 'zod';
import {
  BroadcastSchema,
  IsoDateTime,
  LeagueRefSchema,
  ProviderGameStatusSchema,
  SeasonRefSchema,
  VenueSchema,
} from './common.js';

/** A team as listed in a schedule entry (season schedule, tournament schedule). */
export const ScheduleTeamSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    alias: z.string().optional(),
    market: z.string().optional(),
    seed: z.int().optional(),
    rank: z.int().optional(),
  })
  .loose();

/** One game of a schedule list. Strict on what games/ensureGame persist. */
export const ScheduleGameSchema = z
  .object({
    id: z.string(),
    status: ProviderGameStatusSchema,
    coverage: z.string().optional(),
    scheduled: IsoDateTime,
    title: z.string().optional(),
    home_points: z.int().optional(),
    away_points: z.int().optional(),
    conference_game: z.boolean().optional(),
    neutral_site: z.boolean().optional(),
    track_on_court: z.boolean().optional(),
    venue: VenueSchema.optional(),
    broadcasts: z.array(BroadcastSchema).optional(),
    home: ScheduleTeamSchema,
    away: ScheduleTeamSchema,
  })
  .loose();
export type ScheduleGame = z.infer<typeof ScheduleGameSchema>;

/** Season schedule (`/games/{year}/{type}/schedule.json`). */
export const SeasonScheduleDocumentSchema = z
  .object({
    league: LeagueRefSchema.optional(),
    season: SeasonRefSchema,
    games: z.array(ScheduleGameSchema).default([]),
  })
  .loose();
export type SeasonScheduleDocument = z.infer<typeof SeasonScheduleDocumentSchema>;

/**
 * Daily schedule (`/games/{yyyy}/{mm}/{dd}/schedule.json`): the same game entries as the season
 * schedule, for one calendar day, with coverage as it stands that day (Sportradar: coverage is
 * subject to change up to the scheduled start; NCAAWB `full` follows AP Top 25 teams). The
 * document carries `date` and `league`; a `season` header is optional (the docs sample has none).
 * Fixture: fixtures/ncaawb/docs-daily-schedule-2022-11-07.json (assembled from the season sample).
 */
export const DailyScheduleDocumentSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    league: LeagueRefSchema.optional(),
    season: SeasonRefSchema.optional(),
    games: z.array(ScheduleGameSchema).default([]),
  })
  .loose();
export type DailyScheduleDocument = z.infer<typeof DailyScheduleDocumentSchema>;
