-- wehoop-api: pre-M1 schema fixes from the M0 review (docs/PLAN.md rev 4).
--
-- Finding 1: freshness cannot be a monotonic scalar. 0001 stored
-- games.progress_key = [statusRank, periodSequence, -clockSeconds, eventCount]
-- and compared it to decide staleness. The review showed that score cannot
-- order observations: halftime outranks the second half, a clock restored after
-- a review lowers it, an explicit deletion lowers the event count, and equal
-- scores with different payloads prove nothing about direction. Freshness is
-- now decided by watch generation (games.watch_run_id: the root watch_game or
-- replay run; push_stream/backfill/reconciliation sub-runs inherit it through
-- ingestion_runs.parent_run_id) plus per-entity precedence (PLAN.md section 4),
-- so progress_key goes away and the game records the generation that last wrote
-- it and an orderable period sequence. A run referenced by games.watch_run_id
-- or by another run's parent_run_id can never be deleted (FK restrict), so a
-- generation is never silently forgotten by a prune. ingest.stale_observations
-- stops pretending to hold a key and holds the rejected observation, what was
-- stored, the run, and one of three reasons; its run_id stays on delete set
-- null because it is a log, not a generation marker.
--
-- Finding 2: outbox routing fields could disagree with the change they route.
-- 0001 let the writer supply channel, game_id and seq freely next to change_id.
-- Now (change_id, game_id, seq) is a composite FK onto game_changes(id, game_id,
-- seq), channel is generated from game_id and can never be supplied, and
-- (game_id, seq) is unique. A wrong channel or a foreign seq is impossible by
-- construction rather than by convention. The single-column change_id FK from
-- 0001 is dropped as redundant: the composite FK implies it (and keeps the
-- cascade), and one FK means one error to reason about.
--
-- Grants and RLS: ingest tables keep service_role-only access via the default
-- privileges set in 0001; RLS was enabled per table there and survives column
-- changes. public.game_changes keeps its select-only client policy. Nothing is
-- re-granted here on purpose; test/integration/invariants.sql re-checks it.

-------------------------------------------------------------------------------
-- 1. ingest.ingestion_runs: sub-runs belong to a watch generation
-------------------------------------------------------------------------------
alter table ingest.ingestion_runs
  add column parent_run_id bigint references ingest.ingestion_runs(id) on delete restrict,
  add constraint ingestion_runs_not_own_parent check (parent_run_id is distinct from id);

create index ingestion_runs_parent_run_id_idx on ingest.ingestion_runs (parent_run_id);

comment on column ingest.ingestion_runs.parent_run_id is
  'Watch generation this run belongs to. Null for a root watch_game/replay run (the generation itself) and for generation-less runs (poll_schedule, changes, profile). push_stream, backfill and REST-reconciliation sub-runs point at their root run and inherit its id as the watch generation for freshness. On delete restrict: a generation with children is never pruned from under them.';

-------------------------------------------------------------------------------
-- 2. public.games: observation columns follow the watch-generation policy
-------------------------------------------------------------------------------
alter table public.games drop column progress_key;

alter table public.games
  add column current_period_sequence int,
  add column watch_run_id bigint references ingest.ingestion_runs(id) on delete restrict;

create index games_watch_run_id_idx on public.games (watch_run_id);

comment on column public.games.current_period_sequence is
  'Orderable period sequence (1..n across regulation and overtime) of the last accepted observation. Distinct from current_period, which is the display number. Used by freshness rule 2b.';
comment on column public.games.watch_run_id is
  'Watch generation that last wrote this game: the root watch_game/replay run id; sub-runs inherit it via ingestion_runs.parent_run_id. A batch from a lower generation is stale (older_run); a higher generation must pass the non-regression gate (run_regresses_state). On delete restrict: the generation a game points at is never pruned.';

-------------------------------------------------------------------------------
-- 3. ingest.stale_observations: log the observation, not a progress key
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
  'ingest.ingestion_runs.id that produced the rejected batch. Set null on run delete: this is a log, not a generation marker.';

-------------------------------------------------------------------------------
-- 4. ingest.broadcast_outbox: routing identity is enforced, not supplied
-------------------------------------------------------------------------------
-- FK target: game_changes already has unique(id) and PK(game_id, seq); the
-- composite FK needs the exact triple.
alter table public.game_changes
  add constraint game_changes_id_game_id_seq_key unique (id, game_id, seq);

drop index if exists ingest.broadcast_outbox_pending_idx;
alter table ingest.broadcast_outbox
  drop constraint broadcast_outbox_channel_check,
  drop constraint broadcast_outbox_channel_seq_key,
  -- 0001's single-column FK on change_id; the composite FK below implies it.
  drop constraint broadcast_outbox_change_id_fkey,
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
