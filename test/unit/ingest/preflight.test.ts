import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config.js';
import {
  composePreflight,
  PREFLIGHT_EXIT_PROBLEMS,
  runPreflight,
  stackPairing,
} from '../../../src/ingest/preflight.js';
import type { QuotaStatus } from '../../../src/ingest/quota-guard.js';

const SECRET = 'sr-live-key-THIS-MUST-NEVER-PRINT-0123456789';
const PASSWORD = 'db-password-THIS-MUST-NEVER-PRINT';
const SERVICE = 'service-role-THIS-MUST-NEVER-PRINT';

const trialStack = `postgresql://postgres:${PASSWORD}@127.0.0.1:55322/postgres`;
const devStack = `postgresql://postgres:${PASSWORD}@127.0.0.1:54322/postgres`;

const liveEnv = {
  MODE: 'trial',
  DATABASE_URL: trialStack,
  DATABASE_SESSION_URL: trialStack,
  SUPABASE_URL: 'http://127.0.0.1:55321',
  SUPABASE_SERVICE_ROLE_KEY: SERVICE,
  SPORTRADAR_NCAAWB_KEY: SECRET,
};

const quota = (over: Partial<QuotaStatus> = {}): QuotaStatus => ({
  product: 'ncaawb',
  limit30d: 1000,
  reserve: 100,
  verifiedAt: new Date('2026-10-17T12:00:00Z'),
  overridden: false,
  used30d: 1,
  remaining: 999,
  reserved: 0,
  spendable: 899,
  ...over,
});
const others: QuotaStatus[] = [
  quota({ product: 'wnba', verifiedAt: null, used30d: 0, remaining: 1000, spendable: 900 }),
  quota({ product: 'unrivaled', verifiedAt: null, used30d: 0, remaining: 1000, spendable: 900 }),
];

