import { z } from 'zod';

/**
 * Shared Sportradar basketball v8 shapes. Top-level documents are `.loose()`
 * (Sportradar adds fields freely); the fields we persist are typed strictly.
 */
export const IsoDateTime = z.iso.datetime({ offset: true });

export const TeamRefSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    market: z.string().optional(),
    alias: z.string().optional(),
    sr_id: z.string().optional(),
    reference: z.string().optional(),
  })
  .loose();
export type TeamRef = z.infer<typeof TeamRefSchema>;

export const PlayerRefSchema = z
  .object({
    id: z.string(),
    full_name: z.string().optional(),
    jersey_number: z.string().optional(),
    sr_id: z.string().optional(),
    reference: z.string().optional(),
  })
  .loose();
export type PlayerRef = z.infer<typeof PlayerRefSchema>;

/** Game status strings Sportradar uses; anything else is kept as a string and mapped later. */
export const ProviderGameStatusSchema = z.string();

export const SeasonRefSchema = z
  .object({
    id: z.string(),
    year: z.int(),
    type: z.string(),
    name: z.string().optional(),
  })
  .loose();

export const BroadcastSchema = z
  .object({
    type: z.string().optional(),
    locale: z.string().optional(),
    network: z.string().optional(),
    channel: z.string().optional(),
  })
  .loose();

export const VenueSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    capacity: z.int().optional(),
    address: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    zip: z.string().optional(),
    country: z.string().optional(),
  })
  .loose();

/** `type` is "quarter" / "overtime" in pbp and boxscore scoring, "REG" / "OT" in statistics periods. */
export const ScoringPeriodSchema = z
  .object({
    type: z.string(),
    number: z.int(),
    sequence: z.int(),
    points: z.int(),
  })
  .loose();

/** The game-level fields every game document (pbp, summary, boxscore) carries. */
export const GameHeaderFields = {
  id: z.string(),
  status: ProviderGameStatusSchema,
  coverage: z.string().optional(),
  scheduled: IsoDateTime,
  title: z.string().optional(),
  clock: z.string().optional(),
  clock_decimal: z.string().optional(),
  quarter: z.int().optional(),
  possession_arrow: z.string().optional(),
  track_on_court: z.boolean().optional(),
  reference: z.string().optional(),
  season: SeasonRefSchema.optional(),
  broadcasts: z.array(BroadcastSchema).optional(),
  venue: VenueSchema.optional(),
  /** Simulation replay time (ms epoch); absent on production feeds. */
  time: z.number().optional(),
};

export const GameHeaderTeamFields = {
  id: z.string(),
  name: z.string(),
  alias: z.string().optional(),
  market: z.string().optional(),
  points: z.int().optional(),
  remaining_timeouts: z.int().optional(),
  bonus: z.boolean().optional(),
  sr_id: z.string().optional(),
  reference: z.string().optional(),
  scoring: z.array(ScoringPeriodSchema).optional(),
};
