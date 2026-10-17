import type { LeagueCapabilities } from '../leagues/adapter.js';
import type { GameFeed } from '../providers/sportradar/urls.js';
import type { RunSource } from './runs.js';

/**
 * How often a watcher polls each game feed (plan §4 "Production/simulation
 * scheduler", "Trial mode"). A cadence is the unit the call budget is derived
 * from: `budgetFor` counts the calls a cadence makes over its horizon, so the
 * profile totals in the plan (≈330 / ≈150 / ≈165) are computed, never typed.
 */
export interface Cadence {
  /** Poll interval per feed; null = the feed is not polled. */
  pbpMs: number | null;
  summaryMs: number | null;
  boxscoreMs: number | null;
  /** One-off boxscore fetches at these offsets from the watch start (extended: +120 min). */
  boxscoreAtMs: number[];
  /** Planning horizon (the ≈2.5 h a game takes); the loop itself stops on `closed`. */
  horizonMs: number;
  /** Fetched once the game closes: one summary and one boxscore. */
  closing: GameFeed[];
}

export const TRIAL_PROFILES = ['full', 'extended', 'lean-full'] as const;
export type TrialProfile = (typeof TRIAL_PROFILES)[number];

const MIN = 60_000;
const GAME_HORIZON_MS = 150 * MIN;
const CLOSING: GameFeed[] = ['summary', 'boxscore'];

/**
 * Plan §4: full = pbp/30 s + box-score statistics/5 min; extended = summary/60 s
 * + 1 boxscore at +120 min; lean-full = pbp/60 s + statistics/10 min.
 * In Sportradar v8 the team and player statistics live in the Game Summary
 * document; the Game Boxscore feed carries only the line score and leaders
 * (fixtures/ncaawb/sim-d9b71fe0-{summary,boxscore}-q1.json). The periodic
 * "boxscore" of the plan is therefore the summary feed; the budgets are the same.
 */
export const PROFILE_CADENCE: Record<TrialProfile, Cadence> = {
  full: {
    pbpMs: 30_000,
    summaryMs: 5 * MIN,
    boxscoreMs: null,
    boxscoreAtMs: [],
    horizonMs: GAME_HORIZON_MS,
    closing: CLOSING,
  },
  extended: {
    pbpMs: null,
    summaryMs: 60_000,
    boxscoreMs: null,
    boxscoreAtMs: [120 * MIN],
    horizonMs: GAME_HORIZON_MS,
    closing: CLOSING,
  },
  'lean-full': {
    pbpMs: 60_000,
    summaryMs: 10 * MIN,
    boxscoreMs: null,
    boxscoreAtMs: [],
    horizonMs: GAME_HORIZON_MS,
    closing: CLOSING,
  },
};

/** Simulation replay cadences (no quota): pbp every 3 s + summary every 30 s; score-only games poll the summary instead. */
export const SIM_CADENCE: { full: Cadence; scoreOnly: Cadence } = {
  full: {
    pbpMs: 3_000,
    summaryMs: 30_000,
    boxscoreMs: null,
    boxscoreAtMs: [],
    horizonMs: GAME_HORIZON_MS,
    closing: CLOSING,
  },
  scoreOnly: {
    pbpMs: null,
    summaryMs: 3_000,
    boxscoreMs: 30_000,
    boxscoreAtMs: [],
    horizonMs: GAME_HORIZON_MS,
    closing: CLOSING,
  },
};

export interface Budget {
  pbp: number;
  summary: number;
  boxscore: number;
  closing: number;
  total: number;
}

/** Calls a cadence makes over its horizon (first poll at t=0, then every interval, plus one-offs and closing). */
export function budgetFor(c: Cadence): Budget {
  const periodic = (ms: number | null) => (ms === null ? 0 : Math.ceil(c.horizonMs / ms));
  const pbp = periodic(c.pbpMs);
  const summary = periodic(c.summaryMs);
  const boxscore = periodic(c.boxscoreMs) + c.boxscoreAtMs.length;
  const closing = c.closing.length;
  return { pbp, summary, boxscore, closing, total: pbp + summary + boxscore + closing };
}

/** `full` coverage carries play-by-play; anything else is score-only (adapter.ts). */
export function coverageIsFull(coverage: string | null): boolean {
  return coverage === 'full';
}

/**
 * The profile a game's coverage defaults to, and whether an explicit profile
 * may be used on it: polling pbp on an extended_boxscore game would spend the
 * budget on documents the coverage gate empties.
 */
export function defaultProfileFor(coverage: string | null): TrialProfile {
  return coverageIsFull(coverage) ? 'full' : 'extended';
}

export function profileAllowed(profile: TrialProfile, coverage: string | null): boolean {
  return profile === 'extended' || coverageIsFull(coverage);
}

/**
 * Cadence by (source, capabilities, coverage) (plan §4). Push capabilities
 * (M4) will replace REST pbp polling with a stream plus a 5-minute
 * reconciliation; until then every source polls.
 */
export function cadenceFor(args: {
  source: RunSource;
  capabilities: LeagueCapabilities;
  coverage: string | null;
  profile?: TrialProfile;
}): Cadence {
  const full = coverageIsFull(args.coverage);
  if (args.source === 'simulation' || args.source === 'fixture') {
    return full ? SIM_CADENCE.full : SIM_CADENCE.scoreOnly;
  }
  const profile = args.profile ?? defaultProfileFor(args.coverage);
  if (!profileAllowed(profile, args.coverage)) {
    throw new Error(
      `profile ${profile} polls play-by-play, but coverage ${args.coverage ?? 'unknown'} carries none; use --profile extended`,
    );
  }
  return PROFILE_CADENCE[profile];
}

/** A cadence compressed for a rehearsal against a time-scaled fake provider (`speed` x). */
export function scaleCadence(c: Cadence, speed: number): Cadence {
  if (speed <= 0) throw new Error('speed must be > 0');
  const s = (ms: number | null) => (ms === null ? null : Math.max(1, Math.round(ms / speed)));
  return {
    pbpMs: s(c.pbpMs),
    summaryMs: s(c.summaryMs),
    boxscoreMs: s(c.boxscoreMs),
    boxscoreAtMs: c.boxscoreAtMs.map((ms) => Math.round(ms / speed)),
    horizonMs: Math.round(c.horizonMs / speed),
    closing: c.closing,
  };
}
