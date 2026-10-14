import { z } from 'zod';

/**
 * LiveEvent: the normalized play-by-play body stored in play_events.payload and
 * carried by event_insert / event_update changes. Discriminated on `type`.
 * Shared by all three leagues; adapters only decide how to fill it.
 *
 * EVERY id inside a body is a PROVIDER id (Sportradar) and is named
 * `provider…Id` (plan §3, ratified 2026-10-14): `providerTeamId`,
 * `providerPlayerId`, `providerPossessionTeamId`, `providerAssistId`,
 * `providerBlockId`, `providerStealId`, `providerDrawnById`,
 * `providerOnCourtPlayerIds`. Canonical uuids (`teams.id`, `players.id`) are
 * columns on play_events resolved by identity.ts (M2); they never enter the
 * body or the content hash, so an identity merge never rewrites history.
 * test/unit/model/live-event.test.ts enforces the prefix on every body shape.
 */
export const PeriodTypeSchema = z.enum(['quarter', 'half', 'overtime', 'elam']);
export type PeriodType = z.infer<typeof PeriodTypeSchema>;

export const PeriodRefSchema = z.object({
  number: z.int().nonnegative(),
  type: PeriodTypeSchema,
  sequence: z.int().nonnegative(),
});
export type PeriodRef = z.infer<typeof PeriodRefSchema>;

export const ScoreSchema = z.object({ home: z.int().nonnegative(), away: z.int().nonnegative() });
export type Score = z.infer<typeof ScoreSchema>;

export const GameStatusSchema = z.enum([
  'scheduled',
  'created',
  'inprogress',
  'halftime',
  'complete',
  'closed',
  'cancelled',
  'postponed',
  'delayed',
  'unnecessary',
  'if_necessary',
  'time_tbd',
]);
export type GameStatus = z.infer<typeof GameStatusSchema>;

const base = {
  period: PeriodRefSchema,
  clock: z.string().nullable(),
  clockDecimal: z.string().optional(),
  wallClock: z.iso.datetime({ offset: true }).nullable(),
  score: ScoreSchema,
  providerTeamId: z.string().optional(),
  providerPlayerId: z.string().optional(),
  providerPossessionTeamId: z.string().optional(),
  description: z.string().optional(),
  qualifiers: z.array(z.string()).optional(),
};

export const ShotLocationSchema = z.object({
  x: z.number(),
  y: z.number(),
  area: z.string().optional(),
});

export const LiveEventSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('tip_off') }),
  z.object({
    ...base,
    type: z.literal('shot'),
    made: z.boolean(),
    points: z.int().nonnegative(),
    shotType: z.string().optional(),
    shotTypeDesc: z.string().optional(),
    distance: z.number().optional(),
    providerAssistId: z.string().optional(),
    providerBlockId: z.string().optional(),
    location: ShotLocationSchema.optional(),
  }),
  z.object({
    ...base,
    type: z.literal('free_throw'),
    made: z.boolean(),
    attempt: z.int().positive().optional(),
    of: z.int().positive().optional(),
    freeThrowType: z.string().optional(),
  }),
  z.object({
    ...base,
    type: z.literal('rebound'),
    kind: z.enum(['offensive', 'defensive', 'team_offensive', 'team_defensive', 'unknown']),
  }),
  z.object({
    ...base,
    type: z.literal('turnover'),
    kind: z.string(),
    providerStealId: z.string().optional(),
  }),
  z.object({
    ...base,
    type: z.literal('foul'),
    kind: z.string(),
    providerDrawnById: z.string().optional(),
  }),
  z.object({
    ...base,
    type: z.literal('timeout'),
    kind: z.enum(['team', 'official', 'tv', 'challenge', 'other']),
  }),
  z.object({
    ...base,
    type: z.literal('lineup_change'),
    /**
     * The full on-court set for the attributed team as the provider reports it
     * AFTER the change (sorted provider player ids). Who came in and who went
     * out is derived by clients from consecutive lineups; deriving it here
     * would make the normalizer stateful.
     */
    providerOnCourtPlayerIds: z.array(z.string()),
  }),
  z.object({ ...base, type: z.literal('period_start') }),
  z.object({ ...base, type: z.literal('period_end') }),
  z.object({ ...base, type: z.literal('game_status'), status: GameStatusSchema }),
  z.object({ ...base, type: z.literal('elam_target_set'), target: z.int().positive() }),
  z.object({ ...base, type: z.literal('awarded_point'), points: z.int().positive() }),
  z.object({ ...base, type: z.literal('review'), outcome: z.string().optional() }),
  z.object({ ...base, type: z.literal('other'), providerEventType: z.string() }),
]);
export type LiveEvent = z.infer<typeof LiveEventSchema>;
export type LiveEventType = LiveEvent['type'];
