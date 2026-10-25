import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { wnbaAdapter } from '../../src/leagues/wnba/adapter.js';
import { SummaryDocumentSchema } from '../../src/providers/sportradar/schemas/summary.js';
import {
  apply,
  counts,
  observation,
  R,
  replayRun,
  seedGame,
  silentLog,
  summaryQ1,
  testDb,
} from '../helpers/db.js';
import { fixture } from '../helpers/fixtures.js';

/**
 * clock_running derivation for REST summaries (plan §4): true when
 * status=inprogress and the clock advanced between two observations, false at
 * halftime / period end, null otherwise. Always an observation write: no seq,
 * no change row, no clock in any change body.
 */
const db = testDb();
const deps = { db, log: silentLog };
const T0 = new Date('2026-06-30T23:50:00Z');
const at = (s: number) => new Date(T0.getTime() + s * 1000);

beforeAll(async () => {
  await db`select 1`;
});
afterAll(async () => {
  await db.end();
});

const summaryWith = (over: Record<string, unknown>) =>
  wnbaAdapter.normalizeSummary(
    SummaryDocumentSchema.parse({ ...(fixture(`${R}-summary-q1.json`) as object), ...over }),
  );

describe('clock_running (REST summaries) is an observation, never a durable change', () => {
  it('true after the clock advanced, kept while unchanged, null on a jump up, false at halftime', async () => {
    const first = summaryQ1();
    const { gameId } = await seedGame(db, first);
    const run = await replayRun(db, gameId);
    /** Apply a summary variant, with its own game view as the observation, `seconds` after T0. */
    const applyAt = (over: Record<string, unknown>, seconds: number) => {
      const nd = summaryWith(over);
      return apply(deps, gameId, nd, observation(run, nd, at(seconds)));
    };
    const clockState = async () => {
      const [g] = await db<{ clock: string | null; running: boolean | null; asOf: Date | null }[]>`
        select clock, clock_running as running, clock_as_of as "asOf" from public.games where id = ${gameId}`;
      return g;
    };
    const r0 = await applyAt({ clock: '08:00' }, 0);
    expect(r0.outcome).toBe('applied');
    const before = await counts(db, gameId);
    expect(await clockState()).toMatchObject({ clock: '08:00', running: null });

    // Advanced 08:00 -> 07:50 inside inprogress: running = true, zero durable changes.
    const r1 = await applyAt({ clock: '07:50' }, 10);
    expect(r1.outcome === 'applied' && r1.changes).toEqual([]);
    expect(await clockState()).toMatchObject({ clock: '07:50', running: true, asOf: at(10) });
    expect((await counts(db, gameId)).lastSeq).toBe(before.lastSeq);

    // Unchanged clock keeps the previous value (a stalled clock is not proof it stopped).
    const r2 = await applyAt({ clock: '07:50' }, 20);
    expect(r2.outcome === 'applied' && r2.changes).toEqual([]);
    expect(await clockState()).toMatchObject({ clock: '07:50', running: true });

    // A clock restored upward (review) is a correction with unknown running state.
    const r3 = await applyAt({ clock: '08:30' }, 30);
    expect(r3.outcome === 'applied' && r3.changes).toEqual([]);
    expect(await clockState()).toMatchObject({ clock: '08:30', running: null });

    // Halftime: the feed says the period ended -> false; the status itself is the only durable change.
    const r4 = await applyAt({ clock: '00:00', status: 'halftime' }, 40);
    expect(r4.outcome === 'applied' && r4.changes.map((c) => c.type)).toEqual(['status']);
    expect(await clockState()).toMatchObject({ clock: '00:00', running: false });

    // No change body ever carries a clock-running flag; clock lives in observation columns and pulses.
    const [leak] = await db<{ n: number }[]>`
      select count(*)::int as n from public.game_changes
      where game_id = ${gameId} and (body ? 'clockRunning' or body ? 'clock_running')`;
    expect(leak?.n).toBe(0);
    expect((await counts(db, gameId)).lastSeq).toBe(before.lastSeq + 1);
  });
});
