import type { NormalizedDocument } from '../ingest/types.js';
import type { BoxscoreDocument } from '../providers/sportradar/schemas/boxscore.js';
import type { PbpDocument } from '../providers/sportradar/schemas/pbp.js';
import type { SummaryDocument } from '../providers/sportradar/schemas/summary.js';
import type { LeagueCode } from './codes.js';

export interface LeagueCapabilities {
  pushClock: boolean;
  pushEvents: boolean;
  pushStats: boolean;
}

/**
 * LeagueAdapter (plan §4): one shared Sportradar basketball normalizer, league
 * quirks overridden per adapter. M1 ships the WNBA adapter and the three game
 * feeds; schedules, profiles, standings and push arrive in M2–M4.
 */
export interface LeagueAdapter {
  readonly league: LeagueCode;
  readonly capabilities: LeagueCapabilities;
  /** Sportradar product (quota bucket). */
  readonly product: string;
  normalizePbp(doc: PbpDocument): NormalizedDocument;
  normalizeSummary(doc: SummaryDocument): NormalizedDocument;
  normalizeBoxscore(doc: BoxscoreDocument): NormalizedDocument;
}
