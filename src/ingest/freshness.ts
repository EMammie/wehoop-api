import type { GameStatus } from '../model/live-event.js';
import type { DeletionMarker, GameView } from './types.js';

/**
 * Freshness policy (plan §4, rev 4.2). Pure functions; applyChanges calls them
 * inside its transaction. Freshness is decided by WATCH GENERATION and
 * PER-ENTITY precedence, never by a progress scalar and never by hash
 * inequality alone.
 */

export type Phase = 'pre' | 'live' | 'post';

const PHASE: Record<GameStatus, Phase> = {
  scheduled: 'pre',
  created: 'pre',
  time_tbd: 'pre',
  if_necessary: 'pre',
  inprogress: 'live',
  halftime: 'live',
  delayed: 'live',
  complete: 'post',
  closed: 'post',
  cancelled: 'post',
  postponed: 'post',
  unnecessary: 'post',
};
const PHASE_RANK: Record<Phase, number> = { pre: 0, live: 1, post: 2 };

export function phaseOf(status: GameStatus): Phase {
  return PHASE[status];
}

/* ------------------------------------------------------------------------- */
/* Event positions (rule 2c)                                                  */
/* ------------------------------------------------------------------------- */

export interface EventPosition {
  periodSequence: number | null;
  providerSequence: number | null;
  providerNumber: number | null;
  wallClock: string | null;
}

export function hasPosition(p: EventPosition): boolean {
  return (
    p.periodSequence !== null ||
    p.providerSequence !== null ||
    p.providerNumber !== null ||
    p.wallClock !== null
  );
}

/**
 * Position = (period_sequence, provider_sequence), nulls broken by
 * provider_number, then wall_clock. Returns <0 when `a` is behind `b`.
 */
export function comparePositions(a: EventPosition, b: EventPosition): number {
  if (
    a.periodSequence !== null &&
    b.periodSequence !== null &&
    a.periodSequence !== b.periodSequence
  ) {
    return a.periodSequence - b.periodSequence;
  }
  if (a.providerSequence !== null && b.providerSequence !== null) {
    if (a.providerSequence !== b.providerSequence) return a.providerSequence - b.providerSequence;
    return 0;
  }
  if (a.providerNumber !== null && b.providerNumber !== null) {
    if (a.providerNumber !== b.providerNumber) return a.providerNumber - b.providerNumber;
    return 0;
  }
  if (a.wallClock !== null && b.wallClock !== null) {
    const d = Date.parse(a.wallClock) - Date.parse(b.wallClock);
    return d === 0 ? 0 : d;
  }
  return 0;
}

export function newestPosition(positions: EventPosition[]): EventPosition | null {
  let best: EventPosition | null = null;
  for (const p of positions) {
    if (!hasPosition(p)) continue;
    if (best === null || comparePositions(p, best) > 0) best = p;
  }
  return best;
}

/* ------------------------------------------------------------------------- */
/* Batch-level decision (rules 1, 2, and the game-level part of 3)            */
/* ------------------------------------------------------------------------- */

export interface StoredGameForFreshness {
  watchRunId: number | null;
  lastSeq: number;
  status: GameStatus;
  currentPeriodSequence: number | null;
  observedAt: Date | null;
}

export interface StoredEventForFreshness extends EventPosition {
  providerEventId: string;
  deleted: boolean;
}

export interface BatchInput {
  watchId: number | null;
  observedAt: Date;
  isComplete: boolean;
  gameView: GameView | null;
  /** Positions of the incoming document's events (only meaningful when isComplete). */
  eventPositions: EventPosition[];
  deletedEvents: DeletionMarker[];
}

export type StaleReason = 'older_run' | 'run_regresses_state' | 'superseded_observation';

export type Generation = 'none' | 'same' | 'new';

export type BatchDecision =
  | { kind: 'stale'; reason: 'older_run' | 'run_regresses_state'; detail: string }
  | {
      kind: 'accept';
      generation: Generation;
      /** Set games.watch_run_id = watchId (new generation accepted). */
      advanceWatchRunId: boolean;
      /**
       * write      : gameView is newest, write status/score/period/clock.
       * superseded : gameView present but not newest (log superseded_observation, no game-level write).
       * none       : batch carries no gameView.
       */
      gameLevel: 'write' | 'superseded' | 'none';
      /** Generation-less writers may set status but never score, period, clock or clock_running. */
      restrictedGameLevel: boolean;
      detail: string;
    };

