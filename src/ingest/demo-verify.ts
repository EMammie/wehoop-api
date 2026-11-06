import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSnapshot } from '../api/routes/snapshot.js';
import type { Db } from '../db/client.js';
import { LeagueCodeSchema } from '../leagues/codes.js';
import { adapterFor } from '../leagues/registry.js';
import type { Logger } from '../logger.js';
import { canonicalJson } from '../model/content-hash.js';
import type { Snapshot } from '../model/snapshot.js';
import {
  loadRecording,
  RECORDED_ROTATION,
  type RotationEntry,
  type Slot,
  SYNTHETIC_ROTATION,
  slotRecording,
} from '../providers/sportradar/demo-host.js';
import { CHECK_ID_PREFIX, purgeCheckGame } from './demo-purge.js';
import { GameWatcher, replayRecording } from './game-watcher.js';
import { endRun, startRun } from './runs.js';

/**
 * `pnpm demo verify-slot --slot <replay id> [--keep]` (rev 4.15 restart acceptance, validation
 * round): replay a closed demo slot's shifted documents polling-only, in-process, through the
 * normal ingest path (GameWatcher -> applyChanges, pace 0) into a check game
 * `check-<slot id>`, and compare the canonical state of both games.
 *
 * Compared (`canonicalGame`): status, score, periods, the non-deleted events (count and bodies,
 * with their ordering key), team and player stats. NOT compared, because they legitimately
 * differ between ingestion paths of one recording: `last_seq` / the number of changes (a 3 s
 * polling replay numbers every intermediate revision it sees; a push watch with 5-minute REST
 * reconciliation sees fewer intermediate states but adds clock-carried score steps; a restart adds
 * none but re-reads), `deleted_at` rows (a play inserted and retracted between two
 * reconciliations is never observed by the push path, so it has no deleted row there), and stale
 * observations (a restarted watch logs the documents it re-reads as stale; a fresh replay logs
 * none).
 *
 * The check game is labelled like every demo game: its provenance row (the slot's, under the check
 * id) is written before the replay creates it, so the label and provenance invariants hold. It is
 * purged with every dependent row afterwards (outbox rows discarded: nobody subscribes to it)
 * unless `--keep`. No ingester lock: the check game has its own provider id, row and generation,
 * applyChanges serializes per game row, the demo scheduler never watches a `check-` game and the
 * demo host never lists one, so it runs safely alongside `pnpm demo run`. While it exists (seconds,
 * or until purged with --keep) it is visible in v_schedule as a second replay of the slot.
 */
export class VerifyRefusedError extends Error {}

export interface VerifyResult {
  ok: boolean;
  slotGameId: string;
  checkGameId: string;
  checkProviderGameId: string;
  /** First differences as `path: demo != check`, at most `maxDiffs`. */
  differences: string[];
  compared: { events: number; periods: number; teamStats: number; playerStats: number };
  kept: boolean;
}

interface SlotRow {
  id: string;
  league: string;
  status: string;
  recordingId: string;
  fixturePath: string;
  sha: string;
  provenance: 'recorded' | 'synthetic';
  recordedGameId: string;
  recordedTipOff: Date;
  slotTipOff: Date;
  shiftMs: string;
}

/** The comparable form of a game's state (see the module comment for what is left out). */
export function canonicalGame(s: Snapshot) {
  const byKey = <T>(xs: T[], key: (x: T) => string) =>
    [...xs].sort((a, b) => key(a).localeCompare(key(b)));
  return {
    status: s.game.status,
    score: s.game.score,
    periods: s.periods,
    eventCount: s.events.length,
    events: byKey(s.events, (e) => e.providerEventId),
    teamStats: byKey(s.teamStats, (t) => t.providerTeamId),
    playerStats: byKey(s.playerStats, (p) => p.providerPlayerId),
  };
}

/** Path-level differences of two JSON values, first `max` only. */
export function differences(a: unknown, b: unknown, max = 10, path = ''): string[] {
  const out: string[] = [];
  const walk = (x: unknown, y: unknown, p: string) => {
    if (out.length >= max) return;
    if (canonicalJson(x) === canonicalJson(y)) return;
    if (Array.isArray(x) && Array.isArray(y)) {
      if (x.length !== y.length) out.push(`${p || '.'}: length ${x.length} != ${y.length}`);
      for (let i = 0; i < Math.min(x.length, y.length); i++) walk(x[i], y[i], `${p}[${i}]`);
      return;
    }
    if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x)) {
      const keys = [...new Set([...Object.keys(x), ...Object.keys(y)])].sort();
      for (const k of keys)
        walk((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k], `${p}.${k}`);
      return;
    }
    out.push(
      `${p || '.'}: ${JSON.stringify(x)?.slice(0, 80)} != ${JSON.stringify(y)?.slice(0, 80)}`,
    );
  };
  walk(a, b, path);
  return out;
}

