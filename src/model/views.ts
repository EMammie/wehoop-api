import { z } from 'zod';
import { LeagueCodeSchema } from '../leagues/codes.js';
import { GameStatusSchema, PeriodTypeSchema } from './live-event.js';

/**
 * Rows of the PostgREST views (plan §5): what a client receives from
 * `v_schedule`, `v_boxscore`, `v_standings`, `v_player_seasons` and `v_leaders`,
 * plus the one table the app reads directly, `leagues` (M5 B2: the app's `League`
 * value is this row). Keys are the SQL column names (snake_case) because
 * PostgREST returns them as such.
 *
 * These schemas are the Zod side of two drift checks:
 * - `test/integration/views-contract.test.ts` asserts each schema's keys and base
 *   types against the view's columns on the dev stack (the SQL is the source of
 *   truth for names and types);
 * - `pnpm gen:swift --check` asserts the committed Swift against these schemas.
 * Nullability is not recorded on views by Postgres; it is written here from the
 * base tables and the joins (left joins make the joined columns nullable).
 */
export const SeasonTypeSchema = z.enum(['PRE', 'REG', 'OOT', 'PST', 'CC']);
export type SeasonType = z.infer<typeof SeasonTypeSchema>;

export const CoverageLevelSchema = z.enum(['full', 'extended_boxscore', 'boxscore', 'unknown']);
export type CoverageLevel = z.infer<typeof CoverageLevelSchema>;

const uuid = z.uuid();
const ts = z.iso.datetime({ offset: true });
const json = z.record(z.string(), z.unknown());

export const ScheduleRowSchema = z.object({
  id: uuid,
  league: LeagueCodeSchema,
  provider_game_id: z.string(),
  season_id: uuid.nullable(),
  season_year: z.int().nullable(),
  season_type: SeasonTypeSchema.nullable(),
  tournament_id: uuid.nullable(),
  tournament_name: z.string().nullable(),
  title: z.string().nullable(),
  scheduled_at: ts,
  status: GameStatusSchema,
  coverage: CoverageLevelSchema,
  /** `live plays` | `score only` | `unknown` (plan §9: NCAAWB partial coverage). */
  coverage_label: z.string(),
  home_team_id: uuid.nullable(),
  home_name: z.string().nullable(),
  home_market: z.string().nullable(),
  home_alias: z.string().nullable(),
  away_team_id: uuid.nullable(),
  away_name: z.string().nullable(),
  away_market: z.string().nullable(),
  away_alias: z.string().nullable(),
  home_points: z.int(),
  away_points: z.int(),
  current_period: z.int().nullable(),
  period_type: PeriodTypeSchema.nullable(),
  current_period_sequence: z.int().nullable(),
  elam_target_score: z.int().nullable(),
  clock: z.string().nullable(),
  clock_decimal: z.string().nullable(),
  clock_running: z.boolean().nullable(),
  clock_as_of: ts.nullable(),
  venue: json.nullable(),
  broadcasts: json.nullable(),
  last_seq: z.int(),
  retained_from_seq: z.int(),
  stats_final_at: ts.nullable(),
  observed_at: ts.nullable(),
  updated_at: ts,
});
export type ScheduleRow = z.infer<typeof ScheduleRowSchema>;

export const BoxscoreRowSchema = z.object({
  game_id: uuid,
  team_id: uuid,
  provider_team_id: z.string(),
  /** Null only when the game has no home team yet. */
  is_home: z.boolean().nullable(),
  team_name: z.string(),
  team_market: z.string().nullable(),
  team_alias: z.string().nullable(),
  player_id: uuid,
  provider_player_id: z.string(),
  /** The provider line's own name. */
  full_name: z.string(),
  /** The canonical (possibly merged) player's name. */
  canonical_full_name: z.string(),
  jersey: z.string().nullable(),
  position: z.string().nullable(),
  starter: z.boolean().nullable(),
  played: z.boolean().nullable(),
  on_court: z.boolean().nullable(),
  not_playing_reason: z.string().nullable(),
  minutes: z.string().nullable(),
  points: z.int().nullable(),
  fgm: z.int().nullable(),
  fga: z.int().nullable(),
  tpm: z.int().nullable(),
  tpa: z.int().nullable(),
  ftm: z.int().nullable(),
  fta: z.int().nullable(),
  off_rebounds: z.int().nullable(),
  def_rebounds: z.int().nullable(),
  rebounds: z.int().nullable(),
  assists: z.int().nullable(),
  steals: z.int().nullable(),
  blocks: z.int().nullable(),
  turnovers: z.int().nullable(),
  personal_fouls: z.int().nullable(),
  plus_minus: z.int().nullable(),
  efficiency: z.int().nullable(),
  extra: json.nullable(),
  observed_at: ts.nullable(),
  updated_at: ts,
});
export type BoxscoreRow = z.infer<typeof BoxscoreRowSchema>;

