import { describe, expect, it } from 'vitest';
import { describeDbUrl, isDevStackUrl, loadConfig } from '../../src/config.js';

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

  // Not the dev stack: the ledger-protection check below is about 127.0.0.1:54322 specifically.
  const trialOk = {
    ...base,
    DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:55322/postgres',
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

  describe('ledger protection: trial/production never run against the dev stack by accident (rev 4.6)', () => {
    const devDb = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
    const trialStackDb = 'postgresql://postgres:postgres@127.0.0.1:55322/postgres';

    it('isDevStackUrl: loopback host AND port 54322 only; describeDbUrl never shows credentials', () => {
      expect(isDevStackUrl(devDb)).toBe(true);
      expect(isDevStackUrl('postgresql://u:p@localhost:54322/postgres')).toBe(true);
      expect(isDevStackUrl(trialStackDb)).toBe(false);
      expect(isDevStackUrl('postgresql://u:p@db.example.com:54322/postgres')).toBe(false);
      expect(isDevStackUrl('nope')).toBe(false);
      expect(describeDbUrl('postgresql://postgres:secret-pw@127.0.0.1:54322/postgres')).toBe(
        '127.0.0.1:54322',
      );
      expect(
        describeDbUrl('postgresql://postgres:secret-pw@127.0.0.1:54322/postgres'),
      ).not.toContain('secret-pw');
    });

    it('refuses MODE=trial and MODE=production on the dev stack unless TRIAL_ALLOW_DEV_DB=1', () => {
      const onDev = { ...trialOk, DATABASE_URL: devDb, DATABASE_SESSION_URL: devDb };
      expect(() => loadConfig(onDev)).toThrow(
        /dev\/integration stack[\s\S]*supabase db reset[\s\S]*quota ledger/,
      );
      expect(() => loadConfig(onDev)).not.toThrow(/postgres:postgres/); // no credentials in the message
      expect(() =>
        loadConfig({ ...onDev, MODE: 'production', SPORTRADAR_ACCESS_LEVEL: 'production' }),
      ).toThrow(/dev\/integration stack/);
      // The session URL alone pointing at the dev stack is enough to refuse.
      expect(() => loadConfig({ ...trialOk, DATABASE_SESSION_URL: devDb })).toThrow(
        /dev\/integration stack/,
      );
      const allowed = loadConfig({ ...onDev, TRIAL_ALLOW_DEV_DB: '1' });
      expect(allowed.devStackDb).toBe(true);
      expect(allowed.rehearsal).toBe(false);
      expect(() => loadConfig({ ...onDev, TRIAL_ALLOW_DEV_DB: 'yes' })).toThrow(
        /TRIAL_ALLOW_DEV_DB/,
      );
    });

    it('a rehearsal (loopback SPORTRADAR_BASE_URL) and sim mode are exempt; the trial stack needs no flag', () => {
      const onDev = { ...trialOk, DATABASE_URL: devDb, DATABASE_SESSION_URL: devDb };
      const rehearsal = loadConfig({ ...onDev, SPORTRADAR_BASE_URL: 'http://127.0.0.1:8787' });
      expect(rehearsal.rehearsal).toBe(true);
      expect(rehearsal.devStackDb).toBe(true);
      expect(() => loadConfig({ ...base, MODE: 'sim' })).not.toThrow();
      const trialStack = loadConfig({
        ...trialOk,
        DATABASE_URL: trialStackDb,
        DATABASE_SESSION_URL: trialStackDb,
      });
      expect(trialStack.devStackDb).toBe(false);
      expect(trialStack.rehearsal).toBe(false);
    });
  });
});