describe('composePreflight (pnpm trial preflight, rev 4.6)', () => {
  it('a ready live environment: hostname, key presence, verified quota, trial stack; no secret anywhere', () => {
    const r = composePreflight({
      config: loadConfig(liveEnv),
      quota: [quota(), ...others],
      dbError: null,
      rateSlotsTable: true,
    });
    const text = [...r.lines, ...r.problems].join('\n');
    expect(r.ready).toBe(true);
    expect(r.problems).toEqual([]);
    expect(text).toContain('mode            trial');
    expect(text).toContain('provider        api.sportradar.com');
    expect(text).not.toContain('https://'); // hostname only, never a URL
    expect(text).toContain('key ncaawb      present');
    expect(text).toContain('key wnba        missing');
    expect(text).toContain(
      'quota ncaawb    verified 2026-10-17 limit 1000 reserve 100 used 1 spendable 899',
    );
    expect(text).toContain('quota wnba      UNVERIFIED'); // reported, not a problem: no wnba key
    expect(text).toContain('database        127.0.0.1:55322  dev/integration stack: no');
    expect(text).toContain('supabase        127.0.0.1:55321');
    expect(text).not.toContain('database(sess)'); // same URL: not repeated
    for (const s of [SECRET, PASSWORD, SERVICE, String(SECRET.length)])
      expect(text).not.toContain(s);
  });

  it('stack pairing: API port P with database port P+1 on loopback; anything else is a problem; hosted projects are not checked', () => {
    expect(stackPairing('http://127.0.0.1:55321', trialStack)).toBeNull();
    expect(stackPairing('http://127.0.0.1:54321', devStack)).toBeNull();
    expect(
      stackPairing('https://abc.supabase.co', 'postgresql://u:p@db.abc.supabase.co:5432/postgres'),
    ).toBeNull();
    expect(stackPairing('http://127.0.0.1:54321', trialStack)).toMatch(
      /^SUPABASE_URL and DATABASE_URL point at different stacks \(127\.0\.0\.1:54321 vs 127\.0\.0\.1:55322/,
    );
    expect(stackPairing('http://127.0.0.1:55321', devStack)).toContain('different stacks');
    expect(stackPairing('https://abc.supabase.co', trialStack)).toContain('different stacks');
    expect(
      stackPairing('http://127.0.0.1:55321', 'postgresql://u:p@db.abc.supabase.co:5432/postgres'),
    ).toContain('different stacks');
    expect(stackPairing('http://127.0.0.1:54321', trialStack)).not.toContain(PASSWORD);
    const mixed = composePreflight({
      config: loadConfig({ ...liveEnv, SUPABASE_URL: 'http://127.0.0.1:54321' }),
      quota: [quota(), ...others],
      dbError: null,
      rateSlotsTable: true,
    });
    expect(mixed.problems).toEqual([expect.stringMatching(/point at different stacks/)]);
    // A distinct session URL is shown (host:port only).
    const sess = composePreflight({
      config: loadConfig({
        ...liveEnv,
        DATABASE_SESSION_URL: `postgresql://postgres:${PASSWORD}@db.example.com:5432/postgres`,
      }),
      quota: [quota(), ...others],
      dbError: null,
      rateSlotsTable: true,
    });
    expect(sess.lines.join('\n')).toContain('database(sess)  db.example.com:5432');
    expect(sess.lines.join('\n')).not.toContain(PASSWORD);
  });

  it('one problem line each: unverified quota, env override, no spendable budget, missing row, schema behind, db down', () => {
    const cfg = loadConfig(liveEnv);
    const unverified = composePreflight({
      config: cfg,
      quota: [quota({ verifiedAt: null }), ...others],
      dbError: null,
      rateSlotsTable: true,
    });
    expect(unverified.ready).toBe(false);
    expect(unverified.problems).toEqual([
      expect.stringMatching(/quota ncaawb UNVERIFIED: run `pnpm trial:live quota --product ncaawb/),
    ]);
    const overridden = composePreflight({
      config: loadConfig({ ...liveEnv, QUOTA_NCAAWB: '1000/100' }),
      quota: [quota({ overridden: true }), ...others],
      dbError: null,
      rateSlotsTable: true,
    });
    expect(overridden.problems).toEqual([expect.stringMatching(/QUOTA_NCAAWB is set/)]);
    expect(overridden.lines.join('\n')).toContain('env-override (QUOTA_NCAAWB)');
    const exhausted = composePreflight({
      config: cfg,
      quota: [quota({ used30d: 950, remaining: 50, spendable: -50 }), ...others],
      dbError: null,
      rateSlotsTable: true,
    });
    expect(exhausted.problems).toEqual([expect.stringMatching(/nothing spendable/)]);
    const noRow = composePreflight({
      config: cfg,
      quota: others,
      dbError: null,
      rateSlotsTable: true,
    });
    expect(noRow.problems).toEqual(['no ingest.product_quotas row for ncaawb']);
    const behind = composePreflight({
      config: cfg,
      quota: [quota(), ...others],
      dbError: null,
      rateSlotsTable: false,
    });
    expect(behind.problems).toEqual([
      expect.stringMatching(/migration 0011.*pnpm trial:db migration up/),
    ]);
    const down = composePreflight({
      config: cfg,
      quota: [],
      dbError: 'ECONNREFUSED',
      rateSlotsTable: false,
    });
    expect(down.problems).toEqual(['database unreachable (127.0.0.1:55322): ECONNREFUSED']);
    expect(down.lines.join('\n')).not.toContain(PASSWORD);
  });

  it('the dev stack is a problem for a live run even with TRIAL_ALLOW_DEV_DB=1, and fine for a rehearsal or sim', () => {
    const live = composePreflight({
      config: loadConfig({
        ...liveEnv,
        DATABASE_URL: devStack,
        DATABASE_SESSION_URL: devStack,
        SUPABASE_URL: 'http://127.0.0.1:54321', // same (dev) stack: the only problem is the ledger
        TRIAL_ALLOW_DEV_DB: '1',
      }),
      quota: [quota(), ...others],
      dbError: null,
      rateSlotsTable: true,
    });
    expect(live.lines.join('\n')).toContain('dev/integration stack: YES');
    expect(live.problems).toEqual([
      expect.stringMatching(/dev\/integration stack.*TRIAL_ALLOW_DEV_DB=1/),
    ]);
    const rehearsal = composePreflight({
      config: loadConfig({
        ...liveEnv,
        DATABASE_URL: devStack,
        DATABASE_SESSION_URL: devStack,
        SUPABASE_URL: 'http://127.0.0.1:54321',
        SPORTRADAR_NCAAWB_KEY: 'fake-ncaawb-key',
        SPORTRADAR_BASE_URL: 'http://127.0.0.1:8787',
      }),
      quota: [quota(), ...others],
      dbError: null,
      rateSlotsTable: true,
    });
    expect(rehearsal.ready).toBe(true);
    expect(rehearsal.lines.join('\n')).toContain('provider        127.0.0.1  (rehearsal');
    const sim = composePreflight({
      config: loadConfig({ DATABASE_URL: devStack, SUPABASE_URL: 'http://127.0.0.1:54321' }),
      quota: others,
      dbError: null,
      rateSlotsTable: true,
    });
    expect(sim.problems).toEqual([
      'MODE=sim: a live run needs MODE=trial (or production)',
      'no SPORTRADAR_*_KEY present',
    ]);
    expect(PREFLIGHT_EXIT_PROBLEMS).toBe(65);
  });
});

describe('runPreflight (end to end, loopback only, no database available)', () => {
  const collect = () => {
    const lines: string[] = [];
    return { lines, out: (l: string) => lines.push(l) };
  };

  it('an unreachable database is one problem line with host:port and the error code, never the password', async () => {
    const { lines, out } = collect();
    const code = await runPreflight(
      {
        ...liveEnv,
        DATABASE_URL: `postgresql://postgres:${PASSWORD}@127.0.0.1:1/postgres`,
        DATABASE_SESSION_URL: `postgresql://postgres:${PASSWORD}@127.0.0.1:1/postgres`,
        SUPABASE_URL: 'http://127.0.0.1:0', // pairs with port 1, so only the connection fails
      },
      out,
    );
    const text = lines.join('\n');
    expect(code).toBe(PREFLIGHT_EXIT_PROBLEMS);
    expect(text).toMatch(/database unreachable \(127\.0\.0\.1:1\): [A-Z0-9_]+/);
    expect(text).toContain('ready: NO');
    for (const s of [PASSWORD, SECRET, SERVICE]) expect(text).not.toContain(s);
  }, 5_000);

  it('a refused configuration (dev stack in MODE=trial without consent) prints the refusal without credentials', async () => {
    const { lines, out } = collect();
    const code = await runPreflight(
      { ...liveEnv, DATABASE_URL: devStack, DATABASE_SESSION_URL: devStack },
      out,
    );
    const text = lines.join('\n');
    expect(code).toBe(PREFLIGHT_EXIT_PROBLEMS);
    expect(text).toContain('preflight: configuration refused');
    expect(text).toMatch(/dev\/integration stack \(127\.0\.0\.1:54322\)/);
    for (const s of [PASSWORD, SECRET, SERVICE]) expect(text).not.toContain(s);
  });
});
