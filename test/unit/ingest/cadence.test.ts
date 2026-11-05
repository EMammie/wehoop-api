import { describe, expect, it } from 'vitest';
import {
  budgetFor,
  cadenceFor,
  defaultProfileFor,
  PROFILE_CADENCE,
  PUSH_CONNECTION_ALLOWANCE,
  PUSH_RECONCILE_CADENCE,
  profileAllowed,
  pushAllowances,
  pushBackfillAllowance,
  pushFeedsFor,
  SIM_CADENCE,
  scaleCadence,
} from '../../../src/ingest/cadence.js';
import { ncaawbAdapter } from '../../../src/leagues/ncaawb/adapter.js';
import { wnbaAdapter } from '../../../src/leagues/wnba/adapter.js';

describe('trial profiles: budgets derived from the cadence constants (plan §4)', () => {
  it('full 364: pbp every 30 s + statistics (summary) every 5 min over 2.5 h, a 120-min complete -> closed wait on the summary alone, the closing pair and retry allowance (rev 4.12)', () => {
    expect(budgetFor(PROFILE_CADENCE.full)).toEqual({
      pbp: 301, // t=0 through 2.5 h inclusive (the G3 run made 301)
      summary: 30, // first at +15 s
      boxscore: 0,
      afterComplete: 25, // 120 min at one summary per 5 min, both ends; the pbp pauses
      closing: 2, // the feed that did not report closed, then the boxscore
      retries: 6,
      total: 364,
    });
  });
  it('extended 184: summary every 60 s + one boxscore at +120 min, the complete -> closed wait, closing and retry allowance', () => {
    expect(budgetFor(PROFILE_CADENCE.extended)).toEqual({
      pbp: 0,
      summary: 151,
      boxscore: 1,
      afterComplete: 25,
      closing: 1, // the summary or the boxscore reported closed; the other one
      retries: 6,
      total: 184,
    });
  });
  it('lean-full 187: pbp every 60 s + statistics every 10 min, the complete -> closed wait, closing and retry allowance', () => {
    expect(budgetFor(PROFILE_CADENCE['lean-full'])).toEqual({
      pbp: 151,
      summary: 15, // first at +30 s
      boxscore: 0,
      afterComplete: 13, // the summary stays at 10 min
      closing: 2,
      retries: 6,
      total: 187,
    });
  });
  it('the slow phases poll one feed each: the pbp before play, the summary after complete', () => {
    expect(PROFILE_CADENCE.full).toMatchObject({
      preGameMs: 300_000,
      preGameFeeds: ['pbp'],
      afterCompleteFeeds: ['summary'],
      closing: ['pbp', 'summary', 'boxscore'],
    });
    expect(PROFILE_CADENCE.extended).toMatchObject({
      preGameFeeds: ['summary'],
      afterCompleteFeeds: ['summary'],
      closing: ['summary', 'boxscore'],
    });
  });
  it('push reconciliation (M4) follows the same slow phases and closing set as a pbp profile (rev 4.12)', () => {
    expect(PUSH_RECONCILE_CADENCE).toMatchObject({
      preGameMs: 300_000,
      preGameFeeds: ['pbp'],
      afterCompleteFeeds: ['summary'],
      closing: ['pbp', 'summary', 'boxscore'],
      retryAllowance: 6,
    });
    expect(budgetFor(PUSH_RECONCILE_CADENCE)).toEqual({
      pbp: 31, // every 5 min, t=0 through 2.5 h inclusive
      summary: 30, // first at +2.5 min
      boxscore: 0,
      afterComplete: 25, // 120 min at one summary per 5 min, both ends; the pbp pauses
      closing: 2, // the feed that did not report closed, then the boxscore
      retries: 6,
      total: 94,
    });
    expect(PUSH_CONNECTION_ALLOWANCE).toBe(20);
  });
  it('two full games plus one extended no longer fit the 900 spendable calls of a 1,000-call trial (12 over)', () => {
    // They fitted exactly (900) with a retry allowance of 2; the allowance of 6 (owner decision
    // 2026-11-03) adds 4 calls per reservation.
    const two = 2 * budgetFor(PROFILE_CADENCE.full).total;
    const one = budgetFor(PROFILE_CADENCE.extended).total;
    expect(two + one).toBe(912);
    expect(1000 - 100 - (two + one)).toBe(-12); // 100 = default reserve
  });
});

