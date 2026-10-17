import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Config, loadConfig } from '../../src/config.js';
import type { Db } from '../../src/db/client.js';
import { QuotaGuard, QuotaRefusedError } from '../../src/ingest/quota-guard.js';
import { readRecording, relabelRecording } from '../../src/ingest/recording.js';
import { planDay, resolveGame, runTrialWatch } from '../../src/ingest/trial-mode.js';
import { ncaawbAdapter } from '../../src/leagues/ncaawb/adapter.js';
import {
  type FakeProvider,
  startFakeProvider,
} from '../../src/providers/sportradar/fake-provider.js';
import { BoxscoreDocumentSchema } from '../../src/providers/sportradar/schemas/boxscore.js';
import { counts, silentLog, testDb } from '../helpers/db.js';

/**
 * The trial flow end to end (plan §4 "Trial mode", §7 M3) against the local
 * fake provider standing in for api.sportradar.com: MODE=trial, a key made up
 * in this test (never from .env), SPORTRADAR_BASE_URL pointed at the fake
 * server (a loopback host, so the resolver source is `rehearsal`: rate-limited
 * and guarded like trial, never quota-counted), the recording time-scaled
 * 1000x. Proves: `plan` = exactly one schedule call; `watch` reserves the
 * derived budget, links it to a watch_game run, rate-limits every call (no
 * 429 from the server, >= 1 s between called_at per product), counts each
 * call against the reservation, and releases it; an extended_boxscore game
 * emits only status/period while live and its stats once closed; a trial
 * reservation below reserve is refused before any call; an in-loop refusal
 * ends the watch as an error with the reservation released.
 */
const FULL = new URL('../../fixtures/ncaawb/sim-d9b71fe0-replay.compact.jsonl.gz', import.meta.url)
  .pathname;
const EXT = new URL('../../fixtures/ncaawb/sim-d9b71fe0-replay.extended.jsonl.gz', import.meta.url)
  .pathname;
const REAL_ID = '2e36b340-9277-4b99-af20-b7ff7e86640e';
const EXT_ID = 'e5e5e5e5-9277-4b99-af20-b7ff7e86640e';
const SPEED = 1000;
const DATE = '2026-02-18';

const db = testDb();
const log = silentLog;
const dir = mkdtempSync(join(tmpdir(), 'wehoop-trial-flow-'));
const fullCopy = join(dir, 'full.jsonl.gz');
const extCopy = join(dir, 'ext.jsonl.gz');
const fullId = `test-${randomUUID()}`;
const extId = `test-${randomUUID()}`;
const product = `m3-trial-${randomUUID().slice(0, 8)}`;
const adapter = { ...ncaawbAdapter, product };
const FAKE_KEY = `trial-rehearsal-key-${randomUUID()}`;
let finalBox: { home: number; away: number } | null = null;

const configFor = (server: FakeProvider): Config =>
  loadConfig({
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_SESSION_URL: process.env.DATABASE_URL,
    SUPABASE_URL: process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321',
    SUPABASE_SERVICE_ROLE_KEY: 'not-used-here',
    MODE: 'trial',
    SPORTRADAR_NCAAWB_KEY: FAKE_KEY,
    SPORTRADAR_BASE_URL: server.url,
  });

async function callRows(reservationId: number) {
  return db<
    {
      feed: string;
      source: string;
      quotaCounted: boolean;
      product: string;
      url: string;
      status: number;
    }[]
  >`select feed, source::text as source, quota_counted as "quotaCounted", product, url, status
    from ingest.provider_calls where reservation_id = ${reservationId} order by id`;
}

async function minGapMs(): Promise<number | null> {
  const [row] = await db<{ ms: number | null }[]>`
    select (extract(epoch from min(gap)) * 1000)::int as ms from (
      select called_at - lag(called_at) over (order by called_at, id) as gap
      from ingest.provider_calls
      where product = ${product} and source in ('trial', 'production', 'rehearsal')) g`;
  return row?.ms ?? null;
}

/** A guard that refuses every call after the first `allowed` ones: the in-loop refusal path. */
class RefusingGuard extends QuotaGuard {
  seen = 0;
  constructor(
    db: Db,
    private readonly allowed: number,
  ) {
    super({ db, log });
  }
  override async assertCall(
    product: string,
    source: Parameters<QuotaGuard['assertCall']>[1],
    reservationId: number | null = null,
  ) {
    if (++this.seen > this.allowed) {
      throw new QuotaRefusedError(product, 'below_reserve', null, 'injected: budget exhausted');
    }
    return super.assertCall(product, source, reservationId);
  }
}

