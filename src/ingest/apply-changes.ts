import type { TransactionSql } from 'postgres';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import type { LeagueCode } from '../leagues/codes.js';
import type { Logger } from '../logger.js';
import { contentHash } from '../model/content-hash.js';
import {
  type GameChange,
  gameChangeFromRow,
  type PendingChange,
  type StatsPlayerBody,
} from '../model/game-change.js';
import {
  type GameStatus,
  type LiveEventType,
  type PeriodRef,
  type PeriodType,
  type Score,
  ScoreSchema,
} from '../model/live-event.js';
import type { SeasonTotals } from '../providers/sportradar/schemas/common.js';
import { deriveClockRunning } from './clock.js';
import { diffEvents } from './diff.js';
import type { FaultInjector } from './fault.js';
import {
  type AmbiguousObservation,
  type BatchDecision,
  type BatchStaleReason,
  decideBatch,
  decideStats,
  newestPosition,
  type StaleReason,
  type StoredEventForFreshness,
} from './freshness.js';
import { ensureSeason, playerIdsFor, teamIdsFor } from './identity.js';
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
 *      game_periods, game_team_stats, game_player_stats, game_changes, broadcast_outbox, NOTIFY outbox
 *
 * Season-level stats and standings are not game state and carry no seq, but
 * they are stats tables, so their writers live here too (bottom of the file).
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
  /** Revision-only updates (newer `updated`, same body): no change row. */
  touched: number;
  deleted: number;
  ignoredOlder: number;
  /** Explicit deletion markers older than the stored event's revision. */
  ignoredOlderDeletions: number;
  unchanged: number;
  /** Stats entities (team or player) whose batch observedAt is not newer than the stored row's. */
  ignoredOlderStats: number;
  /** Stats entities confirmed by a newer observation with an identical hash (observed_at advanced). */
  touchedStats: number;
  /** Player stats lines whose player could not be resolved to a canonical id (skipped, logged). */
  unresolvedPlayers: number;
  /**
   * Lines of one document that repeat a provider player id an earlier line of the same document
   * already carried (a provider anomaly): the first line is the one applied, the repeat is
   * skipped. Two DIFFERENT provider ids that resolve to one canonical player are not duplicates:
   * rows, bodies and hashes are provider-keyed, so each keeps its own row and feed order is
   * irrelevant.
   */
  duplicateLines: number;
}

