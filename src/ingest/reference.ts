import type { Db } from '../db/client.js';
import type { LeagueCode } from '../leagues/codes.js';
import { mapStatus } from '../leagues/sportradar-basketball/normalize.js';
import type { Logger } from '../logger.js';
import type { HierarchyTeam } from '../providers/sportradar/schemas/hierarchy.js';
import { LeagueHierarchyDocumentSchema } from '../providers/sportradar/schemas/hierarchy.js';
import { PlayerProfileDocumentSchema } from '../providers/sportradar/schemas/profile.js';
import {
  type ScheduleGame,
  SeasonScheduleDocumentSchema,
} from '../providers/sportradar/schemas/schedule.js';
import {
  LeagueLeadersDocumentSchema,
  TeamSeasonalStatisticsDocumentSchema,
} from '../providers/sportradar/schemas/seasonal-stats.js';
import {
  StandingsDocumentSchema,
  type StandingTeam,
} from '../providers/sportradar/schemas/standings.js';
import {
  TournamentListDocumentSchema,
  TournamentScheduleDocumentSchema,
} from '../providers/sportradar/schemas/tournament.js';
import type { ReferenceFeed } from '../providers/sportradar/urls.js';
import {
  applyChanges,
  applyPlayerSeasonStats,
  applyStandings,
  applyTeamSeasonStats,
  ensureGame,
  type PlayerSeasonLine,
  type StandingLine,
} from './apply-changes.js';
import {
  applyPlayerProfile,
  ensurePlayers,
  ensurePlayerTeamSeason,
  ensureSeason,
  ensureTeams,
  ensureTournament,
  type TeamFacts,
} from './identity.js';
import { type RunHandle, startRun } from './runs.js';
import type { GameView, ObservationSource } from './types.js';

/**
 * Ingests the reference feeds (schedule, tournaments, standings, hierarchy,
 * player profiles, seasonal statistics, league leaders). Their shapes are
 * identical across the three products, so one ingester serves every league.
 *
 * Games listed by a schedule or tournament schedule go through ensureGame and
 * then applyChanges as a GENERATION-LESS batch (plan §4: `watchId = null`,
 * rule 3 only, status writable only while the game is pre-phase or has no
 * durable state, never score/period/clock), so a lagging schedule can never
 * regress a live game. Everything else is reference data written by
 * identity.ts and the season-stats writers in apply-changes.ts.
 */
export interface ReferenceDeps {
  db: Db;
  log: Logger;
  league: LeagueCode;
  source: ObservationSource;
  runSource: 'production' | 'trial' | 'simulation' | 'fixture';
}

export interface ReferenceOutcome {
  feed: ReferenceFeed;
  games: number;
  teams: number;
  players: number;
  seasonLines: number;
  standings: number;
  tournaments: number;
  /** Canonical player rows folded into another by a profile's references. */
  merged: number;
  /** Profile references held for reconciliation (ingest.player_merge_holds) instead of linked or merged. */
  held: number;
  /** Game-level batches rejected or superseded by the freshness policy. */
  stale: number;
}

const EMPTY: Omit<ReferenceOutcome, 'feed'> = {
  games: 0,
  teams: 0,
  players: 0,
  seasonLines: 0,
  standings: 0,
  tournaments: 0,
  merged: 0,
  held: 0,
  stale: 0,
};

export class ReferenceIngester {
  private run: RunHandle | null = null;

  constructor(private readonly deps: ReferenceDeps) {}

  /** The generation-less run every schedule-derived game batch is attributed to. */
  private async runHandle(): Promise<RunHandle> {
    if (this.run) return this.run;
    this.run = await startRun(this.deps.db, {
      kind: 'poll_schedule',
      league: this.deps.league,
      gameId: null,
      source: this.deps.runSource,
      meta: { reference: true },
    });
    return this.run;
  }

  get runId(): number | null {
    return this.run?.id ?? null;
  }

  async process(feed: ReferenceFeed, body: unknown, observedAt: Date): Promise<ReferenceOutcome> {
    const out: ReferenceOutcome = { feed, ...EMPTY };
    switch (feed) {
      case 'schedule':
        await this.schedule(body, observedAt, out);
        break;
      case 'tournament_list':
        await this.tournamentList(body, out);
        break;
      case 'tournament_schedule':
        await this.tournamentSchedule(body, observedAt, out);
        break;
      case 'standings':
        await this.standings(body, observedAt, out);
        break;
      case 'hierarchy':
        await this.hierarchy(body, out);
        break;
      case 'player_profile':
        await this.playerProfile(body, out);
        break;
      case 'seasonal_stats':
        await this.seasonalStats(body, out);
        break;
      case 'league_leaders':
        await this.leagueLeaders(body, out);
        break;
    }
    this.deps.log.info(out, 'reference document applied');
    return out;
  }

