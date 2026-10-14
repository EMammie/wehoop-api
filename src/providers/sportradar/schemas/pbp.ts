import { z } from 'zod';
import {
  GameHeaderFields,
  GameHeaderTeamFields,
  IsoDateTime,
  PlayerRefSchema,
  TeamRefSchema,
} from './common.js';

/** One entry of `event.statistics[]`: typed on the fields the normalizer reads. */
export const EventStatisticSchema = z
  .object({
    type: z.string(),
    made: z.boolean().optional(),
    points: z.int().optional(),
    shot_type: z.string().optional(),
    shot_type_desc: z.string().optional(),
    shot_distance: z.number().optional(),
    three_point_shot: z.boolean().optional(),
    rebound_type: z.string().optional(),
    turnover_type: z.string().optional(),
    foul_type: z.string().optional(),
    free_throw_type: z.string().optional(),
    team: TeamRefSchema.optional(),
    player: PlayerRefSchema.optional(),
  })
  .loose();
export type EventStatistic = z.infer<typeof EventStatisticSchema>;

export const OnCourtSchema = z
  .object({
    home: z
      .object({ id: z.string(), players: z.array(PlayerRefSchema) })
      .loose()
      .optional(),
    away: z
      .object({ id: z.string(), players: z.array(PlayerRefSchema) })
      .loose()
      .optional(),
  })
  .loose();

/** One play. Strict on everything play_events persists. */
export const PbpEventSchema = z
  .object({
    id: z.string(),
    event_type: z.string(),
    number: z.int().optional(),
    sequence: z.number().optional(),
    clock: z.string().optional(),
    clock_decimal: z.string().optional(),
    updated: IsoDateTime.optional(),
    created: IsoDateTime.optional(),
    wall_clock: IsoDateTime.optional(),
    home_points: z.int().optional(),
    away_points: z.int().optional(),
    description: z.string().optional(),
    turnover_type: z.string().optional(),
    attribution: TeamRefSchema.optional(),
    possession: TeamRefSchema.optional(),
    qualifiers: z.array(z.object({ qualifier: z.string() }).loose()).optional(),
    location: z
      .object({ coord_x: z.number(), coord_y: z.number(), action_area: z.string().optional() })
      .loose()
      .optional(),
    on_court: OnCourtSchema.optional(),
    statistics: z.array(EventStatisticSchema).optional(),
    /** Push events carry their period inline. */
    period: z
      .object({ id: z.string().optional(), number: z.int(), sequence: z.int(), type: z.string() })
      .loose()
      .optional(),
  })
  .loose();
export type PbpEvent = z.infer<typeof PbpEventSchema>;

export const PbpPeriodSchema = z
  .object({
    id: z.string().optional(),
    type: z.string(),
    number: z.int(),
    sequence: z.int(),
    scoring: z
      .object({
        home: z.object({ id: z.string(), points: z.int() }).loose(),
        away: z.object({ id: z.string(), points: z.int() }).loose(),
      })
      .loose()
      .optional(),
    events: z.array(PbpEventSchema).default([]),
  })
  .loose();
export type PbpPeriod = z.infer<typeof PbpPeriodSchema>;

/** Sportradar play-by-play document (`/games/{id}/pbp.json`). */
export const PbpDocumentSchema = z
  .object({
    ...GameHeaderFields,
    home: z.object(GameHeaderTeamFields).loose(),
    away: z.object(GameHeaderTeamFields).loose(),
    periods: z.array(PbpPeriodSchema).default([]),
    /**
     * Explicit deletion markers. Absence from `periods[].events` never deletes.
     * `updated` is the marker's own revision when the feed carries one (the
     * recorded WNBA simulation carries only `id`).
     */
    deleted_events: z
      .array(z.object({ id: z.string(), updated: z.string().optional() }).loose())
      .optional(),
  })
  .loose();
export type PbpDocument = z.infer<typeof PbpDocumentSchema>;