export type ApplyResult =
  | {
      outcome: 'stale';
      reason: BatchStaleReason;
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
  elamTargetScore: number | null;
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
  deletedRevisionAt: Date | null;
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

interface StatusState {
  status: GameStatus;
  score: Score;
  period: PeriodRef | null;
  elamTargetScore?: number;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/**
 * The bits of the latest `ambiguous_regression` row rule 2(d) reads back (our own jsonb, parsed
 * anyway). `watchId` is the jsonb text of the generation that logged it: a row without one is
 * unusable and must fail here, never become 0. `distinctScores` counts the distinct scores logged
 * as ambiguous by that same generation for this game.
 */
const AmbiguousRowSchema = z.object({
  watchId: z
    .string()
    .regex(/^\d+$/)
    .transform((v) => Number(v)),
  score: ScoreSchema,
  observedAt: z.date(),
  distinctScores: z.int().positive(),
});

function viewJson(gv: GameView | null, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    status: gv?.status ?? null,
    unknownStatus: gv?.unknownStatus ?? null,
    score: gv?.score ?? null,
    periodSequence: gv?.period?.sequence ?? null,
    clock: gv?.clock ?? null,
    ...extra,
  };
}

/**
 * Create the games row if it does not exist. Status is taken from the document
 * only on insert; a document with an unknown provider status creates the row as
 * `scheduled` (logged). This is the ONLY place a default status exists: on
 * update an unknown status keeps the stored one (plan §4 rule 3).
 */
export async function ensureGame(
  db: Db | Tx,
  game: {
    league: LeagueCode;
    providerGameId: string;
    /** Null when the document carries no `scheduled`: now() on insert, stored value kept on update. */
    scheduledAt: string | null;
    status: GameStatus | null;
    coverage: string | null;
    homeTeamId: string | null;
    awayTeamId: string | null;
    venue: Record<string, unknown> | null;
    broadcasts: unknown[] | null;
    seasonId?: string | null;
    tournamentId?: string | null;
    title?: string | null;
  },
  log?: Logger,
): Promise<{ id: string; created: boolean }> {
  // 'unknown' exists only at row creation when the document carries no coverage; on update an
  // omitted or unrecognized coverage keeps the stored value (omission is not change).
  const coverage = coverageOf(game.coverage);
  if (game.coverage !== null && coverage === null) {
    log?.warn(
      { providerGameId: game.providerGameId, coverage: game.coverage },
      'unrecognized provider coverage; stored value kept',
    );
  }
  const status: GameStatus = game.status ?? 'scheduled';
  if (game.status === null) {
    log?.warn(
      { providerGameId: game.providerGameId },
      'unknown provider status at game creation; row defaults to scheduled',
    );
  }
  const [row] = await db<{ id: string; created: boolean }[]>`
    insert into public.games (league, provider_game_id, scheduled_at, status, coverage,
                              home_team_id, away_team_id, venue, broadcasts, season_id, tournament_id, title)
    values (${game.league}, ${game.providerGameId}, coalesce(${game.scheduledAt}::timestamptz, now()), ${status}, ${coverage ?? 'unknown'},
            ${game.homeTeamId}, ${game.awayTeamId},
            ${game.venue ? db.json(game.venue as never) : null},
            ${game.broadcasts ? db.json(game.broadcasts as never) : null},
            ${game.seasonId ?? null}, ${game.tournamentId ?? null}, ${game.title ?? null})
    on conflict (league, provider_game_id) do update
      set scheduled_at = coalesce(${game.scheduledAt}::timestamptz, public.games.scheduled_at),
          coverage = coalesce(${coverage}::public.coverage_level, public.games.coverage),
          home_team_id = coalesce(excluded.home_team_id, public.games.home_team_id),
          away_team_id = coalesce(excluded.away_team_id, public.games.away_team_id),
          venue = coalesce(excluded.venue, public.games.venue),
          broadcasts = coalesce(excluded.broadcasts, public.games.broadcasts),
          season_id = coalesce(excluded.season_id, public.games.season_id),
          tournament_id = coalesce(excluded.tournament_id, public.games.tournament_id),
          title = coalesce(excluded.title, public.games.title)
    returning id, (xmax = 0) as created`;
  if (!row) throw new Error('games upsert returned no row');
  return row;
}

/** Recognized coverage levels; null for an omitted or unrecognized value (never 'unknown' on update). */
function coverageOf(c: string | null): 'full' | 'extended_boxscore' | 'boxscore' | null {
  switch (c) {
    case 'full':
    case 'extended_boxscore':
    case 'boxscore':
      return c;
    default:
      return null;
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
             elam_target_score as "elamTargetScore",
             last_seq::text as "lastSeq", watch_run_id::text as "watchRunId",
             current_period_sequence as "currentPeriodSequence", observed_at as "observedAt",
             clock, clock_running as "clockRunning"
      from public.games where id = ${gameId} for update`;
    if (!g) throw new Error(`game ${gameId} not found`);
    const lastSeq = Number(g.lastSeq);

    // 3 (load). Current play state; rule 2c needs positions, rule 3 needs revisions.
    const storedRows = await tx<StoredEventRow[]>`
      select id, provider_event_id as "providerEventId", content_hash as "contentHash",
             deleted_at as "deletedAt", deleted_revision_at as "deletedRevisionAt",
             provider_updated_at as "providerUpdatedAt",
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

    // Rule 2d reads the most recent ambiguous observation for this game inside the transaction.
    let lastAmbiguous: AmbiguousObservation | null = null;
    const [ambiguousRow] = await tx<
      { watchId: unknown; score: unknown; observedAt: Date; distinctScores: number }[]
    >`
      select s1.observation->>'watchId' as "watchId", s1.observation->'score' as score,
             s1.observed_at as "observedAt",
             (select count(distinct s2.observation->'score')::int from ingest.stale_observations s2
               where s2.game_id = s1.game_id and s2.reason = 'ambiguous_regression'
                 and s2.observation->>'watchId' = s1.observation->>'watchId') as "distinctScores"
      from ingest.stale_observations s1
      where s1.game_id = ${gameId} and s1.reason = 'ambiguous_regression'
      order by s1.observed_at desc, s1.id desc limit 1`;
    if (ambiguousRow) {
      const parsed = AmbiguousRowSchema.safeParse(ambiguousRow);
      if (parsed.success) {
        const { distinctScores, ...rest } = parsed.data;
        lastAmbiguous = { ...rest, otherScoresSeen: distinctScores > 1 };
      } else {
        deps.log.warn({ gameId, issues: parsed.error.issues }, 'unusable ambiguous_regression row');
      }
    }

    // 2 + 3 (gate).
    const decision: BatchDecision = decideBatch(
      {
        watchRunId: g.watchRunId === null ? null : Number(g.watchRunId),
        lastSeq,
        status: g.status,
        currentPeriodSequence: g.currentPeriodSequence,
        observedAt: g.observedAt,
        score: { home: g.homePoints, away: g.awayPoints },
        clock: g.clock,
        lastAmbiguous,
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
        deletedEvents: batch.deletedEvents,
        eventCount: batch.events.length,
        deletionCount: batch.deletedEvents.length,
      },
      storedForGate,
    );

    const storedPeriodRef: PeriodRef | null =
      g.currentPeriodSequence === null
        ? null
        : {
            number: g.currentPeriod ?? 0,
            type: g.periodType ?? 'quarter',
            sequence: g.currentPeriodSequence,
          };
    const storedView = viewJson(
      {
        status: g.status,
        unknownStatus: null,
        score: { home: g.homePoints, away: g.awayPoints },
        period: storedPeriodRef,
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
      deletedEvents: batch.deletedEvents,
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

    // `observation` carries watchId and score, so rule 2d can read a previous ambiguous row without a
    // join, and the decision `detail` (e.g. `2d: ...`, `3-lagging-view: ...`) so the row explains itself.
    const logStale = async (reason: StaleReason) => {
      const logged = { ...incomingView, detail: decision.detail };
      await tx`insert into ingest.stale_observations (game_id, run_id, source, observed_at, observation, stored, reason)
               values (${gameId}, ${observation.runId}, ${observation.source}, ${observation.observedAt},
                       ${tx.json(logged as never)}, ${tx.json(storedView as never)}, ${reason})`;
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

    if (
      observation.gameView?.unknownStatus !== null &&
      observation.gameView?.unknownStatus !== undefined
    ) {
      deps.log.warn(
        { gameId, providerStatus: observation.gameView.unknownStatus, stored: g.status },
        'unknown provider status; stored status kept',
      );
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
            deletedRevisionAt: iso(r.deletedRevisionAt),
          },
        ]),
      ),
      batch.events,
      batch.deletedEvents,
    );
    const changes: PendingChange[] = [...diff.changes];
    const counts: ApplyCounts = {
      ...diff.counts,
      ignoredOlderStats: 0,
      touchedStats: 0,
      unresolvedPlayers: 0,
      duplicateLines: 0,
    };
    const eventWrites = diff.writes.map((w) => ({ action: w.action, ev: w.event, hash: w.hash }));
    const deletions: Array<{ row: StoredEventRow; revision: string | null }> = [];
    for (const marker of diff.deletions) {
      const s = stored.get(marker.providerEventId);
      if (s) deletions.push({ row: s, revision: marker.updatedAt });
    }

    // Game-level durable fields (status / score / period / Elam target / line score).
    const gv = observation.gameView;
    let nextStatus: StatusState | null = null;
    let nextPeriods: Array<PeriodRef & { score: Score }> | null = null;
    if (gv && decision.gameLevel === 'write') {
      const storedStatus: StatusState = {
        status: g.status,
        score: { home: g.homePoints, away: g.awayPoints },
        period: storedPeriodRef,
        ...(g.elamTargetScore !== null ? { elamTargetScore: g.elamTargetScore } : {}),
      };
      // An unknown provider status (null) keeps the stored status: omission is not change.
      const status = gv.status ?? g.status;
      const target = gv.elamTargetScore ?? g.elamTargetScore;
      const candidate: StatusState = decision.restrictedGameLevel
        ? { ...storedStatus, status }
        : {
            status,
            score: gv.score,
            period: gv.period,
            ...(target !== null ? { elamTargetScore: target } : {}),
          };
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

    // Identity lookups (read-only here; GameWatcher ensures rows before applyChanges).
    const teamIds = await teamIdsFor(tx, g.league, [
      ...batch.teamStats.map((t) => t.providerTeamId),
      ...batch.playerStats.map((p) => p.providerTeamId),
      ...batch.events.flatMap((e) => (e.teamProviderId ? [e.teamProviderId] : [])),
    ]);
    const playerIds = await playerIdsFor(tx, g.league, [
      ...batch.playerStats.map((p) => p.providerPlayerId),
      ...batch.events.flatMap((e) => (e.playerProviderId ? [e.playerProviderId] : [])),
    ]);

    // Stats: observation precedence per entity (rule 3). Newer observedAt than the stored row:
    // a differing hash is a stats_* change, an identical one only advances observed_at.
    // Older or equal: ignored (counted). Closed games take later corrections like any other.
    const statsWrites: Array<{
      teamId: string;
      isHome: boolean;
      stats: NormalizedBatch['teamStats'][number]['stats'];
      hash: string;
    }> = [];
    const statsTouches: string[] = [];
    if (batch.teamStats.length > 0) {
      const existing = await tx<
        { teamId: string; contentHash: string | null; observedAt: Date | null }[]
      >`
        select team_id as "teamId", content_hash as "contentHash", observed_at as "observedAt"
        from public.game_team_stats where game_id = ${gameId}`;
      const existingByTeam = new Map(existing.map((e) => [e.teamId, e]));
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
        const action = decideStats(existingByTeam.get(teamId), {
          contentHash: hash,
          observedAt: observation.observedAt,
        });
        switch (action) {
          case 'ignore_older':
            counts.ignoredOlderStats++;
            break;
          case 'touch':
            counts.touchedStats++;
            statsTouches.push(teamId);
            break;
          default:
            statsWrites.push({ teamId, isHome: ts.isHome, stats: ts.stats, hash });
            changes.push({
              type: 'stats_team',
              body: { providerTeamId: ts.providerTeamId, isHome: ts.isHome, stats: ts.stats },
            });
        }
      }
    }
    for (const teamId of statsTouches) {
      await tx`update public.game_team_stats set observed_at = ${observation.observedAt}, updated_at = now()
               where game_id = ${gameId} and team_id = ${teamId}`;
    }

    // Player stats: same precedence. The row, the body and its hash are all keyed on the PROVIDER
    // player id (plan §3): game_player_stats has PK (game_id, provider_player_id) and player_id is
    // the canonical id resolved at write time. An identity merge repoints player_id and leaves
    // the row, so the next identical summary is a no-op, two provider ids merged into one person
    // keep two rows (exactly what the change stream gave every client), and the order a feed
    // lists players in cannot change the outcome. The hash covers the whole line (roster facts
    // included), so a change of starter/on_court is a change like any other.
    const playerWrites: Array<{
      playerId: string;
      teamId: string;
      body: StatsPlayerBody;
      hash: string;
    }> = [];
    const playerTouches: string[] = [];
    if (batch.playerStats.length > 0) {
      const existing = await tx<
        { providerPlayerId: string; contentHash: string | null; observedAt: Date | null }[]
      >`
        select provider_player_id as "providerPlayerId", content_hash as "contentHash", observed_at as "observedAt"
        from public.game_player_stats where game_id = ${gameId}`;
      const existingByProviderId = new Map(existing.map((e) => [e.providerPlayerId, e]));
      const seenLines = new Set<string>();
      for (const line of batch.playerStats) {
        const playerId = playerIds.get(line.providerPlayerId);
        const teamId = teamIds.get(line.providerTeamId);
        if (!playerId || !teamId) {
          counts.unresolvedPlayers++;
          deps.log.warn(
            {
              gameId,
              providerPlayerId: line.providerPlayerId,
              providerTeamId: line.providerTeamId,
            },
            'player stats for unresolved player or team skipped',
          );
          continue;
        }
        if (seenLines.has(line.providerPlayerId)) {
          // The same provider id twice in one document: one row per (game, provider id), the
          // first line is the one applied; the outcome is deterministic for the document.
          counts.duplicateLines++;
          deps.log.warn(
            { gameId, providerPlayerId: line.providerPlayerId },
            'player stats line skipped: this document already carried that provider id',
          );
          continue;
        }
        seenLines.add(line.providerPlayerId);
        const body: StatsPlayerBody = {
          providerPlayerId: line.providerPlayerId,
          providerTeamId: line.providerTeamId,
          fullName: line.fullName,
          jersey: line.jersey,
          position: line.position,
          starter: line.starter,
          played: line.played,
          onCourt: line.onCourt,
          notPlayingReason: line.notPlayingReason,
          stats: line.stats,
        };
        const hash = contentHash(body);
        const action = decideStats(existingByProviderId.get(line.providerPlayerId), {
          contentHash: hash,
          observedAt: observation.observedAt,
        });
        switch (action) {
          case 'ignore_older':
            counts.ignoredOlderStats++;
            break;
          case 'touch':
            counts.touchedStats++;
            playerTouches.push(line.providerPlayerId);
            break;
          default:
            playerWrites.push({ playerId, teamId, body, hash });
            changes.push({ type: 'stats_player', body });
        }
      }
    }
    for (const providerPlayerId of playerTouches) {
      await tx`update public.game_player_stats set observed_at = ${observation.observedAt}, updated_at = now()
               where game_id = ${gameId} and provider_player_id = ${providerPlayerId}`;
    }

    // 5. Observation write: clock + freshness metadata, never a seq. Omission is not change:
    // every field here is coalesced, so a document that omits it leaves the stored value in place.
    if (gv) {
      const coverage = coverageOf(gv.coverage);
      if (gv.coverage !== null && coverage === null) {
        deps.log.warn(
          { gameId, coverage: gv.coverage },
          'unrecognized provider coverage; stored value kept',
        );
      }
      const seasonId = gv.season ? await ensureSeason(tx, g.league, gv.season, deps.log) : null;
      await tx`update public.games set
                 scheduled_at = coalesce(${gv.scheduledAt}, scheduled_at),
                 coverage = coalesce(${coverage}::public.coverage_level, coverage),
                 venue = coalesce(${gv.venue ? tx.json(gv.venue as never) : null}, venue),
                 broadcasts = coalesce(${gv.broadcasts ? tx.json(gv.broadcasts as never) : null}, broadcasts),
                 season_id = coalesce(${seasonId}::uuid, season_id),
                 title = coalesce(${gv.title}, title)
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
          { status: gv.status ?? g.status, clock: gv.clock, clockRunning: gv.clockRunning },
          newestIncoming,
        );
        await tx`update public.games set
                   clock = ${gv.clock}, clock_decimal = ${gv.clockDecimal}, clock_running = ${clockRunning},
                   clock_as_of = ${observation.observedAt},
                   clock_extra = coalesce(${gv.clockExtra ? tx.json(gv.clockExtra as never) : null}, clock_extra),
                   current_period_sequence = ${gv.period?.sequence ?? null},
                   observed_at = ${observation.observedAt}, observed_source = ${observation.source},
                   provider_updated_at = coalesce(${observation.providerUpdatedAt ?? gv.providerUpdatedAt ?? null}::timestamptz, provider_updated_at)
                 where id = ${gameId}`;
      }
    }

    // 5b. Revision-only updates: a newer `updated` with an identical body advances the stored
    // revision (and the raw copy) so a later, differing, intermediate revision is seen as older.
    // No change row, no seq.
    for (const ev of diff.touches) {
      const s = stored.get(ev.providerEventId);
      if (!s) continue;
      await tx`update public.play_events set provider_updated_at = ${ev.providerUpdatedAt}, updated_at = now()
               where id = ${s.id}`;
      await tx`insert into ingest.play_event_raw (play_event_id, raw, provider_updated_at)
               values (${s.id}, ${tx.json(ev.raw as never)}, ${ev.providerUpdatedAt})
               on conflict (play_event_id) do update set raw = excluded.raw, provider_updated_at = excluded.provider_updated_at`;
    }

    // A repeated deletion can advance its revision without changing the deleted state.
    // Keep the original deleted_at and allocate neither a change nor an outbox row.
    for (const marker of diff.deletionTouches) {
      const s = stored.get(marker.providerEventId);
      if (!s) continue;
      await tx`update public.play_events set deleted_revision_at = ${marker.updatedAt}, updated_at = now()
               where id = ${s.id}`;
    }

    // 6. Durable write.
    const n = changes.length;
    let firstSeq: number | null = null;
    let newLastSeq = lastSeq;
    const numbered: GameChange[] = [];
    if (n > 0) {
      // stats_final_at marks the close that final stats can follow from. A generation-less batch
      // (schedule poll) may close a never-watched game (restrictedGameLevel: status only, 0-0
      // score stays), but a schedule entry carries no stats, so the mark is left for a watcher's
      // own closing document.
      const statsFinal = nextStatus?.status === 'closed' && !decision.restrictedGameLevel;
      const [bumped] = await tx<{ lastSeq: string }[]>`
        update public.games set
          last_seq = last_seq + ${n},
          status = coalesce(${nextStatus?.status ?? null}::public.game_status, status),
          home_points = ${nextStatus ? nextStatus.score.home : g.homePoints},
          away_points = ${nextStatus ? nextStatus.score.away : g.awayPoints},
          current_period = ${nextStatus ? (nextStatus.period?.number ?? null) : g.currentPeriod},
          period_type = ${nextStatus ? (nextStatus.period?.type ?? null) : g.periodType},
          elam_target_score = ${nextStatus ? (nextStatus.elamTargetScore ?? null) : g.elamTargetScore},
          stats_final_at = case when ${statsFinal} and stats_final_at is null then ${now()} else stats_final_at end
        where id = ${gameId} returning last_seq::text as "lastSeq"`;
      if (!bumped) throw new Error('last_seq update returned no row');
      newLastSeq = Number(bumped.lastSeq);
      firstSeq = newLastSeq - n + 1;

      const playEventIds = new Map<string, string>();
      for (const w of eventWrites) {
        const teamId = w.ev.teamProviderId ? (teamIds.get(w.ev.teamProviderId) ?? null) : null;
        const playerId = w.ev.playerProviderId
          ? (playerIds.get(w.ev.playerProviderId) ?? null)
          : null;
        const [row] = await tx<{ id: string }[]>`
          insert into public.play_events (game_id, provider_event_id, provider_number, provider_sequence,
            period_sequence, period_number, period_type, clock, clock_decimal, wall_clock, event_type,
            provider_event_type, team_id, player_id, home_points, away_points, payload, content_hash,
            provider_updated_at, deleted_at)
          values (${gameId}, ${w.ev.providerEventId}, ${w.ev.providerNumber}, ${w.ev.providerSequence},
            ${w.ev.periodSequence}, ${w.ev.periodNumber}, ${w.ev.periodType}, ${w.ev.clock}, ${w.ev.clockDecimal},
            ${w.ev.wallClock}, ${w.ev.body.type}, ${w.ev.providerEventType}, ${teamId}, ${playerId},
            ${w.ev.homePoints}, ${w.ev.awayPoints}, ${tx.json(w.ev.body as never)}, ${w.hash},
            ${w.ev.providerUpdatedAt}, null)
          on conflict (game_id, provider_event_id) do update set
            provider_number = excluded.provider_number, provider_sequence = excluded.provider_sequence,
            period_sequence = excluded.period_sequence, period_number = excluded.period_number,
            period_type = excluded.period_type, clock = excluded.clock, clock_decimal = excluded.clock_decimal,
            wall_clock = excluded.wall_clock, event_type = excluded.event_type,
            provider_event_type = excluded.provider_event_type, team_id = excluded.team_id,
            player_id = coalesce(excluded.player_id, play_events.player_id),
            home_points = excluded.home_points, away_points = excluded.away_points,
            payload = excluded.payload, content_hash = excluded.content_hash,
            provider_updated_at = coalesce(excluded.provider_updated_at, play_events.provider_updated_at),
            deleted_at = null, deleted_revision_at = null
          returning id`;
        if (!row) throw new Error('play_events upsert returned no row');
        playEventIds.set(w.ev.providerEventId, row.id);
        await tx`insert into ingest.play_event_raw (play_event_id, raw, provider_updated_at)
                 values (${row.id}, ${tx.json(w.ev.raw as never)}, ${w.ev.providerUpdatedAt})
                 on conflict (play_event_id) do update set raw = excluded.raw,
                   provider_updated_at = coalesce(excluded.provider_updated_at, play_event_raw.provider_updated_at)`;
      }
      for (const d of deletions) {
        await tx`update public.play_events set deleted_at = ${now()}, deleted_revision_at = ${d.revision}, updated_at = now()
                 where id = ${d.row.id}`;
        playEventIds.set(d.row.providerEventId, d.row.id);
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
                   fast_break_pts, paint_pts, second_chance_pts, bench_pts, biggest_lead, extra, content_hash,
                   observed_at)
                 values (${gameId}, ${s.teamId}, ${s.isHome}, ${st.points}, ${st.fgm}, ${st.fga}, ${st.tpm}, ${st.tpa},
                   ${st.ftm}, ${st.fta}, ${st.offRebounds}, ${st.defRebounds}, ${st.rebounds}, ${st.assists},
                   ${st.steals}, ${st.blocks}, ${st.turnovers}, ${st.personalFouls}, ${st.fastBreakPts},
                   ${st.paintPts}, ${st.secondChancePts}, ${st.benchPts}, ${st.biggestLead},
                   ${tx.json(st.extra as never)}, ${s.hash}, ${observation.observedAt})
                 on conflict (game_id, team_id) do update set is_home = excluded.is_home, points = excluded.points,
                   fgm = excluded.fgm, fga = excluded.fga, tpm = excluded.tpm, tpa = excluded.tpa, ftm = excluded.ftm,
                   fta = excluded.fta, off_rebounds = excluded.off_rebounds, def_rebounds = excluded.def_rebounds,
                   rebounds = excluded.rebounds, assists = excluded.assists, steals = excluded.steals,
                   blocks = excluded.blocks, turnovers = excluded.turnovers, personal_fouls = excluded.personal_fouls,
                   fast_break_pts = excluded.fast_break_pts, paint_pts = excluded.paint_pts,
                   second_chance_pts = excluded.second_chance_pts, bench_pts = excluded.bench_pts,
                   biggest_lead = excluded.biggest_lead, extra = excluded.extra, content_hash = excluded.content_hash,
                   observed_at = excluded.observed_at, updated_at = now()`;
      }
      for (const w of playerWrites) {
        const b = w.body;
        const st = b.stats;
        await tx`insert into public.game_player_stats (game_id, player_id, team_id, provider_player_id, full_name, starter, played,
                   on_court, minutes, points, fgm, fga, tpm, tpa, ftm, fta, off_rebounds, def_rebounds, rebounds, assists,
                   steals, blocks, turnovers, personal_fouls, plus_minus, efficiency, extra, content_hash, observed_at,
                   jersey, position, not_playing_reason)
                 values (${gameId}, ${w.playerId}, ${w.teamId}, ${b.providerPlayerId}, ${b.fullName}, ${b.starter}, ${b.played},
                   ${b.onCourt}, ${st.minutes}, ${st.points}, ${st.fgm}, ${st.fga}, ${st.tpm}, ${st.tpa}, ${st.ftm},
                   ${st.fta}, ${st.offRebounds}, ${st.defRebounds}, ${st.rebounds}, ${st.assists}, ${st.steals},
                   ${st.blocks}, ${st.turnovers}, ${st.personalFouls}, ${st.plusMinus}, ${st.efficiency},
                   ${tx.json(st.extra as never)}, ${w.hash}, ${observation.observedAt}, ${b.jersey}, ${b.position},
                   ${b.notPlayingReason})
                 on conflict (game_id, provider_player_id) do update set team_id = excluded.team_id,
                   player_id = excluded.player_id, full_name = excluded.full_name, starter = excluded.starter,
                   played = excluded.played, on_court = excluded.on_court, minutes = excluded.minutes,
                   points = excluded.points, fgm = excluded.fgm, fga = excluded.fga, tpm = excluded.tpm, tpa = excluded.tpa,
                   ftm = excluded.ftm, fta = excluded.fta, off_rebounds = excluded.off_rebounds,
                   def_rebounds = excluded.def_rebounds, rebounds = excluded.rebounds, assists = excluded.assists,
                   steals = excluded.steals, blocks = excluded.blocks, turnovers = excluded.turnovers,
                   personal_fouls = excluded.personal_fouls, plus_minus = excluded.plus_minus,
                   efficiency = excluded.efficiency, extra = excluded.extra, content_hash = excluded.content_hash,
                   observed_at = excluded.observed_at, jersey = excluded.jersey, position = excluded.position,
                   not_playing_reason = excluded.not_playing_reason, updated_at = now()`;
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

/* ------------------------------------------------------------------------- */
/* Season-level stats and standings (no seq, no change stream)                */
/* ------------------------------------------------------------------------- */

export interface PlayerSeasonLine {
  playerId: string;
  seasonId: string;
  teamId: string;
  total: SeasonTotals;
  average: Record<string, unknown> | null;
}

const SEASON_TYPED_KEYS = new Set([
  'games_played',
  'games_started',
  'minutes',
  'points',
  'rebounds',
  'offensive_rebounds',
  'defensive_rebounds',
  'assists',
  'steals',
  'blocks',
  'turnovers',
  'personal_fouls',
  'field_goals_made',
  'field_goals_att',
  'three_points_made',
  'three_points_att',
  'free_throws_made',
  'free_throws_att',
  'plus',
  'minus',
]);

/**
 * Upsert player season lines (profile `seasons[]`, seasonal statistics,
 * league leaders). Content-hashed: an unchanged line is not rewritten, so
 * re-applying the same document is a no-op. Returns the number of lines written.
 */
export async function applyPlayerSeasonStats(
  db: Db | Tx,
  lines: PlayerSeasonLine[],
): Promise<number> {
  let written = 0;
  for (const l of lines) {
    const t = l.total;
    const extra: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(t)) if (!SEASON_TYPED_KEYS.has(k)) extra[k] = v;
    const hash = contentHash({ total: t, average: l.average });
    const plusMinus =
      t.plus !== undefined || t.minus !== undefined
        ? Math.round((t.plus ?? 0) - (t.minus ?? 0))
        : null;
    const [row] = await db<{ id: string }[]>`
      insert into public.player_season_stats (player_id, season_id, team_id, games_played, games_started, minutes,
        points, rebounds, off_rebounds, def_rebounds, assists, steals, blocks, turnovers, personal_fouls,
        fgm, fga, tpm, tpa, ftm, fta, plus_minus, averages, extra, content_hash)
      values (${l.playerId}, ${l.seasonId}, ${l.teamId}, ${t.games_played ?? null}, ${t.games_started ?? null},
        ${t.minutes ?? null}, ${t.points ?? null}, ${t.rebounds ?? null}, ${t.offensive_rebounds ?? null},
        ${t.defensive_rebounds ?? null}, ${t.assists ?? null}, ${t.steals ?? null}, ${t.blocks ?? null},
        ${t.turnovers ?? null}, ${t.personal_fouls ?? null}, ${t.field_goals_made ?? null}, ${t.field_goals_att ?? null},
        ${t.three_points_made ?? null}, ${t.three_points_att ?? null}, ${t.free_throws_made ?? null},
        ${t.free_throws_att ?? null}, ${plusMinus}, ${l.average ? db.json(l.average as never) : null},
        ${db.json(extra as never)}, ${hash})
      on conflict (player_id, season_id, team_id) do update set
        games_played = excluded.games_played, games_started = excluded.games_started, minutes = excluded.minutes,
        points = excluded.points, rebounds = excluded.rebounds, off_rebounds = excluded.off_rebounds,
        def_rebounds = excluded.def_rebounds, assists = excluded.assists, steals = excluded.steals,
        blocks = excluded.blocks, turnovers = excluded.turnovers, personal_fouls = excluded.personal_fouls,
        fgm = excluded.fgm, fga = excluded.fga, tpm = excluded.tpm, tpa = excluded.tpa, ftm = excluded.ftm,
        fta = excluded.fta, plus_minus = excluded.plus_minus, averages = excluded.averages, extra = excluded.extra,
        content_hash = excluded.content_hash, updated_at = now()
      where public.player_season_stats.content_hash is distinct from excluded.content_hash
      returning player_id as id`;
    if (row) written++;
  }
  return written;
}

export interface TeamSeasonLine {
  teamId: string;
  seasonId: string;
  gamesPlayed: number | null;
  totals: Record<string, unknown>;
  averages: Record<string, unknown> | null;
  extra: Record<string, unknown> | null;
}

export async function applyTeamSeasonStats(db: Db | Tx, lines: TeamSeasonLine[]): Promise<number> {
  let written = 0;
  for (const l of lines) {
    const hash = contentHash({ totals: l.totals, averages: l.averages, extra: l.extra });
    const [row] = await db<{ id: string }[]>`
      insert into public.team_season_stats (team_id, season_id, games_played, totals, averages, extra, content_hash)
      values (${l.teamId}, ${l.seasonId}, ${l.gamesPlayed}, ${db.json(l.totals as never)},
              ${l.averages ? db.json(l.averages as never) : null}, ${l.extra ? db.json(l.extra as never) : null}, ${hash})
      on conflict (team_id, season_id) do update set games_played = excluded.games_played, totals = excluded.totals,
        averages = excluded.averages, extra = excluded.extra, content_hash = excluded.content_hash, updated_at = now()
      where public.team_season_stats.content_hash is distinct from excluded.content_hash
      returning team_id as id`;
    if (row) written++;
  }
  return written;
}

export interface StandingLine {
  seasonId: string;
  teamId: string;
  conference: string | null;
  division: string | null;
  wins: number;
  losses: number;
  winPct: number | null;
  gamesBehind: number | null;
  confWins: number | null;
  confLosses: number | null;
  pointsFor: number | null;
  pointsAgainst: number | null;
  streak: string | null;
  rank: number | null;
  records: unknown[] | null;
  extra: Record<string, unknown> | null;
  asOf: Date;
}

/**
 * Upsert standings lines. `as_of` is the observation at which the line LAST
 * CHANGED (it sits outside the hash but inside the distinct guard), so a
 * re-presented identical table leaves the row, and its `as_of`, untouched.
 */
export async function applyStandings(db: Db | Tx, lines: StandingLine[]): Promise<number> {
  let written = 0;
  for (const l of lines) {
    const { asOf, seasonId, teamId, ...hashed } = l;
    const hash = contentHash(hashed);
    const [row] = await db<{ id: string }[]>`
      insert into public.standings (season_id, team_id, conference, division, wins, losses, win_pct, games_behind,
        conf_wins, conf_losses, points_for, points_against, streak, rank, records, extra, as_of, content_hash)
      values (${seasonId}, ${teamId}, ${l.conference}, ${l.division}, ${l.wins}, ${l.losses}, ${l.winPct},
        ${l.gamesBehind}, ${l.confWins}, ${l.confLosses}, ${l.pointsFor}, ${l.pointsAgainst}, ${l.streak}, ${l.rank},
        ${l.records ? db.json(l.records as never) : null}, ${l.extra ? db.json(l.extra as never) : null}, ${asOf}, ${hash})
      on conflict (season_id, team_id) do update set conference = excluded.conference, division = excluded.division,
        wins = excluded.wins, losses = excluded.losses, win_pct = excluded.win_pct, games_behind = excluded.games_behind,
        conf_wins = excluded.conf_wins, conf_losses = excluded.conf_losses, points_for = excluded.points_for,
        points_against = excluded.points_against, streak = excluded.streak, rank = excluded.rank,
        records = excluded.records, extra = excluded.extra, as_of = excluded.as_of, content_hash = excluded.content_hash,
        updated_at = now()
      where public.standings.content_hash is distinct from excluded.content_hash
      returning team_id as id`;
    if (row) written++;
  }
  return written;
}

/* ------------------------------------------------------------------------- */
/* Identity merge: FK repoint of the tables this module owns (play_events,     */
/* game_player_stats, player_season_stats; CLAUDE.md non-negotiable 2).       */
/* player_team_seasons is roster data and is repointed by identity.ts.        */
/* ------------------------------------------------------------------------- */

/** A row a merge had to drop because the survivor already owned its key, with its full content. */
export interface MergeConflict {
  table: 'player_season_stats' | 'player_team_seasons';
  row: Record<string, unknown>;
}

export interface RepointCounts {
  playEvents: number;
  /** Provider-keyed rows: repointed only, never dropped. */
  gamePlayerStats: { repointed: number };
  playerSeasonStats: { repointed: number; dropped: number };
  playerTeamSeasons: { repointed: number; dropped: number };
}

export interface RepointResult {
  counts: Omit<RepointCounts, 'playerTeamSeasons'>;
  /** Content of every dropped row, for ingest.player_merges.conflicts. */
  conflicts: MergeConflict[];
}

/**
 * Move every row that references `loser` to `survivor` inside the caller's
 * merge transaction (identity.ts mergePlayers).
 * - play_events and game_player_stats are repointed in place. game_player_stats
 *   is keyed on (game_id, provider_player_id), so two provider ids merged into
 *   one person keep their two rows: the snapshot and a client that folded the
 *   provider-keyed stats_player changes stay in agreement, and no durable
 *   change is needed because nothing client-visible moved.
 * - player_season_stats is keyed on (player_id, season_id, team_id): a loser
 *   line whose key the survivor already owns is returned in full (to_jsonb) and
 *   then dropped; the caller persists it as merge provenance.
 * game_changes is never touched: stats bodies are provider-keyed (plan §3), so
 * the merge rewrites no history and the next identical document is a no-op.
 */
export async function repointPlayerReferences(
  tx: Tx,
  loser: string,
  survivor: string,
): Promise<RepointResult> {
  const playEvents =
    await tx`update public.play_events set player_id = ${survivor}, updated_at = now()
                              where player_id = ${loser}`;
  const gps =
    await tx`update public.game_player_stats set player_id = ${survivor}, updated_at = now()
                       where player_id = ${loser}`;
  const pss =
    await tx`update public.player_season_stats s set player_id = ${survivor}, updated_at = now()
                       where s.player_id = ${loser}
                         and not exists (select 1 from public.player_season_stats t
                                         where t.player_id = ${survivor} and t.season_id = s.season_id and t.team_id = s.team_id)`;
  const pssDropped = await tx<{ row: Record<string, unknown> }[]>`
    delete from public.player_season_stats s where s.player_id = ${loser} returning to_jsonb(s) as row`;
  return {
    counts: {
      playEvents: playEvents.count,
      gamePlayerStats: { repointed: gps.count },
      playerSeasonStats: { repointed: pss.count, dropped: pssDropped.length },
    },
    conflicts: pssDropped.map((d) => ({ table: 'player_season_stats', row: d.row })),
  };
}
