import type { z } from 'zod';
import type {
  DocumentPlayer,
  GameView,
  NormalizedDocument,
  NormalizedEvent,
  NormalizedPlayerStats,
  NormalizedTeamStats,
} from '../../ingest/types.js';
import type { PlayerStats, TeamStats } from '../../model/game-change.js';
import {
  type GameStatus,
  GameStatusSchema,
  type LiveEvent,
  type PeriodRef,
  type PeriodType,
  type Score,
} from '../../model/live-event.js';
import type { BoxscoreDocument } from '../../providers/sportradar/schemas/boxscore.js';
import type { ScoringPeriodSchema, SeasonRef } from '../../providers/sportradar/schemas/common.js';
import type {
  EventStatistic,
  PbpDocument,
  PbpEvent,
} from '../../providers/sportradar/schemas/pbp.js';
import type {
  PlayerStatistics,
  SummaryDocument,
  SummaryPlayer,
  TeamStatistics,
} from '../../providers/sportradar/schemas/summary.js';

/**
 * Shared Sportradar basketball normalizer. Pure: no I/O, no clock. Adapters
 * call these and override league quirks (Elam, OOT, coverage) on top.
 * Unknown provider event types map to `other`; nothing here throws on content.
 */

/**
 * Provider status → GameStatus, or null when the provider string is not one we
 * know. The normalizer never invents a value: an unknown status is reported on
 * the gameView as `unknownStatus` and applyChanges keeps the stored status.
 */
export function mapStatus(provider: string): GameStatus | null {
  const s = provider.toLowerCase().replace(/-/g, '_');
  const parsed = GameStatusSchema.safeParse(s);
  return parsed.success ? parsed.data : null;
}

export function mapPeriodType(provider: string | undefined): PeriodType {
  switch ((provider ?? '').toLowerCase()) {
    case 'overtime':
    case 'ot':
      return 'overtime';
    case 'half':
      return 'half';
    case 'elam':
      return 'elam';
    default:
      return 'quarter';
  }
}

export { clockToSeconds } from '../../model/clock.js';

type Header = {
  id: string;
  status: string;
  scheduled: string;
  title?: string | undefined;
  coverage?: string | undefined;
  clock?: string | undefined;
  clock_decimal?: string | undefined;
  clock_type?: string | undefined;
  clock_directional?: string | undefined;
  elam_target_score?: number | undefined;
  target_score?: number | undefined;
  quarter?: number | undefined;
  venue?: Record<string, unknown> | undefined;
  broadcasts?: unknown[] | undefined;
  season?: SeasonRef | undefined;
  home: {
    id: string;
    name: string;
    market?: string | undefined;
    alias?: string | undefined;
    points?: number | undefined;
  };
  away: {
    id: string;
    name: string;
    market?: string | undefined;
    alias?: string | undefined;
    points?: number | undefined;
  };
};

function teamsOf(h: Header): NormalizedDocument['teams'] {
  return [
    {
      providerTeamId: h.home.id,
      name: h.home.name,
      market: h.home.market ?? null,
      alias: h.home.alias ?? null,
      isHome: true,
    },
    {
      providerTeamId: h.away.id,
      name: h.away.name,
      market: h.away.market ?? null,
      alias: h.away.alias ?? null,
      isHome: false,
    },
  ];
}

function currentPeriod(h: Header, periods: Array<PeriodRef & { score: Score }>): PeriodRef | null {
  if (periods.length === 0) return null;
  const byQuarter = h.quarter != null ? periods.find((p) => p.number === h.quarter) : undefined;
  const last = periods.reduce((a, b) => (b.sequence > a.sequence ? b : a));
  const p = byQuarter ?? last;
  return { number: p.number, type: p.type, sequence: p.sequence };
}

/**
 * The two Unrivaled-only clock fields (plan §9: `clock_extra` until a real
 * fixture fixes the names). Read from the header when present, else from the
 * newest event of the document; null when neither carries them.
 */
