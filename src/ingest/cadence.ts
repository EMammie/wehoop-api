import type { LeagueCapabilities } from '../leagues/adapter.js';
import type { GameFeed } from '../providers/sportradar/urls.js';
import type { RunSource } from './runs.js';

/**
 * How often a watcher polls each game feed (plan §4 "Production/simulation
 * scheduler", "Trial mode"). A cadence is the unit the call budget is derived
 * from: `budgetFor` counts the calls a cadence makes over its horizon, so the
 * profile totals in the plan (347 / 162 / 179 since rev 4.9) are computed, never typed.
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
  /**
   * First summary poll at this offset from the watch start (rev 4.9 (2)): half the pbp
   * interval, so the two feeds never leave 2 s apart. Both live runs drew a 429 on the
   * watch's first pbp -> summary pair at the minimum spacing. Default 0.
   */
  summaryOffsetMs?: number;
  /**
   * While the stored status is `complete` (game over, statistics not yet validated) every
   * periodic feed polls at most this often until `closed` (rev 4.9 (3)): no play happens any
   * more, and `closed` can trail `complete` by 13 min (WNBA G3) to about 2 h (NCAAWB docs).
   * Null = no change.
   */
  afterCompleteMs?: number | null;
  /** Budgeted complete -> closed wait, polled at the `afterCompleteMs` cadence. Default 0. */
  closeWaitMs?: number;
  /** Budgeted HTTP 429 retries (each is a counted call). Default 0. */
  retryAllowance?: number;
}

export const TRIAL_PROFILES = ['full', 'extended', 'lean-full'] as const;
export type TrialProfile = (typeof TRIAL_PROFILES)[number];

