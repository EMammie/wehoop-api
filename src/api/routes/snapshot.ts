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
    const teamStats = await tx<
      {
        teamId: string;
        isHome: boolean;
        stats: Record<string, unknown>;
        extra: Record<string, unknown> | null;
      }[]
    >`
      select team_id as "teamId", is_home as "isHome", extra,
             jsonb_build_object(
               'points', points, 'fgm', fgm, 'fga', fga, 'tpm', tpm, 'tpa', tpa, 'ftm', ftm, 'fta', fta,
               'offRebounds', off_rebounds, 'defRebounds', def_rebounds, 'rebounds', rebounds, 'assists', assists,
               'steals', steals, 'blocks', blocks, 'turnovers', turnovers, 'personalFouls', personal_fouls,
               'fastBreakPts', fast_break_pts, 'paintPts', paint_pts, 'secondChancePts', second_chance_pts,
               'benchPts', bench_pts, 'biggestLead', biggest_lead) as stats
      from public.game_team_stats where game_id = ${gameId} order by is_home desc`;
    const playerStats = await tx<Record<string, unknown>[]>`
      select ps.player_id as "playerId", ps.team_id as "teamId",
             coalesce(e.external_id, '') as "providerPlayerId", t.provider_team_id as "providerTeamId",
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
      left join lateral (
        select external_id from public.player_external_ids x
        where x.player_id = ps.player_id and x.league = t.league and x.provider = 'sportradar'
        order by (x.source = 'profile') desc, x.external_id limit 1
      ) e on true
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
        teamId: t.teamId,
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