function clockExtraOf(h: Header, newestEvent: PbpEvent | null): Record<string, unknown> | null {
  const type = h.clock_type ?? newestEvent?.clock_type;
  const directional = h.clock_directional ?? newestEvent?.clock_directional;
  if (type === undefined && directional === undefined) return null;
  return {
    ...(type !== undefined ? { clockType: type } : {}),
    ...(directional !== undefined ? { clockDirectional: directional } : {}),
  };
}

function gameViewOf(
  h: Header,
  periods: Array<PeriodRef & { score: Score }>,
  newestEvent: PbpEvent | null = null,
): GameView {
  const status = mapStatus(h.status);
  const period = currentPeriod(h, periods);
  // Elam (plan §2): the game clock is off, so the game-level clock is null and
  // clock_running is false; the provider's count-up stays in clock_extra.
  const elam = period?.type === 'elam';
  return {
    status,
    unknownStatus: status === null ? h.status : null,
    score: { home: h.home.points ?? 0, away: h.away.points ?? 0 },
    period,
    clock: elam ? null : (h.clock ?? null),
    clockDecimal: elam ? null : (h.clock_decimal ?? null),
    clockRunning: elam ? false : null,
    clockExtra: clockExtraOf(h, newestEvent),
    elamTargetScore: h.elam_target_score ?? h.target_score ?? null,
    periods,
    providerUpdatedAt: null,
    scheduledAt: h.scheduled,
    coverage: h.coverage ?? null,
    venue: h.venue ?? null,
    broadcasts: h.broadcasts ?? null,
    title: h.title ?? null,
    season: h.season
      ? { providerSeasonId: h.season.id, year: h.season.year, type: h.season.type }
      : null,
  };
}

type ScoringPeriod = z.infer<typeof ScoringPeriodSchema>;

/** Zip home/away `scoring[]` (summary, boxscore) into a line score keyed by sequence. */
export function lineScoreFromScoring(
  home: ScoringPeriod[] | undefined,
  away: ScoringPeriod[] | undefined,
): Array<PeriodRef & { score: Score }> {
  const bySeq = new Map<number, PeriodRef & { score: Score }>();
  for (const p of home ?? []) {
    bySeq.set(p.sequence, {
      number: p.number,
      type: mapPeriodType(p.type),
      sequence: p.sequence,
      score: { home: p.points, away: 0 },
    });
  }
  for (const p of away ?? []) {
    const existing = bySeq.get(p.sequence);
    if (existing) existing.score.away = p.points;
    else {
      bySeq.set(p.sequence, {
        number: p.number,
        type: mapPeriodType(p.type),
        sequence: p.sequence,
        score: { home: 0, away: p.points },
      });
    }
  }
  return [...bySeq.values()].sort((a, b) => a.sequence - b.sequence);
}

/* ------------------------------------------------------------------------- */
/* Players named by a document                                                */
/* ------------------------------------------------------------------------- */

/** Collects players by provider id; later mentions fill in blanks, never overwrite. */
export class PlayerCollector {
  private readonly byId = new Map<string, DocumentPlayer>();

  add(p: {
    id: string;
    full_name?: string | undefined;
    first_name?: string | undefined;
    last_name?: string | undefined;
    jersey_number?: string | undefined;
    position?: string | undefined;
    teamId?: string | undefined;
  }): void {
    const existing = this.byId.get(p.id);
    const merged: DocumentPlayer = {
      providerPlayerId: p.id,
      providerTeamId: existing?.providerTeamId ?? p.teamId ?? null,
      fullName: existing?.fullName ?? p.full_name ?? null,
      firstName: existing?.firstName ?? p.first_name ?? null,
      lastName: existing?.lastName ?? p.last_name ?? null,
      jersey: existing?.jersey ?? p.jersey_number ?? null,
      position: existing?.position ?? p.position ?? null,
    };
    this.byId.set(p.id, merged);
  }

