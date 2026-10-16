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
 * Unrivaled (3-on-3, Elam Ending, weighted free throws, 1-on-1 tournament as
 * season type OOT). Every game is `full` coverage. The Elam quirks live in the
 * shared normalizer because they are keyed on the period type the provider
 * reports (`elam`), not on the league: the game-level clock is null and
 * clock_running is false during the target-score phase, the two Unrivaled-only
 * clock fields (`clock_type`, `clock_directional`) land in clock_extra, the
 * target score is read from the header under either spelling, and
 * `lineupchangeone` / `lineupchangethree` are lineup changes. OOT games are
 * attached to their tournament by the tournament schedule feed
 * (ingest/reference.ts), never by a game feed.
 */
export const unrivaledAdapter: LeagueAdapter = {
  league: 'unrivaled',
  product: 'unrivaled',
  capabilities: {
    pushClock: false,
    pushEvents: false,
    pushStats: false,
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
