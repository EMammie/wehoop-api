import { z } from 'zod';
import { SeasonAveragesSchema, SeasonRefSchema, SeasonTotalsSchema } from './common.js';

const RecordSchema = z
  .object({ total: SeasonTotalsSchema.optional(), average: SeasonAveragesSchema.optional() })
  .loose();

export const SeasonalPlayerSchema = z
  .object({
    id: z.string(),
    full_name: z.string(),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    position: z.string().optional(),
    primary_position: z.string().optional(),
    jersey_number: z.string().optional(),
    total: SeasonTotalsSchema.optional(),
    average: SeasonAveragesSchema.optional(),
  })
  .loose();

/** Team seasonal statistics (`/seasons/{year}/{type}/teams/{id}/statistics.json`). */
export const TeamSeasonalStatisticsDocumentSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    market: z.string().optional(),
    alias: z.string().optional(),
    season: SeasonRefSchema,
    own_record: RecordSchema.optional(),
    opponents: RecordSchema.optional(),
    players: z.array(SeasonalPlayerSchema).default([]),
  })
  .loose();
export type TeamSeasonalStatisticsDocument = z.infer<typeof TeamSeasonalStatisticsDocumentSchema>;

/** League leaders (`/seasons/{year}/{type}/leaders.json`): the captured Unrivaled fixture. */
export const LeagueLeadersDocumentSchema = z
  .object({
    season: SeasonRefSchema,
    id: z.string().optional(),
    name: z.string().optional(),
    alias: z.string().optional(),
    categories: z
      .array(
        z
          .object({
            name: z.string(),
            type: z.string().optional(),
            ranks: z
              .array(
                z
                  .object({
                    rank: z.int(),
                    tied: z.boolean().optional(),
                    score: z.number(),
                    player: z
                      .object({
                        id: z.string(),
                        full_name: z.string(),
                        first_name: z.string().optional(),
                        last_name: z.string().optional(),
                        position: z.string().optional(),
                        jersey_number: z.string().optional(),
                      })
                      .loose(),
                    teams: z
                      .array(
                        z
                          .object({
                            id: z.string(),
                            name: z.string(),
                            market: z.string().optional(),
                            alias: z.string().optional(),
                          })
                          .loose(),
                      )
                      .default([]),
                    total: SeasonTotalsSchema.optional(),
                    average: SeasonAveragesSchema.optional(),
                  })
                  .loose(),
              )
              .default([]),
          })
          .loose(),
      )
      .default([]),
  })
  .loose();
export type LeagueLeadersDocument = z.infer<typeof LeagueLeadersDocumentSchema>;
