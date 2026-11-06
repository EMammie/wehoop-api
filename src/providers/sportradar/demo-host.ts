import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { Db } from '../../db/client.js';
import { type RecordedDocument, readRecording } from '../../ingest/recording.js';
import { FIXTURES } from '../../ingest/seed-manifest.js';
import type { LeagueCode } from '../../leagues/codes.js';
import type { Logger } from '../../logger.js';
import type { ReplayKind } from '../../model/replay.js';
import { easternDate } from './fake-provider.js';
import { buildPushTimelines, type PushTimelines, type TimedLine } from './fake-push.js';
import { SummaryDocumentSchema } from './schemas/summary.js';

/**
 * The demo host (plan rev 4.15 (1), (2), (6); M5 B4): the fake provider of
 * `pnpm sim serve` generalized to MANY games. For today and tomorrow (US
 * Eastern, the daily feed's day boundary as in fake-provider.ts) it lists one
 * replay slot every `intervalMs` (default 3 h) on a fixed grid, cycling through
 * a rotation of committed recordings, and serves each slot's documents and push
 * streams over the production URL shape. It runs in the demo process on
 * loopback; the demo worker is locked to it (destination-guard.ts).
 *
 * Deterministic identity. A slot is grid index k: tip-off `SLOT_ORIGIN + k *
 * interval`, recording `rotation[k mod n]`, provider game id
 * `replay-<rec8>-<yyyymmddHHMM>` (the tip-off in UTC). Nothing depends on
 * process start, so a restarted host serves the same documents at the same
 * moments and a restarted worker resumes the same game as a new generation.
 *
 * Two timelines. A recording's documents carry the original game's times
 * (`scheduled`, events' `wall_clock` / `created` / `updated`: WNBA 2026-06-30)
 * and were requested on another day (`requestedAt`: 2026-10-14). The served
 * documents keep the first and replace the second:
 *   - every ISO timestamp in a body is shifted by `shift = slot tip-off -
 *     recorded tip-off` (recorded tip-off = the recording's `scheduled`), so
 *     `scheduled` becomes the slot and revision order is kept (one constant);
 *     the recorded game id becomes the slot's id;
 *   - a document is served from `slot tip-off + (requestedAt - lead -
 *     recorded tip-off)`, where `lead` (per recording) is the smallest gap
 *     between a pbp request and the newest event revision it carried. That
 *     maps each request onto the game clock without ever serving a timestamp
 *     later than the moment it is served (WNBA: the first document at about
 *     +16 min, the game's real 16-minute late start).
 * Before a slot's first document the host serves that first (pregame)
 * document; after the last it keeps serving the last (`closed`).
 *
 * Provenance. Before a slot appears in any document (a schedule listing or a
 * game feed) its row is upserted into `ingest.replay_slots` (recording id,
 * fixture path and sha256, recorded game id and tip-off, shift); migration
 * 0014's trigger labels the game row `games.replay` from it when the schedule
 * ingest creates the game. A row that already exists with different contents
 * (a changed fixture under the same id) is refused: that slot answers 409.
 *
 * Time. `clock` is the host's (and the demo scheduler's) notion of now. At
 * real speed it is the wall clock; `demoClock(speed, epoch)` compresses time
 * around a fixed epoch for tests and rehearsals (both processes of a restart
 * must use the same epoch and speed to see the same documents).
 *
 * It enforces what the real host enforces, like fake-provider.ts: 401 without
 * an `x-api-key` header (the demo resolver sends a placeholder), 429 when two
 * accepted requests for one product arrive closer than `minSpacingMs`.
 */

/** The grid's origin: 2026-01-01 00:00 US Eastern (EST). Slots are ORIGIN + k * interval. */
export const SLOT_ORIGIN_MS = Date.UTC(2026, 0, 1, 5, 0, 0);
export const DEFAULT_INTERVAL_MS = 3 * 3_600_000;
/** A finished slot stays in the schedule listings this long after its `closed` document. */
export const LISTING_GRACE_MS = 30 * 60_000;

export interface RotationEntry {
  league: LeagueCode;
  /** Sportradar Simulations recording id (or the docs game id for the hand-assembled replay). */
  recordingId: string;
  /** First 8 characters of the recording id: the `<rec8>` of the slot ids. */
  rec8: string;
  /** Repository-relative fixture path (stored as provenance). */
  fixture: string;
  provenance: ReplayKind;
}

