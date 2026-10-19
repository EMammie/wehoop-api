import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config.js';
import { seasonFor } from '../../../src/ingest/season.js';
import {
  assertSpeedAllowed,
  backfillNeeded,
  lagFromRecord,
} from '../../../src/ingest/trial-mode.js';

const base = {
  DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  DATABASE_SESSION_URL: 'postgresql://u:p@db.example.com:5432/postgres',
  SPORTRADAR_NCAAWB_KEY: 'unit-test-key',
  // These configs point at the dev stack on purpose (nothing is called); the ledger guard needs consent.
  TRIAL_ALLOW_DEV_DB: '1',
};

describe('assertSpeedAllowed (--speed only against a rehearsal host)', () => {
  it('speed 1 is always fine; a compressed cadence is refused against api.sportradar.com and the simulation service', () => {
    const trial = loadConfig({ ...base, MODE: 'trial' });
    const rehearsal = loadConfig({
      ...base,
      MODE: 'trial',
      SPORTRADAR_BASE_URL: 'http://127.0.0.1:8787',
    });
    const sim = loadConfig({ ...base, MODE: 'sim' });
    expect(() => assertSpeedAllowed(trial, 1)).not.toThrow();
    expect(() => assertSpeedAllowed(rehearsal, 60)).not.toThrow();
    expect(() => assertSpeedAllowed(trial, 30)).toThrow(/only allowed against a rehearsal host/);
    expect(() => assertSpeedAllowed(sim, 30)).toThrow(/simulation service/);
    expect(() => assertSpeedAllowed(rehearsal, 0)).toThrow(/integer/);
  });
});

describe('seasonFor', () => {
  it('NCAAWB seasons are named by their first year; WNBA and Unrivaled by the calendar year', () => {
    expect(seasonFor('ncaawb', new Date('2026-11-08T00:00:00Z'))).toEqual({
      year: 2026,
      type: 'REG',
    });
    expect(seasonFor('ncaawb', new Date('2027-02-18T00:00:00Z'))).toEqual({
      year: 2026,
      type: 'REG',
    });
    expect(seasonFor('wnba', new Date('2026-07-01T00:00:00Z'))).toEqual({
      year: 2026,
      type: 'REG',
    });
    expect(seasonFor('unrivaled', new Date('2027-01-10T00:00:00Z'))).toEqual({
      year: 2027,
      type: 'REG',
    });
    expect(seasonFor('ncaawb', new Date('2027-03-20T00:00:00Z'), { type: 'PST' })).toEqual({
      year: 2026,
      type: 'PST',
    });
  });
});

