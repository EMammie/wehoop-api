import type { z } from 'zod';
import { PlayerResponseSchema } from '../api/routes/players.js';
import { LeagueCodeSchema } from '../leagues/codes.js';
import {
  ChangeTypeSchema,
  EventDeleteBodySchema,
  GameChangeSchema,
  PeriodBodySchema,
  PlayerStatsSchema,
  StatsPlayerBodySchema,
  StatsTeamBodySchema,
  StatusBodySchema,
  TeamStatsSchema,
} from '../model/game-change.js';
import {
  GameStatusSchema,
  LiveEventSchema,
  PeriodRefSchema,
  PeriodTypeSchema,
  ScoreSchema,
  ShotLocationSchema,
} from '../model/live-event.js';
import { PulseSchema } from '../model/pulse.js';
import { ScoreboardDeltaSchema, ScoreboardSchema } from '../model/scoreboard.js';
import { ChangesPageSchema, SnapshotSchema } from '../model/snapshot.js';
import {
  BoxscoreRowSchema,
  CoverageLevelSchema,
  PlayerSeasonRowSchema,
  ScheduleRowSchema,
  SeasonTypeSchema,
  StandingsRowSchema,
} from '../model/views.js';

/**
 * The contract: every schema the iOS client decodes, in emission order
 * (plan §3, M5 B1). A schema listed here is emitted as a named Swift type and
 * referenced by name wherever another schema nests it (by object identity),
 * so `PeriodRef` is one Swift struct however many bodies carry it. Anonymous
 * nested objects become nested types of their parent.
 *
 * `file` groups the output; the Swift module is the same either way.
 */
export interface ContractEntry {
  name: string;
  schema: z.ZodType;
  file: string;
  doc: string;
}

export const CONTRACTS: readonly ContractEntry[] = [
  // Codes (closed in Zod; open in Swift through `.unknown(String)`, plan rev 4.11 (5))
  { name: 'LeagueCode', schema: LeagueCodeSchema, file: 'Codes', doc: 'leagues.code' },
  { name: 'SeasonType', schema: SeasonTypeSchema, file: 'Codes', doc: 'seasons.type' },
  { name: 'CoverageLevel', schema: CoverageLevelSchema, file: 'Codes', doc: 'games.coverage' },
  { name: 'PeriodType', schema: PeriodTypeSchema, file: 'Codes', doc: 'game_periods.type' },
  { name: 'GameStatus', schema: GameStatusSchema, file: 'Codes', doc: 'games.status' },
  { name: 'ChangeType', schema: ChangeTypeSchema, file: 'Codes', doc: 'game_changes.change_type' },

  // Live event bodies
  {
    name: 'PeriodRef',
    schema: PeriodRefSchema,
    file: 'LiveEvent',
    doc: 'A period by number, type and sequence.',
  },
  { name: 'Score', schema: ScoreSchema, file: 'LiveEvent', doc: 'Home and away points.' },
  {
    name: 'ShotLocation',
    schema: ShotLocationSchema,
    file: 'LiveEvent',
    doc: 'Court coordinates of a shot.',
  },
  {
    name: 'LiveEvent',
    schema: LiveEventSchema,
    file: 'LiveEvent',
    doc: 'A normalized play (play_events.payload; the body of event_insert / event_update). Every id is a provider id.',
  },

  // Change stream
  {
    name: 'EventDeleteBody',
    schema: EventDeleteBodySchema,
    file: 'GameChange',
    doc: 'Body of event_delete.',
  },
  {
    name: 'StatusBody',
    schema: StatusBodySchema,
    file: 'GameChange',
    doc: 'Body of status: durable status, score and period.',
  },
  {
    name: 'PeriodBody',
    schema: PeriodBodySchema,
    file: 'GameChange',
    doc: 'Body of period: the full line score so far.',
  },
  {
    name: 'TeamStats',
    schema: TeamStatsSchema,
    file: 'GameChange',
    doc: 'Team box columns; absent stats are null.',
  },
  {
    name: 'StatsTeamBody',
    schema: StatsTeamBodySchema,
    file: 'GameChange',
    doc: 'Body of stats_team, keyed on the provider team id.',
  },
  {
    name: 'PlayerStats',
    schema: PlayerStatsSchema,
    file: 'GameChange',
    doc: 'Player box columns; absent stats are null.',
  },
  {
    name: 'StatsPlayerBody',
    schema: StatsPlayerBodySchema,
    file: 'GameChange',
    doc: 'Body of stats_player, keyed on the provider player id (stable across identity merges).',
  },
  {
    name: 'GameChange',
    schema: GameChangeSchema,
    file: 'GameChange',
    doc: 'The one change schema: Broadcast messages, /changes pages and game_changes rows decode to this.',
  },

  // Transport-only messages
  {
    name: 'Pulse',
    schema: PulseSchema,
    file: 'Pulse',
    doc: 'Clock heartbeat (never stored, never numbered).',
  },
  {
    name: 'ScoreboardDelta',
    schema: ScoreboardDeltaSchema,
    file: 'Scoreboard',
    doc: 'One game in a league:{code}:scores message.',
  },
  {
    name: 'Scoreboard',
    schema: ScoreboardSchema,
    file: 'Scoreboard',
    doc: 'league:{code}:scores message.',
  },

  // REST
  { name: 'Snapshot', schema: SnapshotSchema, file: 'Snapshot', doc: 'GET /v1/games/:id/snapshot' },
  {
    name: 'ChangesPage',
    schema: ChangesPageSchema,
    file: 'Snapshot',
    doc: 'GET /v1/games/:id/changes?after=&limit=',
  },
  {
    name: 'PlayerResponse',
    schema: PlayerResponseSchema,
    file: 'Player',
    doc: 'GET /v1/players/:id',
  },

  // PostgREST view rows (snake_case keys, as PostgREST returns them)
  { name: 'ScheduleRow', schema: ScheduleRowSchema, file: 'Views', doc: 'A row of v_schedule.' },
  {
    name: 'BoxscoreRow',
    schema: BoxscoreRowSchema,
    file: 'Views',
    doc: 'A row of v_boxscore (one per game and provider player id).',
  },
  { name: 'StandingsRow', schema: StandingsRowSchema, file: 'Views', doc: 'A row of v_standings.' },
  {
    name: 'PlayerSeasonRow',
    schema: PlayerSeasonRowSchema,
    file: 'Views',
    doc: 'A row of v_player_seasons.',
  },
];