describe('cadenceFor (source, capabilities, coverage)', () => {
  it('simulation: full coverage polls pbp; score-only coverage polls the summary instead', () => {
    expect(
      cadenceFor({
        source: 'simulation',
        capabilities: wnbaAdapter.capabilities,
        coverage: 'full',
      }),
    ).toBe(SIM_CADENCE.full);
    expect(
      cadenceFor({
        source: 'simulation',
        capabilities: ncaawbAdapter.capabilities,
        coverage: 'extended_boxscore',
      }),
    ).toBe(SIM_CADENCE.scoreOnly);
    expect(
      cadenceFor({ source: 'fixture', capabilities: ncaawbAdapter.capabilities, coverage: null }),
    ).toBe(SIM_CADENCE.scoreOnly);
  });
  it('trial: the profile defaults from coverage, and a pbp profile is refused on a score-only game', () => {
    expect(defaultProfileFor('full')).toBe('full');
    expect(defaultProfileFor('extended_boxscore')).toBe('extended');
    expect(defaultProfileFor(null)).toBe('extended');
    expect(
      cadenceFor({ source: 'trial', capabilities: ncaawbAdapter.capabilities, coverage: 'full' }),
    ).toBe(PROFILE_CADENCE.full);
    expect(
      cadenceFor({
        source: 'trial',
        capabilities: ncaawbAdapter.capabilities,
        coverage: 'extended_boxscore',
      }),
    ).toBe(PROFILE_CADENCE.extended);
    expect(
      cadenceFor({
        source: 'production',
        capabilities: ncaawbAdapter.capabilities,
        coverage: 'full',
        profile: 'lean-full',
      }),
    ).toBe(PROFILE_CADENCE['lean-full']);
    expect(profileAllowed('extended', 'full')).toBe(true);
    expect(profileAllowed('full', 'extended_boxscore')).toBe(false);
    expect(() =>
      cadenceFor({
        source: 'trial',
        capabilities: ncaawbAdapter.capabilities,
        coverage: 'extended_boxscore',
        profile: 'full',
      }),
    ).toThrow(/carries none/);
  });
  it('scaleCadence compresses intervals and horizon for a rehearsal without changing the budget', () => {
    const scaled = scaleCadence(PROFILE_CADENCE.full, 30);
    expect(scaled).toMatchObject({
      pbpMs: 1000,
      summaryMs: 10_000,
      horizonMs: 300_000,
      preGameMs: 10_000,
      preGameFeeds: ['pbp'],
      afterCompleteFeeds: ['summary'],
    });
    expect(budgetFor(scaled)).toEqual(budgetFor(PROFILE_CADENCE.full));
    expect(scaleCadence(PROFILE_CADENCE.extended, 60).boxscoreAtMs).toEqual([120_000]);
    expect(() => scaleCadence(PROFILE_CADENCE.full, 0)).toThrow();
  });
});

describe('push backfill allowance (owner decision 2026-11-05): one backfill pbp per possible events reconnect', () => {
  it('is the shared connection allowance minus the streams the watch opens (each first connection is no reconnect)', () => {
    expect(pushFeedsFor({ pushClock: true })).toEqual(['push_events', 'push_clock']);
    expect(pushFeedsFor({ pushClock: false })).toEqual(['push_events']);
    expect(pushBackfillAllowance(2)).toBe(PUSH_CONNECTION_ALLOWANCE - 2);
    expect(pushBackfillAllowance(2)).toBe(18);
    expect(pushBackfillAllowance(1)).toBe(19);
    expect(pushAllowances(wnbaAdapter.capabilities)).toEqual({ connections: 20, backfills: 18 });
    expect(pushAllowances({ pushClock: false })).toEqual({ connections: 20, backfills: 19 });
    for (const bad of [0, -1, 1.5, PUSH_CONNECTION_ALLOWANCE + 1])
      expect(() => pushBackfillAllowance(bad)).toThrow(/streams/);
  });
});