const MIN = 60_000;
const GAME_HORIZON_MS = 150 * MIN;
const CLOSING: GameFeed[] = ['summary', 'boxscore'];
/** Trial/production pacing after `complete`, the budgeted wait for `closed`, and 429 retries (rev 4.9). */
const AFTER_COMPLETE = { afterCompleteMs: 5 * MIN, closeWaitMs: 30 * MIN, retryAllowance: 2 };

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
    summaryOffsetMs: 15_000,
    ...AFTER_COMPLETE,
  },
  extended: {
    pbpMs: null,
    summaryMs: 60_000,
    boxscoreMs: null,
    boxscoreAtMs: [120 * MIN],
    horizonMs: GAME_HORIZON_MS,
    closing: CLOSING,
    ...AFTER_COMPLETE,
  },
  'lean-full': {
    pbpMs: 60_000,
    summaryMs: 10 * MIN,
    boxscoreMs: null,
    boxscoreAtMs: [],
    horizonMs: GAME_HORIZON_MS,
    closing: CLOSING,
    summaryOffsetMs: 30_000,
    ...AFTER_COMPLETE,
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

/**
 * Push mode (plan §4 "prod push = events + statistics (+ clock WNBA) + REST
 * pbp/5 min reconciliation"): the stream carries every event (and the WNBA
 * clock); REST reconciles the full pbp every 5 minutes and fetches the
 * statistics (summary) every 5 minutes, plus the closing pair. Push statistics
 * are not consumed yet (no recorded sample pins their shape), so statistics
 * stay on the summary feed. The budget is REST only; each stream connection is
 * a counted call on top of it, allowed for by PUSH_CONNECTION_ALLOWANCE.
 */
export const PUSH_RECONCILE_CADENCE: Cadence = {
  pbpMs: 5 * MIN,
  summaryMs: 5 * MIN,
  boxscoreMs: null,
  boxscoreAtMs: [],
  horizonMs: GAME_HORIZON_MS,
  closing: CLOSING,
  // Rev 4.9: the reconciliation pbp and summary share a 5-min grid, so the summary sits half
  // an interval off it; the after-complete pace (5 min) equals the reconciliation pace, so
  // only the budgeted complete -> closed wait and the 429 allowance change the total.
  summaryOffsetMs: 150_000,
  ...AFTER_COMPLETE,
};

/** Stream connection attempts (events + clock, incl. reconnects) reserved on top of the REST budget. */
export const PUSH_CONNECTION_ALLOWANCE = 20;

/** The push cadence for a game, or why it cannot be pushed (no push capability, no play-by-play coverage). */
export function pushCadenceFor(capabilities: LeagueCapabilities, coverage: string | null): Cadence {
  if (!capabilities.pushEvents) throw new Error('this league has no push events feed');
  if (!coverageIsFull(coverage)) {
    throw new Error(
      `push mode needs full coverage (play-by-play); coverage ${coverage ?? 'unknown'} carries none`,
    );
  }
  return PUSH_RECONCILE_CADENCE;
}

export interface Budget {
  pbp: number;
  summary: number;
  boxscore: number;
  /** Polls while waiting for `closed` after `complete` (rev 4.9). */
  afterComplete: number;
  closing: number;
  /** Budgeted 429 retries (rev 4.9). */
  retries: number;
  total: number;
}

/**
 * Calls a cadence makes: every periodic feed from its first poll (t=0, the summary at its
 * offset) through the horizon inclusive, one-offs, the complete -> closed wait at the slower
 * cadence, the closing pair and the 429 allowance. Rev 4.9: the horizon end is inclusive (the
 * G3 run made 301 pbp calls in 2.5 h at 30 s, the old formula counted 300).
 */
export function budgetFor(c: Cadence): Budget {
  const periodic = (ms: number | null, offsetMs = 0) =>
    ms === null ? 0 : Math.floor((c.horizonMs - offsetMs) / ms) + 1;
  const pbp = periodic(c.pbpMs);
  const summary = periodic(c.summaryMs, c.summaryOffsetMs ?? 0);
  const boxscore = periodic(c.boxscoreMs) + c.boxscoreAtMs.length;
  const wait = c.closeWaitMs ?? 0;
  const slow = (ms: number | null) =>
    ms === null || c.afterCompleteMs == null || wait === 0
      ? 0
      : Math.floor(wait / Math.max(ms, c.afterCompleteMs));
  const afterComplete = slow(c.pbpMs) + slow(c.summaryMs) + slow(c.boxscoreMs);
  const closing = c.closing.length;
  const retries = c.retryAllowance ?? 0;
  return {
    pbp,
    summary,
    boxscore,
    afterComplete,
    closing,
    retries,
    total: pbp + summary + boxscore + afterComplete + closing + retries,
  };
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
  /** Opt-in push mode (M4): REST becomes the 5-minute reconciliation. Default off. */
  push?: boolean;
}): Cadence {
  if (args.push) return pushCadenceFor(args.capabilities, args.coverage);
  const full = coverageIsFull(args.coverage);
  if (args.source === 'simulation' || args.source === 'fixture') {
    return full ? SIM_CADENCE.full : SIM_CADENCE.scoreOnly;
  }
  // trial, production, rehearsal: the profile cadences (a rehearsal is the trial path on a stand-in host).
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
  const scaled: Cadence = {
    pbpMs: s(c.pbpMs),
    summaryMs: s(c.summaryMs),
    boxscoreMs: s(c.boxscoreMs),
    boxscoreAtMs: c.boxscoreAtMs.map((ms) => Math.round(ms / speed)),
    horizonMs: Math.round(c.horizonMs / speed),
    closing: c.closing,
  };
  if (c.summaryOffsetMs !== undefined)
    scaled.summaryOffsetMs = Math.round(c.summaryOffsetMs / speed);
  if (c.afterCompleteMs !== undefined) scaled.afterCompleteMs = s(c.afterCompleteMs);
  if (c.closeWaitMs !== undefined) scaled.closeWaitMs = Math.round(c.closeWaitMs / speed);
  if (c.retryAllowance !== undefined) scaled.retryAllowance = c.retryAllowance;
  return scaled;
}
