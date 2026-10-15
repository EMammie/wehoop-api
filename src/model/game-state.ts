import { canonicalJson } from './content-hash.js';
import type { GameChange, StatsPlayerBody, TeamStats } from './game-change.js';
import type { GameStatus, LiveEvent, PeriodRef, Score } from './live-event.js';
import type { Snapshot } from './snapshot.js';

/**
 * Minimal game-state reducer shared by the reference client and tests. Folding
 * every GameChange from a snapshot must yield the same canonical state as a
 * later snapshot; that equality is part of the M1 evidence.
 */
export interface GameState {
  status: GameStatus;
  score: Score;
  period: PeriodRef | null;
  periods: Array<PeriodRef & { score: Score }>;
  events: Map<string, LiveEvent>;
  teamStats: Map<string, { isHome: boolean; stats: TeamStats }>;
  playerStats: Map<string, StatsPlayerBody>;
}

export function stateFromSnapshot(s: Snapshot): GameState {
  return {
    status: s.game.status,
    score: s.game.score,
    period: s.game.period,
    periods: s.periods.map((p) => ({ ...p })),
    events: new Map(s.events.map((e) => [e.providerEventId, e.body])),
    teamStats: new Map(s.teamStats.map((t) => [t.teamId, { isHome: t.isHome, stats: t.stats }])),
    playerStats: new Map(s.playerStats.map((p) => [p.playerId, p])),
  };
}

export function applyChange(state: GameState, c: GameChange): GameState {
  switch (c.type) {
    case 'event_insert':
    case 'event_update':
      state.events.set(c.providerEventId, c.body);
      break;
    case 'event_delete':
      state.events.delete(c.providerEventId);
      break;
    case 'status':
      state.status = c.body.status;
      state.score = c.body.score;
      state.period = c.body.period;
      break;
    case 'period':
      state.periods = c.body.periods.map((p) => ({ ...p }));
      break;
    case 'stats_team':
      state.teamStats.set(c.body.teamId, { isHome: c.body.isHome, stats: c.body.stats });
      break;
    case 'stats_player':
      state.playerStats.set(c.body.playerId, c.body);
      break;
  }
  return state;
}

/** Deterministic, comparable projection (sorted events, no Maps). */
export function canonicalState(state: GameState): string {
  return canonicalJson({
    status: state.status,
    score: state.score,
    period: state.period,
    periods: state.periods,
    events: [...state.events.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([providerEventId, body]) => ({ providerEventId, body })),
    teamStats: [...state.teamStats.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([teamId, v]) => ({ teamId, ...v })),
    playerStats: [...state.playerStats.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, v]) => v),
  });
}
