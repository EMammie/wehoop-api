import { readRecording } from '../ingest/recording.js';
import type { LeagueCode } from '../leagues/codes.js';
import { isGameFeed, type ReferenceFeed } from '../providers/sportradar/urls.js';

/**
 * When the seed's reference documents are observed. Game-level fields follow the
 * newest `observedAt` (plan §4 rule 3), and the replay files carry their own
 * timeline (`requestedAt`: 2025-01 for the hand-assembled Unrivaled game, the
 * recording dates for the simulations), so a schedule entry observed "now" would
 * outrank every replay document and leave a replayed game closed at 0–0. The
 * epoch is older than every replay line (asserted by the unit test), so the
 * replays' game state wins and a reseed with the same epoch changes nothing.
 */
export const SEED_EPOCH = new Date('2024-01-01T00:00:00Z');

/** What `pnpm seed:dev` (src/bin/seed-dev.ts, M5 B2) loads into the dev stack, in order. */
export type SeedStep =
  | { kind: 'reference'; feed: ReferenceFeed; file: string }
  | { kind: 'replay'; file: string };

/**
 * What to load, in order. Within a league: teams (hierarchy) before schedules,
 * schedules before standings and stats, profiles after the rosters they reference,
 * replays last. WNBA before Unrivaled, because the Unrivaled Boston profile
 * references the WNBA ids her WNBA profile owns (plan §4 "Identity"). Documents a
 * replay file already carries are not listed twice.
 */
export const SEED_MANIFEST: Record<LeagueCode, SeedStep[]> = {
  wnba: [
    { kind: 'reference', feed: 'hierarchy', file: 'docs-hierarchy.json' },
    { kind: 'reference', feed: 'schedule', file: 'docs-schedule-2022-PST.json' },
    { kind: 'reference', feed: 'standings', file: 'docs-standings-2022-REG.json' },
    { kind: 'reference', feed: 'seasonal_stats', file: 'docs-seasonal-stats-6f017f37.json' },
    { kind: 'replay', file: 'docs-identity-replay.jsonl' }, // Boston profile + hierarchy
    { kind: 'replay', file: 'sim-93ee7c68-replay.compact.jsonl.gz' }, // Aces at Liberty, CC final
  ],
  ncaawb: [
    { kind: 'reference', feed: 'hierarchy', file: 'docs-hierarchy.json' },
    { kind: 'reference', feed: 'schedule', file: 'docs-schedule-2022-REG.json' },
    { kind: 'reference', feed: 'daily_schedule', file: 'docs-daily-schedule-2022-11-07.json' },
    { kind: 'reference', feed: 'tournament_list', file: 'docs-tournament-list-2022-PST.json' },
    {
      kind: 'reference',
      feed: 'tournament_schedule',
      file: 'docs-tournament-schedule-c4903014.json',
    },
    { kind: 'reference', feed: 'standings', file: 'docs-standings-2023-REG.json' },
    { kind: 'reference', feed: 'seasonal_stats', file: 'docs-seasonal-stats-6e0c5edc.json' },
    { kind: 'reference', feed: 'player_profile', file: 'docs-player-profile-stuelke.json' },
    { kind: 'replay', file: 'sim-d9b71fe0-replay.compact.jsonl.gz' }, // Northwestern at Michigan State, full
    { kind: 'replay', file: 'sim-d9b71fe0-replay.extended.jsonl.gz' }, // the same game relabelled extended_boxscore
  ],
  unrivaled: [
    { kind: 'reference', feed: 'hierarchy', file: 'docs-hierarchy.json' },
    { kind: 'reference', feed: 'schedule', file: 'docs-schedule-2025-REG.json' },
    { kind: 'reference', feed: 'standings', file: 'docs-standings-2025-REG.json' },
    { kind: 'reference', feed: 'seasonal_stats', file: 'docs-seasonal-stats-67c22115.json' },
    { kind: 'replay', file: 'docs-oot-replay.jsonl' }, // tournament list + 1-on-1 schedule
    { kind: 'replay', file: 'docs-838316ea-replay.jsonl' }, // hierarchy, schedule, Collier profile, Elam game
    { kind: 'replay', file: 'identity-replay.jsonl.gz' }, // 2026 REG league leaders + Boston profile
  ],
};

export const FIXTURES = new URL('../../fixtures/', import.meta.url);
export const fixturePath = (league: LeagueCode, file: string) =>
  new URL(`${league}/${file}`, FIXTURES).pathname;

/** The provider game id of the first game document in a replay file, or null when it carries none. */
export async function replayGameId(path: string): Promise<string | null> {
  for await (const line of readRecording(path)) {
    if (!isGameFeed(line.feed)) continue;
    const body = line.body as { id?: unknown };
    return typeof body.id === 'string' ? body.id : null;
  }
  return null;
}
