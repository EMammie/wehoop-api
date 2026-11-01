import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadChanges } from '../../src/api/routes/changes.js';
import { loadSnapshot } from '../../src/api/routes/snapshot.js';
import { GameWatcher, replayRecording } from '../../src/ingest/game-watcher.js';
import { GzipLineWriter, readRecordingLines } from '../../src/ingest/recording.js';
import { wnbaAdapter } from '../../src/leagues/wnba/adapter.js';
import type { GameChange } from '../../src/model/game-change.js';
import type { Snapshot } from '../../src/model/snapshot.js';
import { replayRun, silentLog, testDb } from '../helpers/db.js';

/**
 * The event ordering key (migration 0013, M5 S2): every event_insert / event_update
 * carries the provider sequence and number of its revision, and a client that sorts
 * the events it folded by (period sequence, providerSequence, providerNumber, wall
 * clock, providerEventId), nulls first, gets the snapshot's order. Proven on the WNBA
 * replay, whose arrival order differs from the snapshot's (the provider inserts plays
 * after the fact).
 */
const FIXTURE = new URL('../../fixtures/wnba/sim-93ee7c68-replay.compact.jsonl.gz', import.meta.url)
  .pathname;
const REAL_GAME_ID = '40bea3f6-68c0-4f3b-96fa-336dfb7a9034';
const db = testDb();
const dir = mkdtempSync(join(tmpdir(), 'wehoop-event-order-'));
const COPY = join(dir, 'replay.jsonl.gz');

type Positioned = {
  providerEventId: string;
  providerSequence: number | null;
  providerNumber: number | null;
  body: Snapshot['events'][number]['body'];
};

/** null sorts first, as `nulls first` does. */
const cmpNullable = (a: number | string | null, b: number | string | null): number => {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a < b ? -1 : 1;
};

function clientOrder(a: Positioned, b: Positioned): number {
  return (
    a.body.period.sequence - b.body.period.sequence ||
    cmpNullable(a.providerSequence, b.providerSequence) ||
    cmpNullable(a.providerNumber, b.providerNumber) ||
    cmpNullable(
      a.body.wallClock === null ? null : Date.parse(a.body.wallClock),
      b.body.wallClock === null ? null : Date.parse(b.body.wallClock),
    ) ||
    (a.providerEventId < b.providerEventId ? -1 : a.providerEventId > b.providerEventId ? 1 : 0)
  );
}

let gameId = '';
const changes: GameChange[] = [];
let snapshot: Snapshot;

beforeAll(async () => {
  const testGameId = `order-${randomUUID()}`;
  const writer = new GzipLineWriter(COPY);
  for await (const line of readRecordingLines(FIXTURE)) {
    await writer.write(line.replaceAll(REAL_GAME_ID, testGameId));
  }
  await writer.close();
  const watcher = new GameWatcher({
    db,
    log: silentLog,
    adapter: wnbaAdapter,
    run: await replayRun(db),
    apply: { db, log: silentLog },
    pulse: null,
  });
  await replayRecording(watcher, COPY, silentLog, {
    paceMs: 0,
    isStopped: () => false,
    maxDocs: null,
  });
  if (!watcher.gameId) throw new Error('replay created no game');
  gameId = watcher.gameId;
  let after = 0;
  for (;;) {
    const page = await loadChanges(db, gameId, after, 500);
    if (!page) throw new Error('no changes page');
    changes.push(...page.changes);
    if (!page.hasMore) break;
    after = page.nextAfter;
  }
  const snap = await loadSnapshot(db, gameId);
  if (!snap) throw new Error('no snapshot');
  snapshot = snap;
});
afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await db.end();
});

describe('event ordering key (0013)', () => {
  it('every event_insert / event_update carries the position its play_events row stores for that revision', async () => {
    const latest = new Map<
      string,
      { providerSequence: number | null; providerNumber: number | null }
    >();
    let carried = 0;
    for (const c of changes) {
      if (c.type === 'event_insert' || c.type === 'event_update') {
        expect(c.providerSequence, `seq ${c.seq}`).not.toBeUndefined();
        if (c.providerSequence !== null) carried++;
        latest.set(c.providerEventId, {
          providerSequence: c.providerSequence ?? null,
          providerNumber: c.providerNumber ?? null,
        });
      }
      if (c.type === 'status' || c.type === 'period') expect('providerSequence' in c).toBe(false);
    }
    expect(carried).toBeGreaterThan(400);
    const rows = await db<{ id: string; seq: string | null; num: number | null }[]>`
      select provider_event_id as id, provider_sequence::text as seq, provider_number as num
      from public.play_events where game_id = ${gameId} and deleted_at is null`;
    for (const r of rows) {
      expect(latest.get(r.id), r.id).toEqual({
        providerSequence: r.seq === null ? null : Number(r.seq),
        providerNumber: r.num,
      });
    }
  });

  it('folding the stream and sorting by the client key reproduces the snapshot order, which arrival order does not', () => {
    const folded = new Map<string, Positioned>();
    const arrival: string[] = [];
    for (const c of changes) {
      if (c.type === 'event_insert' || c.type === 'event_update') {
        if (!folded.has(c.providerEventId)) arrival.push(c.providerEventId);
        folded.set(c.providerEventId, {
          providerEventId: c.providerEventId,
          providerSequence: c.providerSequence ?? null,
          providerNumber: c.providerNumber ?? null,
          body: c.body,
        });
      } else if (c.type === 'event_delete') {
        folded.delete(c.providerEventId);
      }
    }
    const server = snapshot.events.map((e) => e.providerEventId);
    const sorted = [...folded.values()].sort(clientOrder).map((e) => e.providerEventId);
    expect(sorted).toEqual(server);
    expect(arrival.filter((id) => folded.has(id))).not.toEqual(server);
    expect(
      snapshot.events.map(({ providerEventId, providerSequence, providerNumber }) => ({
        providerEventId,
        providerSequence,
        providerNumber,
      })),
    ).toEqual(
      sorted.map((id) => {
        const e = folded.get(id);
        return {
          providerEventId: id,
          providerSequence: e?.providerSequence ?? null,
          providerNumber: e?.providerNumber ?? null,
        };
      }),
    );
  });
});