  list(): DocumentPlayer[] {
    return [...this.byId.values()];
  }
}

/* ------------------------------------------------------------------------- */
/* Events                                                                     */
/* ------------------------------------------------------------------------- */

const FOUL_KINDS: Record<string, string> = {
  personalfoul: 'personal',
  offensivefoul: 'offensive',
  shootingfoul: 'shooting',
  technicalfoul: 'technical',
  flagrantone: 'flagrant_one',
  flagranttwo: 'flagrant_two',
  clearpathfoul: 'clear_path',
  defensivethreeseconds: 'defensive_three_seconds',
  delay: 'delay_of_game',
  loosballfoul: 'loose_ball',
  looseballfoul: 'loose_ball',
  awayfromplayfoul: 'away_from_play',
};

const TIMEOUT_KINDS: Record<string, 'team' | 'official' | 'tv' | 'challenge'> = {
  teamtimeout: 'team',
  officialtimeout: 'official',
  tvtimeout: 'tv',
  challengetimeout: 'challenge',
};

/** Unrivaled's 3-on-3 lineup swaps (`lineupchangeone`, `lineupchangethree`) are lineup changes too. */
const LINEUP_CHANGE_TYPES = new Set(['lineupchange', 'lineupchangeone', 'lineupchangethree']);

function stat(ev: PbpEvent, type: string): EventStatistic | undefined {
  return ev.statistics?.find((s) => s.type === type);
}

function lineupFor(ev: PbpEvent, teamId: string | undefined): string[] {
  const oc = ev.on_court;
  if (!oc || !teamId) return [];
  const side = oc.home?.id === teamId ? oc.home : oc.away?.id === teamId ? oc.away : undefined;
  return (side?.players ?? []).map((p) => p.id).sort();
}

