import { Hono } from 'hono';
import { z } from 'zod';
import type { GameStatus, PeriodType } from '../../model/live-event.js';
import { type Snapshot, SnapshotSchema } from '../../model/snapshot.js';
import type { AppEnv } from '../server.js';

const IdParam = z.object({ id: z.uuid() });

/**
 * GET /v1/games/:id/snapshot (plan §5): one REPEATABLE READ transaction so the
 * state and `seq` agree. Never returns watch_run_id.
 */
export function snapshotRoutes() {
  const r = new Hono<AppEnv>();

  r.get('/v1/games/:id/snapshot', async (c) => {
    const params = IdParam.safeParse(c.req.param());
    if (!params.success) return c.json({ error: 'invalid_game_id' }, 400);
    const { db } = c.get('deps');
    const snapshot = await loadSnapshot(db, params.data.id);
    if (!snapshot) return c.json({ error: 'not_found' }, 404);
    const live = snapshot.game.status !== 'closed';
    c.header('cache-control', live ? 'public, max-age=2' : 'public, max-age=3600');
    return c.json(snapshot);
  });

  return r;
}

export async function loadSnapshot(
  db: AppEnv['Variables']['deps']['db'],
  gameId: string,
): Promise<Snapshot | null> {
  return db.begin('isolation level repeatable read read only', async (tx) => {
    const [g] = await tx<
      {
        id: string;
        league: string;
        providerGameId: string;
        status: GameStatus;
        scheduledAt: Date;
        coverage: string;
        homeTeamId: string | null;
        awayTeamId: string | null;
        homePoints: number;
        awayPoints: number;
        currentPeriod: number | null;
        periodType: PeriodType | null;
        currentPeriodSequence: number | null;
        clock: string | null;
        clockDecimal: string | null;
        clockRunning: boolean | null;
        clockAsOf: Date | null;
        observedAt: Date | null;
        elamTargetScore: number | null;
        lastSeq: string;
        retainedFromSeq: string;
        serverTime: Date;
      }[]
    >`select id, league::text as league, provider_game_id as "providerGameId", status, scheduled_at as "scheduledAt",
             coverage::text as coverage, home_team_id as "homeTeamId", away_team_id as "awayTeamId",
             home_points as "homePoints", away_points as "awayPoints", current_period as "currentPeriod",
             period_type as "periodType", current_period_sequence as "currentPeriodSequence",
             clock, clock_decimal as "clockDecimal", clock_running as "clockRunning", clock_as_of as "clockAsOf",
             observed_at as "observedAt", elam_target_score as "elamTargetScore",
             last_seq::text as "lastSeq", retained_from_seq::text as "retainedFromSeq",
             now() as "serverTime"
      from public.games where id = ${gameId}`;
    if (!g) return null;
    const periods = await tx<
      {
        number: number;
        type: PeriodType;
        sequence: number;
        homePoints: number;
        awayPoints: number;
      }[]
    >`
      select number, type, sequence, home_points as "homePoints", away_points as "awayPoints"
      from public.game_periods where game_id = ${gameId} order by sequence`;
    // Stats rows are returned as the provider-keyed bodies the stats_* changes carry (plan §3):
    // the uuids stay columns, so a fold of /changes reproduces the snapshot even after a merge.
    const teamStats = await tx<
      {
        providerTeamId: string;
        isHome: boolean;
        stats: Record<string, unknown>;
        extra: Record<string, unknown> | null;
      }[]
    >`
      select t.provider_team_id as "providerTeamId", s.is_home as "isHome", s.extra,
             jsonb_build_object(
               'points', s.points, 'fgm', s.fgm, 'fga', s.fga, 'tpm', s.tpm, 'tpa', s.tpa, 'ftm', s.ftm, 'fta', s.fta,
               'offRebounds', s.off_rebounds, 'defRebounds', s.def_rebounds, 'rebounds', s.rebounds, 'assists', s.assists,
               'steals', s.steals, 'blocks', s.blocks, 'turnovers', s.turnovers, 'personalFouls', s.personal_fouls,
               'fastBreakPts', s.fast_break_pts, 'paintPts', s.paint_pts, 'secondChancePts', s.second_chance_pts,
               'benchPts', s.bench_pts, 'biggestLead', s.biggest_lead) as stats
      from public.game_team_stats s join public.teams t on t.id = s.team_id
      where s.game_id = ${gameId} order by s.is_home desc`;
    // provider_player_id is the id the line was keyed on (never a lookup through
    // player_external_ids, which can hold several ids per league after a merge).
    const playerStats = await tx<Record<string, unknown>[]>`
      select ps.provider_player_id as "providerPlayerId", t.provider_team_id as "providerTeamId",
             p.full_name as "fullName", ps.jersey, ps.position, ps.starter, ps.played, ps.on_court as "onCourt",
             ps.not_playing_reason as "notPlayingReason",
             jsonb_build_object(
               'minutes', ps.minutes, 'points', ps.points, 'fgm', ps.fgm, 'fga', ps.fga, 'tpm', ps.tpm, 'tpa', ps.tpa,
               'ftm', ps.ftm, 'fta', ps.fta, 'offRebounds', ps.off_rebounds, 'defRebounds', ps.def_rebounds,
               'rebounds', ps.rebounds, 'assists', ps.assists, 'steals', ps.steals, 'blocks', ps.blocks,
               'turnovers', ps.turnovers, 'personalFouls', ps.personal_fouls, 'plusMinus', ps.plus_minus,
               'efficiency', ps.efficiency, 'extra', coalesce(ps.extra, '{}'::jsonb)) as stats
      from public.game_player_stats ps
      join public.games g on g.id = ps.game_id
      join public.players p on p.id = ps.player_id
      join public.teams t on t.id = ps.team_id
      where ps.game_id = ${gameId}
      order by (ps.team_id = g.home_team_id) desc, ps.starter desc nulls last, p.full_name`;
    const events = await tx<{ providerEventId: string; body: unknown }[]>`
      select provider_event_id as "providerEventId", payload as body
      from public.play_events where game_id = ${gameId} and deleted_at is null
      order by period_sequence nulls first, provider_sequence nulls first, provider_number nulls first, wall_clock nulls first, provider_event_id`;
    return SnapshotSchema.parse({
      game: {
        id: g.id,
        league: g.league,
        providerGameId: g.providerGameId,
        status: g.status,
        scheduledAt: g.scheduledAt.toISOString(),
        coverage: g.coverage,
        homeTeamId: g.homeTeamId,
        awayTeamId: g.awayTeamId,
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
        clockDecimal: g.clockDecimal,
        clockRunning: g.clockRunning,
        clockAsOf: g.clockAsOf ? g.clockAsOf.toISOString() : null,
        observedAt: g.observedAt ? g.observedAt.toISOString() : null,
        elamTargetScore: g.elamTargetScore,
      },
      periods: periods.map((p) => ({
        number: p.number,
        type: p.type,
        sequence: p.sequence,
        score: { home: p.homePoints, away: p.awayPoints },
      })),
      teamStats: teamStats.map((t) => ({
        providerTeamId: t.providerTeamId,
        isHome: t.isHome,
        stats: { ...t.stats, extra: t.extra ?? {} },
      })),
      playerStats,
      events,
      seq: Number(g.lastSeq),
      retainedFrom: Number(g.retainedFromSeq),
      coverage: g.coverage,
      serverTime: g.serverTime.toISOString(),
    });
  });
}
