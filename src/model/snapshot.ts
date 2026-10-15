import { z } from 'zod';
import { GameChangeSchema, StatsPlayerBodySchema, StatsTeamBodySchema } from './game-change.js';
import { GameStatusSchema, LiveEventSchema, PeriodRefSchema, ScoreSchema } from './live-event.js';

/**
 * GET /v1/games/:id/snapshot (plan §5). Produced from ONE REPEATABLE READ
 * transaction so `seq` and the state agree. Never exposes watch_run_id.
 */
export const SnapshotSchema = z.object({
  game: z.object({
    id: z.uuid(),
    league: z.string(),
    providerGameId: z.string(),
    status: GameStatusSchema,
    scheduledAt: z.iso.datetime({ offset: true }),
    coverage: z.string(),
    homeTeamId: z.uuid().nullable(),
    awayTeamId: z.uuid().nullable(),
    score: ScoreSchema,
    period: PeriodRefSchema.nullable(),
    clock: z.string().nullable(),
    clockDecimal: z.string().nullable(),
    clockRunning: z.boolean().nullable(),
    clockAsOf: z.iso.datetime({ offset: true }).nullable(),
    observedAt: z.iso.datetime({ offset: true }).nullable(),
    elamTargetScore: z.int().positive().nullable(),
  }),
  periods: z.array(PeriodRefSchema.extend({ score: ScoreSchema })),
  /** The same provider-keyed bodies the stats_* changes carry, so a fold reproduces the snapshot. */
  teamStats: z.array(StatsTeamBodySchema),
  playerStats: z.array(StatsPlayerBodySchema),
  events: z.array(z.object({ providerEventId: z.string(), body: LiveEventSchema })),
  seq: z.int().nonnegative(),
  retainedFrom: z.int().positive(),
  coverage: z.string(),
  serverTime: z.iso.datetime({ offset: true }),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

/** GET /v1/games/:id/changes?after=&limit= */
export const ChangesPageSchema = z.object({
  changes: z.array(GameChangeSchema),
  nextAfter: z.int().nonnegative(),
  latestSeq: z.int().nonnegative(),
  hasMore: z.boolean(),
  retainedFrom: z.int().positive(),
});
export type ChangesPage = z.infer<typeof ChangesPageSchema>;