describe('lagFromRecord (pnpm subscribe --record -> pnpm trial lag)', () => {
  const line = (
    seq: number,
    type: string,
    ts: string,
    receivedAt: string,
    wallClock: string | null,
    via = 'broadcast',
  ) =>
    JSON.stringify({
      via,
      receivedAt,
      change: {
        v: 1,
        id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
        gameId: '11111111-1111-4111-8111-111111111111',
        seq,
        ts,
        type,
        ...(type.startsWith('event') ? { providerEventId: `e${seq}` } : {}),
        body:
          type === 'status'
            ? { status: 'inprogress', score: { home: 1, away: 0 }, period: null }
            : {
                type: 'other',
                providerEventType: 'x',
                period: { number: 1, type: 'quarter', sequence: 1 },
                clock: '9:00',
                wallClock,
                score: { home: 1, away: 0 },
              },
      },
    });
  it('median and p95 of receivedAt - wallClock (event changes) and receivedAt - ts (every change)', () => {
    const lines = [
      line(
        1,
        'event_insert',
        '2026-11-08T01:00:01.000Z',
        '2026-11-08T01:00:01.500Z',
        '2026-11-08T00:59:59.000Z',
      ),
      line(
        2,
        'event_insert',
        '2026-11-08T01:00:02.000Z',
        '2026-11-08T01:00:02.200Z',
        '2026-11-08T01:00:00.000Z',
      ),
      line(3, 'status', '2026-11-08T01:00:03.000Z', '2026-11-08T01:00:03.100Z', null),
      line(4, 'event_insert', '2026-11-08T01:00:04.000Z', '2026-11-08T01:00:04.300Z', null),
      line(
        5,
        'event_insert',
        '2026-11-08T01:00:05.000Z',
        '2026-11-08T01:00:05.900Z',
        '2026-11-08T01:00:04.000Z',
        'catch-up',
      ),
      '',
    ];
    const stats = lagFromRecord(lines);
    expect(stats.changes).toBe(4); // catch-up lines are not live delivery
    expect(stats.wallClock).toEqual({ n: 2, medianMs: 2200, p95Ms: 2500 });
    expect(stats.providerUpdated).toEqual({
      n: 0,
      medianMs: null,
      p95Ms: null,
      excluded: 0,
      notBroadcast: 0,
    });
    expect(stats.pipeline).toEqual({ n: 4, medianMs: 200, p95Ms: 500 });
    expect(stats.catchUp).toEqual({ n: 1, medianMs: 900, p95Ms: 900 });
    // Feeds without wall_clock (NCAAWB): lag from the stored provider revision of each event.
    const revisions = new Map([
      ['e1', '2026-11-08T01:00:00.000Z'],
      ['e4', '2026-11-08T01:00:03.300Z'],
    ]);
    expect(lagFromRecord(lines, revisions).providerUpdated).toEqual({
      n: 2,
      medianMs: 1000,
      p95Ms: 1500,
      excluded: 0,
      notBroadcast: 0,
    });
    expect(lagFromRecord([])).toEqual({
      changes: 0,
      wallClock: { n: 0, medianMs: null, p95Ms: null },
      providerUpdated: { n: 0, medianMs: null, p95Ms: null, excluded: 0, notBroadcast: 0 },
      pipeline: { n: 0, medianMs: null, p95Ms: null },
      catchUp: { n: 0, medianMs: null, p95Ms: null },
    });
  });

  it('measures each event once, on its last delivered change; a later stored revision is excluded, not negative', () => {
    const ev = (seq: number, type: string, id: string, receivedAt: string, wallClock: string) =>
      JSON.stringify({
        via: 'broadcast',
        receivedAt,
        change: {
          v: 1,
          id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
          gameId: '11111111-1111-4111-8111-111111111111',
          seq,
          ts: receivedAt,
          type,
          providerEventId: id,
          body: {
            type: 'other',
            providerEventType: 'x',
            period: { number: 1, type: 'quarter', sequence: 1 },
            clock: '9:00',
            wallClock,
            score: { home: 1, away: 0 },
          },
        },
      });
    const lines = [
      ev(1, 'event_insert', 'a', '2026-10-20T00:20:10.000Z', '2026-10-20T00:20:00.000Z'),
      ev(2, 'event_insert', 'b', '2026-10-20T00:20:40.000Z', '2026-10-20T00:20:30.000Z'),
      // 'a' corrected 10 min later: its wall clock lag must not count the correction delay.
      ev(3, 'event_update', 'a', '2026-10-20T00:30:10.000Z', '2026-10-20T00:20:00.000Z'),
    ];
    const revisions = new Map([
      ['a', '2026-10-20T00:30:05.000Z'], // the revision delivered by seq 3
      ['b', '2026-10-20T00:45:00.000Z'], // revised after receipt without a change (revision-only)
    ]);
    const stats = lagFromRecord(lines, revisions);
    expect(stats.wallClock).toEqual({ n: 2, medianMs: 10_000, p95Ms: 10_000 });
    expect(stats.providerUpdated).toEqual({
      n: 1,
      medianMs: 5000,
      p95Ms: 5000,
      excluded: 1,
      notBroadcast: 0,
    });
  });
});

describe('backfillNeeded (push reconnect -> REST pbp backfill?)', () => {
  const reconnectedAt = new Date('2026-10-18T20:00:00Z');
  const at = (secBefore: number) => new Date(reconnectedAt.getTime() - secBefore * 1000);
  it('no pbp of this generation yet: backfill', () => {
    expect(backfillNeeded({ lastPbpCalledAt: null, reconnectedAt })).toBe(true);
  });
  it('a pbp requested before the reconnect misses the tail of the outage: backfill, even one fetched during the outage', () => {
    expect(backfillNeeded({ lastPbpCalledAt: at(45), reconnectedAt })).toBe(true); // 45 s before a 30 s outage ended
    expect(backfillNeeded({ lastPbpCalledAt: at(4.8), reconnectedAt })).toBe(true); // the validator's gap: 4.8 s before reconnect
    expect(backfillNeeded({ lastPbpCalledAt: at(0.001), reconnectedAt })).toBe(true);
  });
  it('a pbp requested at or after the reconnect covers everything the stream will not replay: skip', () => {
    expect(backfillNeeded({ lastPbpCalledAt: reconnectedAt, reconnectedAt })).toBe(false);
    expect(backfillNeeded({ lastPbpCalledAt: at(-2), reconnectedAt })).toBe(false);
  });
});
