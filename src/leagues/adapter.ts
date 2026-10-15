import type { NormalizedDocument } from '../ingest/types.js';
import type { BoxscoreDocument } from '../providers/sportradar/schemas/boxscore.js';
import type { PbpDocument } from '../providers/sportradar/schemas/pbp.js';
import type { SummaryDocument } from '../providers/sportradar/schemas/summary.js';
import type { LeagueCode } from './codes.js';

/**
 * What a coverage level lets a watcher emit (plan §2 league quirks, §7 M3):
 * `full` games carry play-by-play; NCAAWB `extended_boxscore` / `boxscore`
 * games carry only status, score and period while live, and their stats at
 * `stats_final_at`.
 */
export interface CoverageProfile {
  /** Play events are ingested and emitted as event_* changes. */
  events: boolean;
  /** 'live': stats on every document; 'final': only once the game is complete/closed; 'none'. */
  stats: 'live' | 'final' | 'none';
}

export interface LeagueCapabilities {
  pushClock: boolean;
  pushEvents: boolean;
  pushStats: boolean;
  coverageFor(coverage: string | null): CoverageProfile;
}

/**
 * LeagueAdapter (plan §4): one shared Sportradar basketball normalizer, league
 * quirks overridden per adapter. The three game feeds are normalized here;
 * reference feeds (schedule, profiles, standings, ...) share one ingester
 * (ingest/reference.ts) because their shapes are identical across products.
 */
/** What the watcher knows about the game before the document is normalized. */
export interface NormalizeContext {
  /**
   * `games.coverage` as stored (`full`, `extended_boxscore`, `boxscore`, `unknown`), or null when
   * the game has no row yet. A document that omits `coverage` is gated by this, never by `full`.
   */
  storedCoverage: string | null;
}

export interface LeagueAdapter {
  readonly league: LeagueCode;
  readonly capabilities: LeagueCapabilities;
  /** Sportradar product (quota bucket). */
  readonly product: string;
  normalizePbp(doc: PbpDocument, ctx?: NormalizeContext): NormalizedDocument;
  normalizeSummary(doc: SummaryDocument, ctx?: NormalizeContext): NormalizedDocument;
  normalizeBoxscore(doc: BoxscoreDocument, ctx?: NormalizeContext): NormalizedDocument;
}

export const FULL_COVERAGE: CoverageProfile = { events: true, stats: 'live' };
export const SCORE_ONLY_COVERAGE: CoverageProfile = { events: false, stats: 'final' };

/**
 * Default coverage mapping: only `full` carries live plays and stats. Anything
 * else, including an unknown or absent coverage, is score-only with final
 * stats: a game whose coverage nobody has stated never emits live stats.
 */
export function defaultCoverageFor(coverage: string | null): CoverageProfile {
  return coverage === 'full' ? FULL_COVERAGE : SCORE_ONLY_COVERAGE;
}

/** The coverage a document is gated by: its own `coverage`, else the stored one, never `full` by default. */
export function effectiveCoverage(
  documentCoverage: string | null | undefined,
  ctx: NormalizeContext | undefined,
): string | null {
  return documentCoverage ?? ctx?.storedCoverage ?? null;
}

/**
 * Apply a coverage profile to a normalized game document: a score-only game
 * never emits play events (the document is then not a complete pbp either),
 * and emits stats only once the game is complete or closed.
 */
export function applyCoverage(
  nd: NormalizedDocument,
  profile: CoverageProfile,
): NormalizedDocument {
  if (profile.events && profile.stats === 'live') return nd;
  const status = nd.gameView?.status ?? null;
  const finalPhase = status === 'complete' || status === 'closed';
  const keepStats = profile.stats === 'live' || (profile.stats === 'final' && finalPhase);
  return {
    ...nd,
    isComplete: profile.events ? nd.isComplete : false,
    batch: {
      events: profile.events ? nd.batch.events : [],
      deletedEvents: profile.events ? nd.batch.deletedEvents : [],
      teamStats: keepStats ? nd.batch.teamStats : [],
      playerStats: keepStats ? nd.batch.playerStats : [],
    },
  };
}
