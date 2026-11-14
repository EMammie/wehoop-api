import type { Db } from '../db/client.js';
import type { LeagueAdapter } from '../leagues/adapter.js';
import {
  mapPeriodType,
  mapStatus,
  normalizeEvent,
  PlayerCollector,
} from '../leagues/sportradar-basketball/normalize.js';
import type { Logger } from '../logger.js';
import type { PeriodRef, PeriodType, Score } from '../model/live-event.js';
import type { PushLine } from '../providers/sportradar/push-client.js';
import type { PushClockMessage, PushEventMessage } from '../providers/sportradar/schemas/push.js';
import { type ApplyDeps, type ApplyResult, applyChanges } from './apply-changes.js';
import { ensurePlayers } from './identity.js';
import { endRun, type RunHandle, type RunSource, startRun } from './runs.js';
import type { DocumentPlayer, GameView, NormalizedBatch } from './types.js';

/**
 * Push ingestion (plan §4, M4). A `push_stream` sub-run of the watch generation
 * (`parent_run_id` = the root watch run, so `watchId` is inherited) feeds:
 *   - every push EVENT as a non-complete batch WITHOUT a `gameView` (a single
 *     event carries no game-level view), `operation=delete` as an explicit
 *     deletion marker carrying the message's revision;
 *   - every WNBA push CLOCK message as an observation write: a `gameView` with
 *     status / period / score / clock / `clockRunning` (from `clocks.running`)
 *     and no events. Game-level fields then follow `observedAt` and the
 *     lagging-view rule inside `applyChanges`; the clock alone never produces
 *     a durable change (status, score and period unchanged -> no change row).
 * `observedAt` is the message receipt time. Nothing here writes game state
 * directly: every line goes through `applyChanges`.
 */

/**
 * The push clock feed writes the game clock as digits without a separator
 * (`"1000"` = 10:00, `"959"` = 9:59 in the recorded sample), while every REST
 * document and the stored `games.clock` use `m:ss` (`"10:00"`, `"00:25"`).
 * Normalize to the REST form so `clockToSeconds`, rule 2(d) and the pulse see
 * one format. A value that already carries a colon is returned as is.
 */
export function normalizePushClock(clock: string | null | undefined): string | null {
  if (clock === null || clock === undefined) return null;
  const trimmed = clock.trim();
  if (trimmed === '') return null;
  if (trimmed.includes(':')) return trimmed;
  const m = /^(\d{1,4})(?:\.(\d+))?$/.exec(trimmed);
  if (!m) return trimmed;
  const digits = (m[1] ?? '').padStart(4, '0');
  const mins = Number(digits.slice(0, 2));
  const secs = digits.slice(2);
  const frac = m[2] ? `.${m[2]}` : '';
  return `${mins === 0 ? '00' : String(mins)}:${secs}${frac}`;
}

function periodRefOf(p: { number: number; sequence: number; type: string }): PeriodRef {
  return { number: p.number, sequence: p.sequence, type: mapPeriodType(p.type) };
}

export type PushEventNormalization =
  | {
      ok: true;
      providerGameId: string;
      operation: 'insert' | 'update' | 'delete';
      batch: NormalizedBatch;
      players: DocumentPlayer[];
    }
  | { ok: false; providerGameId: string; reason: 'no_period' | 'unknown_operation' };

/** One push event message -> the batch `applyChanges` takes (no gameView: single events have none). */
export function pushEventToBatch(msg: PushEventMessage): PushEventNormalization {
  const providerGameId = msg.payload.game.id;
  const ev = msg.payload.event;
  const op = msg.metadata.operation;
  if (op !== 'insert' && op !== 'update' && op !== 'delete') {
    return { ok: false, providerGameId, reason: 'unknown_operation' };
  }
  if (op === 'delete') {
    return {
      ok: true,
      providerGameId,
      operation: op,
      batch: {
        events: [],
        deletedEvents: [{ providerEventId: ev.id, updatedAt: ev.updated ?? null }],
        teamStats: [],
        playerStats: [],
      },
      players: [],
    };
  }
  if (!ev.period) return { ok: false, providerGameId, reason: 'no_period' };
  const players = new PlayerCollector();
  const event = normalizeEvent(ev, periodRefOf(ev.period), players);
  return {
    ok: true,
    providerGameId,
    operation: op,
    batch: { events: [event], deletedEvents: [], teamStats: [], playerStats: [] },
    players: players.list(),
  };
}

/** The stored game-level fields a clock message may omit (read once per line, outside the applyChanges transaction). */
export interface StoredGameLevel {
  period: PeriodRef | null;
  score: Score;
}

/**
 * One push clock message -> an observation-only `gameView`. Omission is not
 * change (plan §4 rule 3): a message without `period` (the recorded sample
 * omits it on 3 of 4 lines) keeps the stored period, and a team without
 * `points` keeps the stored score rather than claiming 0, which would be the
 * newest observation of the generation and would zero the score with a
 * durable `status` change. `0` is used only when nothing is stored yet.
 */
export function pushClockToGameView(
  msg: PushClockMessage,
  stored: StoredGameLevel | null,
): GameView {
  const g = msg.payload.game;
  const status = mapStatus(g.status);
  return {
    status,
    unknownStatus: status === null ? g.status : null,
    score: {
      home: g.home.points ?? stored?.score.home ?? 0,
      away: g.away.points ?? stored?.score.away ?? 0,
    },
    period: msg.payload.period ? periodRefOf(msg.payload.period) : (stored?.period ?? null),
    clock: normalizePushClock(msg.payload.clocks.game),
    clockDecimal: normalizePushClock(msg.payload.clocks.game_decimal),
    clockRunning: msg.payload.clocks.running,
    clockExtra: null,
    elamTargetScore: null,
    periods: [],
    providerUpdatedAt: null,
    scheduledAt: g.scheduled ?? null,
    coverage: g.coverage ?? null,
    venue: null,
    broadcasts: null,
    title: null,
    season: null,
  };
}

