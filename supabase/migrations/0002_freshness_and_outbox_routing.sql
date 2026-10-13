-- wehoop-api: pre-M1 schema fixes from the M0 review (docs/PLAN.md rev 4).
--
-- Finding 1: freshness cannot be a monotonic scalar. 0001 stored
-- games.progress_key = [statusRank, periodSequence, -clockSeconds, eventCount]
-- and compared it to decide staleness. The review showed that score cannot
-- order observations: halftime outranks the second half, a clock restored after
-- a review lowers it, an explicit deletion lowers the event count, and equal
-- scores with different payloads prove nothing about direction. Freshness is
-- now decided by ingestion run (games.observed_run_id, monotonic bigint) plus
-- per-entity precedence (PLAN.md section 4), so progress_key goes away and the
-- game records the run that last wrote it and an orderable period sequence.
-- ingest.stale_observations stops pretending to hold a key and holds the
-- rejected observation, what was stored, the run, and one of three reasons.
--
-- Finding 2: outbox routing fields could disagree with the change they route.
-- 0001 let the writer supply channel, game_id and seq freely next to change_id.
-- Now (change_id, game_id, seq) is a composite FK onto game_changes(id, game_id,
-- seq), channel is generated from game_id and can never be supplied, and
-- (game_id, seq) is unique. A wrong channel or a foreign seq is impossible by
-- construction rather than by convention.
--
-- Grants and RLS: ingest tables keep service_role-only access via the default
-- privileges set in 0001; RLS was enabled per table there and survives column
-- changes. public.game_changes keeps its select-only client policy. Nothing is
-- re-granted here on purpose; test/integration/invariants.sql re-checks it.

-------------------------------------------------------------------------------
-- 1. public.games: observation columns follow the run-generation policy
-------------------------------------------------------------------------------
alter table public.games drop column progress_key;

alter table public.games
  add column current_period_sequence int,
  add column observed_run_id bigint references ingest.ingestion_runs(id) on delete set null;

create index games_observed_run_id_idx on public.games (observed_run_id);

comment on column public.games.current_period_sequence is
  'Orderable period sequence (1..n across regulation and overtime) of the last accepted observation. Distinct from current_period, which is the display number. Used by freshness rule 2b.';
comment on column public.games.observed_run_id is
  'ingest.ingestion_runs.id of the run that last wrote this game. A batch from a lower run id is stale (older_run); a higher run id must pass the non-regression gate (run_regresses_state).';

-------------------------------------------------------------------------------
-- 2. ingest.stale_observations: log the observation, not a progress key
-------------------------------------------------------------------------------
alter table ingest.stale_observations rename column progress_key to observation;
alter table ingest.stale_observations rename column stored_progress_key to stored;
alter table ingest.stale_observations rename column fetched_at to observed_at;

alter table ingest.stale_observations
  add column run_id bigint references ingest.ingestion_runs(id) on delete set null,
  add constraint stale_observations_reason_check
    check (reason in ('older_run', 'run_regresses_state', 'superseded_observation'));

create index stale_observations_run_id_idx on ingest.stale_observations (run_id);

comment on column ingest.stale_observations.observation is
  'The rejected or superseded batch''s game-level view (status, score, period sequence, clock, event count, observedAt) as jsonb.';
comment on column ingest.stale_observations.stored is
  'The game-level view that was stored when the batch was rejected, same shape as observation.';
comment on column ingest.stale_observations.observed_at is
  'Observation.observedAt of the rejected batch: request start for REST/sim, receipt time for push.';
comment on column ingest.stale_observations.run_id is
  'ingest.ingestion_runs.id that produced the rejected batch.';

-------------------------------------------------------------------------------
-- 3. ingest.broadcast_outbox: routing identity is enforced, not supplied
-------------------------------------------------------------------------------
-- FK target: game_changes already has unique(id) and PK(game_id, seq); the
-- composite FK needs the exact triple.
alter table public.game_changes
  add constraint game_changes_id_game_id_seq_key unique (id, game_id, seq);

drop index if exists ingest.broadcast_outbox_pending_idx;
alter table ingest.broadcast_outbox
  drop constraint broadcast_outbox_channel_check,
  drop constraint broadcast_outbox_channel_seq_key,
  drop column channel;

alter table ingest.broadcast_outbox
  add column channel text generated always as ('game:' || game_id::text) stored not null,
  add constraint broadcast_outbox_routes_its_change
    foreign key (change_id, game_id, seq)
    references public.game_changes (id, game_id, seq) on delete cascade,
  add constraint broadcast_outbox_game_id_seq_key unique (game_id, seq);

create index broadcast_outbox_pending_idx
  on ingest.broadcast_outbox (game_id, seq)
  where published_at is null and dead_at is null;

comment on column ingest.broadcast_outbox.channel is
  'Derived Realtime topic for this change (game:{game_id}). Generated; inserts that supply it fail with SQLSTATE 428C9.';
comment on constraint broadcast_outbox_routes_its_change on ingest.broadcast_outbox is
  'An outbox row can only route the change it references: game_id and seq must match game_changes for change_id.';
