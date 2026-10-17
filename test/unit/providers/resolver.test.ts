import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config.js';
import { createResolver, KEY_ENV_NAMES } from '../../../src/providers/sportradar/resolver.js';
import { ProdUrlResolver, SimulationUrlResolver } from '../../../src/providers/sportradar/urls.js';

const base = {
  DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  DATABASE_SESSION_URL: 'postgresql://u:p@db.example.com:5432/postgres',
};
// A key generated in-test: never from .env.
const FAKE_KEY = `unit-test-key-${Math.random().toString(36).slice(2)}`;

describe('createResolver (MODE selects production vs simulation)', () => {
  it('sim mode builds a simulation resolver and needs a session', () => {
    const config = loadConfig({ ...base, MODE: 'sim' });
    const r = createResolver(config, 'ncaawb', { recordingId: 'r', sessionId: 's' });
    expect(r).toBeInstanceOf(SimulationUrlResolver);
    expect(r.source).toBe('simulation');
    expect(() => createResolver(config, 'ncaawb')).toThrow(/session/);
  });

  it('trial mode builds production URLs at the trial access level with the league key in a header', () => {
    const config = loadConfig({ ...base, MODE: 'trial', SPORTRADAR_NCAAWB_KEY: FAKE_KEY });
    const r = createResolver(config, 'ncaawb');
    expect(r).toBeInstanceOf(ProdUrlResolver);
    expect(r.source).toBe('trial');
    const { url, headers } = r.resolve('pbp', { gameId: 'g1' });
    expect(url).toBe('https://api.sportradar.com/ncaawb/trial/v8/en/games/g1/pbp.json');
    expect(headers).toEqual({ 'x-api-key': FAKE_KEY });
    expect(url).not.toContain(FAKE_KEY);
  });

  it('production mode uses the production access level and the configured host only when default', () => {
    const config = loadConfig({
      ...base,
      MODE: 'production',
      SPORTRADAR_ACCESS_LEVEL: 'production',
      SPORTRADAR_WNBA_KEY: FAKE_KEY,
    });
    const r = createResolver(config, 'wnba');
    expect(r.source).toBe('production');
    expect(r.resolve('hierarchy', {}).url).toBe(
      'https://api.sportradar.com/wnba/production/v8/en/league/hierarchy.json',
    );
    expect(() =>
      loadConfig({
        ...base,
        MODE: 'production',
        SPORTRADAR_ACCESS_LEVEL: 'production',
        SPORTRADAR_WNBA_KEY: FAKE_KEY,
        SPORTRADAR_BASE_URL: 'http://127.0.0.1:8787',
      }),
    ).toThrow(/SPORTRADAR_BASE_URL/);
  });

  it('a missing key is reported by variable name; a configured key value never appears in errors, inspect or JSON', () => {
    const config = loadConfig({ ...base, MODE: 'trial', SPORTRADAR_WNBA_KEY: FAKE_KEY });
    expect(() => createResolver(config, 'ncaawb')).toThrow(KEY_ENV_NAMES.ncaawb);
    const r = createResolver(config, 'wnba') as ProdUrlResolver;
    let message = '';
    try {
      r.resolve('pbp', {});
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/gameId/);
    expect(message).not.toContain(FAKE_KEY);
    expect(inspect(r)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(r)).not.toContain(FAKE_KEY);
    expect(Object.keys(r)).not.toContain('apiKey');
    expect(JSON.stringify(config)).toContain(FAKE_KEY); // config holds it; resolvers and logs never print config
    expect(() => new ProdUrlResolver({ league: 'wnba', accessLevel: 'trial', apiKey: '' })).toThrow(
      /API key/,
    );
  });

  it('the rehearsal host override is honoured outside production', () => {
    const config = loadConfig({
      ...base,
      MODE: 'trial',
      SPORTRADAR_NCAAWB_KEY: FAKE_KEY,
      SPORTRADAR_BASE_URL: 'http://127.0.0.1:8787',
    });
    expect(createResolver(config, 'ncaawb').resolve('summary', { gameId: 'g' }).url).toBe(
      'http://127.0.0.1:8787/ncaawb/trial/v8/en/games/g/summary.json',
    );
  });
});

describe('QUOTA_<PRODUCT> overrides', () => {
  it('parse "<limit>[/<reserve>]", default reserve 100, empty = unset', () => {
    const c = loadConfig({
      ...base,
      QUOTA_NCAAWB: '1000/50',
      QUOTA_WNBA: '500',
      QUOTA_UNRIVALED: '',
    });
    expect(c.quotaOverrides).toEqual({
      ncaawb: { limit30d: 1000, reserve: 50 },
      wnba: { limit30d: 500, reserve: 100 },
    });
    expect(() => loadConfig({ ...base, QUOTA_NCAAWB: 'lots' })).toThrow(/QUOTA_NCAAWB/);
  });
});