beforeAll(async () => {
  await db`select 1`;
  await relabelRecording(FULL, fullCopy, {
    coverage: 'full',
    gameId: { from: REAL_ID, to: fullId },
  });
  await relabelRecording(EXT, extCopy, {
    coverage: 'extended_boxscore',
    gameId: { from: EXT_ID, to: extId },
  });
  for await (const line of readRecording(fullCopy)) {
    if (line.feed === 'boxscore') {
      const b = BoxscoreDocumentSchema.parse(line.body);
      finalBox = { home: b.home.points ?? 0, away: b.away.points ?? 0 };
    }
  }
  await db`insert into ingest.product_quotas (product, limit_30d, qps, reserve, note, verified_at)
           values (${product}, 1000, 1, 100, 'integration rehearsal', now())`;
});
afterAll(async () => {
  // The watch runs stay (games.watch_run_id restricts their deletion), so their reservations stay
  // too and are re-homed under the seeded product; released, they count for nothing.
  await db`update ingest.budget_reservations set product = 'ncaawb', released_at = coalesce(released_at, now()),
             note = coalesce(note, '') || ' [integration product row removed]' where product = ${product}`;
  await db`delete from ingest.product_quotas where product = ${product}`;
  rmSync(dir, { recursive: true, force: true });
  await db.end();
});

