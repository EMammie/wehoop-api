import type { TransactionSql } from 'postgres';
import type { Db } from '../db/client.js';
import type { LeagueCode } from '../leagues/codes.js';
import type { Logger } from '../logger.js';
import { contentHash } from '../model/content-hash.js';
import { type GameChange, gameChangeFromRow, type PendingChange } from '../model/game-change.js';
import type {
  GameStatus,
  LiveEventType,
  PeriodRef,
  PeriodType,
  Score,
} from '../model/live-event.js';
import { deriveClockRunning } from './clock.js';
import { diffEvents } from './diff.js';
import type { FaultInjector } from './fault.js';
import {
  type BatchDecision,
  decideBatch,
  newestPosition,
  type StoredEventForFreshness,
} from './freshness.js';
import { teamIdsFor } from './identity.js';
import type { GameView, NormalizedBatch, NormalizedEvent, Observation } from './types.js';

/**
 * THE ONLY WRITER of games, play_events, game_changes, game_periods and the
 * stats tables (CLAUDE.md non-negotiable 2). One transaction per batch:
 *   1. lock the game row                       (FOR UPDATE)
 *   2. freshness rules 1, 2a, 2b               (stale -> one stale_observations row, nothing else)
 *   3. load play_events, rule 2c, advance watch_run_id on an accepted new generation
 *   4. diff into durable changes by per-entity precedence (rule 3)
 *   5. observation write (clock + freshness metadata) when the gameView is newest; no seq
 *   6. durable write only when n > 0: last_seq += n, play_events, play_event_raw,
 *      game_periods, game_team_stats, game_changes, broadcast_outbox, NOTIFY outbox
 */

export interface ApplyDeps {
  db: Db;
  log: Logger;
  fault?: FaultInjector;
  now?: () => Date;
}

export interface ApplyCounts {
  inserted: number;
  updated: number;
  deleted: number;
  ignoredOlder: number;
  unchanged: number;
}

export type ApplyResult =
  | {
      outcome: 'stale';
      reason: 'older_run' | 'run_regresses_state';
      detail: string;
      changes: GameChange[];
      lastSeq: number;
    }
  | {
      outcome: 'applied';
      changes: GameChange[];
      firstSeq: number | null;
      lastSeq: number;
      gameLevel: 'write' | 'superseded' | 'none';
      generationAdvanced: boolean;
      counts: ApplyCounts;
      detail: string;
    };

type Tx = TransactionSql;

interface GameRow {
  id: string;
  league: LeagueCode;
  status: GameStatus;
  homePoints: number;
  awayPoints: number;
  currentPeriod: number | null;
  periodType: PeriodType | null;
  lastSeq: string;
  watchRunId: string | null;
  currentPeriodSequence: number | null;
  observedAt: Date | null;
  clock: string | null;
  clockRunning: boolean | null;
}

interface StoredEventRow {
  id: string;
  providerEventId: string;
  contentHash: string;
  deletedAt: Date | null;
  providerUpdatedAt: Date | null;
  periodSequence: number | null;
  providerSequence: string | null;
  providerNumber: number | null;
  wallClock: Date | null;
  eventType: string;
}

interface PeriodRow {
  sequence: number;
  number: number;
  type: PeriodType;
  homePoints: number;
  awayPoints: number;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function viewJson(gv: GameView | null, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    status: gv?.status ?? null,
    score: gv?.score ?? null,
    periodSequence: gv?.period?.sequence ?? null,
    clock: gv?.clock ?? null,
    ...extra,
  };
}