export function decideBatch(
  stored: StoredGameForFreshness,
  input: BatchInput,
  storedEvents: StoredEventForFreshness[],
): BatchDecision {
  const { watchId, gameView } = input;
  let generation: Generation;
  let gated = false;

  if (watchId === null) {
    generation = 'none';
  } else if (stored.watchRunId === null) {
    generation = 'new';
    gated = stored.lastSeq > 0;
  } else if (watchId < stored.watchRunId) {
    return {
      kind: 'stale',
      reason: 'older_run',
      detail: `watchId ${watchId} < watch_run_id ${stored.watchRunId}`,
    };
  } else if (watchId === stored.watchRunId) {
    generation = 'same';
  } else {
    generation = 'new';
    gated = true;
  }

  if (gated) {
    const storedPhase = phaseOf(stored.status);
    if (gameView) {
      // An unknown provider status makes no phase claim: 2a is skipped, 2b still applies.
      const incomingPhase = gameView.status === null ? storedPhase : phaseOf(gameView.status);
      if (gameView.status !== null && PHASE_RANK[incomingPhase] < PHASE_RANK[storedPhase]) {
        const rescheduled =
          storedPhase === 'post' && incomingPhase === 'pre' && stored.lastSeq === 0;
        if (!rescheduled) {
          return {
            kind: 'stale',
            reason: 'run_regresses_state',
            detail: `2a: phase ${incomingPhase} (${gameView.status}) < stored ${storedPhase} (${stored.status})`,
          };
        }
      } else if (
        incomingPhase === storedPhase &&
        gameView.period !== null &&
        stored.currentPeriodSequence !== null &&
        gameView.period.sequence < stored.currentPeriodSequence
      ) {
        return {
          kind: 'stale',
          reason: 'run_regresses_state',
          detail: `2b: period sequence ${gameView.period.sequence} < stored ${stored.currentPeriodSequence}`,
        };
      }
    }
    if (input.isComplete) {
      const deleted = new Set(input.deletedEvents.map((d) => d.providerEventId));
      const storedNewest = newestPosition(
        storedEvents.filter((e) => !e.deleted && !deleted.has(e.providerEventId)),
      );
      if (storedNewest !== null) {
        const incomingNewest = newestPosition(input.eventPositions);
        const anyIncoming = input.eventPositions.length > 0;
        if (!anyIncoming) {
          return {
            kind: 'stale',
            reason: 'run_regresses_state',
            detail: '2c: complete document has no events while stored live events exist',
          };
        }
        if (incomingNewest !== null && comparePositions(incomingNewest, storedNewest) < 0) {
          return {
            kind: 'stale',
            reason: 'run_regresses_state',
            detail: `2c: newest incoming ${JSON.stringify(incomingNewest)} behind stored ${JSON.stringify(storedNewest)}`,
          };
        }
        // incomingNewest === null: events carry no position fields; not gated by 2c.
      }
    }
  }

  // Rule 3, game-level part: newest observedAt wins; generation-less writers are restricted.
  let gameLevel: 'write' | 'superseded' | 'none' = 'none';
  let restrictedGameLevel = false;
  let detail = `${generation} generation`;
  if (gameView) {
    const newest =
      stored.observedAt === null || input.observedAt.getTime() > stored.observedAt.getTime();
    if (generation === 'none') {
      const allowed = phaseOf(stored.status) === 'pre' || stored.lastSeq === 0;
      restrictedGameLevel = true;
      gameLevel = allowed && newest ? 'write' : 'superseded';
      if (!allowed) detail += '; generation-less batch during live/finished game';
    } else {
      gameLevel = newest ? 'write' : 'superseded';
    }
    if (!newest)
      detail += `; observedAt ${input.observedAt.toISOString()} <= stored ${stored.observedAt?.toISOString()}`;
  }

  return {
    kind: 'accept',
    generation,
    advanceWatchRunId: generation === 'new',
    gameLevel,
    restrictedGameLevel,
    detail,
  };
}

/* ------------------------------------------------------------------------- */
/* Per-event precedence (rule 3, events)                                      */
/* ------------------------------------------------------------------------- */

export interface StoredEventRevision {
  contentHash: string;
  providerUpdatedAt: string | null;
  deleted: boolean;
  /** The revision of the marker that deleted it (play_events.deleted_revision_at); null if none. */
  deletedRevisionAt: string | null;
}

export interface IncomingEventRevision {
  contentHash: string;
  providerUpdatedAt: string | null;
}

export type EventAction =
  | 'insert'
  | 'update'
  /** Newer `updated`, identical body: advance provider_updated_at only, no change row. */
  | 'touch'
  | 'delete'
  | 'reinstate'
  | 'ignore_older'
  /** Explicit marker whose revision is older than the stored event's `updated`. */
  | 'ignore_older_deletion'
  | 'ignore_missing'
  | 'unchanged';

function newer(a: string | null, b: string | null): boolean | null {
  if (a === null || b === null) return null;
  const da = Date.parse(a);
  const db = Date.parse(b);
  if (Number.isNaN(da) || Number.isNaN(db)) return null;
  return da > db ? true : da < db ? false : null;
}

/**
 * Rule 3 for one event (plan §4 rev 4.3). `deletion` is the explicit provider
 * marker with its own revision; absence from a document never reaches this
 * function as a deletion.
 *   - marker, revision older than the stored `updated`  -> ignore_older_deletion
 *   - marker without a revision (or stored has none)    -> delete (explicit statement)
 *   - deleted row: reinstated only by an incoming `updated` newer than
 *     coalesce(deletedRevisionAt, providerUpdatedAt); with no revision on either
 *     side the deletion is sticky
 *   - newer `updated`, identical body                    -> touch (revision-only)
 *   - older `updated`                                    -> ignore_older
 *   - otherwise content decides: a differing body is a correction (update)
 */
export function decideEvent(
  stored: StoredEventRevision | undefined,
  incoming: IncomingEventRevision | null,
  deletion: { updatedAt: string | null } | null,
): EventAction {
  if (deletion) {
    if (!stored) return 'ignore_missing';
    if (stored.deleted) return 'unchanged';
    if (newer(stored.providerUpdatedAt, deletion.updatedAt) === true)
      return 'ignore_older_deletion';
    return 'delete';
  }
  if (!incoming) return 'unchanged';
  if (!stored) return 'insert';
  if (stored.deleted) {
    const deletedAs = stored.deletedRevisionAt ?? stored.providerUpdatedAt;
    return newer(incoming.providerUpdatedAt, deletedAs) === true ? 'reinstate' : 'unchanged';
  }
  const cmp = newer(incoming.providerUpdatedAt, stored.providerUpdatedAt);
  if (cmp === false) return 'ignore_older';
  if (incoming.contentHash === stored.contentHash) return cmp === true ? 'touch' : 'unchanged';
  // Newer or equal/missing `updated` with a differing body: a correction.
  return 'update';
}
