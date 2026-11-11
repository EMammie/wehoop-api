import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { purgeReplayGames } from '../../src/ingest/demo-purge.js';
import { GameWatcher, replayRecording } from '../../src/ingest/game-watcher.js';
import { endRun, startRun } from '../../src/ingest/runs.js';
import { wnbaAdapter } from '../../src/leagues/wnba/adapter.js';
import type { Logger } from '../../src/logger.js';
import {
  DEFAULT_INTERVAL_MS,
  type DemoHost,
  PgProvenanceStore,
  ProvenanceConflictError,
  type RotationEntry,
  rotationFor,
  SLOT_ORIGIN_MS,
  type Slot,
  slotAt,
  slotRecording,
  startDemoHost,
} from '../../src/providers/sportradar/demo-host.js';
import { silentLog, testDb } from '../helpers/db.js';

/**
 * Redeploy path A (review of the aligned demo fixtures): slots listed under the compact rotation
 * are re-pointed to the aligned demo files when the rotation switches, but only while unplayed;
 * a played slot keeps its provenance and answers 409. Dev stack (`ingest.replay_slots` +
 * `public.games` through the ordinary watcher).
 */
const db = testDb();
const dir = mkdtempSync(join(tmpdir(), 'wehoop-repoint-'));
const DEMO = rotationFor({ leagues: ['wnba'] });
const demoEntry = DEMO[0] as RotationEntry;
const COMPACT: RotationEntry[] = [
  { ...demoEntry, fixture: demoEntry.fixture.replace('.demo.', '.compact.') },
];
// Far ahead and on a grid of its own: no other test or scheduler range touches these slots.
const TIP = Date.UTC(2027, 2, 10, 23, 0);
const K = Math.round((TIP - SLOT_ORIGIN_MS) / DEFAULT_INTERVAL_MS);
const [A, B, C, D] = [0, 1, 2, 3].map((i) => slotAt(K + i, DEMO, DEFAULT_INTERVAL_MS)) as [
  Slot,
  Slot,
  Slot,
  Slot,
];
const ids = [A, B, C, D].map((s) => s.providerGameId);
let now = TIP - 60 * 60_000;
const clock = { now: () => now, speed: 1, epochMs: 0 };
const warnings: string[] = [];
const log = new Proxy(silentLog, {
  get(target, prop, receiver) {
    if (prop === 'warn')
      return (o: unknown, msg?: string) => {
        if (msg)
          warnings.push(msg.startsWith('replay slot not') ? `${msg} ${JSON.stringify(o)}` : msg);
      };
    return Reflect.get(target, prop, receiver);
  },
}) as Logger;

/**
 * Remove the test's games WITH their provenance rows. The watcher here runs without a publisher,
 * so its outbox rows stay unpublished and purge would skip those games (leaving them labelled
 * with no provenance row, which `replay_games_have_matching_provenance` catches): they are marked
 * published first. A provenance row is deleted directly only for a slot that has no game row.
 */
async function clean() {
  const games = await db<{ id: string }[]>`
    select id from public.games where league = 'wnba' and provider_game_id in ${db(ids)}`;
  if (games.length) {
    const gameIds = games.map((g) => g.id);
    await db`update ingest.broadcast_outbox set published_at = now()
             where game_id in ${db(gameIds)} and published_at is null`;
    const out = await purgeReplayGames(db, silentLog, {
      olderThan: null,
      dryRun: false,
      gameIds,
      listingHorizonMs: 0,
      now: () => new Date(TIP + 30 * 86_400_000),
    });
    expect(out.purged.map((p) => p.gameId).sort()).toEqual([...gameIds].sort());
  }
  await db`delete from ingest.replay_slots s
           where s.league = 'wnba' and s.provider_game_id in ${db(ids)}
             and not exists (select 1 from public.games g
                             where g.league = s.league and g.provider_game_id = s.provider_game_id)`;
  const [left] = await db<{ games: number; slots: number }[]>`
    select (select count(*)::int from public.games where provider_game_id in ${db(ids)}) as games,
           (select count(*)::int from ingest.replay_slots where provider_game_id in ${db(ids)}) as slots`;
  expect(left).toEqual({ games: 0, slots: 0 });
}
const shaOf = async (id: string) =>
  (
    await db<{ sha: string; path: string }[]>`
      select fixture_sha256 as sha, fixture_path as path from ingest.replay_slots
      where league = 'wnba' and provider_game_id = ${id}`
  )[0];

/** The first `docs` documents a compact-rotation host serves for `slot`, through the watcher. */
async function playFirst(host: DemoHost, slot: Slot, docs: number) {
  const rec = host.recordings.get(slot.entry.rec8);
  if (!rec) throw new Error('recording not loaded');
  const file = join(dir, `${slot.providerGameId}.jsonl`);
  writeFileSync(
    file,
    `${slotRecording(rec, slot)
      .map((l) => JSON.stringify(l))
      .join('\n')}\n`,
  );
  const run = await startRun(db, {
    kind: 'replay',
    league: 'wnba',
    gameId: null,
    source: 'fixture',
    meta: { test: 'demo-repoint' },
  });
  const watcher = new GameWatcher({
    db,
    log: silentLog,
    adapter: wnbaAdapter,
    run,
    apply: { db, log: silentLog },
    pulse: null,
  });
  await replayRecording(watcher, file, silentLog, {
    paceMs: 0,
    isStopped: () => false,
    maxDocs: docs,
  });
  await endRun(db, run.id, 'ok');
}