  /* ---------------------------------------------------------------------- */

  private async schedule(body: unknown, observedAt: Date, out: ReferenceOutcome) {
    const doc = SeasonScheduleDocumentSchema.parse(body);
    const seasonId = await ensureSeason(
      this.deps.db,
      this.deps.league,
      { providerSeasonId: doc.season.id, year: doc.season.year, type: doc.season.type },
      this.deps.log,
    );
    for (const g of doc.games) {
      await this.scheduledGame(g, seasonId, null, observedAt, out);
    }
  }

  private async tournamentList(body: unknown, out: ReferenceOutcome) {
    const doc = TournamentListDocumentSchema.parse(body);
    const seasonId = await ensureSeason(
      this.deps.db,
      this.deps.league,
      { providerSeasonId: doc.season.id, year: doc.season.year, type: doc.season.type },
      this.deps.log,
    );
    for (const t of doc.tournaments) {
      await ensureTournament(this.deps.db, this.deps.league, seasonId, {
        providerTournamentId: t.id,
        name: t.name,
        location: t.location ?? null,
        status: t.status ?? null,
        startsOn: t.start_date ?? null,
        endsOn: t.end_date ?? null,
        providerParentId: t.parent_id ?? null,
      });
      out.tournaments++;
    }
  }

  private async tournamentSchedule(body: unknown, observedAt: Date, out: ReferenceOutcome) {
    const doc = TournamentScheduleDocumentSchema.parse(body);
    const seasonId = await ensureSeason(
      this.deps.db,
      this.deps.league,
      { providerSeasonId: doc.season.id, year: doc.season.year, type: doc.season.type },
      this.deps.log,
    );
    const tournamentId = await ensureTournament(this.deps.db, this.deps.league, seasonId, {
      providerTournamentId: doc.id,
      name: doc.name,
      location: doc.location ?? null,
      status: doc.status ?? null,
      startsOn: null,
      endsOn: null,
      providerParentId: doc.parent_id ?? null,
    });
    out.tournaments++;
    for (const round of doc.rounds) {
      const games = [...round.games, ...round.bracketed.flatMap((b) => b.games)];
      for (const g of games) await this.scheduledGame(g, seasonId, tournamentId, observedAt, out);
    }
  }

  /** One schedule entry: rows, then a generation-less game-level batch through applyChanges. */
  private async scheduledGame(
    g: ScheduleGame,
    seasonId: string | null,
    tournamentId: string | null,
    observedAt: Date,
    out: ReferenceOutcome,
  ) {
    const { db, log, league } = this.deps;
    const teamIds = await ensureTeams(db, league, [
      {
        providerTeamId: g.home.id,
        name: g.home.name,
        market: g.home.market ?? null,
        alias: g.home.alias ?? null,
      },
      {
        providerTeamId: g.away.id,
        name: g.away.name,
        market: g.away.market ?? null,
        alias: g.away.alias ?? null,
      },
    ]);
    out.teams += teamIds.size;
    const status = mapStatus(g.status);
    const { id: gameId } = await ensureGame(
      db,
      {
        league,
        providerGameId: g.id,
        scheduledAt: g.scheduled,
        status,
        coverage: g.coverage ?? null,
        homeTeamId: teamIds.get(g.home.id) ?? null,
        awayTeamId: teamIds.get(g.away.id) ?? null,
        venue: g.venue ?? null,
        broadcasts: g.broadcasts ?? null,
        seasonId,
        tournamentId,
        title: g.title ?? null,
      },
      log,
    );
    // Generation-less (watchId null): rule 3 only, and restricted to status while the game is
    // pre-phase or has no durable state, so the score below is never written. It is the schedule's
    // own claim (0-0 when the entry carries none) and reaches only the stale_observations log; a
    // closed entry for a never-watched game therefore leaves a closed 0-0 row with a null
    // stats_final_at until a watcher's closing document arrives.
    const gameView: GameView = {
      status,
      unknownStatus: status === null ? g.status : null,
      score: { home: g.home_points ?? 0, away: g.away_points ?? 0 },
      period: null,
      clock: null,
      clockDecimal: null,
      clockRunning: null,
      clockExtra: null,
      elamTargetScore: null,
      periods: [],
      providerUpdatedAt: null,
      scheduledAt: g.scheduled,
      coverage: g.coverage ?? null,
      venue: g.venue ?? null,
      broadcasts: g.broadcasts ?? null,
      title: g.title ?? null,
      season: null,
    };
    const run = await this.runHandle();
    const result = await applyChanges(
      { db, log },
      gameId,
      { events: [], deletedEvents: [], teamStats: [], playerStats: [] },
      {
        source: this.deps.source,
        runId: run.id,
        watchId: null,
        observedAt,
        isComplete: false,
        gameView,
      },
    );
    out.games++;
    if (result.outcome === 'stale' || result.gameLevel === 'superseded') out.stale++;
  }

