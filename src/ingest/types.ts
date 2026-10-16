import type { PlayerStats, TeamStats } from '../model/game-change.js';
import type { GameStatus, LiveEvent, PeriodRef, PeriodType, Score } from '../model/live-event.js';

/** One normalized play, ready for play_events and the change stream. */
export interface NormalizedEvent {
  providerEventId: string;
  providerNumber: number | null;
  providerSequence: number | null;
  /** Provider revision timestamp (`updated`), ISO. Null when the feed has none. */
  providerUpdatedAt: string | null;
  wallClock: string | null;
  periodSequence: number | null;
  periodNumber: number | null;
  periodType: PeriodType | null;
  clock: string | null;
  clockDecimal: string | null;
  providerEventType: string;
  teamProviderId: string | null;
  playerProviderId: string | null;
  homePoints: number | null;
  awayPoints: number | null;
  body: LiveEvent;
  /** Provider payload as received, for ingest.play_event_raw. */
  raw: unknown;
}

/** The batch's own game-level view (plan §4). Absent for single push events. */
export interface GameView {
  /** Null when the provider status is unknown: no phase claim, stored status kept. */
  status: GameStatus | null;
  /** The raw provider status string when `status` is null (logged, never stored). */
  unknownStatus: string | null;
  score: Score;
  period: PeriodRef | null;
  clock: string | null;
  clockDecimal: string | null;
  /** true/false when the feed says so; null = unknown. */
  clockRunning: boolean | null;
  clockExtra: Record<string, unknown> | null;
  /** Unrivaled Elam target once the target-score phase begins; null = not carried (omission is not change). */
  elamTargetScore: number | null;
  /** Line score when the document carries one. */
  periods: Array<PeriodRef & { score: Score }>;
  providerUpdatedAt: string | null;
  /** Schedule-level facts a generation-less poll may always fix. */
  scheduledAt: string | null;
  coverage: string | null;
  venue: Record<string, unknown> | null;
  broadcasts: unknown[] | null;
  title: string | null;
  /** The document's `season` header, when present; linked to public.seasons by ensureGame. */
  season: { providerSeasonId: string; year: number; type: string } | null;
}

export interface NormalizedTeamStats {
  providerTeamId: string;
  isHome: boolean;
  stats: TeamStats;
}

/** One player's box line as the summary reports it (provider ids; identity resolves uuids). */
export interface NormalizedPlayerStats {
  providerPlayerId: string;
  providerTeamId: string;
  fullName: string;
  jersey: string | null;
  position: string | null;
  starter: boolean | null;
  played: boolean | null;
  onCourt: boolean | null;
  notPlayingReason: string | null;
  stats: PlayerStats;
}

/** An explicit provider deletion marker (`deleted_events[]` entry, push `operation=delete`). */
export interface DeletionMarker {
  providerEventId: string;
  /** The marker's own revision (`updated`), ISO; null when the feed carries none. */
  updatedAt: string | null;
}

export interface NormalizedBatch {
  events: NormalizedEvent[];
  /** Explicit provider deletion markers. Absence from `events` never deletes. */
  deletedEvents: DeletionMarker[];
  teamStats: NormalizedTeamStats[];
  playerStats: NormalizedPlayerStats[];
}

export type ObservationSource = 'push' | 'rest' | 'simulation' | 'fixture';

/** Provenance of a batch; decides freshness (plan §4). */
export interface Observation {
  source: ObservationSource;
  runId: number;
  /** Watch generation: root run id, or null for generation-less runs (schedule polls). */
  watchId: number | null;
  /** Our clock: request start (REST/sim), receipt time (push), test-supplied (fixture). */
  observedAt: Date;
  providerUpdatedAt?: string | null;
  /** Whole pbp document (vs a single push event or a summary without events). */
  isComplete: boolean;
  gameView: GameView | null;
}

/** A player mentioned by a game document (roster line or play attribution): what identity needs. */
export interface DocumentPlayer {
  providerPlayerId: string;
  providerTeamId: string | null;
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  jersey: string | null;
  position: string | null;
}

/** What an adapter returns for one provider document. */
export interface NormalizedDocument {
  batch: NormalizedBatch;
  gameView: GameView | null;
  isComplete: boolean;
  teams: Array<{
    providerTeamId: string;
    name: string;
    market: string | null;
    alias: string | null;
    isHome: boolean;
  }>;
  /** Every player the document names, deduplicated by provider id. */
  players: DocumentPlayer[];
  providerGameId: string;
}