/** The default rotation: the two Simulations recordings (fixtures/{wnba,ncaawb}/README.md). */
export const RECORDED_ROTATION: readonly RotationEntry[] = [
  {
    league: 'wnba',
    recordingId: '93ee7c68-28d8-4ae8-b54a-974a551aa1f6',
    rec8: '93ee7c68',
    fixture: 'fixtures/wnba/sim-93ee7c68-replay.compact.jsonl.gz',
    provenance: 'recorded',
  },
  {
    league: 'ncaawb',
    recordingId: 'd9b71fe0-0cbf-11f1-bf29-5913e6df42d2',
    rec8: 'd9b71fe0',
    fixture: 'fixtures/ncaawb/sim-d9b71fe0-replay.compact.jsonl.gz',
    provenance: 'recorded',
  },
];

/**
 * `--include-synthetic`: the hand-assembled Unrivaled replay (docs samples, a synthetic Elam
 * target and synthetic request times; fixtures/unrivaled/README.md). Three pbp documents, not a
 * watchable game, hence out of the default rotation and labelled `synthetic`.
 */
export const SYNTHETIC_ROTATION: readonly RotationEntry[] = [
  {
    league: 'unrivaled',
    recordingId: 'docs-838316ea-ab7b-4581-a1dd-74229d1970d5',
    rec8: '838316ea',
    fixture: 'fixtures/unrivaled/docs-838316ea-replay.jsonl',
    provenance: 'synthetic',
  },
];

export function rotationFor(opts: {
  includeSynthetic?: boolean;
  leagues?: readonly LeagueCode[];
}): RotationEntry[] {
  const all = [...RECORDED_ROTATION, ...(opts.includeSynthetic ? SYNTHETIC_ROTATION : [])];
  const picked = opts.leagues?.length ? all.filter((e) => opts.leagues?.includes(e.league)) : all;
  if (picked.length === 0) throw new Error('demo rotation is empty (check --league)');
  return picked;
}

/* ------------------------------------------------------------------ */
/* Clock                                                               */
/* ------------------------------------------------------------------ */

export interface DemoClock {
  /** Demo "now" (ms epoch). */
  now(): number;
  speed: number;
  /** The fixed point of the compression (ms epoch); irrelevant at speed 1. */
  epochMs: number;
}

/** Wall clock at speed 1; otherwise `epoch + (wall - epoch) * speed`. */
export function demoClock(speed = 1, epochMs = 0, wall: () => number = Date.now): DemoClock {
  if (!Number.isInteger(speed) || speed < 1) throw new Error('--speed must be an integer >= 1');
  if (speed === 1) return { now: wall, speed, epochMs };
  return { now: () => epochMs + (wall() - epochMs) * speed, speed, epochMs };
}

/**
 * The epoch that makes a compressed clock read `target` at wall time `wallNow`
 * (tests: start a few demo minutes before a slot). Solves epoch + (wallNow - epoch) * speed = target.
 */
export function epochFor(target: number, wallNow: number, speed: number): number {
  if (speed === 1) return wallNow;
  return Math.round((wallNow * speed - target) / (speed - 1));
}

/* ------------------------------------------------------------------ */
/* Slots                                                               */
/* ------------------------------------------------------------------ */

export interface Slot {
  k: number;
  tipOffMs: number;
  entry: RotationEntry;
  providerGameId: string;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** `yyyymmddHHMM` of an instant in UTC. */
export function slotStamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
}

/** `replay-<rec8>-<yyyymmddHHMM>`: derived only from the recording and the slot. */
export function slotGameId(rec8: string, tipOffMs: number): string {
  return `replay-${rec8}-${slotStamp(tipOffMs)}`;
}

const SLOT_ID = /^replay-([0-9a-f]{8})-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/;

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

export function slotAt(k: number, rotation: readonly RotationEntry[], intervalMs: number): Slot {
  const entry = rotation[mod(k, rotation.length)];
  if (!entry) throw new Error('empty rotation');
  const tipOffMs = SLOT_ORIGIN_MS + k * intervalMs;
  return { k, tipOffMs, entry, providerGameId: slotGameId(entry.rec8, tipOffMs) };
}