export function normalizeEvent(
  ev: PbpEvent,
  period: PeriodRef,
  players?: PlayerCollector,
): NormalizedEvent {
  const teamId = ev.attribution?.id;
  const base = {
    period,
    clock: ev.clock ?? null,
    ...(ev.clock_decimal !== undefined ? { clockDecimal: ev.clock_decimal } : {}),
    ...(ev.clock_directional !== undefined ? { clockDirectional: ev.clock_directional } : {}),
    wallClock: ev.wall_clock ?? null,
    score: { home: ev.home_points ?? 0, away: ev.away_points ?? 0 },
    ...(teamId ? { providerTeamId: teamId } : {}),
    ...(ev.possession?.id ? { providerPossessionTeamId: ev.possession.id } : {}),
    ...(ev.description !== undefined ? { description: ev.description } : {}),
    ...(ev.qualifiers?.length ? { qualifiers: ev.qualifiers.map((q) => q.qualifier) } : {}),
  };
  const t = ev.event_type;
  let body: LiveEvent;
  let playerId: string | undefined;

  if (t === 'opentip') {
    body = { ...base, type: 'tip_off' };
  } else if (LINEUP_CHANGE_TYPES.has(t)) {
    body = { ...base, type: 'lineup_change', providerOnCourtPlayerIds: lineupFor(ev, teamId) };
  } else if (t === 'startperiod') {
    body = { ...base, type: 'period_start' };
  } else if (t === 'endperiod') {
    body = { ...base, type: 'period_end' };
  } else if (/^(two|three)point(made|miss)$/.test(t)) {
    const fg = stat(ev, 'fieldgoal');
    const made = t.endsWith('made');
    const pts = t.startsWith('three') ? 3 : 2;
    playerId = fg?.player?.id;
    const assist = stat(ev, 'assist')?.player?.id;
    const block = stat(ev, 'block')?.player?.id;
    body = {
      ...base,
      ...(playerId ? { providerPlayerId: playerId } : {}),
      type: 'shot',
      made,
      points: made ? (fg?.points ?? pts) : pts,
      ...(fg?.shot_type !== undefined ? { shotType: fg.shot_type } : {}),
      ...(fg?.shot_type_desc !== undefined ? { shotTypeDesc: fg.shot_type_desc } : {}),
      ...(fg?.shot_distance !== undefined ? { distance: fg.shot_distance } : {}),
      ...(assist ? { providerAssistId: assist } : {}),
      ...(block ? { providerBlockId: block } : {}),
      ...(fg?.winning_basket === true ? { winningBasket: true } : {}),
      ...(ev.location
        ? {
            location: {
              x: ev.location.coord_x,
              y: ev.location.coord_y,
              ...(ev.location.action_area !== undefined ? { area: ev.location.action_area } : {}),
            },
          }
        : {}),
    };
  } else if (t === 'freethrowmade' || t === 'freethrowmiss') {
    const ft = stat(ev, 'freethrow');
    playerId = ft?.player?.id;
    const m = /free throw (\d+) of (\d+)/i.exec(ev.description ?? '');
    const ftPoints = ft?.free_throw_points ?? ft?.points;
    body = {
      ...base,
      ...(playerId ? { providerPlayerId: playerId } : {}),
      type: 'free_throw',
      made: t === 'freethrowmade',
      ...(m ? { attempt: Number(m[1]), of: Number(m[2]) } : {}),
      ...(ft?.free_throw_type !== undefined ? { freeThrowType: ft.free_throw_type } : {}),
      ...(ftPoints !== undefined && ftPoints > 0 ? { points: ftPoints } : {}),
    };
  } else if (t === 'rebound') {
    const rb = stat(ev, 'rebound');
    playerId = rb?.player?.id;
    const rt =
      rb?.rebound_type ??
      (/(offensive|defensive)/i.exec(ev.description ?? '')?.[1] ?? '').toLowerCase();
    let kind: 'offensive' | 'defensive' | 'team_offensive' | 'team_defensive' | 'unknown' =
      'unknown';
    if (rt === 'offensive' || rt === 'defensive') kind = playerId ? rt : `team_${rt}`;
    body = { ...base, ...(playerId ? { providerPlayerId: playerId } : {}), type: 'rebound', kind };
  } else if (t === 'turnover') {
    const to = stat(ev, 'turnover');
    playerId = to?.player?.id;
    const steal = stat(ev, 'steal')?.player?.id;
    body = {
      ...base,
      ...(playerId ? { providerPlayerId: playerId } : {}),
      type: 'turnover',
      kind: ev.turnover_type ?? to?.turnover_type ?? 'unknown',
      ...(steal ? { providerStealId: steal } : {}),
    };
  } else if (t in FOUL_KINDS) {
    const foul = ev.statistics?.find((s) => s.type.endsWith('foul'));
    playerId = foul?.player?.id;
    const drawn = stat(ev, 'fouldrawn')?.player?.id;
    body = {
      ...base,
      ...(playerId ? { providerPlayerId: playerId } : {}),
      type: 'foul',
      kind: foul?.foul_type ?? FOUL_KINDS[t] ?? t,
      ...(drawn ? { providerDrawnById: drawn } : {}),
    };
  } else if (t in TIMEOUT_KINDS) {
    body = { ...base, type: 'timeout', kind: TIMEOUT_KINDS[t] ?? 'other' };
  } else if (t === 'review' || t === 'challengereview') {
    const m = /\(Request: ([^)]+)\)/.exec(ev.description ?? '');
    body = { ...base, type: 'review', ...(m?.[1] ? { outcome: m[1] } : {}) };
  } else if (t === 'endofgame') {
    body = { ...base, type: 'game_status', status: 'complete' };
  } else {
    body = { ...base, type: 'other', providerEventType: t };
  }

  if (players) {
    for (const s of ev.statistics ?? []) {
      if (s.player) players.add({ ...s.player, teamId: s.team?.id ?? teamId });
    }
    for (const side of [ev.on_court?.home, ev.on_court?.away]) {
      for (const p of side?.players ?? []) players.add({ ...p, teamId: side?.id });
    }
  }

  return {
    providerEventId: ev.id,
    providerNumber: ev.number ?? null,
    providerSequence: ev.sequence ?? null,
    providerUpdatedAt: ev.updated ?? null,
    wallClock: ev.wall_clock ?? null,
    periodSequence: period.sequence,
    periodNumber: period.number,
    periodType: period.type,
    clock: ev.clock ?? null,
    clockDecimal: ev.clock_decimal ?? null,
    providerEventType: t,
    teamProviderId: teamId ?? null,
    playerProviderId: playerId ?? null,
    homePoints: ev.home_points ?? null,
    awayPoints: ev.away_points ?? null,
    body,
    raw: ev,
  };
}