/** Create the games row if it does not exist. Status is taken from the document only on insert. */
export async function ensureGame(
  db: Db,
  game: {
    league: LeagueCode;
    providerGameId: string;
    scheduledAt: string;
    status: GameStatus;
    coverage: string | null;
    homeTeamId: string | null;
    awayTeamId: string | null;
    venue: Record<string, unknown> | null;
    broadcasts: unknown[] | null;
  },
): Promise<{ id: string; created: boolean }> {
  const coverage = coverageOf(game.coverage);
  const [row] = await db<{ id: string; created: boolean }[]>`
    insert into public.games (league, provider_game_id, scheduled_at, status, coverage,
                              home_team_id, away_team_id, venue, broadcasts)
    values (${game.league}, ${game.providerGameId}, ${game.scheduledAt}, ${game.status}, ${coverage},
            ${game.homeTeamId}, ${game.awayTeamId},
            ${game.venue ? db.json(game.venue as never) : null},
            ${game.broadcasts ? db.json(game.broadcasts as never) : null})
    on conflict (league, provider_game_id) do update
      set scheduled_at = excluded.scheduled_at,
          coverage = excluded.coverage,
          home_team_id = coalesce(excluded.home_team_id, public.games.home_team_id),
          away_team_id = coalesce(excluded.away_team_id, public.games.away_team_id),
          venue = coalesce(excluded.venue, public.games.venue),
          broadcasts = coalesce(excluded.broadcasts, public.games.broadcasts)
    returning id, (xmax = 0) as created`;
  if (!row) throw new Error('games upsert returned no row');
  return row;
}

function coverageOf(c: string | null): 'full' | 'extended_boxscore' | 'boxscore' | 'unknown' {
  switch (c) {
    case 'full':
    case 'extended_boxscore':
    case 'boxscore':
      return c;
    default:
      return 'unknown';
  }
}

