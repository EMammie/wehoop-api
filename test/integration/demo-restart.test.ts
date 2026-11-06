import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { purgeReplayGames } from '../../src/ingest/demo-purge.js';
import { GameWatcher, replayRecording } from '../../src/ingest/game-watcher.js';
import { wnbaAdapter } from '../../src/leagues/wnba/adapter.js';
import { canonicalJson } from '../../src/model/content-hash.js';
import {
  DEFAULT_INTERVAL_MS,
  epochFor,
  loadRecording,
  rotationFor,
  SLOT_ORIGIN_MS,
  slotAt,
  slotRecording,
} from '../../src/providers/sportradar/demo-host.js';
import { replayRun, silentLog, testDb } from '../helpers/db.js';

/**
 * Restart continuity (plan rev 4.15 acceptance): `pnpm demo run` (the demo host + the production
 * scheduler, one process, MODE=demo on the dev stack) is SIGKILLed mid-game and started again
 * with the same --speed and --epoch. The same provider game id must resume as a new watch
 * generation and finish `closed`, with final events, periods, score and status equal to the same
 * shifted slot replayed polling-only (pattern: push-flow.test.ts); every invariant passes, no
 * entity has two consecutive changes with the same content hash, and no provider call of the
 * game names a host other than the demo host.
 *
 * Time is compressed (speed 60: the 2 h 36 min WNBA replay in about 2.6 minutes) around an epoch
 * placing the demo clock 12 demo minutes before a slot picked at random far ahead, so no other
 * run's games and no real-time scheduler share its range.
 */
const ROOT = new URL('../../', import.meta.url).pathname;
const SPEED = 60;
const PORT = 18_790 + Math.floor(Math.random() * 500);
const rotation = rotationFor({ leagues: ['wnba'] });
const db = testDb();
const dir = mkdtempSync(join(tmpdir(), 'wehoop-demo-restart-'));
const kNow = Math.floor((Date.now() - SLOT_ORIGIN_MS) / DEFAULT_INTERVAL_MS);
const slot = slotAt(kNow + 400 + Math.floor(Math.random() * 4000), rotation, DEFAULT_INTERVAL_MS);
let epoch = 0;
const children: ChildProcess[] = [];

interface Run {
  child: ChildProcess;
  out: string[];
  exited: Promise<number | null>;
}

function startDemo(): Run {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      'src/bin/demo.ts',
      'run',
      '--league',
      'wnba',
      '--speed',
      String(SPEED),
      '--epoch',
      new Date(epoch).toISOString(),
      '--port',
      String(PORT),
      '--lock-wait',
      '30',
    ],
    {
      cwd: ROOT,
      env: { ...process.env, SPORTRADAR_BASE_URL: `http://127.0.0.1:${PORT}`, LOG_LEVEL: 'warn' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  children.push(child);
  const out: string[] = [];
  child.stdout?.on('data', (b: Buffer) => out.push(b.toString()));
  child.stderr?.on('data', (b: Buffer) => out.push(b.toString()));
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, out, exited };
}

async function until<T>(what: string, probe: () => Promise<T | null>, ms: number, run?: Run) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== null) return v;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${what}\n${run?.out.join('').slice(-4000) ?? ''}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function gameRow() {
  const [g] = await db<{ id: string; status: string; events: number; watchRunId: string | null }[]>`
    select g.id, g.status::text as status, g.watch_run_id::text as "watchRunId",
           (select count(*)::int from public.play_events p where p.game_id = g.id and p.deleted_at is null) as events
    from public.games g where g.league = 'wnba' and g.provider_game_id = ${slot.providerGameId}`;
  return g ?? null;
}