export async function verifySlot(
  db: Db,
  log: Logger,
  slotGameId: string,
  opts: { keep?: boolean; maxDiffs?: number } = {},
): Promise<VerifyResult> {
  const [row] = await db<SlotRow[]>`
    select g.id, g.league::text as league, g.status::text as status,
           s.recording_id as "recordingId", s.fixture_path as "fixturePath", s.fixture_sha256 as sha,
           s.provenance, s.recorded_game_id as "recordedGameId", s.recorded_tip_off as "recordedTipOff",
           s.slot_tip_off as "slotTipOff", s.shift_ms::text as "shiftMs"
    from public.games g
    join ingest.replay_slots s on s.league = g.league and s.provider_game_id = g.provider_game_id
    where g.provider_game_id = ${slotGameId}`;
  if (!row) throw new VerifyRefusedError(`${slotGameId}: no demo game with provenance`);
  if (row.status !== 'closed')
    throw new VerifyRefusedError(`${slotGameId} is ${row.status}; verify-slot needs a closed slot`);
  const entry: RotationEntry | undefined = [...RECORDED_ROTATION, ...SYNTHETIC_ROTATION].find(
    (e) => e.recordingId === row.recordingId && e.fixture === row.fixturePath,
  );
  if (!entry) throw new VerifyRefusedError(`${slotGameId}: unknown recording ${row.recordingId}`);
  const rec = await loadRecording(entry);
  if (rec.sha256 !== row.sha)
    throw new VerifyRefusedError(
      `${slotGameId}: ${row.fixturePath} changed since the slot was served (sha256 differs)`,
    );
  const slot: Slot = {
    k: 0,
    tipOffMs: row.slotTipOff.getTime(),
    entry,
    providerGameId: slotGameId,
  };
  const checkId = `${CHECK_ID_PREFIX}${slotGameId}`;
  const league = LeagueCodeSchema.parse(row.league);
  const [existing] = await db<{ id: string }[]>`
    select id from public.games where league = ${league} and provider_game_id = ${checkId}`;
  if (existing) await purgeCheckGame(db, log, { id: existing.id, providerGameId: checkId });
  // The check game's provenance first, so the trigger labels it at creation (0014).
  await db`
    insert into ingest.replay_slots
      (league, provider_game_id, recording_id, fixture_path, fixture_sha256, provenance,
       recorded_game_id, recorded_tip_off, slot_tip_off, shift_ms)
    values (${league}, ${checkId}, ${row.recordingId}, ${row.fixturePath}, ${row.sha},
            ${row.provenance}, ${row.recordedGameId}, ${row.recordedTipOff}, ${row.slotTipOff},
            ${row.shiftMs})
    on conflict (league, provider_game_id) do nothing`;

  const dir = mkdtempSync(join(tmpdir(), 'wehoop-verify-slot-'));
  let checkGameId = '';
  try {
    const file = join(dir, 'slot.jsonl');
    writeFileSync(
      file,
      `${slotRecording(rec, slot, checkId)
        .map((l) => JSON.stringify(l))
        .join('\n')}\n`,
    );
    const run = await startRun(db, {
      kind: 'replay',
      league,
      gameId: null,
      source: 'fixture',
      meta: { verifySlot: slotGameId },
    });
    const watcher = new GameWatcher({
      db,
      log,
      adapter: adapterFor(league),
      run,
      apply: { db, log },
      pulse: null,
    });
    try {
      await replayRecording(watcher, file, log, {
        paceMs: 0,
        isStopped: () => false,
        maxDocs: null,
      });
      await endRun(db, run.id, 'ok');
    } catch (err) {
      await endRun(db, run.id, 'error', (err as Error).message);
      throw err;
    }
    if (!watcher.gameId) throw new Error('the check replay created no game');
    checkGameId = watcher.gameId;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const demo = await loadSnapshot(db, row.id);
  const check = await loadSnapshot(db, checkGameId);
  if (!demo || !check) throw new Error('snapshot missing');
  const a = canonicalGame(demo);
  const b = canonicalGame(check);
  const diffs = differences(a, b, opts.maxDiffs ?? 10);
  const result: VerifyResult = {
    ok: diffs.length === 0,
    slotGameId,
    checkGameId,
    checkProviderGameId: checkId,
    differences: diffs,
    compared: {
      events: a.eventCount,
      periods: a.periods.length,
      teamStats: a.teamStats.length,
      playerStats: a.playerStats.length,
    },
    kept: opts.keep === true,
  };
  if (!opts.keep) await purgeCheckGame(db, log, { id: checkGameId, providerGameId: checkId });
  return result;
}
