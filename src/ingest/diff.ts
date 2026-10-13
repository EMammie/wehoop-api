import { contentHash } from '../model/content-hash.js';
import type { PendingChange } from '../model/game-change.js';
import { decideEvent, type EventAction, type StoredEventRevision } from './freshness.js';
import type { NormalizedEvent } from './types.js';

export interface EventDiffCounts {
  inserted: number;
  updated: number;
  deleted: number;
  ignoredOlder: number;
  unchanged: number;
}

export interface EventWrite {
  action: Extract<EventAction, 'insert' | 'update' | 'reinstate'>;
  event: NormalizedEvent;
  hash: string;
}

export interface EventDiff {
  /** Durable changes in document order: inserts/updates first, then explicit deletions. */
  changes: PendingChange[];
  writes: EventWrite[];
  /** Provider event ids to soft-delete (explicit markers only). */
  deletions: string[];
  counts: EventDiffCounts;
}

/**
 * Pure per-entity reconciliation of one batch against stored play state
 * (plan §4 rule 3). Absence from the batch never deletes; only
 * `deletedEventIds` (an explicit provider marker) does. Applying the same
 * batch twice yields an empty diff.
 */
export function diffEvents(
  stored: Map<string, StoredEventRevision>,
  events: NormalizedEvent[],
  deletedEventIds: string[],
): EventDiff {
  const counts: EventDiffCounts = {
    inserted: 0,
    updated: 0,
    deleted: 0,
    ignoredOlder: 0,
    unchanged: 0,
  };
  const changes: PendingChange[] = [];
  const writes: EventWrite[] = [];
  const deletions: string[] = [];
  const deletedSet = new Set(deletedEventIds);

  const byId = new Map<string, NormalizedEvent>();
  for (const ev of events) byId.set(ev.providerEventId, ev); // last occurrence in the batch wins
  for (const ev of byId.values()) {
    if (deletedSet.has(ev.providerEventId)) continue; // the marker is authoritative
    const hash = contentHash(ev.body);
    const action = decideEvent(
      stored.get(ev.providerEventId),
      { contentHash: hash, providerUpdatedAt: ev.providerUpdatedAt },
      false,
    );
    switch (action) {
      case 'insert':
      case 'reinstate':
        counts.inserted++;
        writes.push({ action, event: ev, hash });
        changes.push({ type: 'event_insert', providerEventId: ev.providerEventId, body: ev.body });
        break;
      case 'update':
        counts.updated++;
        writes.push({ action, event: ev, hash });
        changes.push({ type: 'event_update', providerEventId: ev.providerEventId, body: ev.body });
        break;
      case 'ignore_older':
        counts.ignoredOlder++;
        break;
      default:
        counts.unchanged++;
    }
  }
  for (const id of deletedSet) {
    if (decideEvent(stored.get(id), null, true) === 'delete') {
      counts.deleted++;
      deletions.push(id);
      changes.push({ type: 'event_delete', providerEventId: id, body: { providerEventId: id } });
    }
  }
  return { changes, writes, deletions, counts };
}