export const StandingsRowSchema = z.object({
  season_id: uuid,
  league: LeagueCodeSchema,
  season_year: z.int(),
  season_type: SeasonTypeSchema,
  team_id: uuid,
  provider_team_id: z.string(),
  team_name: z.string(),
  team_market: z.string().nullable(),
  team_alias: z.string().nullable(),
  conference: z.string().nullable(),
  division: z.string().nullable(),
  wins: z.int().nullable(),
  losses: z.int().nullable(),
  win_pct: z.number().nullable(),
  games_behind: z.number().nullable(),
  conf_wins: z.int().nullable(),
  conf_losses: z.int().nullable(),
  points_for: z.number().nullable(),
  points_against: z.number().nullable(),
  streak: z.string().nullable(),
  rank: z.int().nullable(),
  records: json.nullable(),
  extra: json.nullable(),
  as_of: ts.nullable(),
  updated_at: ts,
});
export type StandingsRow = z.infer<typeof StandingsRowSchema>;

export const PlayerSeasonRowSchema = z.object({
  player_id: uuid,
  full_name: z.string(),
  season_id: uuid,
  league: LeagueCodeSchema,
  season_year: z.int(),
  season_type: SeasonTypeSchema,
  team_id: uuid,
  provider_team_id: z.string(),
  team_name: z.string(),
  team_market: z.string().nullable(),
  team_alias: z.string().nullable(),
  games_played: z.int().nullable(),
  games_started: z.int().nullable(),
  minutes: z.number().nullable(),
  points: z.int().nullable(),
  rebounds: z.int().nullable(),
  off_rebounds: z.int().nullable(),
  def_rebounds: z.int().nullable(),
  assists: z.int().nullable(),
  steals: z.int().nullable(),
  blocks: z.int().nullable(),
  turnovers: z.int().nullable(),
  personal_fouls: z.int().nullable(),
  fgm: z.int().nullable(),
  fga: z.int().nullable(),
  tpm: z.int().nullable(),
  tpa: z.int().nullable(),
  ftm: z.int().nullable(),
  fta: z.int().nullable(),
  plus_minus: z.int().nullable(),
  averages: json.nullable(),
  extra: json.nullable(),
  updated_at: ts,
});
export type PlayerSeasonRow = z.infer<typeof PlayerSeasonRowSchema>;

/** View name → row schema, in the order the views were created. */
/** v_leaders (0012, M5 B2): one row per season line and category; `value` from the typed totals. */
export const LeaderCategorySchema = z.enum([
  'points',
  'rebounds',
  'assists',
  'steals',
  'blocks',
  'minutes',
  'turnovers',
  'fg_pct',
  'three_pct',
  'ft_pct',
]);
export type LeaderCategory = z.infer<typeof LeaderCategorySchema>;

export const LeadersRowSchema = z.object({
  league: LeagueCodeSchema,
  season_id: uuid,
  season_year: z.int(),
  season_type: SeasonTypeSchema,
  category: LeaderCategorySchema,
  value: z.number(),
  rank: z.int(),
  player_id: uuid,
  full_name: z.string(),
  team_id: uuid,
  provider_team_id: z.string(),
  team_name: z.string(),
  team_market: z.string().nullable(),
  team_alias: z.string().nullable(),
  games_played: z.int(),
});
export type LeadersRow = z.infer<typeof LeadersRowSchema>;

/** public.leagues (0001 + 0012): the app lists leagues from these rows and never names one. */
export const LeagueRowSchema = z.object({
  code: LeagueCodeSchema,
  name: z.string(),
  provider_alias: z.string(),
  created_at: ts,
  updated_at: ts,
  short_name: z.string(),
  colors: json.nullable(),
});
export type LeagueRow = z.infer<typeof LeagueRowSchema>;

export const VIEW_ROW_SCHEMAS = {
  v_schedule: ScheduleRowSchema,
  v_boxscore: BoxscoreRowSchema,
  v_standings: StandingsRowSchema,
  v_player_seasons: PlayerSeasonRowSchema,
  v_leaders: LeadersRowSchema,
} as const;

/** Tables the client reads directly (same drift checks as the views). */
export const TABLE_ROW_SCHEMAS = {
  leagues: LeagueRowSchema,
} as const;