describe('trial flow against the fake provider (MODE=trial, made-up key, local host)', () => {
  it('full game: plan makes one schedule call; watch reserves 332, rate-limits, counts and releases (rehearsal: never quota-counted)', async () => {
    const server = await startFakeProvider({ replayFile: fullCopy, speed: SPEED });
    try {
      const config = configFor(server);
      const guard = new QuotaGuard({ db, log });
      const plan = await planDay({ db, log, config, adapter, guard }, { date: DATE });
      expect(plan.calls).toBe(1);
      expect(plan.season).toEqual({ year: 2025, type: 'REG' });
      const planned = plan.games.find((g) => g.providerGameId === fullId);
      expect(planned).toMatchObject({ coverage: 'full', profile: 'full', status: 'created' });
      expect(planned?.budget.total).toBe(332);
      const [schedCall] = await db<
        { feed: string; quotaCounted: boolean; url: string; source: string }[]
      >`
        select feed, quota_counted as "quotaCounted", url, source::text as source
        from ingest.provider_calls where product = ${product} order by id`;
      expect(schedCall).toMatchObject({
        feed: 'schedule',
        quotaCounted: false,
        source: 'rehearsal',
      });
      expect(schedCall?.url).toContain('/games/2025/REG/schedule.json');
      expect(schedCall?.url).not.toContain(FAKE_KEY);

      const game = await resolveGame(db, 'ncaawb', fullId);
      if (!game) throw new Error('plan did not create the game');
      expect(await resolveGame(db, 'ncaawb', game.id)).toMatchObject({ providerGameId: fullId });
      const out = await runTrialWatch(
        { db, log, config, adapter, guard, pulse: null, isStopped: () => false },
        { game, profile: 'full', speed: SPEED, note: 'integration rehearsal' },
      );
      expect(out.status).toBe('closed');
      expect(out.refused).toBe(0);
      expect(out.reservation).toMatchObject({
        profile: 'full',
        reservedCalls: 332,
        source: 'rehearsal',
        runId: out.runId,
        gameId: game.id,
      });
      expect(out.reservation.releasedAt).toBeInstanceOf(Date);
      expect(out.reservation.usedCalls).toBe(out.calls);
      expect(out.calls).toBeGreaterThanOrEqual(4);
      expect(out.calls).toBeLessThanOrEqual(332);
      const calls = await callRows(out.reservation.id);
      expect(calls).toHaveLength(out.reservation.usedCalls);
      for (const c of calls) {
        expect(c).toMatchObject({ source: 'rehearsal', quotaCounted: false, product, status: 200 });
        expect(c.url).not.toContain(FAKE_KEY);
      }
      expect(new Set(calls.map((c) => c.feed))).toEqual(new Set(['pbp', 'boxscore', 'summary']));
      expect(calls.at(-2)?.feed).toBe('summary'); // closing pair
      expect(calls.at(-1)?.feed).toBe('boxscore');
      expect(await minGapMs()).toBeGreaterThanOrEqual(1000);
      expect(server.stats.rejected429).toBe(0);
      expect(server.stats.rejected401).toBe(0);
      const [run] = await db<{ kind: string; source: string; status: string; gameId: string }[]>`
        select kind, source::text as source, status, game_id as "gameId" from ingest.ingestion_runs where id = ${out.runId}`;
      expect(run).toEqual({
        kind: 'watch_game',
        source: 'rehearsal',
        status: 'ok',
        gameId: game.id,
      });
      // A rehearsal spends no quota: the product's used_30d and reserved stay at zero.
      const [q] = await db<{ used: number; reserved: number }[]>`
        select used_30d as used, reserved from ingest.v_quota where product = ${product}`;
      expect(q).toEqual({ used: 0, reserved: 0 });
      const c = await counts(db, game.id);
      expect(c.watchRunId).toBe(String(out.runId));
      expect(c.events).toBeGreaterThan(200);
      if (!finalBox) throw new Error('no boxscore in fixture');
      expect(c).toMatchObject({ home: finalBox.home, away: finalBox.away });
      expect(c.changes).toBe(c.lastSeq);
      expect(c.outbox).toBe(c.changes);
    } finally {
      await server.close();
    }
  }, 120_000);

  it('a trial reservation that would dip below reserve is refused before any call', async () => {
    const tight = `m3-tight-${randomUUID().slice(0, 8)}`;
    await db`insert into ingest.product_quotas (product, limit_30d, qps, reserve, note, verified_at)
             values (${tight}, 400, 1, 100, 'integration: too small for a full game', now())`;
    const server = await startFakeProvider({ replayFile: fullCopy, speed: SPEED });
    try {
      // Against the default host (source trial) the guard refuses at reservation time, before the
      // resolver is ever asked for a URL; the made-up key never leaves the process.
      const config = loadConfig({
        DATABASE_URL: process.env.DATABASE_URL,
        DATABASE_SESSION_URL: process.env.DATABASE_URL,
        SUPABASE_URL: process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321',
        SUPABASE_SERVICE_ROLE_KEY: 'not-used-here',
        MODE: 'trial',
        SPORTRADAR_NCAAWB_KEY: FAKE_KEY,
      });
      const guard = new QuotaGuard({ db, log });
      const game = await resolveGame(db, 'ncaawb', fullId);
      if (!game) throw new Error('game missing');
      await db`update public.games set status = 'scheduled' where id = ${game.id}`; // re-open for the attempt
      // Real cadence (no --speed: refused against the real host); the guard refuses first anyway.
      await expect(
        runTrialWatch(
          {
            db,
            log,
            config,
            adapter: { ...ncaawbAdapter, product: tight },
            guard,
            pulse: null,
            isStopped: () => false,
          },
          { game: { ...game, status: 'scheduled' }, profile: 'full' },
        ),
      ).rejects.toMatchObject({ reason: 'below_reserve' } satisfies Partial<QuotaRefusedError>);
      expect(await guard.reservations({ product: tight })).toEqual([]);
      expect(server.stats.requests).toBe(0);
      const [calls] = await db<
        { n: number }[]
      >`select count(*)::int as n from ingest.provider_calls where product = ${tight}`;
      expect(calls?.n).toBe(0);
      const [n] = await db<{ n: number }[]>`
        select count(*)::int as n from ingest.ingestion_runs where kind = 'watch_game' and game_id = ${game.id} and status = 'running'`;
      expect(n?.n).toBe(0);
    } finally {
      await server.close();
      await db`update public.games set status = 'closed' where provider_game_id = ${fullId}`;
      await db`delete from ingest.product_quotas where product = ${tight}`;
    }
  });

  it('an in-loop quota refusal ends the watch as an error and releases the reservation', async () => {
    const server = await startFakeProvider({ replayFile: fullCopy, speed: SPEED });
    try {
      const config = configFor(server);
      const guard = new RefusingGuard(db, 2);
      const game = await resolveGame(db, 'ncaawb', fullId);
      if (!game) throw new Error('game missing');
      await db`update public.games set status = 'scheduled' where id = ${game.id}`;
      await expect(
        runTrialWatch(
          { db, log, config, adapter, guard, pulse: null, isStopped: () => false },
          { game: { ...game, status: 'scheduled' }, profile: 'full', speed: SPEED },
        ),
      ).rejects.toMatchObject({ reason: 'below_reserve' });
      // Two calls allowed (pbp, then summary at t=0), the third guard check refuses before any HTTP.
      expect({
        seen: guard.seen,
        served: server.stats.served,
        requests: server.stats.requests,
      }).toEqual({ seen: 3, served: 2, requests: 2 });
      const [res] = await guard.reservations({ product });
      const last = (await guard.reservations({ product })).at(-1);
      expect(res).toBeDefined();
      expect(last?.releasedAt).toBeInstanceOf(Date);
      expect(last?.usedCalls).toBe(2);
      const [run] = await db<{ status: string; error: string | null }[]>`
        select status, error from ingest.ingestion_runs where id = ${last?.runId ?? 0}`;
      expect(run?.status).toBe('error');
      expect(run?.error).toMatch(/quota refused/);
    } finally {
      await server.close();
      await db`update public.games set status = 'closed' where provider_game_id = ${fullId}`;
    }
  });

  it('extended_boxscore game: profile defaults to extended (153), emits status/period only while live, stats once closed, no pbp calls', async () => {
    const server = await startFakeProvider({ replayFile: extCopy, speed: SPEED });
    try {
      const config = configFor(server);
      const guard = new QuotaGuard({ db, log });
      const plan = await planDay({ db, log, config, adapter, guard }, { date: DATE });
      const planned = plan.games.find((g) => g.providerGameId === extId);
      expect(planned).toMatchObject({ coverage: 'extended_boxscore', profile: 'extended' });
      expect(planned?.budget.total).toBe(153);
      const game = await resolveGame(db, 'ncaawb', extId);
      if (!game) throw new Error('plan did not create the extended game');
      const out = await runTrialWatch(
        { db, log, config, adapter, guard, pulse: null, isStopped: () => false },
        { game, speed: SPEED },
      );
      expect(out.status).toBe('closed');
      expect(out.reservation).toMatchObject({ profile: 'extended', reservedCalls: 153 });
      const calls = await callRows(out.reservation.id);
      expect(calls.some((c) => c.feed === 'pbp')).toBe(false);
      expect(calls.filter((c) => c.feed === 'summary').length).toBeGreaterThan(2);
      const types = await db<{ type: string; n: number; minSeq: string }[]>`
        select change_type::text as type, count(*)::int as n, min(seq)::text as "minSeq"
        from public.game_changes where game_id = ${game.id} group by 1 order by 1`;
      const by = Object.fromEntries(types.map((t) => [t.type, t]));
      expect(Object.keys(by).filter((t) => t.startsWith('event_'))).toEqual([]);
      expect(by.status?.n).toBeGreaterThan(0);
      expect(by.period?.n).toBeGreaterThan(0);
      // Two per closing document that changed them (summary, then boxscore): never fewer than one pair.
      expect(by.stats_team?.n).toBeGreaterThanOrEqual(2);
      expect(by.stats_player?.n).toBeGreaterThan(10);
      const [closed] = await db<{ seq: string }[]>`
        select min(seq)::text as seq from public.game_changes
        where game_id = ${game.id} and change_type = 'status' and body->>'status' = 'closed'`;
      expect(Number(by.stats_team?.minSeq)).toBeGreaterThan(Number(closed?.seq));
      expect(Number(by.stats_player?.minSeq)).toBeGreaterThan(Number(closed?.seq));
      const [g] = await db<{ coverage: string; statsFinalAt: Date | null; events: number }[]>`
        select coverage::text as coverage, stats_final_at as "statsFinalAt",
               (select count(*)::int from public.play_events where game_id = ${game.id}) as events
        from public.games where id = ${game.id}`;
      expect(g).toMatchObject({ coverage: 'extended_boxscore', events: 0 });
      expect(g?.statsFinalAt).toBeInstanceOf(Date);
      expect(await minGapMs()).toBeGreaterThanOrEqual(1000);
      expect(server.stats.rejected429).toBe(0);
    } finally {
      await server.close();
    }
  }, 120_000);
});