/** The slot a provider game id names on this grid and rotation, or null (unknown id: 404). */
export function parseSlotId(
  id: string,
  rotation: readonly RotationEntry[],
  intervalMs: number,
): Slot | null {
  const m = SLOT_ID.exec(id);
  if (!m) return null;
  const tip = Date.UTC(Number(m[2]), Number(m[3]) - 1, Number(m[4]), Number(m[5]), Number(m[6]));
  const k = (tip - SLOT_ORIGIN_MS) / intervalMs;
  if (!Number.isInteger(k)) return null;
  const slot = slotAt(k, rotation, intervalMs);
  return slot.entry.rec8 === m[1] ? slot : null;
}

/** Every slot whose tip-off falls on one of `dates` (US Eastern `YYYY-MM-DD`). */
export function slotsOn(
  dates: readonly string[],
  rotation: readonly RotationEntry[],
  intervalMs: number,
  aroundMs: number,
): Slot[] {
  const from = Math.floor((aroundMs - 3 * 86_400_000 - SLOT_ORIGIN_MS) / intervalMs);
  const to = Math.ceil((aroundMs + 3 * 86_400_000 - SLOT_ORIGIN_MS) / intervalMs);
  const out: Slot[] = [];
  for (let k = from; k <= to; k++) {
    const s = slotAt(k, rotation, intervalMs);
    if (dates.includes(easternDate(new Date(s.tipOffMs).toISOString()))) out.push(s);
  }
  return out;
}

/** Today and tomorrow on the US Eastern calendar (the scheduler's `scheduleDates`). */
export function todayAndTomorrow(nowMs: number): string[] {
  return [
    easternDate(new Date(nowMs).toISOString()),
    easternDate(new Date(nowMs + 86_400_000).toISOString()),
  ];
}

/* ------------------------------------------------------------------ */
/* Recordings and shifting                                             */
/* ------------------------------------------------------------------ */

