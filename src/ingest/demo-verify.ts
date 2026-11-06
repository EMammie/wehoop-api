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
import { CHECK_ID_PREFIX, CheckPurgeRefusedError, purgeCheckGame } from './demo-purge.js';
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
 * purged with every dependent row afterwards (outbox rows discarded) unless `--keep`.
 *
 * DEV STACK ONLY (review round 3): while the check game exists it is a real game row of the
 * database, so on a hosted demo it would reach testers: a second replay of the slot in v_schedule,
 * a delta in every `league:*:scores` message, and about 1,000 broadcasts on `game:<check uuid>`
 * sharing Realtime's rate limit with the live replay. It refuses unless both connection strings
 * are the dev stack (`config.devStackOnly`). There, and only there, it runs safely alongside
 * `pnpm demo run` without the ingester lock: the check game has its own provider id, row and
 * generation, applyChanges serializes per game row, the demo scheduler never watches a `check-`
 * game, the demo host never lists one, and the worker's orphan cleanup leaves the verify run
 * (meta `verifySlot`) alone. Hosted verification is a follow-up (docs/DEPLOY.md): fetch the demo
 * game over HTTP and replay into the local dev stack, so no check row lands in the demo project.
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

/** The comparison is meaningful only between two distinct games with plays (pure; tested). */
export function comparableProblem(c: {
  slotGameId: string;
  checkGameId: string;
  events: number;
}): string | null {
  if (c.checkGameId === c.slotGameId)
    return 'the check replay landed on the slot game itself; refusing to compare (and to purge) it';
  if (c.events === 0) return 'the slot game has no plays; nothing to compare';
  return null;
}

export async function verifySlot(
  db: Db,
  log: Logger,
  slotGameId: string,
  opts: { keep?: boolean; maxDiffs?: number; devStackOnly: boolean },
): Promise<VerifyResult> {
  if (!opts.devStackOnly)
    throw new VerifyRefusedError(
      "verify-slot runs on the dev stack only (DATABASE_URL and DATABASE_SESSION_URL at 127.0.0.1:54322): its check game would reach a hosted demo's testers (v_schedule, league scores, ~1,000 broadcasts). Hosted verification is a planned follow-up (docs/DEPLOY.md)",
    );
  if (slotGameId.startsWith(CHECK_ID_PREFIX))
    throw new VerifyRefusedError(`${slotGameId} is a check game; pass the slot id (replay-...)`);
  // The league comes from the slot id's recording (rec8), never from whatever row matches the id.
  const rec8 = /^replay-([0-9a-f]{8})-\d{12}$/.exec(slotGameId)?.[1];
  const slotLeague = [...RECORDED_ROTATION, ...SYNTHETIC_ROTATION].find(
    (e) => e.rec8 === rec8,
  )?.league;
  if (!slotLeague)
    throw new VerifyRefusedError(`${slotGameId} is not a slot id of a known recording`);
  const [row] = await db<SlotRow[]>`
    select g.id, g.league::text as league, g.status::text as status,
           s.recording_id as "recordingId", s.fixture_path as "fixturePath", s.fixture_sha256 as sha,
           s.provenance, s.recorded_game_id as "recordedGameId", s.recorded_tip_off as "recordedTipOff",
           s.slot_tip_off as "slotTipOff", s.shift_ms::text as "shiftMs"
    from public.games g
    join ingest.replay_slots s on s.league = g.league and s.provider_game_id = g.provider_game_id
    where g.league = ${slotLeague} and g.provider_game_id = ${slotGameId}`;
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
  if (existing) await purgeCheck(db, log, existing.id, checkId);
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

  const same = comparableProblem({ slotGameId: row.id, checkGameId, events: 1 });
  if (same) throw new VerifyRefusedError(same);
  const demo = await loadSnapshot(db, row.id);
  const check = await loadSnapshot(db, checkGameId);
  if (!demo || !check) throw new Error('snapshot missing');
  const a = canonicalGame(demo);
  const b = canonicalGame(check);
  const empty = comparableProblem({ slotGameId: row.id, checkGameId, events: a.eventCount });
  if (empty) {
    if (!opts.keep) await purgeCheck(db, log, checkGameId, checkId);
    throw new VerifyRefusedError(empty);
  }
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
  if (!opts.keep) await purgeCheck(db, log, checkGameId, checkId);
  return result;
}

/** purgeCheckGame, with a refusal (a concurrent verify of the same slot) mapped to exit 65. */
async function purgeCheck(db: Db, log: Logger, id: string, providerGameId: string) {
  try {
    await purgeCheckGame(db, log, { id, providerGameId });
  } catch (err) {
    if (!(err instanceof CheckPurgeRefusedError)) throw err;
    throw new VerifyRefusedError(
      `${err.message}${/still running/.test(err.message) ? ' (another verify-slot of this slot is running?)' : ''}`,
    );
  }
}