/** Durable state without volatile ids (push-flow.test.ts). */
async function durableState(gameId: string) {
  const [g] = await db<{ status: string; home: number; away: number }[]>`
    select status::text as status, home_points as home, away_points as away
    from public.games where id = ${gameId}`;
  const periods = await db`
    select sequence, number, type::text as type, home_points as h, away_points as a
    from public.game_periods where game_id = ${gameId} order by sequence`;
  const events = await db<{ providerEventId: string; body: unknown }[]>`
    select provider_event_id as "providerEventId", payload as body from public.play_events
    where game_id = ${gameId} and deleted_at is null order by provider_event_id`;
  const [deleted] = await db<{ n: number }[]>`
    select count(*)::int as n from public.play_events where game_id = ${gameId} and deleted_at is not null`;
  return {
    status: g?.status,
    score: { home: g?.home, away: g?.away },
    periods: [...periods],
    eventCount: events.length,
    deleted: deleted?.n ?? 0,
    eventsHash: canonicalJson(events),
  };
}

/** Every `-- check:` block of invariants.sql, as `pnpm invariants` runs them. */
async function invariants(): Promise<Array<{ check: string; expect: string; actual: string }>> {
  const text = readFileSync(join(ROOT, 'test/integration/invariants.sql'), 'utf8');
  const out: Array<{ check: string; expect: string; actual: string }> = [];
  for (const block of text.split(/\n(?=-- check:)/).map((b) => b.trim())) {
    const m = /^-- check:\s*(.+?)\s*\|\s*expect:\s*(.+)$/.exec(block.split('\n')[0] ?? '');
    if (!m) continue;
    const rows = await db.unsafe(block.slice((block.split('\n')[0] ?? '').length));
    const first = rows[0] as Record<string, unknown> | undefined;
    out.push({
      check: m[1] ?? '',
      expect: (m[2] ?? '').trim(),
      actual: first ? String(Object.values(first)[0]) : '<no row>',
    });
  }
  return out;
}

beforeAll(async () => {
  await db`select 1`;
  // 12 demo minutes before the slot at the moment the first process starts.
  epoch = epochFor(slot.tipOffMs - 12 * 60_000, Date.now() + 2_000, SPEED);
  const [prev] = await db<{ id: string }[]>`
    select id from public.games where league = 'wnba' and provider_game_id = ${slot.providerGameId}`;
  if (prev)
    await purgeReplayGames(db, silentLog, { olderThan: null, dryRun: false, gameIds: [prev.id] });
});
afterAll(async () => {
  for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
  await db.end();
});

