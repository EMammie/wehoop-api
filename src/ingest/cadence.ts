import type { LeagueCapabilities } from '../leagues/adapter.js';
import type { GameFeed } from '../providers/sportradar/urls.js';
import type { RunSource } from './runs.js';

/**
 * How often a watcher polls each game feed (plan §4 "Production/simulation
 * scheduler", "Trial mode"). A cadence is the unit the call budget is derived
 * from: `budgetFor` counts the calls a cadence makes over its horizon, so the
 * profile totals (364 / 184 / 187 since the retry allowance became 6) are computed, never typed.
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
  /**
   * Fetched once the game closes, except the feed whose document reported `closed`
   * (rev 4.12 (2): it was just fetched). A profile lists every feed it polls here, so the
   * closing set is the other feeds plus the boxscore.
   */
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
  /**
   * The feeds polled while waiting for `closed`; the others pause on their grids (rev 4.12 (2):
   * on NCAAWB the summary reported `closed` 75 s before the pbp; the pbp's corrections land
   * with the closing pbp). Default: every periodic feed.
   */
  afterCompleteFeeds?: GameFeed[];
  /**
   * While the stored status is pre-game (`scheduled`, `created`, `time_tbd`, `if_necessary`),
   * only `preGameFeeds` poll, at most this often, until a document reports play (rev 4.12 (1):
   * an NCAAWB tip 27 min late cost 59 calls at the live cadence). Null = no change.
   */
  preGameMs?: number | null;
  /** The feeds polled before play starts (default: every periodic feed). */
  preGameFeeds?: GameFeed[];
  /** Budgeted complete -> closed wait, polled at the `afterCompleteMs` cadence. Default 0. */
  closeWaitMs?: number;
  /**
   * Budgeted retries, each a counted call: cadence HTTP 429s (one retry each) and closing-set
   * failures (up to two retries per closing feed). Default 0.
   */
  retryAllowance?: number;
}

export const TRIAL_PROFILES = ['full', 'extended', 'lean-full'] as const;
export type TrialProfile = (typeof TRIAL_PROFILES)[number];

const MIN = 60_000;
const GAME_HORIZON_MS = 150 * MIN;
const CLOSING: GameFeed[] = ['summary', 'boxscore'];
/** Closing set of a pbp profile: the feed that did not report `closed`, then the boxscore (rev 4.12). */
const PBP_CLOSING: GameFeed[] = ['pbp', 'summary', 'boxscore'];
/**
 * Trial/production pacing after `complete`: the summary alone every 5 min, the budgeted wait for
 * `closed` (rev 4.12: 120 min, Sportradar's NCAAWB figure; the first NCAAWB game waited 71 min,
 * the 30 min of rev 4.9 covered the WNBA's 13 and 25), and retries (rev 4.9: 2 for 429s; owner
 * decision 2026-11-03: 6, since closing fetches retry any failure twice per feed, so a two-feed
 * closing set alone can spend 4).
 */
const AFTER_COMPLETE = {
  afterCompleteMs: 5 * MIN,
  afterCompleteFeeds: ['summary'] as GameFeed[],
  closeWaitMs: 120 * MIN,
  retryAllowance: 6,
};
/** Before play starts, one feed every 5 min (rev 4.12 (1)). */
const PRE_GAME_MS = 5 * MIN;

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
    closing: PBP_CLOSING,
    summaryOffsetMs: 15_000,
    preGameMs: PRE_GAME_MS,
    preGameFeeds: ['pbp'],
    ...AFTER_COMPLETE,
  },
  extended: {
    pbpMs: null,
    summaryMs: 60_000,
    boxscoreMs: null,
    boxscoreAtMs: [120 * MIN],
    horizonMs: GAME_HORIZON_MS,
    closing: CLOSING,
    preGameMs: PRE_GAME_MS,
    preGameFeeds: ['summary'],
    ...AFTER_COMPLETE,
  },
  'lean-full': {
    pbpMs: 60_000,
    summaryMs: 10 * MIN,
    boxscoreMs: null,
    boxscoreAtMs: [],
    horizonMs: GAME_HORIZON_MS,
    closing: PBP_CLOSING,
    summaryOffsetMs: 30_000,
    preGameMs: PRE_GAME_MS,
    preGameFeeds: ['pbp'],
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

export interface Budget {
  pbp: number;
  summary: number;
  boxscore: number;
  /** Polls while waiting for `closed` after `complete` (rev 4.9). */
  afterComplete: number;
  closing: number;
  /** Budgeted retries: cadence 429s and closing-set failures (`retryAllowance`). */
  retries: number;
  total: number;
}

/**
 * Calls a cadence makes: every periodic feed from its first poll (t=0, the summary at its
 * offset) through the horizon inclusive, one-offs, the complete -> closed wait at the slower
 * cadence (only the `afterCompleteFeeds`), the closing set and the retry allowance. Rev 4.9: the
 * horizon end is inclusive (the G3 run made 301 pbp calls in 2.5 h at 30 s, the old formula
 * counted 300); rev 4.12 counts the wait's end the same way (a summary polled at the horizon's
 * end and 120 min later is 25 polls). The horizon is counted at the live cadence, so the slower pre-game polling of
 * rev 4.12 (1) only spends less. The closing set loses the feed that reported `closed` when
 * every polled feed is in it (rev 4.12 (2)).
 */
export function budgetFor(c: Cadence): Budget {
  const periodic = (ms: number | null, offsetMs = 0) =>
    ms === null ? 0 : Math.floor((c.horizonMs - offsetMs) / ms) + 1;
  const pbp = periodic(c.pbpMs);
  const summary = periodic(c.summaryMs, c.summaryOffsetMs ?? 0);
  const boxscore = periodic(c.boxscoreMs) + c.boxscoreAtMs.length;
  const wait = c.closeWaitMs ?? 0;
  const slow = (feed: GameFeed, ms: number | null) =>
    ms === null ||
    c.afterCompleteMs == null ||
    wait === 0 ||
    (c.afterCompleteFeeds !== undefined && !c.afterCompleteFeeds.includes(feed))
      ? 0
      : Math.floor(wait / Math.max(ms, c.afterCompleteMs)) + 1;
  const afterComplete =
    slow('pbp', c.pbpMs) + slow('summary', c.summaryMs) + slow('boxscore', c.boxscoreMs);
  const polled: GameFeed[] = [
    ...(c.pbpMs !== null ? (['pbp'] as const) : []),
    ...(c.summaryMs !== null ? (['summary'] as const) : []),
    ...(c.boxscoreMs !== null || c.boxscoreAtMs.length > 0 ? (['boxscore'] as const) : []),
  ];
  const reporterSkipped = polled.length > 0 && polled.every((f) => c.closing.includes(f));
  const closing = c.closing.length - (reporterSkipped ? 1 : 0);
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
}): Cadence {
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
  if (c.afterCompleteFeeds !== undefined) scaled.afterCompleteFeeds = c.afterCompleteFeeds;
  if (c.preGameMs !== undefined) scaled.preGameMs = s(c.preGameMs);
  if (c.preGameFeeds !== undefined) scaled.preGameFeeds = c.preGameFeeds;
  if (c.closeWaitMs !== undefined) scaled.closeWaitMs = Math.round(c.closeWaitMs / speed);
  if (c.retryAllowance !== undefined) scaled.retryAllowance = c.retryAllowance;
  return scaled;
}
