import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GameWatcher, replayRecording } from '../../src/ingest/game-watcher.js';
import { readRecording, relabelRecording } from '../../src/ingest/recording.js';
import { ncaawbAdapter } from '../../src/leagues/ncaawb/adapter.js';
import { BoxscoreDocumentSchema } from '../../src/providers/sportradar/schemas/boxscore.js';
import { counts, replayRun, silentLog, testDb } from '../helpers/db.js';

/**
 * The committed extended_boxscore NCAAWB replay fixture (a documented
 * re-labelling of the recorded `full` game; fixtures/ncaawb/README.md) through
 * the worker path: an extended-coverage game produces zero event_* changes and
 * zero stats_* changes until the closing document, then its stats once, at
 * `stats_final_at` (plan §2 league quirks, §7 M3 acceptance).
 */
const FIXTURE = new URL(
  '../../fixtures/ncaawb/sim-d9b71fe0-replay.extended.jsonl.gz',
  import.meta.url,
).pathname;
const EXT_ID = 'e5e5e5e5-9277-4b99-af20-b7ff7e86640e';
const db = testDb();
const dir = mkdtempSync(join(tmpdir(), 'wehoop-ext-replay-'));
const COPY = join(dir, 'replay.jsonl.gz');
const testGameId = `test-${randomUUID()}`;
let total = 0;
let finalBox: { home: number; away: number } | null = null;
let gameId = '';

beforeAll(async () => {
  await db`select 1`;
  await relabelRecording(FIXTURE, COPY, {
    coverage: 'extended_boxscore',
    gameId: { from: EXT_ID, to: testGameId },
  });
  for await (const line of readRecording(COPY)) {
    total++;
    if (line.feed === 'boxscore') {
      const b = BoxscoreDocumentSchema.parse(line.body);
      finalBox = { home: b.home.points ?? 0, away: b.away.points ?? 0 };
    }
  }
  const watcher = new GameWatcher({
    db,
    log: silentLog,
    adapter: ncaawbAdapter,
    run: await replayRun(db),
    apply: { db, log: silentLog },
    pulse: null,
  });
  const out = await replayRecording(watcher, COPY, silentLog, {
    paceMs: 0,
    isStopped: () => false,
    maxDocs: null,
  });
  expect(out.docs).toBe(total);
  if (!watcher.gameId) throw new Error('replay created no game');
  gameId = watcher.gameId;
});
afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await db.end();
});

describe('extended_boxscore replay fixture through the worker path', () => {
  it('status/period only while live, stats exactly once at close, never an event change', async () => {
    const c = await counts(db, gameId);
    if (!finalBox) throw new Error('fixture has no boxscore');
    expect(c).toMatchObject({ events: 0, deleted: 0, home: finalBox.home, away: finalBox.away });
    expect(c.changes).toBe(c.lastSeq);
    const types = await db<{ type: string; n: number; minSeq: string; maxSeq: string }[]>`
      select change_type::text as type, count(*)::int as n, min(seq)::text as "minSeq", max(seq)::text as "maxSeq"
      from public.game_changes where game_id = ${gameId} group by 1 order by 1`;
    const by = Object.fromEntries(types.map((t) => [t.type, t]));
    expect(Object.keys(by).sort()).toEqual(['period', 'stats_player', 'stats_team', 'status']);
    expect(by.status?.n).toBeGreaterThanOrEqual(3); // created -> inprogress -> halftime -> ... -> closed
    expect(by.period?.n).toBeGreaterThanOrEqual(4);
    // One pair per closing document whose team totals differed (summary, then boxscore).
    expect(by.stats_team?.n).toBeGreaterThanOrEqual(2);
    expect(by.stats_team?.n).toBeLessThanOrEqual(6);
    expect(by.stats_player?.n).toBeGreaterThan(10);
    const [closed] = await db<{ seq: string; statsFinalAt: Date | null }[]>`
      select (select min(seq) from public.game_changes where game_id = ${gameId}
               and change_type = 'status' and body->>'status' = 'closed')::text as seq,
             stats_final_at as "statsFinalAt"
      from public.games where id = ${gameId}`;
    expect(closed?.statsFinalAt).toBeInstanceOf(Date);
    // Every stats change is numbered after the closing status change: nothing stats-like leaked while live.
    expect(Number(by.stats_team?.minSeq)).toBeGreaterThan(Number(closed?.seq));
    expect(Number(by.stats_player?.minSeq)).toBeGreaterThan(Number(closed?.seq));
    const [g] = await db<{ coverage: string; periods: number; players: number }[]>`
      select g.coverage::text as coverage,
             (select count(*)::int from public.game_periods p where p.game_id = g.id) as periods,
             (select count(*)::int from public.game_player_stats p where p.game_id = g.id) as players
      from public.games g where g.id = ${gameId}`;
    expect(g).toMatchObject({ coverage: 'extended_boxscore' });
    expect(g?.periods).toBeGreaterThanOrEqual(4);
    expect(g?.players).toBe(by.stats_player?.n);
  });
});