  private async standings(body: unknown, observedAt: Date, out: ReferenceOutcome) {
    const doc = StandingsDocumentSchema.parse(body);
    const seasonId = await ensureSeason(
      this.deps.db,
      this.deps.league,
      { providerSeasonId: doc.season.id, year: doc.season.year, type: doc.season.type },
      this.deps.log,
    );
    if (!seasonId) return;
    const entries: Array<{ team: StandingTeam; conference: string; division: string | null }> = [];
    for (const c of doc.conferences) {
      for (const team of c.teams ?? []) entries.push({ team, conference: c.name, division: null });
      for (const d of c.divisions ?? [])
        for (const team of d.teams) entries.push({ team, conference: c.name, division: d.name });
    }
    const teamIds = await ensureTeams(
      this.deps.db,
      this.deps.league,
      entries.map(({ team, conference, division }) => ({
        providerTeamId: team.id,
        name: team.name,
        market: team.market ?? null,
        alias: team.alias ?? null,
        conference,
        division,
      })),
    );
    out.teams += teamIds.size;
    const lines: StandingLine[] = [];
    for (const { team: t, conference, division } of entries) {
      const teamId = teamIds.get(t.id);
      if (!teamId) continue;
      const conf = t.records?.find((r) => r.record_type === 'conference');
      const {
        id: _id,
        name: _name,
        market: _market,
        alias: _alias,
        wins: _w,
        losses: _l,
        win_pct: _wp,
        points_for: _pf,
        points_against: _pa,
        games_behind: _gb,
        streak: _st,
        calc_rank: _cr,
        conference_rank: _cnr,
        records: _rec,
        ...extra
      } = t;
      lines.push({
        seasonId,
        teamId,
        conference,
        division,
        wins: t.wins,
        losses: t.losses,
        winPct: t.win_pct ?? null,
        gamesBehind: t.games_behind?.conference ?? t.games_behind?.league ?? null,
        confWins: conf?.wins ?? null,
        confLosses: conf?.losses ?? null,
        pointsFor: t.points_for ?? null,
        pointsAgainst: t.points_against ?? null,
        streak: t.streak ? `${t.streak.kind === 'win' ? 'W' : 'L'}${t.streak.length}` : null,
        rank: t.calc_rank?.conf_rank ?? t.conference_rank ?? t.calc_rank?.league_rank ?? null,
        records: t.records ?? null,
        extra: Object.keys(extra).length > 0 ? extra : null,
        asOf: observedAt,
      });
    }
    out.standings += await applyStandings(this.deps.db, lines);
  }

  private async hierarchy(body: unknown, out: ReferenceOutcome) {
    const doc = LeagueHierarchyDocumentSchema.parse(body);
    const teams: TeamFacts[] = [];
    const add = (t: HierarchyTeam, conference: string, division: string | null) =>
      teams.push({
        providerTeamId: t.id,
        name: t.name,
        market: t.market ?? null,
        alias: t.alias ?? null,
        conference,
        division,
        colors: t.team_colors ?? null,
        venue: t.venue ?? null,
      });
    const conferences = [
      ...(doc.conferences ?? []),
      ...(doc.divisions ?? []).flatMap((d) => d.conferences),
    ];
    for (const c of conferences) {
      for (const t of c.teams ?? []) add(t, c.name, null);
      for (const d of c.divisions ?? []) for (const t of d.teams) add(t, c.name, d.name);
    }
    out.teams += (await ensureTeams(this.deps.db, this.deps.league, teams)).size;
  }

  private async playerProfile(body: unknown, out: ReferenceOutcome) {
    const doc = PlayerProfileDocumentSchema.parse(body);
    const run = await this.runHandle();
    const result = await applyPlayerProfile(this.deps.db, this.deps.league, doc, this.deps.log, {
      runId: run.id,
    });
    out.players++;
    out.merged += result.mergedFrom.length;
    out.held += result.held.length;
    out.seasonLines += result.seasonLines;
  }

