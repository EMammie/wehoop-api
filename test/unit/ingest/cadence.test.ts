import { describe, expect, it } from 'vitest';
import {
  budgetFor,
  cadenceFor,
  defaultProfileFor,
  PROFILE_CADENCE,
  profileAllowed,
  SIM_CADENCE,
  scaleCadence,
} from '../../../src/ingest/cadence.js';
import { ncaawbAdapter } from '../../../src/leagues/ncaawb/adapter.js';
import { wnbaAdapter } from '../../../src/leagues/wnba/adapter.js';

describe('trial profiles: budgets derived from the cadence constants (plan §4)', () => {
  it('full ≈ 330: pbp every 30 s + boxscore every 5 min over 2.5 h, plus the closing pair', () => {
    expect(budgetFor(PROFILE_CADENCE.full)).toEqual({
      pbp: 300,
      summary: 0,
      boxscore: 30,
      closing: 2,
      total: 332,
    });
  });
  it('extended ≈ 150: summary every 60 s + one boxscore at +120 min, plus closing', () => {
    expect(budgetFor(PROFILE_CADENCE.extended)).toEqual({
      pbp: 0,
      summary: 150,
      boxscore: 1,
      closing: 2,
      total: 153,
    });
  });
  it('lean-full ≈ 165: pbp every 60 s + boxscore every 10 min, plus closing', () => {
    expect(budgetFor(PROFILE_CADENCE['lean-full'])).toEqual({
      pbp: 150,
      summary: 0,
      boxscore: 15,
      closing: 2,
      total: 167,
    });
  });
  it('two full games plus one extended fit a 1,000-call trial with discovery to spare', () => {
    const two = 2 * budgetFor(PROFILE_CADENCE.full).total;
    const one = budgetFor(PROFILE_CADENCE.extended).total;
    expect(two + one).toBe(817);
    expect(1000 - 100 - (two + one)).toBeGreaterThan(0); // 100 = default reserve
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
    expect(scaled).toMatchObject({ pbpMs: 1000, boxscoreMs: 10_000, horizonMs: 300_000 });
    expect(budgetFor(scaled)).toEqual(budgetFor(PROFILE_CADENCE.full));
    expect(scaleCadence(PROFILE_CADENCE.extended, 60).boxscoreAtMs).toEqual([120_000]);
    expect(() => scaleCadence(PROFILE_CADENCE.full, 0)).toThrow();
  });
});
