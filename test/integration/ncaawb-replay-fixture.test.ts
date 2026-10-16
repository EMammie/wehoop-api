import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GameWatcher, replayRecording } from '../../src/ingest/game-watcher.js';
import { GzipLineWriter, readRecording, readRecordingLines } from '../../src/ingest/recording.js';
import type { RunHandle } from '../../src/ingest/runs.js';
import { ncaawbAdapter } from '../../src/leagues/ncaawb/adapter.js';
import { BoxscoreDocumentSchema } from '../../src/providers/sportradar/schemas/boxscore.js';
import { counts, replayRun, silentLog, staleReasons, testDb } from '../helpers/db.js';

/**
 * The committed NCAAWB compact replay fixture through the worker path (plan §7
 * M2 "per-league fixture replay row counts"). Mirrors the WNBA test: the
 * provider game id is rewritten per run so the validator's replay of the real
 * game in the same database is never touched. The expected final score is
 * read from the fixture's own last boxscore, never hard-coded.
 */
const FIXTURE = new URL(
  '../../fixtures/ncaawb/sim-d9b71fe0-replay.compact.jsonl.gz',
  import.meta.url,
).pathname;
const REAL_GAME_ID = '2e36b340-9277-4b99-af20-b7ff7e86640e';
const db = testDb();
const deps = { db, log: silentLog };
const dir = mkdtempSync(join(tmpdir(), 'wehoop-ncaawb-replay-'));
const COPY = join(dir, 'replay.jsonl.gz');
const testGameId = `test-${randomUUID()}`;

async function replay(run: RunHandle) {
  const watcher = new GameWatcher({
    db,
    log: silentLog,
    adapter: ncaawbAdapter,
    run,
    apply: deps,
    pulse: null,
  });
  const out = await replayRecording(watcher, COPY, silentLog, {
    paceMs: 0,
    isStopped: () => false,
    maxDocs: null,
  });
  if (!watcher.gameId) throw new Error('replay created no game');
  return { ...out, gameId: watcher.gameId, watcher };
}

let gameId = '';
let firstPass: Awaited<ReturnType<typeof replay>>;
let total = 0;
let finalBox: { home: number; away: number } | null = null;

beforeAll(async () => {
  await db`select 1`;
  const writer = new GzipLineWriter(COPY);
  for await (const line of readRecordingLines(FIXTURE)) {
    if (!line.includes(REAL_GAME_ID)) throw new Error('fixture line without the game id');
    await writer.write(line.replaceAll(REAL_GAME_ID, testGameId));
  }
  await writer.close();
  for await (const line of readRecording(COPY)) {
    total++;
    if (line.feed === 'boxscore') {
      const b = BoxscoreDocumentSchema.parse(line.body);
      finalBox = { home: b.home.points ?? 0, away: b.away.points ?? 0 };
    }
  }
  firstPass = await replay(await replayRun(db));
  gameId = firstPass.gameId;
});
afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await db.end();
});

describe('NCAAWB committed replay fixture through the worker path', () => {
  it('consumes every document, closes the game, and the final score matches the recording boxscore', async () => {
    expect(total).toBeGreaterThan(50);
    expect(firstPass.docs).toBe(total);
    expect(firstPass.status).toBe('closed');
    if (!finalBox) throw new Error('fixture has no boxscore');
    const c = await counts(db, gameId);
    expect(c).toMatchObject({ home: finalBox.home, away: finalBox.away });
    expect(c.changes).toBe(c.lastSeq);
    expect(c.outbox).toBe(c.changes);
    expect(c.events).toBeGreaterThan(200);
    const [g] = await db<{ coverage: string; season: string; periods: number; players: number }[]>`
      select g.coverage::text as coverage, s.type::text || s.year::text as season,
             (select count(*)::int from public.game_periods p where p.game_id = g.id) as periods,
             (select count(*)::int from public.game_player_stats p where p.game_id = g.id) as players
      from public.games g join public.seasons s on s.id = g.season_id where g.id = ${gameId}`;
    expect(g).toMatchObject({ coverage: 'full', season: 'REG2025' });
    expect(g?.periods).toBeGreaterThanOrEqual(4);
    expect(g?.players).toBeGreaterThan(15);
    // every attributed play resolved to a canonical player
    const [unresolved] = await db<{ n: number }[]>`
      select count(*)::int as n from public.play_events
      where game_id = ${gameId} and player_id is null and payload ? 'providerPlayerId'`;
    expect(unresolved?.n).toBe(0);
  });

  it('no regression: re-running the fixture as a new run writes 0 new changes (stats included), score unchanged, stale rows logged', async () => {
    const before = await counts(db, gameId);
    const second = await replay(await replayRun(db));
    expect(second.docs).toBe(total);
    const after = await counts(db, gameId);
    expect(after.changes).toBe(before.changes);
    expect(after.lastSeq).toBe(before.lastSeq);
    expect(after).toMatchObject({ home: before.home, away: before.away });
    expect((await staleReasons(db, gameId)).run_regresses_state ?? 0).toBeGreaterThan(0);
    expect(second.watcher.applied).toBe(0);
  });
});