/* ------------------------------------------------------------------------- */
/* Documents                                                                  */
/* ------------------------------------------------------------------------- */

export function normalizePbpDocument(doc: PbpDocument): NormalizedDocument {
  const periods: Array<PeriodRef & { score: Score }> = doc.periods
    .map((p) => ({
      number: p.number,
      type: mapPeriodType(p.type),
      sequence: p.sequence,
      score: { home: p.scoring?.home.points ?? 0, away: p.scoring?.away.points ?? 0 },
    }))
    .sort((a, b) => a.sequence - b.sequence);
  const events: NormalizedEvent[] = [];
  const players = new PlayerCollector();
  let newest: PbpEvent | null = null;
  for (const p of doc.periods) {
    const ref: PeriodRef = { number: p.number, type: mapPeriodType(p.type), sequence: p.sequence };
    for (const ev of p.events) {
      events.push(normalizeEvent(ev, ref, players));
      newest = ev;
    }
  }
  return {
    providerGameId: doc.id,
    teams: teamsOf(doc),
    players: players.list(),
    gameView: gameViewOf(doc, periods, newest),
    isComplete: true,
    batch: {
      events,
      deletedEvents: (doc.deleted_events ?? []).map((d) => ({
        providerEventId: d.id,
        updatedAt: d.updated ?? null,
      })),
      teamStats: [],
      playerStats: [],
    },
  };
}

export function teamStatsFrom(stats: TeamStatistics | undefined): TeamStats {
  const n = (v: number | undefined) => (v === undefined ? null : v);
  const typedKeys = new Set([
    'points',
    'field_goals_made',
    'field_goals_att',
    'three_points_made',
    'three_points_att',
    'free_throws_made',
    'free_throws_att',
    'offensive_rebounds',
    'defensive_rebounds',
    'rebounds',
    'total_rebounds',
    'assists',
    'steals',
    'blocks',
    'turnovers',
    'total_turnovers',
    'personal_fouls',
    'fast_break_pts',
    'points_in_paint',
    'second_chance_pts',
    'bench_points',
    'biggest_lead',
    'periods',
  ]);
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(stats ?? {})) if (!typedKeys.has(k)) extra[k] = v;
  return {
    points: n(stats?.points),
    fgm: n(stats?.field_goals_made),
    fga: n(stats?.field_goals_att),
    tpm: n(stats?.three_points_made),
    tpa: n(stats?.three_points_att),
    ftm: n(stats?.free_throws_made),
    fta: n(stats?.free_throws_att),
    offRebounds: n(stats?.offensive_rebounds),
    defRebounds: n(stats?.defensive_rebounds),
    rebounds: n(stats?.rebounds ?? stats?.total_rebounds),
    assists: n(stats?.assists),
    steals: n(stats?.steals),
    blocks: n(stats?.blocks),
    turnovers: n(stats?.turnovers ?? stats?.total_turnovers),
    personalFouls: n(stats?.personal_fouls),
    fastBreakPts: n(stats?.fast_break_pts),
    paintPts: n(stats?.points_in_paint),
    secondChancePts: n(stats?.second_chance_pts),
    benchPts: n(stats?.bench_points),
    biggestLead: n(stats?.biggest_lead),
    extra,
  };
}

