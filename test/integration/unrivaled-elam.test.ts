import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/server.js';
import { loadConfig } from '../../src/config.js';
import { GameWatcher, replayRecording } from '../../src/ingest/game-watcher.js';
import { readRecordingLines } from '../../src/ingest/recording.js';
import { ReferenceIngester } from '../../src/ingest/reference.js';
import { unrivaledAdapter } from '../../src/leagues/unrivaled/adapter.js';
import { buildPulse } from '../../src/live/pulse.js';
import { applyChange, canonicalState, stateFromSnapshot } from '../../src/model/game-state.js';
import { ChangesPageSchema, SnapshotSchema } from '../../src/model/snapshot.js';
import { counts, replayRun, silentLog, testDb } from '../helpers/db.js';

/**
 * The hand-assembled Unrivaled replay (fixtures/unrivaled/README.md) through
 * the worker path: Elam period row + target, null clock with clock_running
 * false, stats_player with canonical ids, player_id on play rows, and a
 * snapshot/changes fold that agrees. The game id is rewritten per run.
 */
const FIXTURE = new URL('../../fixtures/unrivaled/docs-838316ea-replay.jsonl', import.meta.url)
  .pathname;
const REAL_GAME_ID = '838316ea-ab7b-4581-a1dd-74229d1970d5';
const db = testDb();
const app = createApp({ db, config: loadConfig({ ...process.env, MODE: 'sim' }), log: silentLog });
const dir = mkdtempSync(join(tmpdir(), 'wehoop-elam-'));
const COPY = join(dir, 'replay.jsonl');
const testGameId = `test-${randomUUID()}`;
let gameId = '';

beforeAll(async () => {
  await db`select 1`;
  const lines: string[] = [];
  for await (const line of readRecordingLines(FIXTURE))
    lines.push(line.replaceAll(REAL_GAME_ID, testGameId));
  writeFileSync(COPY, `${lines.join('\n')}\n`);
  const watcher = new GameWatcher({
    db,
    log: silentLog,
    adapter: unrivaledAdapter,
    run: await replayRun(db),
    apply: { db, log: silentLog },
    pulse: null,
  });
  const out = await replayRecording(watcher, COPY, silentLog, {
    paceMs: 0,
    isStopped: () => false,
    maxDocs: null,
    reference: new ReferenceIngester({
      db,
      log: silentLog,
      league: 'unrivaled',
      source: 'fixture',
      runSource: 'fixture',
    }),
  });
  expect(out).toMatchObject({ docs: 8, referenceDocs: 3, status: 'closed' });
  if (!watcher.gameId) throw new Error('no game');
  gameId = watcher.gameId;
});
afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await db.end();
});