beforeAll(async () => {
  await clean();
});
afterAll(async () => {
  await clean();
  rmSync(dir, { recursive: true, force: true });
  await db.end();
});

describe('re-pointing unplayed replay slots to a new fixture', () => {
  it('compact slots listed, rotation switched: unplayed slots re-pointed, a played slot still 409', async () => {
    // 1. The old deploy: the compact rotation writes provenance for four slots; slot A is played
    //    into (game inprogress with plays), slot C is watched pregame only (game row, no plays).
    const old = await startDemoHost({
      rotation: COMPACT,
      clock,
      provenance: new PgProvenanceStore(db),
      minSpacingMs: 0,
      log: silentLog,
    });
    const compactSha = old.recordings.get('93ee7c68')?.sha256 ?? '';
    // The old host's own slots (same ids and tip-offs, its rotation entry: the compact file).
    const asOld = (s: Slot) => slotAt(s.k, COMPACT, DEFAULT_INTERVAL_MS);
    for (const s of [A, B, C, D]) await old.ensureProvenance(asOld(s));
    expect((await shaOf(A.providerGameId))?.path).toBe(COMPACT[0]?.fixture);
    await playFirst(old, A, 60);
    await playFirst(old, C, 3);
    await old.close();
    const [gA] = await db<{ status: string; events: number }[]>`
      select g.status::text as status, (select count(*)::int from public.play_events p where p.game_id = g.id) as events
      from public.games g where g.provider_game_id = ${A.providerGameId}`;
    expect(gA?.status).toBe('inprogress');
    expect(gA?.events).toBeGreaterThan(0);
    const [gC] = await db<{ status: string; events: number; lastSeq: string }[]>`
      select g.status::text as status, g.last_seq::text as "lastSeq",
             (select count(*)::int from public.play_events p where p.game_id = g.id) as events
      from public.games g where g.provider_game_id = ${C.providerGameId}`;
    expect(gC).toMatchObject({ status: 'created', events: 0 });
    const before = Object.fromEntries(
      await Promise.all(ids.map(async (id) => [id, (await shaOf(id))?.sha])),
    );
    for (const id of ids) expect(before[id]).toBe(compactSha);

    // 2. The new deploy, 30 min before A's tip-off (every slot before its bound by time).
    now = TIP - 30 * 60_000;
    const host = await startDemoHost({
      rotation: DEMO,
      clock,
      provenance: new PgProvenanceStore(db),
      minSpacingMs: 0,
      log,
    });
    const demoSha = host.recordings.get('93ee7c68')?.sha256 ?? '';
    expect(demoSha).not.toBe(compactSha);
    const key = { headers: { 'x-api-key': 'demo-mode-no-key' } };
    const pbp = (s: Slot) =>
      fetch(`${host.url}/wnba/production/v8/en/games/${s.providerGameId}/pbp.json`, key);
    try {
      // A has plays: refused (409), provenance unchanged.
      await expect(host.ensureProvenance(A)).rejects.toThrow(ProvenanceConflictError);
      expect((await pbp(A)).status).toBe(409);
      expect((await shaOf(A.providerGameId))?.sha).toBe(compactSha);
      // B (no game row) and C (pregame game row, last_seq may be > 0): re-pointed, served.
      expect((await pbp(B)).status, warnings.join(' | ')).toBe(200);
      expect((await pbp(C)).status).toBe(200);
      expect(await shaOf(B.providerGameId)).toEqual({ sha: demoSha, path: demoEntry.fixture });
      expect(await shaOf(C.providerGameId)).toEqual({ sha: demoSha, path: demoEntry.fixture });
      expect(host.stats.repointed).toBe(2);
      expect(
        warnings.filter((w) => w === 'replay slot re-pointed to a new fixture before play'),
      ).toHaveLength(2);
      // D, asked first after its bound (tip-off + first document): refused, unchanged.
      now = D.tipOffMs + (host.recordings.get('93ee7c68')?.startOffsetMs ?? 0);
      expect((await pbp(D)).status).toBe(409);
      expect((await shaOf(D.providerGameId))?.sha).toBe(compactSha);
      const after = Object.fromEntries(
        await Promise.all(ids.map(async (id) => [id, (await shaOf(id))?.sha])),
      );
      // The handoff's evidence line (vitest shows a test's stdout).
      process.stdout.write(
        `REPOINT_EVIDENCE ${JSON.stringify({
          compactSha,
          demoSha,
          slots: ids.map((id) => ({ id, before: before[id], after: after[id] })),
          gameA: gA,
          gameC: gC,
          statusA409: true,
          statusD409: true,
        })}\n`,
      );
    } finally {
      await host.close();
    }
  });
});
