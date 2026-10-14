import type { NormalizedDocument } from '../../ingest/types.js';
import type { BoxscoreDocument } from '../../providers/sportradar/schemas/boxscore.js';
import type { PbpDocument } from '../../providers/sportradar/schemas/pbp.js';
import type { SummaryDocument } from '../../providers/sportradar/schemas/summary.js';
import type { LeagueAdapter } from '../adapter.js';
import type { LeagueCode } from '../codes.js';
import {
  normalizeBoxscoreDocument,
  normalizePbpDocument,
  normalizeSummaryDocument,
} from '../sportradar-basketball/normalize.js';

/**
 * WNBA: four 10-minute quarters, 5-minute overtimes, full pbp coverage, push
 * clock/events/statistics available in production. No quirks beyond the shared
 * normalizer in M1.
 */
export const wnbaAdapter: LeagueAdapter = {
  league: 'wnba',
  product: 'wnba',
  capabilities: { pushClock: true, pushEvents: true, pushStats: true },
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

export function adapterFor(league: LeagueCode): LeagueAdapter {
  if (league === 'wnba') return wnbaAdapter;
  throw new Error(`league adapter for ${league} arrives in M2`);
}
