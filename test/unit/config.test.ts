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

  it('requires the service-role key outside sim mode', () => {
    expect(() => loadConfig({ ...base, MODE: 'trial' })).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
    expect(() =>
      loadConfig({ ...base, MODE: 'trial', SUPABASE_SERVICE_ROLE_KEY: 'x' }),
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
