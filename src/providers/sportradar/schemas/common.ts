import { z } from 'zod';

/**
 * Shared Sportradar basketball v8 shapes. Top-level documents are `.loose()`
 * (Sportradar adds fields freely); the fields we persist are typed strictly.
 */
export const IsoDateTime = z.iso.datetime({ offset: true });
/** `YYYY-MM-DD` dates (birthdate, tournament start/end). */
export const IsoDate = z.iso.date();

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

export const LeagueRefSchema = z
  .object({ id: z.string(), name: z.string().optional(), alias: z.string().optional() })
  .loose();

/** `season` header of a game document and of list documents (schedule, standings, tournaments). */
export const SeasonRefSchema = z
  .object({
    id: z.string(),
    year: z.int(),
    type: z.string(),
    name: z.string().optional(),
  })
  .loose();
export type SeasonRef = z.infer<typeof SeasonRefSchema>;

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

export const TeamColorSchema = z
  .object({
    type: z.string().optional(),
    hex_color: z.string().optional(),
    rgb_color: z.object({ red: z.int(), green: z.int(), blue: z.int() }).loose().optional(),
  })
  .loose();

/** `type` is "quarter" / "overtime" / "elam" in pbp and boxscore scoring, "REG" / "OT" / "ELAM" in statistics periods. */
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
  /**
   * Unrivaled-only clock fields (plan §9: names uncertain until a real fixture
   * fixes them; the public docs sample carries them on events, so both the
   * header and the newest event are read). Stored in games.clock_extra.
   */
  clock_type: z.string().optional(),
  clock_directional: z.string().optional(),
  /**
   * Elam target score. The public Unrivaled docs describe "score + target score
   * fields (when available)" without a sample; the plan names the column
   * `elam_target_score` and §9 says the normalizer accepts both spellings.
   */
  elam_target_score: z.int().optional(),
  target_score: z.int().optional(),
  quarter: z.int().optional(),
  possession_arrow: z.string().optional(),
  track_on_court: z.boolean().optional(),
  conference_game: z.boolean().optional(),
  neutral_site: z.boolean().optional(),
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
  /** NCAAWB AP rank, tournament seed. */
  rank: z.int().optional(),
  seed: z.int().optional(),
  sr_id: z.string().optional(),
  reference: z.string().optional(),
  scoring: z.array(ScoringPeriodSchema).optional(),
};

/**
 * Season totals as carried by player profiles, seasonal statistics and league
 * leaders (`total`). Typed on the columns player_season_stats persists; the
 * rest is kept loose and lands in `extra`.
 */
export const SeasonTotalsSchema = z
  .object({
    games_played: z.int().optional(),
    games_started: z.int().optional(),
    minutes: z.number().optional(),
    points: z.int().optional(),
    rebounds: z.int().optional(),
    offensive_rebounds: z.int().optional(),
    defensive_rebounds: z.int().optional(),
    assists: z.int().optional(),
    steals: z.int().optional(),
    blocks: z.int().optional(),
    turnovers: z.int().optional(),
    personal_fouls: z.int().optional(),
    field_goals_made: z.int().optional(),
    field_goals_att: z.int().optional(),
    three_points_made: z.int().optional(),
    three_points_att: z.int().optional(),
    free_throws_made: z.int().optional(),
    free_throws_att: z.int().optional(),
    plus: z.number().optional(),
    minus: z.number().optional(),
  })
  .loose();
export type SeasonTotals = z.infer<typeof SeasonTotalsSchema>;

/** Per-game averages (`average`): stored as provided in player_season_stats.averages. */
export const SeasonAveragesSchema = z.record(z.string(), z.unknown());