describe('Unrivaled Elam game through the worker path', () => {
  it('games: closed 80-84, period 4 of type elam, elam_target_score 84, clock null, clock_running false, Elam clock fields in clock_extra', async () => {
    const [g] = await db<Record<string, unknown>[]>`
      select status::text as status, home_points as home, away_points as away, current_period as period, period_type::text as "periodType",
             elam_target_score as target, clock, clock_running as "clockRunning", clock_extra as "clockExtra", title,
             (select type::text from public.seasons s where s.id = games.season_id) as season
      from public.games where id = ${gameId}`;
    expect(g).toMatchObject({
      status: 'closed',
      home: 80,
      away: 84,
      period: 4,
      periodType: 'elam',
      target: 84,
      clock: null,
      clockRunning: false,
      season: 'REG',
    });
    expect(g?.clockExtra).toEqual({ clockType: 'elam', clockDirectional: '+00:19' });
  });

  it('game_periods carries the elam row with its score', async () => {
    const rows = await db<
      { sequence: number; number: number; type: string; home: number; away: number }[]
    >`
      select sequence, number, type::text as type, home_points as home, away_points as away
      from public.game_periods where game_id = ${gameId} order by sequence`;
    expect(rows).toEqual([
      { sequence: 1, number: 1, type: 'quarter', home: 20, away: 19 },
      { sequence: 4, number: 4, type: 'elam', home: 7, away: 17 },
    ]);
  });

  it('status changes carry elamTargetScore from the Elam period on; event rows carry canonical player ids; stats_player emitted with uuids', async () => {
    const changes = await db<{ seq: number; type: string; body: Record<string, unknown> }[]>`
      select seq::int as seq, change_type::text as type, body from public.game_changes where game_id = ${gameId} order by seq`;
    const statuses = changes.filter((c) => c.type === 'status').map((c) => c.body);
    expect(statuses.map((b) => b.elamTargetScore)).toEqual([undefined, 84, 84]);
    expect(statuses[2]).toMatchObject({
      status: 'closed',
      score: { home: 80, away: 84 },
      period: { type: 'elam', sequence: 4 },
    });
    const byType = Object.fromEntries(
      [...new Set(changes.map((c) => c.type))].map((t) => [
        t,
        changes.filter((c) => c.type === t).length,
      ]),
    );
    expect(byType).toEqual({
      event_insert: 4,
      status: 3,
      period: 3,
      stats_team: 1,
      stats_player: 1,
    });
    const sp = changes.find((c) => c.type === 'stats_player')?.body as {
      playerId: string;
      providerPlayerId: string;
      fullName: string;
    };
    expect(sp.providerPlayerId).toBe('a00515fd-bdd9-44d1-83a5-597a99316c54');
    expect(sp.fullName).toBe('Breanna Stewart');
    const [ext] = await db<{ playerId: string }[]>`
      select player_id as "playerId" from public.player_external_ids where league = 'unrivaled' and external_id = ${sp.providerPlayerId}`;
    expect(ext?.playerId).toBe(sp.playerId);
    const events = await db<{ type: string; hasPlayer: boolean; hasTeam: boolean }[]>`
      select event_type as type, player_id is not null as "hasPlayer", team_id is not null as "hasTeam"
      from public.play_events where game_id = ${gameId} order by period_sequence, provider_sequence`;
    expect(events).toEqual([
      { type: 'shot', hasPlayer: true, hasTeam: true },
      { type: 'shot', hasPlayer: true, hasTeam: true },
      { type: 'rebound', hasPlayer: false, hasTeam: true }, // team rebound
      { type: 'shot', hasPlayer: true, hasTeam: true },
    ]);
    const c = await counts(db, gameId);
    expect(c.changes).toBe(c.lastSeq);
    expect(c.outbox).toBe(c.changes);
  });

  it('pulse: clock null, clockRunning false, status closed', async () => {
    const pulse = await buildPulse(db, gameId);
    expect(pulse).toMatchObject({
      status: 'closed',
      clock: null,
      clockRunning: false,
      latestSeq: (await counts(db, gameId)).lastSeq,
    });
  });

  it('snapshot carries elamTargetScore and playerStats; folding /changes reproduces it', async () => {
    const snapRes = await app.request(`/v1/games/${gameId}/snapshot`);
    expect(snapRes.status).toBe(200);
    const snap = SnapshotSchema.parse(await snapRes.json());
    expect(snap.game.elamTargetScore).toBe(84);
    expect(snap.game.period).toEqual({ number: 4, type: 'elam', sequence: 4 });
    expect(snap.playerStats).toHaveLength(1);
    expect(snap.playerStats[0]).toMatchObject({
      fullName: 'Breanna Stewart',
      providerPlayerId: 'a00515fd-bdd9-44d1-83a5-597a99316c54',
      stats: { points: 6, rebounds: 13 },
    });
    const page = ChangesPageSchema.parse(
      await (await app.request(`/v1/games/${gameId}/changes?limit=500`)).json(),
    );
    const folded = stateFromSnapshot({
      ...snap,
      events: [],
      periods: [],
      teamStats: [],
      playerStats: [],
      game: { ...snap.game, status: 'scheduled', score: { home: 0, away: 0 }, period: null },
    });
    for (const ch of page.changes) applyChange(folded, ch);
    expect(canonicalState(folded)).toBe(canonicalState(stateFromSnapshot(snap)));
  });

  it('replaying the same file as a new generation writes 0 new changes', async () => {
    const before = await counts(db, gameId);
    const watcher = new GameWatcher({
      db,
      log: silentLog,
      adapter: unrivaledAdapter,
      run: await replayRun(db),
      apply: { db, log: silentLog },
      pulse: null,
    });
    await replayRecording(watcher, COPY, silentLog, {
      paceMs: 0,
      isStopped: () => false,
      maxDocs: null,
      reference: new ReferenceIngester({
        db,
        log: silentLog,
        league: 'unrivaled',
        source: 'fixture',
        runSource: 'fixture',
      }),
    });
    const after = await counts(db, gameId);
    expect(after.changes).toBe(before.changes);
    expect(watcher.applied).toBe(0);
  });
});
