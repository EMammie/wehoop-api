-- wehoop-api: M1 corrective pass (docs/PLAN.md rev 4.3).
--
-- 1. Freshness rule 2(d): a new generation's summary-only document with a lower
--    score and no clock position on either side is neither accepted nor
--    rejected; it is logged as `ambiguous_regression` and nothing is written.
--    The next batch of the same generation reads the most recent such row
--    (inside the applyChanges transaction) to corroborate the lower score.
-- 2. Deletions carry their own revision: the `updated` of a `deleted_events[]`
--    entry (or push delete message). A marker older than the stored event's
--    revision is ignored; a marker without a revision is applied and recorded
--    with a null revision. Reinstatement requires an incoming `updated` newer
--    than coalesce(deleted_revision_at, provider_updated_at).

alter table ingest.stale_observations
  drop constraint stale_observations_reason_check,
  add constraint stale_observations_reason_check
    check (reason in ('older_run', 'run_regresses_state', 'superseded_observation', 'ambiguous_regression'));

alter table public.play_events
  add column deleted_revision_at timestamptz;

comment on column public.play_events.deleted_revision_at is
  'The deletion marker''s own provider revision (`updated` on the deleted_events[] entry or push delete message); null when the marker carried none. Meaningful only while deleted_at is not null; cleared on reinstatement. A deleted event is reinstated only by an incoming revision newer than coalesce(deleted_revision_at, provider_updated_at).';
