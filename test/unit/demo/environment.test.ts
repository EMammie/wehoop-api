import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config.js';
import { demoInitProblem } from '../../../src/ingest/demo-init.js';
import { environmentProblem } from '../../../src/ingest/environment.js';

/**
 * Plan rev 4.15 (4) and review round 1: only MODE=demo writes to a database marked demo; MODE=demo
 * runs on a demo database or the dev stack on BOTH URLs (not marked production).
 */
const MODES = ['sim', 'trial', 'production', 'demo'] as const;
const KINDS = [null, 'dev', 'demo', 'production'] as const;

describe('environment marker decision: every mode x marker x dev-stack combination', () => {
  const allowed = (
    mode: (typeof MODES)[number],
    devStackOnly: boolean,
    kind: (typeof KINDS)[number],
  ) => {
    if (mode === 'demo')
      return kind === 'demo' || (devStackOnly && (kind === null || kind === 'dev'));
    return kind !== 'demo';
  };
  for (const mode of MODES)
    for (const kind of KINDS)
      for (const devStackOnly of [true, false])
        it(`MODE=${mode}, marked ${kind ?? 'none'}, dev stack on both URLs ${devStackOnly}: ${allowed(mode, devStackOnly, kind) ? 'allowed' : 'refused'}`, () => {
          const problem = environmentProblem(mode, devStackOnly, kind, 'db:5432');
          if (allowed(mode, devStackOnly, kind)) expect(problem).toBeNull();
          else if (mode === 'demo')
            expect(problem).toMatch(
              /MODE=demo runs only on the dev stack .* or a database marked demo/,
            );
          else
            expect(problem).toMatch(new RegExp(`MODE=${mode} refuses db:5432: it is marked demo`));
        });
});

describe('the demo exemption needs the dev stack on both connection strings', () => {
  const env = {
    MODE: 'demo',
    SUPABASE_URL: 'http://127.0.0.1:54321',
    SUPABASE_SERVICE_ROLE_KEY: 'x',
    SPORTRADAR_BASE_URL: 'http://127.0.0.1:8790',
  };
  const dev = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
  const cloud = 'postgresql://u:p@db.example.supabase.co:5432/postgres';
  it('one dev-stack URL does not carry a cloud database along', () => {
    const mixed = loadConfig({ ...env, DATABASE_URL: dev, DATABASE_SESSION_URL: cloud });
    expect(mixed.devStackDb).toBe(true); // ledger protection still sees the dev stack
    expect(mixed.devStackOnly).toBe(false);
    expect(environmentProblem('demo', mixed.devStackOnly, null, 'x')).not.toBeNull();
    const reverse = loadConfig({ ...env, DATABASE_URL: cloud, DATABASE_SESSION_URL: dev });
    expect(reverse.devStackOnly).toBe(false);
    const both = loadConfig({ ...env, DATABASE_URL: dev, DATABASE_SESSION_URL: dev });
    expect(both.devStackOnly).toBe(true);
    expect(environmentProblem('demo', both.devStackOnly, null, 'x')).toBeNull();
  });
});

describe('demo init refusal', () => {
  const clean = { kind: null, games: 0, countedCalls: 0, verifiedProducts: [] };
  it('accepts a fresh unmarked database (placeholder, unverified limits) and a demo one', () => {
    expect(demoInitProblem(clean)).toBeNull();
    expect(
      demoInitProblem({ kind: 'demo', games: 9, countedCalls: 0, verifiedProducts: [] }),
    ).toBeNull();
  });
  it('refuses another marker, a real deployment (counted calls or a verified limit) and games', () => {
    expect(demoInitProblem({ ...clean, kind: 'production' })).toMatch(/marked production/);
    expect(demoInitProblem({ ...clean, kind: 'dev' })).toMatch(/marked dev/);
    expect(demoInitProblem({ ...clean, countedCalls: 3 })).toMatch(
      /looks like a real deployment: 3 quota-counted/,
    );
    expect(demoInitProblem({ ...clean, verifiedProducts: ['ncaawb'] })).toMatch(
      /operator-verified limits for \[ncaawb\]/,
    );
    expect(demoInitProblem({ ...clean, games: 2 })).toMatch(/holds 2 game\(s\)/);
  });
});
