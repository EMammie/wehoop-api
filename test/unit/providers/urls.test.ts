import { describe, expect, it } from 'vitest';
import {
  FEEDS,
  isGameFeed,
  ProdUrlResolver,
  SimulationUrlResolver,
} from '../../../src/providers/sportradar/urls.js';

describe('UrlResolver', () => {
  const prod = new ProdUrlResolver({ league: 'unrivaled', accessLevel: 'trial', apiKey: 'k' });

  it('builds every v8 feed path from the public docs and keeps the key in a header', () => {
    const root = 'https://api.sportradar.com/unrivaled/trial/v8/en';
    const u = (feed: Parameters<typeof prod.resolve>[0], params = {}) =>
      prod.resolve(feed, params).url;
    expect(u('pbp', { gameId: 'g' })).toBe(`${root}/games/g/pbp.json`);
    expect(u('summary', { gameId: 'g' })).toBe(`${root}/games/g/summary.json`);
    expect(u('boxscore', { gameId: 'g' })).toBe(`${root}/games/g/boxscore.json`);
    expect(u('schedule', { seasonYear: 2025, seasonType: 'REG' })).toBe(
      `${root}/games/2025/REG/schedule.json`,
    );
    expect(u('daily_schedule', { date: '2026-11-08' })).toBe(
      `${root}/games/2026/11/08/schedule.json`,
    );
    expect(() => prod.resolve('daily_schedule', { date: '2026-1-8' })).toThrow(/YYYY-MM-DD/);
    expect(() => prod.resolve('daily_schedule', {})).toThrow(/date/);
    expect(u('tournament_list', { seasonYear: 2025, seasonType: 'OOT' })).toBe(
      `${root}/tournaments/2025/OOT/schedule.json`,
    );
    expect(u('tournament_schedule', { tournamentId: 't' })).toBe(
      `${root}/tournaments/t/schedule.json`,
    );
    expect(u('standings', { seasonYear: 2025, seasonType: 'REG' })).toBe(
      `${root}/seasons/2025/REG/standings.json`,
    );
    expect(u('hierarchy')).toBe(`${root}/league/hierarchy.json`);
    expect(u('player_profile', { playerId: 'p' })).toBe(`${root}/players/p/profile.json`);
    expect(u('seasonal_stats', { seasonYear: 2025, seasonType: 'REG', teamId: 't' })).toBe(
      `${root}/seasons/2025/REG/teams/t/statistics.json`,
    );
    expect(u('league_leaders', { seasonYear: 2026, seasonType: 'REG' })).toBe(
      `${root}/seasons/2026/REG/leaders.json`,
    );
    expect(prod.resolve('hierarchy', {}).headers).toEqual({ 'x-api-key': 'k' });
    expect(prod.resolve('hierarchy', {}).url).not.toContain('k=');
  });

  it('refuses a feed without its parameters', () => {
    expect(() => prod.resolve('pbp', {})).toThrow(/gameId/);
    expect(() => prod.resolve('player_profile', {})).toThrow(/playerId/);
    expect(() => prod.resolve('schedule', { seasonYear: 2025 })).toThrow(/seasonType/);
  });

  it('simulation resolver replays only the game feeds', () => {
    const sim = new SimulationUrlResolver({
      playbackUrl: 'https://playback.sportradar.com',
      league: 'ncaawb',
      recordingId: 'r',
      sessionId: 's',
    });
    expect(sim.resolve('summary').url).toBe(
      'https://playback.sportradar.com/replay/ncaawb/r?feed=game&contentType=json&sessionId=s',
    );
    expect(() => sim.resolve('schedule')).toThrow(/do not replay/);
  });

  it('classifies feeds', () => {
    expect(FEEDS.filter(isGameFeed)).toEqual(['pbp', 'summary', 'boxscore']);
  });
});
