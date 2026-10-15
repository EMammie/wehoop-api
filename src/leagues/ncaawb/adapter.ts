import type { NormalizedDocument } from '../../ingest/types.js';
import type { BoxscoreDocument } from '../../providers/sportradar/schemas/boxscore.js';
import type { PbpDocument } from '../../providers/sportradar/schemas/pbp.js';
import type { SummaryDocument } from '../../providers/sportradar/schemas/summary.js';
import {
  applyCoverage,
  defaultCoverageFor,
  effectiveCoverage,
  type LeagueAdapter,
  type NormalizeContext,
} from '../adapter.js';
import {
  normalizeBoxscoreDocument,
  normalizePbpDocument,
  normalizeSummaryDocument,
} from '../sportradar-basketball/normalize.js';

/**
 * NCAA Women's: four 10-minute quarters, 5-minute overtimes, no push feeds on
 * the trial product. Coverage varies per game (plan §2, §9): `full` games carry
 * play-by-play; `extended_boxscore` / `boxscore` games are score-only while
 * live (status, score, period) and get their stats once the game is final.
 * The document's own `coverage` decides; a document that omits it is gated by
 * the stored `games.coverage` the watcher passes in, and with neither known the
 * game is score-only (never `full` by default).
 */
export const ncaawbAdapter: LeagueAdapter = {
  league: 'ncaawb',
  product: 'ncaawb',
  capabilities: {
    pushClock: false,
    pushEvents: false,
    pushStats: false,
    coverageFor: defaultCoverageFor,
  },
  normalizePbp(doc: PbpDocument, ctx?: NormalizeContext): NormalizedDocument {
    return applyCoverage(normalizePbpDocument(doc), profile(doc.coverage, ctx));
  },
  normalizeSummary(doc: SummaryDocument, ctx?: NormalizeContext): NormalizedDocument {
    return applyCoverage(normalizeSummaryDocument(doc), profile(doc.coverage, ctx));
  },
  normalizeBoxscore(doc: BoxscoreDocument, ctx?: NormalizeContext): NormalizedDocument {
    return applyCoverage(normalizeBoxscoreDocument(doc), profile(doc.coverage, ctx));
  },
};

function profile(documentCoverage: string | null | undefined, ctx: NormalizeContext | undefined) {
  return defaultCoverageFor(effectiveCoverage(documentCoverage, ctx));
}