const PLAYER_TYPED_KEYS = new Set([
  'minutes',
  'points',
  'field_goals_made',
  'field_goals_att',
  'three_points_made',
  'three_points_att',
  'free_throws_made',
  'free_throws_att',
  'offensive_rebounds',
  'defensive_rebounds',
  'rebounds',
  'assists',
  'steals',
  'blocks',
  'turnovers',
  'personal_fouls',
  'pls_min',
  'efficiency',
  'periods',
]);

export function playerStatsFrom(stats: PlayerStatistics | undefined): PlayerStats {
  const n = (v: number | undefined) => (v === undefined ? null : v);
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(stats ?? {})) if (!PLAYER_TYPED_KEYS.has(k)) extra[k] = v;
  return {
    minutes: stats?.minutes ?? null,
    points: n(stats?.points),
    fgm: n(stats?.field_goals_made),
    fga: n(stats?.field_goals_att),
    tpm: n(stats?.three_points_made),
    tpa: n(stats?.three_points_att),
    ftm: n(stats?.free_throws_made),
    fta: n(stats?.free_throws_att),
    offRebounds: n(stats?.offensive_rebounds),
    defRebounds: n(stats?.defensive_rebounds),
    rebounds: n(stats?.rebounds),
    assists: n(stats?.assists),
    steals: n(stats?.steals),
    blocks: n(stats?.blocks),
    turnovers: n(stats?.turnovers),
    personalFouls: n(stats?.personal_fouls),
    plusMinus: n(stats?.pls_min),
    efficiency: stats?.efficiency === undefined ? null : Math.round(stats.efficiency),
    extra,
  };
}

function playerLine(p: SummaryPlayer, providerTeamId: string): NormalizedPlayerStats {
  return {
    providerPlayerId: p.id,
    providerTeamId,
    fullName: p.full_name ?? `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim(),
    jersey: p.jersey_number ?? null,
    position: p.position ?? null,
    starter: p.starter ?? null,
    played: p.played ?? null,
    onCourt: p.on_court ?? null,
    notPlayingReason: p.not_playing_reason ?? null,
    stats: playerStatsFrom(p.statistics),
  };
}

export function normalizeSummaryDocument(doc: SummaryDocument): NormalizedDocument {
  const periods = lineScoreFromScoring(doc.home.scoring, doc.away.scoring);
  const teamStats: NormalizedTeamStats[] = [];
  const playerStats: NormalizedPlayerStats[] = [];
  const players = new PlayerCollector();
  for (const side of [doc.home, doc.away]) {
    const isHome = side === doc.home;
    if (side.statistics)
      teamStats.push({ providerTeamId: side.id, isHome, stats: teamStatsFrom(side.statistics) });
    for (const p of side.players ?? []) {
      players.add({ ...p, teamId: side.id });
      // A roster line without statistics (pregame) is identity only, not a box line.
      if (p.statistics) playerStats.push(playerLine(p, side.id));
    }
  }
  return {
    providerGameId: doc.id,
    teams: teamsOf(doc),
    players: players.list(),
    gameView: gameViewOf(doc, periods),
    isComplete: false,
    batch: { events: [], deletedEvents: [], teamStats, playerStats },
  };
}

export function normalizeBoxscoreDocument(doc: BoxscoreDocument): NormalizedDocument {
  const periods = lineScoreFromScoring(doc.home.scoring, doc.away.scoring);
  const players = new PlayerCollector();
  for (const side of [doc.home, doc.away]) {
    const leaders = side.leaders;
    for (const list of [leaders?.points, leaders?.rebounds, leaders?.assists]) {
      for (const p of list ?? []) players.add({ ...p, teamId: side.id });
    }
  }
  return {
    providerGameId: doc.id,
    teams: teamsOf(doc),
    players: players.list(),
    gameView: gameViewOf(doc, periods),
    isComplete: false,
    batch: { events: [], deletedEvents: [], teamStats: [], playerStats: [] },
  };
}
