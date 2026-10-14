import { contentHash } from '../model/content-hash.js';
import type { PendingChange } from '../model/game-change.js';
import { decideEvent, type EventAction, type StoredEventRevision } from './freshness.js';
import type { DeletionMarker, NormalizedEvent } from './types.js';

export interface EventDiffCounts {
  inserted: number;
  updated: number;
  /** Revision-only updates: provider_updated_at advanced, no change row. */
  touched: number;
  deleted: number;
  ignoredOlder: number;
  /** Explicit markers older than the stored event's revision. */
  ignoredOlderDeletions: number;
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
  /** Revision-only updates (newer `updated`, same body): no change row, no seq. */
  touches: NormalizedEvent[];
  /** Markers to apply as soft-deletes, with the marker's own revision. */
  deletions: DeletionMarker[];
  counts: EventDiffCounts;
}

/**
 * Pure per-entity reconciliation of one batch against stored play state
 * (plan §4 rule 3). Absence from the batch never deletes; only
 * `deletedEvents` (an explicit provider marker) does. Applying the same
 * batch twice yields an empty diff.
 */
export function diffEvents(
  stored: Map<string, StoredEventRevision>,
  events: NormalizedEvent[],
  deletedEvents: DeletionMarker[],
): EventDiff {
  const counts: EventDiffCounts = {
    inserted: 0,
    updated: 0,
    touched: 0,
    deleted: 0,
    ignoredOlder: 0,
    ignoredOlderDeletions: 0,
    unchanged: 0,
  };
  const changes: PendingChange[] = [];
  const writes: EventWrite[] = [];
  const touches: NormalizedEvent[] = [];
  const deletions: DeletionMarker[] = [];
  const markers = new Map<string, DeletionMarker>();
  for (const d of deletedEvents) markers.set(d.providerEventId, d); // last marker in the batch wins

  const byId = new Map<string, NormalizedEvent>();
  for (const ev of events) byId.set(ev.providerEventId, ev); // last occurrence in the batch wins
  for (const ev of byId.values()) {
    if (markers.has(ev.providerEventId)) continue; // the marker is authoritative
    const hash = contentHash(ev.body);
    const action = decideEvent(
      stored.get(ev.providerEventId),
      { contentHash: hash, providerUpdatedAt: ev.providerUpdatedAt },
      null,
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
      case 'touch':
        counts.touched++;
        touches.push(ev);
        break;
      case 'ignore_older':
        counts.ignoredOlder++;
        break;
      default:
        counts.unchanged++;
    }
  }
  for (const marker of markers.values()) {
    const id = marker.providerEventId;
    const action = decideEvent(stored.get(id), null, { updatedAt: marker.updatedAt });
    if (action === 'delete') {
      counts.deleted++;
      deletions.push(marker);
      changes.push({ type: 'event_delete', providerEventId: id, body: { providerEventId: id } });
    } else if (action === 'ignore_older_deletion') {
      counts.ignoredOlderDeletions++;
    }
  }
  return { changes, writes, touches, deletions, counts };
}
