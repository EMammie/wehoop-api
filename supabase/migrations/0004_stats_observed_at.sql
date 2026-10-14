-- wehoop-api: stats follow observation precedence (docs/PLAN.md rev 4.3, §4 rule 3 "Stats").
--
-- The M1 battery at 631ff1c re-ran the replay fixture over a finished game and
-- wrote four stats_team changes (two regressions, two restorations): post-phase
-- documents pass the generation gate by design, and team stats were applied by
-- content hash alone. Each stats row now records the observedAt of the batch
-- that wrote it; an incoming stats entity is applied only when its batch is
-- newer than the stored row, and produces a change row only when its hash
-- differs. Older observations are ignored (counted). Official corrections on
-- closed games arrive later and therefore still apply.

alter table public.game_team_stats add column observed_at timestamptz;
alter table public.game_player_stats add column observed_at timestamptz;

-- Rows written before this migration carry their last write time; new rows are
-- always written with the batch's observedAt by applyChanges.
update public.game_team_stats set observed_at = updated_at where observed_at is null;
update public.game_player_stats set observed_at = updated_at where observed_at is null;

comment on column public.game_team_stats.observed_at is
  'Observation.observedAt of the batch that last wrote or confirmed this row (request start for REST/sim, receipt time for push). Nullable only for rows predating 0004; applyChanges always sets it. An incoming stats entity is applied only when its observedAt is newer (freshness rule 3, stats).';
comment on column public.game_player_stats.observed_at is
  'Observation.observedAt of the batch that last wrote or confirmed this row. Nullable only for rows predating 0004; applyChanges always sets it (M2 writes player stats).';