  private async seasonalStats(body: unknown, out: ReferenceOutcome) {
    const doc = TeamSeasonalStatisticsDocumentSchema.parse(body);
    const { db, league } = this.deps;
    const seasonId = await ensureSeason(
      db,
      league,
      { providerSeasonId: doc.season.id, year: doc.season.year, type: doc.season.type },
      this.deps.log,
    );
    if (!seasonId) return;
    const teamIds = await ensureTeams(db, league, [
      {
        providerTeamId: doc.id,
        name: doc.name,
        market: doc.market ?? null,
        alias: doc.alias ?? null,
      },
    ]);
    const teamId = teamIds.get(doc.id);
    if (!teamId) return;
    out.teams++;
    if (doc.own_record) {
      const total = doc.own_record.total ?? {};
      const { games_played, ...totals } = total;
      await applyTeamSeasonStats(db, [
        {
          teamId,
          seasonId,
          gamesPlayed: games_played ?? null,
          totals,
          averages: doc.own_record.average ?? null,
          extra: doc.opponents ? { opponents: doc.opponents } : null,
        },
      ]);
    }
    const playerIds = await ensurePlayers(
      db,
      league,
      doc.players.map((p) => ({
        providerPlayerId: p.id,
        providerTeamId: doc.id,
        fullName: p.full_name,
        firstName: p.first_name ?? null,
        lastName: p.last_name ?? null,
        jersey: p.jersey_number ?? null,
        position: p.position ?? null,
      })),
    );
    out.players += playerIds.size;
    const lines: PlayerSeasonLine[] = [];
    for (const p of doc.players) {
      const playerId = playerIds.get(p.id);
      if (!playerId || (!p.total && !p.average)) continue;
      await ensurePlayerTeamSeason(db, { playerId, teamId, seasonId, jersey: p.jersey_number });
      lines.push({ playerId, seasonId, teamId, total: p.total ?? {}, average: p.average ?? null });
    }
    out.seasonLines += await applyPlayerSeasonStats(db, lines);
  }

  private async leagueLeaders(body: unknown, out: ReferenceOutcome) {
    const doc = LeagueLeadersDocumentSchema.parse(body);
    const { db, league } = this.deps;
    const seasonId = await ensureSeason(
      db,
      league,
      { providerSeasonId: doc.season.id, year: doc.season.year, type: doc.season.type },
      this.deps.log,
    );
    if (!seasonId) return;
    // Every category repeats the same player line; dedupe on (player, team) before writing.
    const byKey = new Map<
      string,
      {
        playerId: string;
        teamId: string;
        total: PlayerSeasonLine['total'];
        average: PlayerSeasonLine['average'];
      }
    >();
    const ranks = doc.categories.flatMap((c) => c.ranks);
    const teamIds = await ensureTeams(
      db,
      league,
      ranks.flatMap((r) =>
        r.teams.map((t) => ({
          providerTeamId: t.id,
          name: t.name,
          market: t.market ?? null,
          alias: t.alias ?? null,
        })),
      ),
    );
    out.teams += teamIds.size;
    const playerIds = await ensurePlayers(
      db,
      league,
      ranks.map((r) => ({
        providerPlayerId: r.player.id,
        providerTeamId: r.teams[0]?.id ?? null,
        fullName: r.player.full_name,
        firstName: r.player.first_name ?? null,
        lastName: r.player.last_name ?? null,
        jersey: r.player.jersey_number ?? null,
        position: r.player.position ?? null,
      })),
    );
    out.players += playerIds.size;
    for (const r of ranks) {
      const playerId = playerIds.get(r.player.id);
      const team = r.teams[0];
      const teamId = team ? teamIds.get(team.id) : undefined;
      if (!playerId || !teamId || (!r.total && !r.average)) continue;
      const key = `${playerId}:${teamId}`;
      if (!byKey.has(key))
        byKey.set(key, { playerId, teamId, total: r.total ?? {}, average: r.average ?? null });
    }
    for (const l of byKey.values()) {
      await ensurePlayerTeamSeason(db, { playerId: l.playerId, teamId: l.teamId, seasonId });
    }
    out.seasonLines += await applyPlayerSeasonStats(
      db,
      [...byKey.values()].map((l) => ({ ...l, seasonId })),
    );
  }
}
