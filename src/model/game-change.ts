import { z } from 'zod';
import { GameStatusSchema, LiveEventSchema, PeriodRefSchema, ScoreSchema } from './live-event.js';

/**
 * The ONE GameChange schema (plan §3). Broadcast messages, `/changes` responses
 * and `game_changes` rows all decode to this. Equality between sources is
 * tested on decoded objects, never on JSON bytes.
 */
export const ChangeTypeSchema = z.enum([
  'event_insert',
  'event_update',
  'event_delete',
  'status',
  'period',
  'stats_team',
  'stats_player',
]);
export type ChangeType = z.infer<typeof ChangeTypeSchema>;

const envelope = {
  v: z.literal(1),
  id: z.uuid(),
  gameId: z.uuid(),
  seq: z.int().positive(),
  ts: z.iso.datetime({ offset: true }),
};

export const EventDeleteBodySchema = z.object({ providerEventId: z.string() });

/**
 * Durable game-level state: status, score and the current period. Unrivaled
 * adds the Elam target once the target-score phase begins; it is omitted
 * (never null) for every other game, so M1 bodies decode unchanged.
 */
export const StatusBodySchema = z.object({
  status: GameStatusSchema,
  score: ScoreSchema,
  period: PeriodRefSchema.nullable(),
  elamTargetScore: z.int().positive().optional(),
});

/** Full line score replacement: one row per period played so far. */
export const PeriodBodySchema = z.object({
  periods: z.array(PeriodRefSchema.extend({ score: ScoreSchema })),
});

export const TeamStatsSchema = z.object({
  points: z.int().nullable(),
  fgm: z.int().nullable(),
  fga: z.int().nullable(),
  tpm: z.int().nullable(),
  tpa: z.int().nullable(),
  ftm: z.int().nullable(),
  fta: z.int().nullable(),
  offRebounds: z.int().nullable(),
  defRebounds: z.int().nullable(),
  rebounds: z.int().nullable(),
  assists: z.int().nullable(),
  steals: z.int().nullable(),
  blocks: z.int().nullable(),
  turnovers: z.int().nullable(),
  personalFouls: z.int().nullable(),
  fastBreakPts: z.int().nullable(),
  paintPts: z.int().nullable(),
  secondChancePts: z.int().nullable(),
  benchPts: z.int().nullable(),
  biggestLead: z.int().nullable(),
  extra: z.record(z.string(), z.unknown()),
});
export type TeamStats = z.infer<typeof TeamStatsSchema>;

export const StatsTeamBodySchema = z.object({
  teamId: z.uuid(),
  providerTeamId: z.string(),
  isHome: z.boolean(),
  stats: TeamStatsSchema,
});

/** One player's box line. Typed on the game_player_stats columns; everything else in `extra`. */
export const PlayerStatsSchema = z.object({
  minutes: z.string().nullable(),
  points: z.int().nullable(),
  fgm: z.int().nullable(),
  fga: z.int().nullable(),
  tpm: z.int().nullable(),
  tpa: z.int().nullable(),
  ftm: z.int().nullable(),
  fta: z.int().nullable(),
  offRebounds: z.int().nullable(),
  defRebounds: z.int().nullable(),
  rebounds: z.int().nullable(),
  assists: z.int().nullable(),
  steals: z.int().nullable(),
  blocks: z.int().nullable(),
  turnovers: z.int().nullable(),
  personalFouls: z.int().nullable(),
  plusMinus: z.int().nullable(),
  efficiency: z.int().nullable(),
  extra: z.record(z.string(), z.unknown()),
});
export type PlayerStats = z.infer<typeof PlayerStatsSchema>;

/**
 * Player stats (M2). `playerId` / `teamId` are the canonical uuids resolved by
 * identity.ts; `providerPlayerId` is kept so a client holding a provider id
 * from a LiveEvent body can join without a lookup.
 */
export const StatsPlayerBodySchema = z.object({
  playerId: z.uuid(),
  teamId: z.uuid(),
  providerPlayerId: z.string(),
  providerTeamId: z.string(),
  fullName: z.string(),
  jersey: z.string().nullable(),
  position: z.string().nullable(),
  starter: z.boolean().nullable(),
  played: z.boolean().nullable(),
  onCourt: z.boolean().nullable(),
  notPlayingReason: z.string().nullable(),
  stats: PlayerStatsSchema,
});
export type StatsPlayerBody = z.infer<typeof StatsPlayerBodySchema>;

export const GameChangeSchema = z.discriminatedUnion('type', [
  z.object({
    ...envelope,
    type: z.literal('event_insert'),
    providerEventId: z.string(),
    body: LiveEventSchema,
  }),
  z.object({
    ...envelope,
    type: z.literal('event_update'),
    providerEventId: z.string(),
    body: LiveEventSchema,
  }),
  z.object({
    ...envelope,
    type: z.literal('event_delete'),
    providerEventId: z.string(),
    body: EventDeleteBodySchema,
  }),
  z.object({ ...envelope, type: z.literal('status'), body: StatusBodySchema }),
  z.object({ ...envelope, type: z.literal('period'), body: PeriodBodySchema }),
  z.object({ ...envelope, type: z.literal('stats_team'), body: StatsTeamBodySchema }),
  z.object({ ...envelope, type: z.literal('stats_player'), body: StatsPlayerBodySchema }),
]);
export type GameChange = z.infer<typeof GameChangeSchema>;
export type GameChangeBody = GameChange['body'];

/** A change before it has a seq/id/ts: what the differ produces and applyChanges numbers. */
export type PendingChange =
  | { type: 'event_insert'; providerEventId: string; body: z.infer<typeof LiveEventSchema> }
  | { type: 'event_update'; providerEventId: string; body: z.infer<typeof LiveEventSchema> }
  | { type: 'event_delete'; providerEventId: string; body: z.infer<typeof EventDeleteBodySchema> }
  | { type: 'status'; body: z.infer<typeof StatusBodySchema> }
  | { type: 'period'; body: z.infer<typeof PeriodBodySchema> }
  | { type: 'stats_team'; body: z.infer<typeof StatsTeamBodySchema> }
  | { type: 'stats_player'; body: z.infer<typeof StatsPlayerBodySchema> };

/**
 * Rebuild the envelope from stored columns. Used by `/changes`, the outbox
 * publisher and the snapshot so every reader decodes the same object.
 */
export interface GameChangeRow {
  id: string;
  gameId: string;
  seq: number | string | bigint;
  changeType: string;
  providerEventId: string | null;
  body: unknown;
  createdAt: Date | string;
}

export function gameChangeFromRow(row: GameChangeRow): GameChange {
  const ts =
    row.createdAt instanceof Date
      ? row.createdAt.toISOString()
      : new Date(row.createdAt).toISOString();
  return GameChangeSchema.parse({
    v: 1,
    id: row.id,
    gameId: row.gameId,
    seq: Number(row.seq),
    ts,
    type: row.changeType,
    ...(row.providerEventId ? { providerEventId: row.providerEventId } : {}),
    body: row.body,
  });
}