export async function applyChanges(
  deps: ApplyDeps,
  gameId: string,
  batch: NormalizedBatch,
  observation: Observation,
): Promise<ApplyResult> {
  const now = deps.now ?? (() => new Date());
  return deps.db.begin(async (tx) => {
    // 1. Serialize per game.
    const [g] = await tx<GameRow[]>`
      select id, league, status, home_points as "homePoints", away_points as "awayPoints",
             current_period as "currentPeriod", period_type as "periodType",
             last_seq::text as "lastSeq", watch_run_id::text as "watchRunId",
             current_period_sequence as "currentPeriodSequence", observed_at as "observedAt",
             clock, clock_running as "clockRunning"
      from public.games where id = ${gameId} for update`;
    if (!g) throw new Error(`game ${gameId} not found`);
    const lastSeq = Number(g.lastSeq);

    // 3 (load). Current play state; rule 2c needs positions, rule 3 needs revisions.
    const storedRows = await tx<StoredEventRow[]>`
      select id, provider_event_id as "providerEventId", content_hash as "contentHash",
             deleted_at as "deletedAt", provider_updated_at as "providerUpdatedAt",
             period_sequence as "periodSequence", provider_sequence::text as "providerSequence",
             provider_number as "providerNumber", wall_clock as "wallClock", event_type as "eventType"
      from public.play_events where game_id = ${gameId}`;
    const stored = new Map(storedRows.map((r) => [r.providerEventId, r]));
    const storedForGate: StoredEventForFreshness[] = storedRows.map((r) => ({
      providerEventId: r.providerEventId,
      deleted: r.deletedAt !== null,
      periodSequence: r.periodSequence,
      providerSequence: r.providerSequence === null ? null : Number(r.providerSequence),
      providerNumber: r.providerNumber,
      wallClock: iso(r.wallClock),
    }));

    // 2 + 3 (gate).
    const decision: BatchDecision = decideBatch(
      {
        watchRunId: g.watchRunId === null ? null : Number(g.watchRunId),
        lastSeq,
        status: g.status,
        currentPeriodSequence: g.currentPeriodSequence,
        observedAt: g.observedAt,
      },
      {
        watchId: observation.watchId,
        observedAt: observation.observedAt,
        isComplete: observation.isComplete,
        gameView: observation.gameView,
        eventPositions: batch.events.map((e) => ({
          periodSequence: e.periodSequence,
          providerSequence: e.providerSequence,
          providerNumber: e.providerNumber,
          wallClock: e.wallClock,
        })),
        deletedEventIds: batch.deletedEventIds,
      },
      storedForGate,
    );

    const storedView = viewJson(
      {
        status: g.status,
        score: { home: g.homePoints, away: g.awayPoints },
        period:
          g.currentPeriodSequence === null
            ? null
            : {
                number: g.currentPeriod ?? 0,
                type: g.periodType ?? 'quarter',
                sequence: g.currentPeriodSequence,
              },
        clock: g.clock,
      } as GameView,
      {
        eventCount: storedRows.filter((r) => r.deletedAt === null).length,
        newestPosition: newestPosition(storedForGate.filter((e) => !e.deleted)),
        observedAt: iso(g.observedAt),
        watchRunId: g.watchRunId === null ? null : Number(g.watchRunId),
        lastSeq,
      },
    );
    const incomingView = viewJson(observation.gameView, {
      eventCount: batch.events.length,
      deletedEventIds: batch.deletedEventIds,
      newestPosition: newestPosition(
        batch.events.map((e) => ({
          periodSequence: e.periodSequence,
          providerSequence: e.providerSequence,
          providerNumber: e.providerNumber,
          wallClock: e.wallClock,
        })),
      ),
      observedAt: observation.observedAt.toISOString(),
      watchId: observation.watchId,
      source: observation.source,
      isComplete: observation.isComplete,
    });

    const logStale = async (
      reason: 'older_run' | 'run_regresses_state' | 'superseded_observation',
    ) => {
      await tx`insert into ingest.stale_observations (game_id, run_id, source, observed_at, observation, stored, reason)
               values (${gameId}, ${observation.runId}, ${observation.source}, ${observation.observedAt},
                       ${tx.json(incomingView as never)}, ${tx.json(storedView as never)}, ${reason})`;
    };

    if (decision.kind === 'stale') {
      await logStale(decision.reason);
      await tx`update ingest.ingestion_runs set stale_batches = stale_batches + 1 where id = ${observation.runId}`;
      deps.log.warn({ gameId, reason: decision.reason, detail: decision.detail }, 'stale batch');
      return {
        outcome: 'stale',
        reason: decision.reason,
        detail: decision.detail,
        changes: [],
        lastSeq,
      };
    }

    if (decision.advanceWatchRunId && observation.watchId !== null) {
      await tx`update public.games set watch_run_id = ${observation.watchId} where id = ${gameId}`;
    }

    // 4. Diff (pure, see diff.ts).
    const diff = diffEvents(
      new Map(
        storedRows.map((r) => [
          r.providerEventId,
          {
            contentHash: r.contentHash,
            providerUpdatedAt: iso(r.providerUpdatedAt),
            deleted: r.deletedAt !== null,
          },
        ]),
      ),
      batch.events,
      batch.deletedEventIds,
    );
    const changes: PendingChange[] = [...diff.changes];
    const counts: ApplyCounts = diff.counts;
    const eventWrites = diff.writes.map((w) => ({ action: w.action, ev: w.event, hash: w.hash }));
    const deletions: StoredEventRow[] = [];
    for (const id of diff.deletions) {
      const s = stored.get(id);
      if (s) deletions.push(s);
    }

    // Game-level durable fields (status / score / period / line score).
    const gv = observation.gameView;
    let nextStatus: { status: GameStatus; score: Score; period: PeriodRef | null } | null = null;
    let nextPeriods: Array<PeriodRef & { score: Score }> | null = null;
    if (gv && decision.gameLevel === 'write') {
      const storedStatus = {
        status: g.status,
        score: { home: g.homePoints, away: g.awayPoints },
        period:
          g.currentPeriodSequence === null
            ? null
            : {
                number: g.currentPeriod ?? 0,
                type: g.periodType ?? 'quarter',
                sequence: g.currentPeriodSequence,
              },
      };
      const candidate = decision.restrictedGameLevel
        ? { ...storedStatus, status: gv.status }
        : { status: gv.status, score: gv.score, period: gv.period };
      if (contentHash(candidate) !== contentHash(storedStatus)) {
        nextStatus = candidate;
        changes.push({ type: 'status', body: candidate });
      }
      if (!decision.restrictedGameLevel && gv.periods.length > 0) {
        const rows = await tx<PeriodRow[]>`
          select sequence, number, type, home_points as "homePoints", away_points as "awayPoints"
          from public.game_periods where game_id = ${gameId} order by sequence`;
        const storedPeriods = rows.map((r) => ({
          number: r.number,
          type: r.type,
          sequence: r.sequence,
          score: { home: r.homePoints, away: r.awayPoints },
        }));
        const merged = mergePeriods(storedPeriods, gv.periods);
        if (contentHash(merged) !== contentHash(storedPeriods)) {
          nextPeriods = merged;
          changes.push({ type: 'period', body: { periods: merged } });
        }
      }
    } else if (gv && decision.gameLevel === 'superseded') {
      await logStale('superseded_observation');
      deps.log.info({ gameId, detail: decision.detail }, 'game-level view superseded');
    }

    // Stats: hash compare, always applied.
    const teamIds = await teamIdsFor(
      tx as unknown as Db,
      g.league,
      batch.teamStats.map((t) => t.providerTeamId),
    );
    const statsWrites: Array<{
      teamId: string;
      isHome: boolean;
      stats: NormalizedBatch['teamStats'][number]['stats'];
      hash: string;
    }> = [];
    if (batch.teamStats.length > 0) {
      const existing = await tx<{ teamId: string; contentHash: string | null }[]>`
        select team_id as "teamId", content_hash as "contentHash" from public.game_team_stats where game_id = ${gameId}`;
      const existingHash = new Map(existing.map((e) => [e.teamId, e.contentHash]));
      for (const ts of batch.teamStats) {
        const teamId = teamIds.get(ts.providerTeamId);
        if (!teamId) {
          deps.log.warn(
            { gameId, providerTeamId: ts.providerTeamId },
            'team stats for unknown team skipped',
          );
          continue;
        }
        const hash = contentHash(ts.stats);
        if (existingHash.get(teamId) === hash) continue;
        statsWrites.push({ teamId, isHome: ts.isHome, stats: ts.stats, hash });
        changes.push({
          type: 'stats_team',
          body: { teamId, providerTeamId: ts.providerTeamId, isHome: ts.isHome, stats: ts.stats },
        });
      }
    }

    // 5. Observation write: clock + freshness metadata, never a seq.
    if (gv) {
      await tx`update public.games set
                 scheduled_at = coalesce(${gv.scheduledAt}, scheduled_at),
                 coverage = ${coverageOf(gv.coverage)},
                 venue = coalesce(${gv.venue ? tx.json(gv.venue as never) : null}, venue),
                 broadcasts = coalesce(${gv.broadcasts ? tx.json(gv.broadcasts as never) : null}, broadcasts)
               where id = ${gameId}`;
    }
    if (gv && decision.gameLevel === 'write') {
      if (decision.restrictedGameLevel) {
        await tx`update public.games set observed_at = ${observation.observedAt}, observed_source = ${observation.source}
                 where id = ${gameId}`;
      } else {
        const newestIncoming = newestEventType(batch.events);
        const clockRunning = deriveClockRunning(
          { status: g.status, clock: g.clock, clockRunning: g.clockRunning },
          { status: gv.status, clock: gv.clock, clockRunning: gv.clockRunning },
          newestIncoming,
        );
        await tx`update public.games set
                   clock = ${gv.clock}, clock_decimal = ${gv.clockDecimal}, clock_running = ${clockRunning},
                   clock_as_of = ${observation.observedAt},
                   clock_extra = ${gv.clockExtra ? tx.json(gv.clockExtra as never) : null},
                   current_period_sequence = ${gv.period?.sequence ?? null},
                   observed_at = ${observation.observedAt}, observed_source = ${observation.source},
                   provider_updated_at = ${observation.providerUpdatedAt ?? gv.providerUpdatedAt ?? null}
                 where id = ${gameId}`;
      }
    }

    // 6. Durable write.
    const n = changes.length;
    let firstSeq: number | null = null;
    let newLastSeq = lastSeq;
    const numbered: GameChange[] = [];
    if (n > 0) {
      const [bumped] = await tx<{ lastSeq: string }[]>`
        update public.games set
          last_seq = last_seq + ${n},
          status = ${nextStatus ? nextStatus.status : g.status},
          home_points = ${nextStatus ? nextStatus.score.home : g.homePoints},
          away_points = ${nextStatus ? nextStatus.score.away : g.awayPoints},
          current_period = ${nextStatus ? (nextStatus.period?.number ?? null) : g.currentPeriod},
          period_type = ${nextStatus ? (nextStatus.period?.type ?? null) : g.periodType},
          stats_final_at = case when ${nextStatus?.status === 'closed'} and stats_final_at is null then ${now()} else stats_final_at end
        where id = ${gameId} returning last_seq::text as "lastSeq"`;
      if (!bumped) throw new Error('last_seq update returned no row');
      newLastSeq = Number(bumped.lastSeq);
      firstSeq = newLastSeq - n + 1;

      const playEventIds = new Map<string, string>();
      for (const w of eventWrites) {
        const teamId = w.ev.teamProviderId
          ? (teamIds.get(w.ev.teamProviderId) ??
            (await teamIdsFor(tx as unknown as Db, g.league, [w.ev.teamProviderId])).get(
              w.ev.teamProviderId,
            ) ??
            null)
          : null;
        const [row] = await tx<{ id: string }[]>`
          insert into public.play_events (game_id, provider_event_id, provider_number, provider_sequence,
            period_sequence, period_number, period_type, clock, clock_decimal, wall_clock, event_type,
            provider_event_type, team_id, home_points, away_points, payload, content_hash,
            provider_updated_at, deleted_at)
          values (${gameId}, ${w.ev.providerEventId}, ${w.ev.providerNumber}, ${w.ev.providerSequence},
            ${w.ev.periodSequence}, ${w.ev.periodNumber}, ${w.ev.periodType}, ${w.ev.clock}, ${w.ev.clockDecimal},
            ${w.ev.wallClock}, ${w.ev.body.type}, ${w.ev.providerEventType}, ${teamId},
            ${w.ev.homePoints}, ${w.ev.awayPoints}, ${tx.json(w.ev.body as never)}, ${w.hash},
            ${w.ev.providerUpdatedAt}, null)
          on conflict (game_id, provider_event_id) do update set
            provider_number = excluded.provider_number, provider_sequence = excluded.provider_sequence,
            period_sequence = excluded.period_sequence, period_number = excluded.period_number,
            period_type = excluded.period_type, clock = excluded.clock, clock_decimal = excluded.clock_decimal,
            wall_clock = excluded.wall_clock, event_type = excluded.event_type,
            provider_event_type = excluded.provider_event_type, team_id = excluded.team_id,
            home_points = excluded.home_points, away_points = excluded.away_points,
            payload = excluded.payload, content_hash = excluded.content_hash,
            provider_updated_at = excluded.provider_updated_at, deleted_at = null
          returning id`;
        if (!row) throw new Error('play_events upsert returned no row');
        playEventIds.set(w.ev.providerEventId, row.id);
        await tx`insert into ingest.play_event_raw (play_event_id, raw, provider_updated_at)
                 values (${row.id}, ${tx.json(w.ev.raw as never)}, ${w.ev.providerUpdatedAt})
                 on conflict (play_event_id) do update set raw = excluded.raw, provider_updated_at = excluded.provider_updated_at`;
      }
      for (const d of deletions) {
        await tx`update public.play_events set deleted_at = ${now()} where id = ${d.id}`;
        playEventIds.set(d.providerEventId, d.id);
      }
      if (nextPeriods) {
        for (const p of nextPeriods) {
          await tx`insert into public.game_periods (game_id, sequence, number, type, home_points, away_points)
                   values (${gameId}, ${p.sequence}, ${p.number}, ${p.type}, ${p.score.home}, ${p.score.away})
                   on conflict (game_id, sequence) do update set number = excluded.number, type = excluded.type,
                     home_points = excluded.home_points, away_points = excluded.away_points`;
        }
      }
      for (const s of statsWrites) {
        const st = s.stats;
        await tx`insert into public.game_team_stats (game_id, team_id, is_home, points, fgm, fga, tpm, tpa, ftm, fta,
                   off_rebounds, def_rebounds, rebounds, assists, steals, blocks, turnovers, personal_fouls,
                   fast_break_pts, paint_pts, second_chance_pts, bench_pts, biggest_lead, extra, content_hash)
                 values (${gameId}, ${s.teamId}, ${s.isHome}, ${st.points}, ${st.fgm}, ${st.fga}, ${st.tpm}, ${st.tpa},
                   ${st.ftm}, ${st.fta}, ${st.offRebounds}, ${st.defRebounds}, ${st.rebounds}, ${st.assists},
                   ${st.steals}, ${st.blocks}, ${st.turnovers}, ${st.personalFouls}, ${st.fastBreakPts},
                   ${st.paintPts}, ${st.secondChancePts}, ${st.benchPts}, ${st.biggestLead},
                   ${tx.json(st.extra as never)}, ${s.hash})
                 on conflict (game_id, team_id) do update set is_home = excluded.is_home, points = excluded.points,
                   fgm = excluded.fgm, fga = excluded.fga, tpm = excluded.tpm, tpa = excluded.tpa, ftm = excluded.ftm,
                   fta = excluded.fta, off_rebounds = excluded.off_rebounds, def_rebounds = excluded.def_rebounds,
                   rebounds = excluded.rebounds, assists = excluded.assists, steals = excluded.steals,
                   blocks = excluded.blocks, turnovers = excluded.turnovers, personal_fouls = excluded.personal_fouls,
                   fast_break_pts = excluded.fast_break_pts, paint_pts = excluded.paint_pts,
                   second_chance_pts = excluded.second_chance_pts, bench_pts = excluded.bench_pts,
                   biggest_lead = excluded.biggest_lead, extra = excluded.extra, content_hash = excluded.content_hash`;
      }

      let seq = firstSeq;
      for (const c of changes) {
        const providerEventId = 'providerEventId' in c ? c.providerEventId : null;
        const playEventId = providerEventId ? (playEventIds.get(providerEventId) ?? null) : null;
        const [row] = await tx<{ id: string; createdAt: Date }[]>`
          insert into public.game_changes (game_id, seq, change_type, play_event_id, provider_event_id, body, content_hash)
          values (${gameId}, ${seq}, ${c.type}, ${playEventId}, ${providerEventId}, ${tx.json(c.body as never)}, ${contentHash(c.body)})
          returning id, created_at as "createdAt"`;
        if (!row) throw new Error('game_changes insert returned no row');
        await tx`insert into ingest.broadcast_outbox (change_id, game_id, seq) values (${row.id}, ${gameId}, ${seq})`;
        numbered.push(
          gameChangeFromRow({
            id: row.id,
            gameId,
            seq,
            changeType: c.type,
            providerEventId,
            body: c.body,
            createdAt: row.createdAt,
          }),
        );
        seq++;
      }
      await tx`update ingest.ingestion_runs set
                 events_inserted = events_inserted + ${counts.inserted},
                 events_updated = events_updated + ${counts.updated},
                 events_deleted = events_deleted + ${counts.deleted}
               where id = ${observation.runId}`;
      await tx.notify('outbox', gameId);
      // Crash point (b): every write of this batch is issued; the transaction has not committed.
      deps.fault?.maybeFire('before_commit', newLastSeq);
    }

    return {
      outcome: 'applied',
      changes: numbered,
      firstSeq,
      lastSeq: newLastSeq,
      gameLevel: decision.gameLevel,
      generationAdvanced: decision.advanceWatchRunId,
      counts,
      detail: decision.detail,
    };
  }) as Promise<ApplyResult>;
}

/** Incoming line score replaces stored rows for the periods it carries; older rows are kept. */
function mergePeriods(
  stored: Array<PeriodRef & { score: Score }>,
  incoming: Array<PeriodRef & { score: Score }>,
): Array<PeriodRef & { score: Score }> {
  const bySeq = new Map(stored.map((p) => [p.sequence, p]));
  for (const p of incoming) bySeq.set(p.sequence, p);
  return [...bySeq.values()].sort((a, b) => a.sequence - b.sequence);
}

function newestEventType(events: NormalizedEvent[]): LiveEventType | null {
  const positions = events.map((e) => ({
    periodSequence: e.periodSequence,
    providerSequence: e.providerSequence,
    providerNumber: e.providerNumber,
    wallClock: e.wallClock,
  }));
  const newest = newestPosition(positions);
  if (!newest) return null;
  const idx = positions.indexOf(newest);
  return events[idx]?.body.type ?? null;
}

export type { Tx as ApplyTx };
