import { z } from 'zod';
import { GameHeaderFields, GameHeaderTeamFields, PlayerRefSchema } from './common.js';

const LeaderSchema = PlayerRefSchema.extend({
  statistics: z.record(z.string(), z.unknown()).optional(),
});

export const BoxscoreTeamSchema = z
  .object({
    ...GameHeaderTeamFields,
    leaders: z
      .object({
        points: z.array(LeaderSchema).optional(),
        rebounds: z.array(LeaderSchema).optional(),
        assists: z.array(LeaderSchema).optional(),
      })
      .loose()
      .optional(),
  })
  .loose();

/** Sportradar boxscore document: header + per-period scoring + leaders. */
export const BoxscoreDocumentSchema = z
  .object({
    ...GameHeaderFields,
    home: BoxscoreTeamSchema,
    away: BoxscoreTeamSchema,
  })
  .loose();
export type BoxscoreDocument = z.infer<typeof BoxscoreDocumentSchema>;
