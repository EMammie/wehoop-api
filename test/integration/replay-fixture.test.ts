import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GameWatcher, replayRecording } from '../../src/ingest/game-watcher.js';
import { readRecording } from '../../src/ingest/recording.js';
import type { RunHandle } from '../../src/ingest/runs.js';
import type { NormalizedDocument } from '../../src/ingest/types.js';
import { wnbaAdapter } from '../../src/leagues/wnba/adapter.js';
import { contentHash } from '../../src/model/content-hash.js';
import { SummaryDocumentSchema } from '../../src/providers/sportradar/schemas/summary.js';
import {
  apply,
  counts,
  observation,
  replayRun,
  silentLog,
  staleReasons,
  testDb,
} from '../helpers/db.js';

/**
 * The committed compact replay fixture, end to end through a real GameWatcher
 * (plan §7 "Reproducible replay", §8 "no regression"). The provider game id is
 * the real one, so this file owns that game row for the test database.
 */
const FIXTURE = new URL('../../fixtures/wnba/sim-93ee7c68-replay.compact.jsonl.gz', import.meta.url)
  .pathname;
const db = testDb();
const deps = { db, log: silentLog };

async function replay(run: RunHandle) {
  const watcher = new GameWatcher({
    db,
    log: silentLog,
    adapter: wnbaAdapter,
    run,
    apply: deps,
    pulse: null,
  });
  const out = await replayRecording(watcher, FIXTURE, silentLog, {
    paceMs: 0,
    untilClosed: true,
    isStopped: () => false,
    maxDocs: null,
  });
  if (!watcher.gameId) throw new Error('replay created no game');
  return { ...out, gameId: watcher.gameId, watcher };
}

let gameId = '';
let firstPass: Awaited<ReturnType<typeof replay>>;
let lastSummary: NormalizedDocument | null = null;
let total = 0;

beforeAll(async () => {
  await db`select 1`;
  await db`delete from public.games where provider_game_id = '40bea3f6-68c0-4f3b-96fa-336dfb7a9034'`;
  for await (const line of readRecording(FIXTURE)) {
    total++;
    if (line.feed === 'summary')
      lastSummary = wnbaAdapter.normalizeSummary(SummaryDocumentSchema.parse(line.body));
  }
  firstPass = await replay(await replayRun(db));
  gameId = firstPass.gameId;
});
afterAll(async () => {
  await db.end();
});

describe('committed replay fixture through the worker path', () => {
  it('consumes every document, including the summary and boxscore after the first closed pbp', async () => {
    expect(total).toBe(158);
    expect(firstPass.docs).toBe(total);
    expect(firstPass.status).toBe('closed');
    const c = await counts(db, gameId);
    expect(c).toMatchObject({ home: 93, away: 85 }); // LVA 85 at NYL 93, the recording's boxscore
    expect(c.changes).toBe(c.lastSeq);
    expect(c.outbox).toBe(c.changes);
  });

  it("final game_team_stats equal the last summary document's statistics", async () => {
    if (!lastSummary) throw new Error('fixture has no summary document');
    const rows = await db<{ contentHash: string; observedAt: Date }[]>`
      select content_hash as "contentHash", observed_at as "observedAt"
      from public.game_team_stats where game_id = ${gameId}`;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.contentHash).sort()).toEqual(
      lastSummary.batch.teamStats.map((t) => contentHash(t.stats)).sort(),
    );
    for (const r of rows) expect(r.observedAt).toBeInstanceOf(Date);
  });

  it('no regression: re-running the fixture as a new run writes 0 new changes (stats included), score unchanged, stale rows logged', async () => {
    const before = await counts(db, gameId);
    const second = await replay(await replayRun(db));
    expect(second.docs).toBe(total);
    const after = await counts(db, gameId);
    expect(after.changes).toBe(before.changes);
    expect(after.lastSeq).toBe(before.lastSeq);
    expect(after).toMatchObject({ home: before.home, away: before.away });
    const reasons = await staleReasons(db, gameId);
    expect(reasons.run_regresses_state ?? 0).toBeGreaterThan(0);
    expect(second.watcher.applied).toBe(0);
  });

  it('an official correction on the closed game (later observedAt, differing stats) is exactly one stats_team change', async () => {
    if (!lastSummary) throw new Error('fixture has no summary document');
    const before = await counts(db, gameId);
    const run = await replayRun(db, gameId);
    const home = lastSummary.batch.teamStats.find((t) => t.isHome);
    if (!home) throw new Error('no home stats');
    const corrected: NormalizedDocument = {
      ...lastSummary,
      batch: {
        ...lastSummary.batch,
        teamStats: lastSummary.batch.teamStats.map((t) =>
          t.isHome ? { ...t, stats: { ...t.stats, assists: (t.stats.assists ?? 0) + 1 } } : t,
        ),
      },
    };
    const r = await apply(deps, gameId, corrected, observation(run, corrected, new Date()));
    expect(r.outcome === 'applied' && r.changes.map((c) => c.type)).toEqual(['stats_team']);
    expect(r.outcome === 'applied' && r.counts.touchedStats).toBe(1); // the away side: same hash, newer observation
    expect((await counts(db, gameId)).changes).toBe(before.changes + 1);
    // the same correction re-presented with an OLDER observedAt is ignored, not re-applied
    const older = await apply(
      deps,
      gameId,
      lastSummary,
      observation(run, lastSummary, new Date(Date.now() - 3_600_000)),
    );
    expect(older.outcome === 'applied' && older.changes).toEqual([]);
    expect(older.outcome === 'applied' && older.counts.ignoredOlderStats).toBe(2);
  });
});
