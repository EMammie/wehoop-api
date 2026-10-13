import { z } from 'zod';
import { GameHeaderFields, GameHeaderTeamFields, PlayerRefSchema } from './common.js';

/** Team statistics block as found in the game summary (`/games/{id}/summary.json`, sim feed `game`). */
export const TeamStatisticsSchema = z
  .object({
    minutes: z.string().optional(),
    points: z.int().optional(),
    field_goals_made: z.int().optional(),
    field_goals_att: z.int().optional(),
    three_points_made: z.int().optional(),
    three_points_att: z.int().optional(),
    free_throws_made: z.int().optional(),
    free_throws_att: z.int().optional(),
    offensive_rebounds: z.int().optional(),
    defensive_rebounds: z.int().optional(),
    rebounds: z.int().optional(),
    total_rebounds: z.int().optional(),
    assists: z.int().optional(),
    steals: z.int().optional(),
    blocks: z.int().optional(),
    turnovers: z.int().optional(),
    total_turnovers: z.int().optional(),
    personal_fouls: z.int().optional(),
    fast_break_pts: z.int().optional(),
    points_in_paint: z.int().optional(),
    second_chance_pts: z.int().optional(),
    bench_points: z.int().optional(),
    biggest_lead: z.int().optional(),
    periods: z
      .array(z.object({ number: z.int(), sequence: z.int(), type: z.string() }).loose())
      .optional(),
  })
  .loose();
export type TeamStatistics = z.infer<typeof TeamStatisticsSchema>;

export const PlayerStatisticsSchema = z
  .object({
    minutes: z.string().optional(),
    points: z.int().optional(),
    rebounds: z.int().optional(),
    assists: z.int().optional(),
  })
  .loose();

export const SummaryPlayerSchema = PlayerRefSchema.extend({
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  position: z.string().optional(),
  primary_position: z.string().optional(),
  active: z.boolean().optional(),
  starter: z.boolean().optional(),
  played: z.boolean().optional(),
  on_court: z.boolean().optional(),
  statistics: PlayerStatisticsSchema.optional(),
});

export const SummaryTeamSchema = z
  .object({
    ...GameHeaderTeamFields,
    statistics: TeamStatisticsSchema.optional(),
    players: z.array(SummaryPlayerSchema).optional(),
  })
  .loose();

/** Sportradar game summary document. Carries a gameView and stats, never events. */
export const SummaryDocumentSchema = z
  .object({
    ...GameHeaderFields,
    home: SummaryTeamSchema,
    away: SummaryTeamSchema,
  })
  .loose();
export type SummaryDocument = z.infer<typeof SummaryDocumentSchema>;
