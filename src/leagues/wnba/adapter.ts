import type { NormalizedDocument } from '../../ingest/types.js';
import type { BoxscoreDocument } from '../../providers/sportradar/schemas/boxscore.js';
import type { PbpDocument } from '../../providers/sportradar/schemas/pbp.js';
import type { SummaryDocument } from '../../providers/sportradar/schemas/summary.js';
import { FULL_COVERAGE, type LeagueAdapter } from '../adapter.js';
import {
  normalizeBoxscoreDocument,
  normalizePbpDocument,
  normalizeSummaryDocument,
} from '../sportradar-basketball/normalize.js';

/**
 * WNBA: four 10-minute quarters, 5-minute overtimes, push clock/events/
 * statistics available in production. Every WNBA game is `full` coverage, so
 * the normalizers do not gate on `coverage` and `coverageFor` states exactly
 * that: full, whatever the document says. No quirks beyond the shared
 * normalizer.
 */
export const wnbaAdapter: LeagueAdapter = {
  league: 'wnba',
  product: 'wnba',
  capabilities: {
    pushClock: true,
    pushEvents: true,
    pushStats: true,
    coverageFor: () => FULL_COVERAGE,
  },
  normalizePbp(doc: PbpDocument): NormalizedDocument {
    return normalizePbpDocument(doc);
  },
  normalizeSummary(doc: SummaryDocument): NormalizedDocument {
    return normalizeSummaryDocument(doc);
  },
  normalizeBoxscore(doc: BoxscoreDocument): NormalizedDocument {
    return normalizeBoxscoreDocument(doc);
  },
};
