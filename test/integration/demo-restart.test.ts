import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/server.js';
import { loadConfig } from '../../src/config.js';
import { purgeReplayGames } from '../../src/ingest/demo-purge.js';
import { GameWatcher, replayRecording } from '../../src/ingest/game-watcher.js';
import { wnbaAdapter } from '../../src/leagues/wnba/adapter.js';
import { type ChangesApi, GameSubscriber } from '../../src/live/subscriber.js';
import { gameChannel } from '../../src/live/transport.js';
import { canonicalJson } from '../../src/model/content-hash.js';
import { canonicalState, stateFromSnapshot } from '../../src/model/game-state.js';
import { ChangesPageSchema, SnapshotSchema } from '../../src/model/snapshot.js';
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

/**
 * The reference client (src/live/subscriber.ts) on the real Realtime private channel with the
 * anon key, against the Hono API in-process (`app.request`, the HTTP bodies Zod-parsed exactly as
 * `pnpm subscribe` parses fetch responses). Connected before the SIGKILL and through the restart.
 */
const apiConfig = loadConfig({ ...process.env, MODE: 'sim' });
const app = createApp({ db, config: apiConfig, log: silentLog });
const api: ChangesApi = {
  async snapshot(id) {
    const res = await app.request(`/v1/games/${id}/snapshot`);
    if (!res.ok) throw new Error(`snapshot HTTP ${res.status}`);
    return SnapshotSchema.parse(await res.json());
  },
  async changes(id, after, limit = 200) {
    const res = await app.request(`/v1/games/${id}/changes?after=${after}&limit=${limit}`);
    if (!res.ok) throw new Error(`changes HTTP ${res.status}`);
    return ChangesPageSchema.parse(await res.json());
  },
};
let realtime: SupabaseClient | null = null;