export interface PushIngestDeps {
  db: Db;
  log: Logger;
  adapter: LeagueAdapter;
  apply: ApplyDeps;
  gameId: string;
  providerGameId: string;
  /** The watch generation this sub-run belongs to (its `watchId` is inherited). */
  parentRun: RunHandle;
  source: RunSource;
}

export interface PushIngestStats {
  events: number;
  deletes: number;
  clocks: number;
  heartbeats: number;
  applied: number;
  changes: number;
  stale: number;
  /** Lines for another game (the `match` filter should prevent this; counted, skipped). */
  otherGame: number;
  /** Event lines that could not be normalized (no period, unknown operation). */
  skipped: number;
}

export class PushIngest {
  run: RunHandle | null = null;
  readonly stats: PushIngestStats = {
    events: 0,
    deletes: 0,
    clocks: 0,
    heartbeats: 0,
    applied: 0,
    changes: 0,
    stale: 0,
    otherGame: 0,
    skipped: 0,
  };

  constructor(private readonly deps: PushIngestDeps) {}

  /** Open the `push_stream` sub-run under the watch generation. */
  async start(meta: Record<string, unknown> = {}): Promise<RunHandle> {
    if (this.run) return this.run;
    const parentRunId = this.deps.parentRun.watchId ?? this.deps.parentRun.id;
    this.run = await startRun(this.deps.db, {
      kind: 'push_stream',
      league: this.deps.adapter.league,
      gameId: this.deps.gameId,
      source: this.deps.source,
      parentRunId,
      meta: { providerGameId: this.deps.providerGameId, ...meta },
    });
    this.deps.log.info(
      { runId: this.run.id, watchId: this.run.watchId, gameId: this.deps.gameId },
      'push_stream sub-run started',
    );
    return this.run;
  }

  async end(status: 'ok' | 'error' | 'aborted', error?: string): Promise<void> {
    if (!this.run) return;
    await endRun(this.deps.db, this.run.id, status, error);
    this.deps.log.info({ runId: this.run.id, stats: this.stats }, 'push_stream sub-run ended');
  }

  /**
   * One read of the game-level fields a clock line may omit. It runs outside the applyChanges
   * transaction, so a concurrent writer may move them in between; the consequence is a view that
   * repeats a value one line old, which the freshness rules treat as any other observation (never a
   * regression: omitted fields only ever echo stored state).
   */
  private async storedGameLevel(): Promise<StoredGameLevel | null> {
    const [row] = await this.deps.db<
      {
        number: number | null;
        type: PeriodType | null;
        sequence: number | null;
        home: number;
        away: number;
      }[]
    >`select current_period as number, period_type as type, current_period_sequence as sequence,
             home_points as home, away_points as away
      from public.games where id = ${this.deps.gameId}`;
    if (!row) return null;
    return {
      period:
        row.sequence === null
          ? null
          : { number: row.number ?? 0, type: row.type ?? 'quarter', sequence: row.sequence },
      score: { home: row.home, away: row.away },
    };
  }

  /** Route one parsed push line through `applyChanges`. Returns the apply result, or null when nothing was applied. */
  async handle(line: PushLine, receivedAt: Date): Promise<ApplyResult | null> {
    if (!this.run) throw new Error('PushIngest.start() first');
    if (line.kind === 'heartbeat') {
      this.stats.heartbeats++;
      return null;
    }
    const observation = {
      source: 'push' as const,
      runId: this.run.id,
      watchId: this.run.watchId,
      observedAt: receivedAt,
      isComplete: false,
    };
    let result: ApplyResult;
    if (line.kind === 'event') {
      const n = pushEventToBatch(line.message);
      if (n.providerGameId !== this.deps.providerGameId) {
        this.stats.otherGame++;
        return null;
      }
      if (!n.ok) {
        this.stats.skipped++;
        this.deps.log.warn(
          { reason: n.reason, eventId: line.message.payload.event.id },
          'push event skipped',
        );
        return null;
      }
      if (n.operation === 'delete') this.stats.deletes++;
      else this.stats.events++;
      if (n.players.length > 0)
        await ensurePlayers(this.deps.db, this.deps.adapter.league, n.players);
      result = await applyChanges(this.deps.apply, this.deps.gameId, n.batch, {
        ...observation,
        gameView: null,
      });
    } else {
      if (line.message.payload.game.id !== this.deps.providerGameId) {
        this.stats.otherGame++;
        return null;
      }
      this.stats.clocks++;
      const gameView = pushClockToGameView(line.message, await this.storedGameLevel());
      result = await applyChanges(
        this.deps.apply,
        this.deps.gameId,
        { events: [], deletedEvents: [], teamStats: [], playerStats: [] },
        { ...observation, gameView },
      );
    }
    if (result.outcome === 'stale') {
      this.stats.stale++;
      this.deps.log.warn(
        { kind: line.kind, reason: result.reason, detail: result.detail },
        'push line stale',
      );
    } else {
      this.stats.applied++;
      this.stats.changes += result.changes.length;
      this.deps.log.debug(
        {
          kind: line.kind,
          changes: result.changes.length,
          gameLevel: result.gameLevel,
          seq: result.lastSeq,
        },
        'push line applied',
      );
    }
    return result;
  }
}
