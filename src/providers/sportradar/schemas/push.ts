import { z } from 'zod';
import { GameHeaderTeamFields, IsoDateTime } from './common.js';
import { PbpEventSchema } from './pbp.js';

/**
 * Sportradar push feed lines (newline-delimited JSON). The push client (M4)
 * consumes these; M1 parses recorded samples so the shape is pinned early.
 */
export const PushHeartbeatSchema = z.object({ heartbeat: z.object({ interval: z.int() }).loose() });

const PushGameSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    coverage: z.string().optional(),
    scheduled: IsoDateTime.optional(),
    home: z.object(GameHeaderTeamFields).loose(),
    away: z.object(GameHeaderTeamFields).loose(),
  })
  .loose();

export const PushMetadataSchema = z
  .object({
    match: z.string().optional(),
    league: z.string().optional(),
    status: z.string().optional(),
    operation: z.enum(['insert', 'update', 'delete']).or(z.string()),
    event_type: z.string().optional(),
    version: z.string().optional(),
  })
  .loose();

export const PushEventMessageSchema = z
  .object({
    payload: z.object({ game: PushGameSchema, event: PbpEventSchema }).loose(),
    metadata: PushMetadataSchema,
    locale: z.string().optional(),
  })
  .loose();

export const PushClockMessageSchema = z
  .object({
    payload: z
      .object({
        game: PushGameSchema,
        period: z
          .object({ number: z.int(), sequence: z.int(), type: z.string() })
          .loose()
          .optional(),
        clocks: z
          .object({
            game: z.string(),
            game_decimal: z.string().optional(),
            shot: z.string().optional(),
            running: z.boolean(),
          })
          .loose(),
      })
      .loose(),
    metadata: PushMetadataSchema,
  })
  .loose();

export const PushLineSchema = z.union([
  PushHeartbeatSchema,
  PushEventMessageSchema,
  PushClockMessageSchema,
]);
export type PushEventMessage = z.infer<typeof PushEventMessageSchema>;
export type PushClockMessage = z.infer<typeof PushClockMessageSchema>;
