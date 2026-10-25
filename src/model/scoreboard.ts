import { z } from 'zod';
import { LeagueCodeSchema } from '../leagues/codes.js';
import { GameStatusSchema, PeriodRefSchema, ScoreSchema } from './live-event.js';

/**
 * `league:{code}:scores` (plan §5): 5 s-coalesced scoreboard deltas for the
 * games whose `games` row changed, sent straight through the transport (never
 * the outbox). Best effort: loss is harmless, list screens re-fetch
 * `v_schedule` on reconnect and the next tick supersedes.
 */
export const ScoreboardDeltaSchema = z.object({
  gameId: z.uuid(),
  score: ScoreSchema,
  status: GameStatusSchema,
  period: PeriodRefSchema.nullable(),
  clock: z.string().nullable(),
  /** `games.last_seq`: a game screen compares it with its own seq to decide whether to catch up. */
  latestSeq: z.int().nonnegative(),
  observedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type ScoreboardDelta = z.infer<typeof ScoreboardDeltaSchema>;

export const ScoreboardSchema = z.object({
  v: z.literal(1),
  type: z.literal('scores'),
  league: LeagueCodeSchema,
  deltas: z.array(ScoreboardDeltaSchema).min(1),
  sentAt: z.iso.datetime({ offset: true }),
});
export type Scoreboard = z.infer<typeof ScoreboardSchema>;

export function leagueScoresChannel(league: string): string {
  return `league:${league}:scores`;
}
