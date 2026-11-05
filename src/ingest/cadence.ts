import type { LeagueCapabilities } from '../leagues/adapter.js';
import type { GameFeed, PushFeed } from '../providers/sportradar/urls.js';
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
 * The budgeted complete -> closed wait (rev 4.12 (3): 120 min), exported for the scheduler: a
 * game stored as `complete` is (re)watched until at least this long after it BECAME complete
 * (`completeRewatchUntil` in scheduler.ts).
 */
export const COMPLETE_CLOSE_WAIT_MS = AFTER_COMPLETE.closeWaitMs;

/**
 * The scheduled-time floor of the same bound: a game stored as `complete` is (re)watched at least
 * until its scheduled tip-off plus the planning horizon plus the budgeted wait (150 + 120 = 270
 * min), even when the moment it became complete is unknown. A late tip-off or overtime pushes
 * the end of the wait past this, which is why the scheduler also anchors on that moment.
 */
export const COMPLETE_REWATCH_MS = GAME_HORIZON_MS + COMPLETE_CLOSE_WAIT_MS;

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

/**
 * Push mode (plan §4 "prod push = events + statistics (+ clock WNBA) + REST
 * pbp/5 min reconciliation"): the stream carries every event (and the WNBA
 * clock); REST reconciles the full pbp every 5 minutes and fetches the
 * statistics (summary) every 5 minutes, plus the closing pair. Push statistics
 * are not consumed yet (no recorded sample pins their shape), so statistics
 * stay on the summary feed. This cadence's budget (`budgetFor`) is REST only; a push watch's
 * reservation adds two allowances on top (`pushAllowances`): every stream connection attempt is a
 * counted call (PUSH_CONNECTION_ALLOWANCE), and every reconnect of the events stream may cost one
 * backfill pbp (PUSH_BACKFILL_ALLOWANCE). The rev 4.12 pre-game and after-complete rules and the
 * rev 4.13 retry allowance apply as for the polling profiles.
 *
 * Backfills: during the post-`complete` wait the pbp is paused, so no applied pbp of the
 * generation is ever newer than a reconnect (`backfillNeeded`) and every events-stream reconnect
 * (never a clock-stream one) triggers a backfill. Its calls go through the shared rate slot and
 * the quota guard, are logged in `ingest.provider_calls` and counted in the reservation's
 * `used_calls`, and the backfill allowance sizes the reservation for one pbp per possible
 * reconnect. A backfill's 429 retry (at most one) has no term of its own: it draws on the same
 * reservation as the 6-call retry allowance (which the retry report, `meta.retries`, counts for
 * the cadence loop only).
 */
export const PUSH_RECONCILE_CADENCE: Cadence = {
  pbpMs: 5 * MIN,
  summaryMs: 5 * MIN,
  boxscoreMs: null,
  boxscoreAtMs: [],
  horizonMs: GAME_HORIZON_MS,
  // Rev 4.12 (2), as for every pbp profile: the summary alone polls after `complete` and the pbp
  // pauses, so the closing set is pbp, summary, boxscore minus the feed that reported `closed`
  // (the closing pbp carries plays corrected during the wait). Two closing calls either way.
  closing: PBP_CLOSING,
  // Rev 4.9: the reconciliation pbp and summary share a 5-min grid, so the summary sits half
  // an interval off it; the after-complete pace (5 min) equals the reconciliation pace, so
  // only the budgeted complete -> closed wait and the retry allowance change the total.
  summaryOffsetMs: 150_000,
  // Rev 4.12 (1): before play, the pbp alone every 5 min (the summary pauses on its grid).
  preGameMs: PRE_GAME_MS,
  preGameFeeds: ['pbp'],
  ...AFTER_COMPLETE,
};

/** Stream connection attempts (events + clock, incl. reconnects) reserved on top of the REST budget. */
export const PUSH_CONNECTION_ALLOWANCE = 20;

/** The push streams a watch opens for a league: events, plus the clock where the league has one. */
export function pushFeedsFor(capabilities: Pick<LeagueCapabilities, 'pushClock'>): PushFeed[] {
  return ['push_events', ...(capabilities.pushClock ? (['push_clock'] as const) : [])];
}

/**
 * Backfill pbp calls a push watch reserves (owner decision 2026-11-05): the minimum that always
 * covers one per possible events-stream reconnect, PUSH_CONNECTION_ALLOWANCE - 1 = 19, whatever
 * streams the watch opens. Only an events reconnect triggers a backfill, and a stream's first
 * successful connection is not a reconnect, so at most the events stream's own attempts minus one
 * can. Those attempts are not bounded by 20 - streams: an attempt whose slot claim times out
 * before anything is sent is refunded (push-client.ts), so a clock stream whose every attempt was
 * refunded nets zero and leaves all 20 attempts, and 19 reconnects, to the events stream.
 */
export const PUSH_BACKFILL_ALLOWANCE = PUSH_CONNECTION_ALLOWANCE - 1;

/** What a push watch reserves on top of the REST budget: connection attempts and backfills. */
export function pushAllowances(): { connections: number; backfills: number } {
  return { connections: PUSH_CONNECTION_ALLOWANCE, backfills: PUSH_BACKFILL_ALLOWANCE };
}

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
  /** Budgeted retries: cadence 429s and closing-set failures (`retryAllowance`). */
  retries: number;
  /** Push watch only: stream connection attempts (PUSH_CONNECTION_ALLOWANCE). */
  connections?: number;
  /** Push watch only: backfill pbp calls, one per possible events reconnect (PUSH_BACKFILL_ALLOWANCE). */
  backfills?: number;
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
  if (c.afterCompleteFeeds !== undefined) scaled.afterCompleteFeeds = c.afterCompleteFeeds;
  if (c.preGameMs !== undefined) scaled.preGameMs = s(c.preGameMs);
  if (c.preGameFeeds !== undefined) scaled.preGameFeeds = c.preGameFeeds;
  if (c.closeWaitMs !== undefined) scaled.closeWaitMs = Math.round(c.closeWaitMs / speed);
  if (c.retryAllowance !== undefined) scaled.retryAllowance = c.retryAllowance;
  return scaled;
}
