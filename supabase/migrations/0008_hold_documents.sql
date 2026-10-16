-- wehoop-api: M2 third corrective pass (docs/PLAN.md rev 4.5, §2 and §4 "Identity").
--
-- A profile document whose ids resolve to rows that contradict each other
-- (conflicting_profiles, on the own-id path and now on the reference path too)
-- is SKIPPED in full: no own-id link, no merge, no attribute update, no seasons
-- or season lines. So that the held backlog can be worked later (M3 assesses
-- its coverage impact; before M5 beta the owner decides whether provisional
-- profiles are needed) without a provider refetch, every hold row, whatever its
-- reason, keeps the document itself: the Zod-parsed profile exactly as it was
-- applied, the observation time the ingester tracked for it, and when the
-- stored body was last refreshed. A repeated document refreshes the stored body
-- on the one open hold (the partial unique index still keeps it single).
--
-- Rows written before this migration carry null in the three new columns
-- (dev-only tables; nothing to backfill from): those holds predate preservation
-- and are replayable only by re-ingesting the provider document.

alter table ingest.player_merge_holds
  add column document             jsonb,
  add column document_observed_at timestamptz,
  add column document_updated_at  timestamptz;

comment on column ingest.player_merge_holds.document is
  'The parsed profile document (PlayerProfileDocumentSchema output, not the raw bytes) whose ingestion wrote this hold, as it was last seen. Null only on holds written before 0008. replayHeldDocument re-parses it with the profile schema and re-applies it through applyPlayerProfile.';
comment on column ingest.player_merge_holds.document_observed_at is
  'The observation time the reference ingester tracked for the document: the request time of the fetch that returned it (in replays, the recorded request time), the same clock that stamps game observations. The feed carries no observation time of its own (its `updated` is the provider revision and is kept inside document); when a caller passes none, the time the document was applied. Null only on holds written before 0008.';
comment on column ingest.player_merge_holds.document_updated_at is
  'When document was last written on this row: the first time the hold was opened, then every re-ingestion of the same document while the hold stays open. Null only on holds written before 0008.';

comment on table ingest.player_merge_holds is
  'References identity.ts would not link or merge automatically, each with the profile document that carried it preserved in `document`. A conflicting_profiles hold (or a held own id) skips the whole document: nothing else is written; the other reasons withhold that one reference while the document lands. unknown_scope: references[].scope is not a league alias we know; unknown_id_type: id_type outside league_profile / sport_profile / external; id_type_mismatch: the id string is already stored in that league under another id_type; tombstone_owner: the stored id belongs to a player that is itself merged (a data inconsistency, never followed blindly); conflicting_profiles: the rows the document would land on or merge each own a profile-sourced league_profile id in the same league (or different sport_profile ids), so merging would give one person two provider profiles. candidate_ids lists the canonical rows involved. Held, never merged, until an operator resolves the row. Service role only.';

-- Grants are unchanged (0007 revoked everything from anon / authenticated and the ingest
-- schema is not exposed); the new columns inherit the table's closure.
