import type { NormalizedDocument } from '../../ingest/types.js';
import type { BoxscoreDocument } from '../../providers/sportradar/schemas/boxscore.js';
import type { PbpDocument } from '../../providers/sportradar/schemas/pbp.js';
import type { SummaryDocument } from '../../providers/sportradar/schemas/summary.js';
import { applyCoverage, defaultCoverageFor, type LeagueAdapter } from '../adapter.js';
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
 * The coverage of the document itself decides, so a watcher never has to know
 * the game's coverage before its first document.
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
  normalizePbp(doc: PbpDocument): NormalizedDocument {
    return applyCoverage(normalizePbpDocument(doc), defaultCoverageFor(doc.coverage ?? null));
  },
  normalizeSummary(doc: SummaryDocument): NormalizedDocument {
    return applyCoverage(normalizeSummaryDocument(doc), defaultCoverageFor(doc.coverage ?? null));
  },
  normalizeBoxscore(doc: BoxscoreDocument): NormalizedDocument {
    return applyCoverage(normalizeBoxscoreDocument(doc), defaultCoverageFor(doc.coverage ?? null));
  },
};