const ISO = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Shift one ISO datetime by `ms`, keeping its offset notation and fractional digits. Non-ISO strings are returned as is. */
export function shiftIso(value: string, ms: number): string {
  const m = ISO.exec(value);
  if (!m) return value;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return value;
  const zone = m[4] ?? 'Z';
  const offsetMin =
    zone === 'Z'
      ? 0
      : (zone.startsWith('-') ? -1 : 1) *
        (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6)));
  const local = new Date(t + ms + offsetMin * 60_000);
  // Slot shifts are whole minutes, so the fraction (any number of digits) is kept as written;
  // a shift with milliseconds renders them with three digits.
  const frac = ms % 1000 === 0 ? (m[3] ?? '') : `.${pad(local.getUTCMilliseconds(), 3)}`;
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}${frac}${zone}`;
}

/**
 * A served document: every ISO datetime string shifted by `shiftMs`, every string containing the
 * recorded game id rewritten to the slot's id (the body's `id`, push `match` values). Pure; the
 * input is not modified.
 */
export function shiftDocument(
  body: unknown,
  shiftMs: number,
  fromGameId: string,
  toGameId: string,
): unknown {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const renamed = v.includes(fromGameId) ? v.replaceAll(fromGameId, toGameId) : v;
      return shiftIso(renamed, shiftMs);
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return walk(body);
}

type GameFeed = 'pbp' | 'summary' | 'boxscore';

interface ServedDocument {
  /** When it is served, relative to the slot's tip-off (ms). */
  offsetMs: number;
  requestedAt: string;
  body: unknown;
}

export interface LoadedRecording {
  entry: RotationEntry;
  sha256: string;
  recordedGameId: string;
  recordedTipOffMs: number;
  /**
   * Request time minus game time, the smallest over the pbp documents (see the module comment);
   * 0 for a recording whose request times are already on the game timeline.
   */
  leadMs: number;
  /** First document -> first `closed` document, on the request timeline (the plan's "span"). */
  spanMs: number;
  /** Served window relative to the slot tip-off: first document .. first `closed` document. */
  startOffsetMs: number;
  endOffsetMs: number;
  docs: Record<GameFeed, ServedDocument[]>;
  /** In served order across feeds (slotRecording). */
  all: Array<ServedDocument & { feed: GameFeed }>;
  firstSummary: ReturnType<typeof SummaryDocumentSchema.parse>;
  /** Built on first use (push leagues only). */
  push: PushTimelines | null;
}

const isGameFeed = (f: string): f is GameFeed => f === 'pbp' || f === 'summary' || f === 'boxscore';

function newestRevision(body: unknown): number | null {
  const periods = (body as { periods?: Array<{ events?: Array<Record<string, unknown>> }> })
    .periods;
  let newest: number | null = null;
  for (const p of periods ?? []) {
    for (const e of p.events ?? []) {
      for (const key of ['updated', 'created', 'wall_clock']) {
        const v = e[key];
        if (typeof v !== 'string') continue;
        const t = Date.parse(v);
        if (!Number.isNaN(t) && (newest === null || t > newest)) newest = t;
      }
    }
  }
  return newest;
}

/** Read a rotation fixture: game documents only (reference lines of a replay file are skipped). */
export async function loadRecording(entry: RotationEntry): Promise<LoadedRecording> {
  const path = new URL(`../${entry.fixture}`, FIXTURES).pathname;
  const sha256 = createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
  const lines: Array<RecordedDocument & { feed: GameFeed }> = [];
  for await (const line of readRecording(path)) {
    if (isGameFeed(line.feed)) lines.push({ ...line, feed: line.feed });
  }
  if (lines.length === 0) throw new Error(`${entry.fixture}: no game documents`);
  lines.sort((a, b) => Date.parse(a.requestedAt) - Date.parse(b.requestedAt));
  const summaryLine = lines.find((l) => l.feed === 'summary') ?? lines[0];
  const firstSummary = SummaryDocumentSchema.parse(summaryLine?.body);
  const recordedGameId = firstSummary.id;
  const scheduled = firstSummary.scheduled;
  if (!scheduled) throw new Error(`${entry.fixture}: the first summary has no scheduled tip-off`);
  const recordedTipOffMs = Date.parse(scheduled);
  const firstRequested = Date.parse(lines[0]?.requestedAt ?? '');
  let leadMs: number | null = null;
  for (const l of lines) {
    if (l.feed !== 'pbp') continue;
    const newest = newestRevision(l.body);
    if (newest === null) continue;
    const gap = Date.parse(l.requestedAt) - newest;
    if (leadMs === null || gap < leadMs) leadMs = gap;
  }
  // A recording whose requests already sit on the game's timeline (the hand-assembled Unrivaled
  // replay: synthetic request times around its own tip-off, docs-sample revisions stamped months
  // later) needs no mapping; neither does one without event revisions.
  const onGameTimeline = Math.abs(firstRequested - recordedTipOffMs) <= 12 * 3_600_000;
  const lead = onGameTimeline || leadMs === null ? 0 : leadMs;
  const closed = lines.find((l) => (l.body as { status?: unknown }).status === 'closed');
  const closedAt = Date.parse((closed ?? lines[lines.length - 1])?.requestedAt ?? '');
  const offset = (requestedAt: string) => Date.parse(requestedAt) - lead - recordedTipOffMs;
  const docs: Record<GameFeed, ServedDocument[]> = { pbp: [], summary: [], boxscore: [] };
  const all: LoadedRecording['all'] = [];
  for (const l of lines) {
    const d = { offsetMs: offset(l.requestedAt), requestedAt: l.requestedAt, body: l.body };
    docs[l.feed].push(d);
    all.push({ ...d, feed: l.feed });
  }
  return {
    entry,
    sha256,
    recordedGameId,
    recordedTipOffMs,
    leadMs: lead,
    spanMs: closedAt - firstRequested,
    startOffsetMs: offset(lines[0]?.requestedAt ?? ''),
    endOffsetMs: closedAt - lead - recordedTipOffMs,
    docs,
    all,
    firstSummary,
    push: null,
  };
}

/**
 * Rev 4.15 (1): consecutive replays must not overlap at real time. A slot occupies
 * [tip + startOffset, tip + endOffset]; consecutive slots never overlap when the interval exceeds
 * the largest end minus the smallest start over the rotation, which is at least the longest span
 * (first document -> `closed`). Throws with both numbers otherwise.
 */
export function assertIntervalFits(recordings: readonly LoadedRecording[], intervalMs: number) {
  const longest = Math.max(...recordings.map((r) => r.spanMs));
  const footprint =
    Math.max(...recordings.map((r) => r.endOffsetMs)) -
    Math.min(...recordings.map((r) => r.startOffsetMs));
  const min = (ms: number) => `${Math.round(ms / 60_000)} min`;
  if (intervalMs <= longest || intervalMs <= footprint) {
    throw new Error(
      `--interval ${min(intervalMs)} is too short: the longest recording in the rotation spans ${min(longest)} (first document to closed) and the served windows cover ${min(footprint)} (earliest first document to latest closed, relative to the tip-off); consecutive replays would overlap`,
    );
  }
}

/** The shift a slot applies to its recording's timestamps. */
export function shiftFor(rec: LoadedRecording, slot: Slot): number {
  return slot.tipOffMs - rec.recordedTipOffMs;
}

/** Index of the document served `relMs` after the tip-off (the first one before it). */
export function pickIndex(list: readonly { offsetMs: number }[], relMs: number): number {
  let chosen = 0;
  for (let i = 0; i < list.length; i++) {
    if ((list[i]?.offsetMs ?? Number.POSITIVE_INFINITY) <= relMs) chosen = i;
    else break;
  }
  return chosen;
}

/**
 * A slot as a recording file (`RecordedDocument` lines): the shifted documents in served order,
 * `requestedAt` = when the host serves them. `gameId` overrides the slot id (a polling-only
 * comparison replay must be a distinct game). What `pnpm demo export-slot` writes.
 */
export function slotRecording(
  rec: LoadedRecording,
  slot: Slot,
  gameId: string = slot.providerGameId,
): RecordedDocument[] {
  const shift = shiftFor(rec, slot);
  return rec.all.map((d) => {
    const at = new Date(slot.tipOffMs + d.offsetMs).toISOString();
    return {
      feed: d.feed,
      requestedAt: at,
      receivedAt: at,
      status: 200,
      body: shiftDocument(d.body, shift, rec.recordedGameId, gameId),
    };
  });
}

/* ------------------------------------------------------------------ */
/* Provenance                                                          */
/* ------------------------------------------------------------------ */

export interface ReplaySlotRow {
  league: LeagueCode;
  providerGameId: string;
  recordingId: string;
  fixturePath: string;
  fixtureSha256: string;
  provenance: ReplayKind;
  recordedGameId: string;
  recordedTipOff: Date;
  slotTipOff: Date;
  shiftMs: number;
}

export function provenanceRow(rec: LoadedRecording, slot: Slot): ReplaySlotRow {
  return {
    league: slot.entry.league,
    providerGameId: slot.providerGameId,
    recordingId: slot.entry.recordingId,
    fixturePath: slot.entry.fixture,
    fixtureSha256: rec.sha256,
    provenance: slot.entry.provenance,
    recordedGameId: rec.recordedGameId,
    recordedTipOff: new Date(rec.recordedTipOffMs),
    slotTipOff: new Date(slot.tipOffMs),
    shiftMs: shiftFor(rec, slot),
  };
}

export interface ProvenanceStore {
  /** Idempotent: an identical existing row is fine; a different one throws. */
  ensure(row: ReplaySlotRow): Promise<void>;
}

export class ProvenanceConflictError extends Error {}

/** `ingest.replay_slots` (0014). */
export class PgProvenanceStore implements ProvenanceStore {
  constructor(private readonly db: Db) {}

  async ensure(r: ReplaySlotRow): Promise<void> {
    await this.db`
      insert into ingest.replay_slots
        (league, provider_game_id, recording_id, fixture_path, fixture_sha256, provenance,
         recorded_game_id, recorded_tip_off, slot_tip_off, shift_ms)
      values (${r.league}, ${r.providerGameId}, ${r.recordingId}, ${r.fixturePath},
              ${r.fixtureSha256}, ${r.provenance}, ${r.recordedGameId}, ${r.recordedTipOff},
              ${r.slotTipOff}, ${r.shiftMs})
      on conflict (league, provider_game_id) do nothing`;
    const [row] = await this.db<
      { recordingId: string; sha: string; provenance: string; shiftMs: string; tip: Date }[]
    >`
      select recording_id as "recordingId", fixture_sha256 as sha, provenance,
             shift_ms::text as "shiftMs", slot_tip_off as tip
      from ingest.replay_slots where league = ${r.league} and provider_game_id = ${r.providerGameId}`;
    if (
      !row ||
      row.recordingId !== r.recordingId ||
      row.sha !== r.fixtureSha256 ||
      row.provenance !== r.provenance ||
      Number(row.shiftMs) !== r.shiftMs ||
      row.tip.getTime() !== r.slotTipOff.getTime()
    ) {
      throw new ProvenanceConflictError(
        `ingest.replay_slots already holds ${r.providerGameId} with different provenance (fixture changed?); refusing to serve it`,
      );
    }
  }
}

/** For DB-free tests: remembers what was written. */
export class MemoryProvenanceStore implements ProvenanceStore {
  readonly rows = new Map<string, ReplaySlotRow>();
  async ensure(row: ReplaySlotRow): Promise<void> {
    const prev = this.rows.get(row.providerGameId);
    if (prev && JSON.stringify(prev) !== JSON.stringify(row))
      throw new ProvenanceConflictError(`${row.providerGameId}: different provenance`);
    this.rows.set(row.providerGameId, row);
  }
}

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */

export interface DemoHostOptions {
  rotation: readonly RotationEntry[];
  intervalMs?: number;
  clock?: DemoClock;
  provenance: ProvenanceStore;
  port?: number;
  host?: string;
  minSpacingMs?: number;
  heartbeatMs?: number;
  log?: Logger;
}

export interface DemoHostStats {
  requests: number;
  served: number;
  rejected401: number;
  rejected429: number;
  unknownSlot: number;
  byFeed: Record<string, number>;
  pushConnections: number;
  pushLinesSent: number;
  provenanceRows: number;
}

export interface DemoHost {
  url: string;
  port: number;
  intervalMs: number;
  clock: DemoClock;
  recordings: ReadonlyMap<string, LoadedRecording>;
  stats: DemoHostStats;
  /** The slots listed for today and tomorrow at the host's now. */
  slotsNow(): Slot[];
  /** Upsert one slot's provenance (also done before any document naming it). */
  ensureProvenance(slot: Slot): Promise<void>;
  close(): Promise<void>;
}

export async function startDemoHost(opts: DemoHostOptions): Promise<DemoHost> {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const clock = opts.clock ?? demoClock();
  const rotation = opts.rotation;
  const recordings = new Map<string, LoadedRecording>();
  for (const entry of rotation) {
    if (!recordings.has(entry.rec8)) recordings.set(entry.rec8, await loadRecording(entry));
  }
  // Refused before the host listens: a rotation that overlaps is a configuration error.
  assertIntervalFits([...recordings.values()], intervalMs);
  const recOf = (slot: Slot): LoadedRecording => {
    const r = recordings.get(slot.entry.rec8);
    if (!r) throw new Error(`no recording loaded for ${slot.entry.rec8}`);
    return r;
  };
  const pushOf = (rec: LoadedRecording): PushTimelines => {
    if (!rec.push) rec.push = buildPushTimelines(rec.docs.pbp);
    return rec.push;
  };

  const stats: DemoHostStats = {
    requests: 0,
    served: 0,
    rejected401: 0,
    rejected429: 0,
    unknownSlot: 0,
    byFeed: {},
    pushConnections: 0,
    pushLinesSent: 0,
    provenanceRows: 0,
  };
  const minSpacingMs = opts.minSpacingMs ?? 1000;
  const heartbeatMs = opts.heartbeatMs ?? 5000;
  const lastAccepted = new Map<string, number>();
  const written = new Map<string, Promise<void>>();
  const ensureProvenance = (slot: Slot): Promise<void> => {
    let p = written.get(slot.providerGameId);
    if (!p) {
      p = opts.provenance.ensure(provenanceRow(recOf(slot), slot)).then(() => {
        stats.provenanceRows++;
      });
      // A failed write is retried by the next request.
      p.catch(() => written.delete(slot.providerGameId));
      written.set(slot.providerGameId, p);
    }
    return p;
  };
  // A slot whose replay ended (closed, plus a grace) before now is no longer listed: a host
  // started at 15:00 must not create that morning's slots as closed 0-0 games through the
  // schedule. Deterministic in time like everything else; a game already ingested keeps its row,
  // and its documents stay served for a watch that resumes late.
  const listable = (slot: Slot) =>
    clock.now() <= slot.tipOffMs + recOf(slot).endOffsetMs + LISTING_GRACE_MS;
  const slotsNow = () =>
    slotsOn(todayAndTomorrow(clock.now()), rotation, intervalMs, clock.now()).filter(listable);

  // Shifted bodies are cached as text: a 1 MB pbp is shifted once per (slot, document).
  const cache = new Map<string, string>();
  const servedText = (slot: Slot, feed: GameFeed, i: number): string => {
    const key = `${slot.providerGameId}|${feed}|${i}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const rec = recOf(slot);
    const body = rec.docs[feed][i]?.body;
    const text = JSON.stringify(
      shiftDocument(body, shiftFor(rec, slot), rec.recordedGameId, slot.providerGameId),
    );
    cache.set(key, text);
    if (cache.size > 96) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    return text;
  };
  const relNow = (slot: Slot) => clock.now() - slot.tipOffMs;
  const currentIndex = (slot: Slot, feed: GameFeed) =>
    pickIndex(recOf(slot).docs[feed], relNow(slot));
  const currentStatus = (slot: Slot): string => {
    const rec = recOf(slot);
    const doc = rec.docs.summary[currentIndex(slot, 'summary')] ?? rec.docs.pbp[0];
    return String((doc?.body as { status?: unknown })?.status ?? 'scheduled');
  };
  const scheduleEntry = (slot: Slot) => {
    const rec = recOf(slot);
    const s = shiftDocument(
      rec.firstSummary,
      shiftFor(rec, slot),
      rec.recordedGameId,
      slot.providerGameId,
    ) as typeof rec.firstSummary;
    const team = (t: typeof s.home) => ({
      id: t.id,
      name: t.name,
      alias: t.alias,
      market: t.market,
    });
    return {
      id: slot.providerGameId,
      status: currentStatus(slot),
      coverage: s.coverage,
      scheduled: s.scheduled,
      home: team(s.home),
      away: team(s.away),
      ...(s.venue ? { venue: s.venue } : {}),
      ...(s.broadcasts ? { broadcasts: s.broadcasts } : {}),
    };
  };

  const openPush = new Set<ServerResponse>();
  const streamPush = (
    res: ServerResponse,
    slot: Slot,
    feed: 'push_events' | 'push_clock',
    lines: TimedLine[],
  ) => {
    const rec = recOf(slot);
    const shift = shiftFor(rec, slot);
    stats.pushConnections++;
    stats.byFeed[feed] = (stats.byFeed[feed] ?? 0) + 1;
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
    res.flushHeaders();
    openPush.add(res);
    // No history, as on the real host: only lines after the moment of connection.
    let i = lines.findIndex((l) => l.offsetMs > relNow(slot));
    if (i < 0) i = lines.length;
    const write = (line: unknown) => {
      if (res.destroyed || res.writableEnded) return;
      res.write(`${JSON.stringify(line)}\n`);
    };
    const hb = setInterval(() => write({ heartbeat: { interval: heartbeatMs } }), heartbeatMs);
    const tick = setInterval(() => {
      const rel = relNow(slot);
      while (i < lines.length && (lines[i]?.offsetMs ?? Number.POSITIVE_INFINITY) <= rel) {
        stats.pushLinesSent++;
        write(shiftDocument(lines[i]?.line, shift, rec.recordedGameId, slot.providerGameId));
        i++;
      }
    }, 50);
    res.on('close', () => {
      clearInterval(hb);
      clearInterval(tick);
      openPush.delete(res);
    });
  };

  const server: Server = createServer((req, res) => {
    stats.requests++;
    const send = (status: number, body: unknown) => {
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      res.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(text),
      });
      res.end(text);
    };
    const fail = (err: unknown) => {
      if (err instanceof ProvenanceConflictError) return send(409, { message: err.message });
      opts.log?.error({ err }, 'demo host: request failed');
      if (!res.headersSent) send(500, { message: 'demo host error' });
    };
    const url = new URL(req.url ?? '/', 'http://demo');
    if (req.method === 'GET' && url.pathname === '/_demo/status') {
      // Loopback status for operators and the validator: no key, no spacing check.
      return send(200, {
        now: new Date(clock.now()).toISOString(),
        speed: clock.speed,
        intervalMin: intervalMs / 60_000,
        slots: slotsNow().map((s) => ({
          providerGameId: s.providerGameId,
          league: s.entry.league,
          tipOff: new Date(s.tipOffMs).toISOString(),
          provenance: s.entry.provenance,
          status: currentStatus(s),
        })),
        stats,
      });
    }
    if (!req.headers['x-api-key']) {
      stats.rejected401++;
      return send(401, { message: 'Unauthorized' });
    }
    const leagueMatch = /^\/(wnba|ncaawb|unrivaled)\//.exec(url.pathname);
    if (!leagueMatch) return send(404, { message: 'not found' });
    const league = leagueMatch[1] as LeagueCode;
    const t = Date.now();
    const last = lastAccepted.get(league);
    if (last !== undefined && t - last < minSpacingMs) {
      stats.rejected429++;
      opts.log?.warn({ spacingMs: t - last, path: url.pathname }, 'demo host: 429');
      return send(429, { message: 'Too Many Requests: developer over QPS' });
    }
    const slotFor = (id: string): Slot | null => {
      const s = parseSlotId(id, rotation, intervalMs);
      if (!s || s.entry.league !== league) {
        stats.unknownSlot++;
        return null;
      }
      return s;
    };
    const count = (feed: string) => {
      lastAccepted.set(league, t);
      stats.served++;
      stats.byFeed[feed] = (stats.byFeed[feed] ?? 0) + 1;
    };

    const stream = /\/stream\/[a-z]{2}\/(events|clock|statistics)\/subscribe$/.exec(url.pathname);
    if (stream) {
      lastAccepted.set(league, t);
      if (stream[1] === 'statistics') return send(404, { message: 'push statistics not mocked' });
      const match = /^sd:match:(.+)$/.exec(url.searchParams.get('match') ?? '');
      const slot = match?.[1] ? slotFor(match[1]) : null;
      if (!slot) return send(404, { message: 'push streams need match=sd:match:<slot id>' });
      ensureProvenance(slot).then(() => {
        stats.served++;
        const push = pushOf(recOf(slot));
        if (stream[1] === 'events') streamPush(res, slot, 'push_events', push.events);
        else streamPush(res, slot, 'push_clock', push.clocks);
      }, fail);
      return;
    }
    const game = /\/games\/([^/]+)\/(pbp|summary|boxscore)\.json$/.exec(url.pathname);
    if (game) {
      const slot = slotFor(decodeURIComponent(game[1] ?? ''));
      if (!slot) return send(404, { message: 'no such replay slot' });
      const feed = game[2] as GameFeed;
      ensureProvenance(slot).then(() => {
        count(feed);
        send(200, servedText(slot, feed, currentIndex(slot, feed)));
      }, fail);
      return;
    }
    const daily = /\/games\/(\d{4})\/(\d{2})\/(\d{2})\/schedule\.json$/.exec(url.pathname);
    const season = /\/games\/\d+\/[A-Z]+\/schedule\.json$/.exec(url.pathname);
    if (daily || season) {
      const window = todayAndTomorrow(clock.now());
      const dates = daily ? [`${daily[1]}-${daily[2]}-${daily[3]}`] : window;
      // Only today and tomorrow exist on this host; any other day lists no game.
      const listed = slotsOn(
        dates.filter((d) => window.includes(d)),
        rotation,
        intervalMs,
        clock.now(),
      ).filter((s) => s.entry.league === league && listable(s));
      // Provenance first: the schedule ingest creates the game rows the trigger labels.
      Promise.all(listed.map(ensureProvenance)).then(() => {
        const first =
          recordings.get(listed[0]?.entry.rec8 ?? '') ??
          [...recordings.values()].find((r) => r.entry.league === league);
        const header = first
          ? { league: first.firstSummary.league, season: first.firstSummary.season }
          : {};
        count(daily ? 'daily_schedule' : 'schedule');
        send(200, {
          ...header,
          ...(daily ? { date: dates[0] } : {}),
          games: listed.map(scheduleEntry),
        });
      }, fail);
      return;
    }
    return send(404, { message: 'not found' });
  });

  const host = opts.host ?? '127.0.0.1';
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : (opts.port ?? 0);
  opts.log?.info(
    {
      port,
      speed: clock.speed,
      epoch: clock.speed === 1 ? null : new Date(clock.epochMs).toISOString(),
      intervalMin: intervalMs / 60_000,
      rotation: rotation.map((e) => `${e.league}:${e.rec8}:${e.provenance}`),
      spansMin: [...recordings.values()].map((r) => Math.round(r.spanMs / 60_000)),
    },
    'demo host listening',
  );
  return {
    url: `http://${host}:${port}`,
    port,
    intervalMs,
    clock,
    recordings,
    stats,
    slotsNow,
    ensureProvenance,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const r of openPush) r.destroy();
        openPush.clear();
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      }),
  };
}
