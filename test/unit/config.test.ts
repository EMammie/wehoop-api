import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

const base = {
  DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
  SUPABASE_URL: 'http://127.0.0.1:54321',
};

describe('loadConfig', () => {
  it('defaults to sim mode and tolerates missing keys', () => {
    const c = loadConfig(base);
    expect(c.mode).toBe('sim');
    expect(c.db.sessionUrl).toBe(base.DATABASE_URL);
    expect(c.supabase.serviceRoleKey).toBeUndefined();
    expect(c.sportradar.keys).toEqual({});
  });

  it('treats empty strings from .env as unset', () => {
    const c = loadConfig({ ...base, SUPABASE_ANON_KEY: '', SPORTRADAR_WNBA_KEY: '' });
    expect(c.supabase.anonKey).toBeUndefined();
    expect(c.sportradar.keys.wnba).toBeUndefined();
  });

  const trialOk = {
    ...base,
    MODE: 'trial',
    SUPABASE_SERVICE_ROLE_KEY: 'x',
    DATABASE_SESSION_URL: 'postgresql://u:p@db.example.com:5432/postgres',
    SPORTRADAR_NCAAWB_KEY: 'k',
  };

  it('requires service-role key, session URL, and a Sportradar key outside sim mode', () => {
    expect(() => loadConfig({ ...base, MODE: 'trial' })).toThrow(
      /SUPABASE_SERVICE_ROLE_KEY[\s\S]*DATABASE_SESSION_URL[\s\S]*SPORTRADAR_\*_KEY/,
    );
    expect(() => loadConfig(trialOk)).not.toThrow();
  });

  it('rejects a transaction-mode pooler as the session URL', () => {
    expect(() =>
      loadConfig({
        ...trialOk,
        DATABASE_SESSION_URL: 'postgresql://u:p@pooler.example.com:6543/postgres',
      }),
    ).toThrow(/transaction-mode pooler/);
    expect(() =>
      loadConfig({
        ...trialOk,
        DATABASE_SESSION_URL: 'postgresql://u:p@db.example.com:5432/postgres?pgbouncer=true',
      }),
    ).toThrow(/transaction-mode pooler/);
  });

  it('requires production access level in production mode', () => {
    expect(() => loadConfig({ ...trialOk, MODE: 'production' })).toThrow(/SPORTRADAR_ACCESS_LEVEL/);
    expect(() =>
      loadConfig({ ...trialOk, MODE: 'production', SPORTRADAR_ACCESS_LEVEL: 'production' }),
    ).not.toThrow();
  });

  it('reports every invalid variable at once', () => {
    expect(() => loadConfig({ DATABASE_URL: 'nope', SUPABASE_URL: 'nope', PORT: 'abc' })).toThrow(
      /DATABASE_URL[\s\S]*SUPABASE_URL[\s\S]*PORT/,
    );
  });

  it('uses a separate session URL when provided', () => {
    const c = loadConfig({
      ...base,
      DATABASE_SESSION_URL: 'postgresql://u:p@db.example.com:5432/postgres',
    });
    expect(c.db.sessionUrl).toContain('db.example.com');
  });
});