describe('demo restart continuity', () => {
  it('SIGKILL mid-game: the same provider game id resumes as a new generation, closes, and equals the slot replayed polling-only', async () => {
    const first = startDemo();
    const mid = await until(
      'the replay to reach mid-game',
      async () => {
        const g = await gameRow();
        return g && g.events >= 120 && g.status === 'inprogress' ? g : null;
      },
      180_000,
      first,
    );
    first.child.kill('SIGKILL');
    expect(await first.exited).toBeNull(); // killed, no exit code
    const firstWatch = mid.watchRunId;
    expect(firstWatch).not.toBeNull();

    const second = startDemo();
    const closed = await until(
      'the resumed watch to close the game',
      async () => {
        const g = await gameRow();
        return g?.status === 'closed' ? g : null;
      },
      300_000,
      second,
    );
    // The watch ends by itself after its closing fetches (status ok), not by the stop below.
    await until(
      'the resumed watch to end',
      async () => {
        const [w] = await db<{ status: string }[]>`
          select status from ingest.ingestion_runs
          where kind = 'watch_game' and game_id = ${closed.id} order by id desc limit 1`;
        return w && w.status !== 'running' ? w : null;
      },
      120_000,
      second,
    );
    // Everything committed reaches subscribers before the process is stopped.
    await until(
      'the outbox to drain',
      async () => {
        const [o] = await db<{ n: number }[]>`
          select count(*)::int as n from ingest.broadcast_outbox
          where game_id = ${closed.id} and published_at is null`;
        return o?.n === 0 ? true : null;
      },
      60_000,
      second,
    );
    second.child.kill('SIGTERM');
    expect(await second.exited).toBe(0);

    // A new generation of the same game: the killed watch was aborted by the next lock holder.
    const watches = await db<{ id: string; status: string }[]>`
      select id::text, status from ingest.ingestion_runs
      where kind = 'watch_game' and game_id = ${closed.id} order by id`;
    expect(watches.length).toBeGreaterThanOrEqual(2);
    expect(watches[0]).toEqual({ id: firstWatch, status: 'aborted' });
    expect(watches.at(-1)?.status).toBe('ok');
    expect(closed.watchRunId).toBe(watches.at(-1)?.id);
    expect(closed.watchRunId).not.toBe(firstWatch);

    // No Sportradar traffic: every call of the game's runs went to the demo host, never counted.
    const calls = await db<{ url: string; source: string; counted: boolean }[]>`
      select c.url, c.source::text as source, c.quota_counted as counted
      from ingest.provider_calls c join ingest.ingestion_runs r on r.id = c.run_id
      where r.game_id = ${closed.id}
         or r.parent_run_id in (select id from ingest.ingestion_runs where game_id = ${closed.id})`;
    expect(calls.length).toBeGreaterThan(10);
    for (const c of calls) {
      expect(c.url.startsWith(`http://127.0.0.1:${PORT}/`)).toBe(true);
      expect(c).toMatchObject({ source: 'rehearsal', counted: false });
    }
    const [label] = await db<
      { replay: string | null }[]
    >`select replay from public.games where id = ${closed.id}`;
    expect(label?.replay).toBe('recorded');

    // The same shifted slot, replayed polling-only into a distinct game.
    const rec = await loadRecording(slot.entry);
    const file = join(dir, 'slot.jsonl');
    const pollId = `test-${randomUUID()}`;
    writeFileSync(
      file,
      `${slotRecording(rec, slot, pollId)
        .map((l) => JSON.stringify(l))
        .join('\n')}\n`,
    );
    const watcher = new GameWatcher({
      db,
      log: silentLog,
      adapter: wnbaAdapter,
      run: await replayRun(db),
      apply: { db, log: silentLog },
      pulse: null,
    });
    await replayRecording(watcher, file, silentLog, {
      paceMs: 0,
      isStopped: () => false,
      maxDocs: null,
    });
    if (!watcher.gameId) throw new Error('polling replay created no game');
    const viaDemo = await durableState(closed.id);
    const viaPoll = await durableState(watcher.gameId);
    expect(viaDemo.status).toBe('closed');
    expect(viaDemo.score).toEqual(viaPoll.score);
    expect(viaDemo.periods).toEqual(viaPoll.periods);
    expect(viaDemo.eventCount).toBe(viaPoll.eventCount);
    expect(viaDemo.eventsHash).toBe(viaPoll.eventsHash);
    // Retracted plays exist only where a path observed them before the retraction (push-flow).
    expect(viaDemo.deleted).toBeLessThanOrEqual(viaPoll.deleted);

    // No entity has two consecutive changes with the same content hash (the new generation
    // re-read the same documents and wrote nothing twice).
    const [dup] = await db<{ n: number }[]>`
      select count(*)::int as n from (
        select c.content_hash,
               lag(c.content_hash) over (partition by e.entity order by c.seq) as prev
        from public.game_changes c
        cross join lateral (select case
          when c.change_type in ('event_insert', 'event_update', 'event_delete') then 'event:' || c.provider_event_id
          when c.change_type = 'stats_player' then 'player:' || (c.body->>'providerPlayerId')
          when c.change_type = 'stats_team' then 'team:' || (c.body->>'providerTeamId')
          else c.change_type::text end as entity) e
        where c.game_id = ${closed.id}
      ) x where x.content_hash is not null and x.content_hash = x.prev`;
    expect(dup?.n).toBe(0);
    for (const inv of await invariants()) expect(inv.actual, inv.check).toBe(inv.expect);
  }, 600_000);
});