async function connectSubscriber(gameId: string) {
  const anonKey = apiConfig.supabase.anonKey;
  if (!anonKey) throw new Error('SUPABASE_ANON_KEY is required for the restart subscriber');
  const client = createClient(apiConfig.supabase.url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  realtime = client;
  await client.realtime.setAuth(anonKey);
  const via = { broadcast: 0, 'catch-up': 0, buffer: 0 };
  const catchUps: Array<{ from: number; to: number; pages: number }> = [];
  const sub = new GameSubscriber(gameId, api, {
    onChange: (_c, how) => {
      via[how]++;
    },
    onCatchUp: (info) => catchUps.push({ from: info.from, to: info.to, pages: info.pages }),
  });
  // The app's channel handling: the first SUBSCRIBED starts the subscriber (snapshot + buffer); any
  // later SUBSCRIBED (a rejoin after the socket dropped) runs its reconnect, i.e. /changes from
  // its last seq. The test never calls reconnect() itself.
  let started = false;
  let channel: RealtimeChannel | null = null;
  const join = () =>
    new Promise<void>((resolve, reject) => {
      const ch = client.channel(gameChannel(gameId), { config: { private: true } });
      channel = ch;
      ch.on('broadcast', { event: '*' }, (m) =>
        sub.handleMessage({ event: m.event, payload: m.payload }),
      );
      ch.subscribe((status, err) => {
        if (status === 'SUBSCRIBED') {
          if (!started) {
            started = true;
            sub.start().then(resolve, reject);
          } else {
            void sub.reconnect();
            resolve();
          }
        }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT')
          reject(new Error(`${status}: ${err?.message}`));
      });
    });
  const drop = async () => {
    if (channel) await client.removeChannel(channel);
    channel = null;
  };
  await join();
  return { sub, via, catchUps, rejoin: join, drop };
}

beforeAll(async () => {
  await db`select 1`;
  // 12 demo minutes before the slot at the moment the first process starts.
  epoch = epochFor(slot.tipOffMs - 12 * 60_000, Date.now() + 2_000, SPEED);
  const [prev] = await db<{ id: string }[]>`
    select id from public.games where league = 'wnba' and provider_game_id = ${slot.providerGameId}`;
  if (prev)
    await purgeReplayGames(db, silentLog, {
      olderThan: null,
      dryRun: false,
      gameIds: [prev.id],
      listingHorizonMs: 0,
      now: () => new Date(slot.tipOffMs + 2 * 86_400_000),
    });
});
afterAll(async () => {
  for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
  await realtime?.removeAllChannels();
  rmSync(dir, { recursive: true, force: true });
  await db.end();
});

describe('demo restart continuity', () => {
  it('SIGKILL mid-game: the same provider game id resumes as a new generation, closes, and equals the slot replayed polling-only', async () => {
    const [started] = await db<{ at: Date }[]>`select now() as at`;
    const first = startDemo();
    const listed = await until('the slot to be listed', gameRow, 120_000, first);
    // The app's subscriber connects before the game starts and stays connected throughout.
    const client = await connectSubscriber(listed.id);
    const mid = await until(
      'the replay to reach mid-game',
      async () => {
        const g = await gameRow();
        return g && g.events >= 120 && g.status === 'inprogress' ? g : null;
      },
      180_000,
      first,
    );
    // The app loses its socket first (the gap is real: nothing reaches it until it rejoins).
    await client.drop();
    await client.sub.idle();
    const dropSeq = client.sub.lastSeq;
    const catchUpAppliedAtDrop = client.via['catch-up'];
    const catchUpsAtDrop = client.catchUps.length;
    expect(dropSeq).toBeGreaterThan(0);
    first.child.kill('SIGKILL');
    expect(await first.exited).toBeNull(); // killed, no exit code
    const firstWatch = mid.watchRunId;
    expect(firstWatch).not.toBeNull();

    const second = startDemo();
    await until(
      'the restarted worker to take the lock',
      async () => (second.out.join('').includes('WORKER_PID=') ? true : null),
      60_000,
      second,
    );
    // Rejoin only once the restarted worker has published changes past the drop (its startup
    // drain and the resumed watch): those seqs exist only through /changes for this client.
    const publishedMax = await until(
      'changes past the drop to be published',
      async () => {
        const [o] = await db<{ max: string | null }[]>`
          select max(seq)::text as max from ingest.broadcast_outbox
          where game_id = ${mid.id} and published_at is not null and seq > ${dropSeq}`;
        return o?.max ? Number(o.max) : null;
      },
      120_000,
      second,
    );
    await client.rejoin(); // its SUBSCRIBED handler runs the reconnect (the app's normal path)
    const recovery = await until(
      'the rejoined subscriber to catch up through /changes',
      async () =>
        client.catchUps.slice(catchUpsAtDrop).find((c) => c.from === dropSeq && c.to > c.from) ??
        null,
      30_000,
      second,
    );
    expect(recovery.to).toBeGreaterThanOrEqual(publishedMax);
    expect(client.via['catch-up'] - catchUpAppliedAtDrop).toBeGreaterThan(0);
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

    // No Sportradar traffic: EVERY provider call since the demo started (schedule polls with no
    // game included) went to the demo host, never counted.
    const calls = await db<{ url: string; source: string; counted: boolean }[]>`
      select url, source::text as source, quota_counted as counted
      from ingest.provider_calls where called_at >= ${started?.at ?? new Date(0)}`;
    expect(calls.length).toBeGreaterThan(10);
    for (const c of calls) {
      expect(c.url.startsWith(`http://127.0.0.1:${PORT}/`)).toBe(true);
      expect(c).toMatchObject({ source: 'rehearsal', counted: false });
    }
    expect(calls.some((c) => c.url.includes('/schedule.json'))).toBe(true);

    // Convergence on the subscriber's own (broadcast, pulse, close) path: no reconnect from here.
    const final = await api.snapshot(closed.id);
    await until(
      'the subscriber to reach the final seq by itself',
      async () => (client.sub.lastSeq >= final.seq && client.sub.finalSnapshot ? true : null),
      60_000,
    );
    await client.sub.idle();
    expect(client.sub.lastSeq).toBe(final.seq);
    const seqs = client.sub.applied.map((c) => c.seq);
    expect(seqs.every((q, i) => i === 0 || q === (seqs[i - 1] ?? 0) + 1)).toBe(true);
    if (!client.sub.state) throw new Error('subscriber has no state');
    expect(canonicalState(client.sub.state)).toBe(canonicalState(stateFromSnapshot(final)));
    expect(client.sub.state).toEqual(stateFromSnapshot(final));
    expect(final.game.replay).toBe('recorded');
    expect(final.game.status).toBe('closed');

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
    // Housekeeping: nobody subscribes to the comparison game; its rows must not reach the next
    // file that drains the whole outbox to the real Realtime (realtime-auth).
    await db`update ingest.broadcast_outbox set published_at = now()
             where game_id = ${watcher.gameId} and published_at is null`;
  }, 600_000);
});
