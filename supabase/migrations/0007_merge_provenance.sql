-- wehoop-api: M2 corrective pass (docs/PLAN.md rev 4.4, §2 and §4 "Identity").
--
-- 1. game_player_stats is keyed on (game_id, provider_player_id). The stats
--    bodies, their content hashes, the snapshot and the client reducer are all
--    provider-keyed (plan §3, ratified 2026-10-14), so the stored row must be
--    too: a client that folds /changes holds one entry per provider id, and a
--    fresh snapshot must return the same set. Under the old PK (game_id,
--    player_id) an identity merge of two provider ids that both had a line in
--    one game had to delete one row, which silently diverged from every
--    connected client. Now a merge only repoints player_id (the resolved
--    canonical column) and drops nothing, and the in-batch "first line wins"
--    guard on the canonical id is gone: the outcome no longer depends on the
--    order a feed lists players in.
-- 2. ingest.player_merges: provenance for every automatic merge: the document
--    and the references[] entry that triggered it, survivor, loser, the FK
--    repoint counts and the full content of every row that had to be dropped
--    because the survivor already owned the same key (season lines, team
--    seasons). Nothing a merge removes is lost; there is no unmerge UI yet.
-- 3. ingest.player_merge_holds: references identity.ts refuses to act on
--    automatically (unknown scope or id type, an id stored under another type,
--    an id owned by a tombstone, or two provider profiles of one league that
--    would end up on one person). Held, never merged, until an operator
--    reconciles them.
-- 4. player_team_seasons is reference/roster data outside the live-game
--    single-writer rule; its writers are named on the table comment.
--
-- Note on 0006: its backfill of provider_player_id assumed every existing row
-- had a league_profile id under the game's league; rows written by
-- apply-changes.ts always do (a line is written only for a resolved player),
-- and a row that did not would have failed the `set not null` loudly rather
-- than been guessed. Nothing to correct; recorded here because 0006 cannot be
-- edited after it was applied.

-------------------------------------------------------------------------------
-- 1. game_player_stats: provider-keyed primary key
-------------------------------------------------------------------------------
alter table public.game_player_stats drop constraint game_player_stats_pkey;
alter table public.game_player_stats add primary key (game_id, provider_player_id);
-- player_id keeps its own index (0001); (game_id, player_id) reads use it.

-- The body's fullName is stored on the row too: the snapshot must return the line exactly as
-- the stats_player change carried it, and after a merge players.full_name is the survivor's
-- name for every provider id, which is not what the stream said. Backfilled from players for
-- rows written before this migration (none on a fresh reset).
alter table public.game_player_stats add column full_name text;
update public.game_player_stats ps set full_name = p.full_name
  from public.players p where p.id = ps.player_id and ps.full_name is null;
alter table public.game_player_stats alter column full_name set not null;
comment on column public.game_player_stats.full_name is
  'The name the provider line carried (stats_player body fullName). The canonical name is players.full_name via player_id.';

comment on table public.game_player_stats is
  'One row per (game, provider player id): the stored form of a stats_player body. player_id is the canonical player resolved by identity.ts at write time and repointed by a merge; two provider ids that resolve to one person keep two rows, exactly as the change stream and the snapshot present them. Written only by apply-changes.ts.';

-------------------------------------------------------------------------------
-- 2. Merge provenance
-------------------------------------------------------------------------------
create table ingest.player_merges (
  id                   uuid primary key default gen_random_uuid(),
  survivor_id          uuid not null references public.players(id),
  loser_id             uuid not null references public.players(id),
  league               public.league_code not null,
  trigger_feed         text not null check (trigger_feed in ('player_profile', 'manual')),
  trigger_document_id  text,
  trigger_source       text not null check (trigger_source in ('profile', 'reference', 'game', 'manual')),
  trigger_reference    jsonb not null,
  run_id               bigint references ingest.ingestion_runs(id),
  repoint              jsonb not null,
  conflicts            jsonb not null default '[]'::jsonb,
  created_at           timestamptz not null default now(),
  unique (loser_id)
);
create index player_merges_survivor_id_idx on ingest.player_merges (survivor_id);
create index player_merges_run_id_idx on ingest.player_merges (run_id);

comment on table ingest.player_merges is
  'One row per automatic identity merge (identity.ts mergePlayers). loser_id is the tombstone (players.merged_into set); survivor_id is the row it was folded into at the time (a later merge may fold the survivor again; players.merged_into is the current resolution). Service role only.';
comment on column ingest.player_merges.trigger_reference is
  'The reference that caused the merge: for a profile, the references[] entry {scope, id_type, source_id} (or {id_type, source_id, scope} built from the document''s own id) that resolved to the other canonical row. trigger_source says which: profile (the document''s own id), reference (a references[] entry), game, manual.';
comment on column ingest.player_merges.repoint is
  'Counts per table: {playEvents, gamePlayerStats: {repointed}, playerSeasonStats: {repointed, dropped}, playerTeamSeasons: {repointed, dropped}}.';
comment on column ingest.player_merges.conflicts is
  'Full content of every loser row that was dropped because the survivor already owned the same key: [{table, row}] with row = to_jsonb(the deleted row). Empty when nothing collided. game_player_stats never appears here: it is provider-keyed and never dropped.';

create table ingest.player_merge_holds (
  id                   uuid primary key default gen_random_uuid(),
  league               public.league_code not null,
  trigger_feed         text not null check (trigger_feed in ('player_profile', 'manual')),
  trigger_document_id  text not null,
  trigger_reference    jsonb not null,
  reason               text not null check (reason in (
                         'unknown_scope', 'unknown_id_type', 'id_type_mismatch',
                         'tombstone_owner', 'conflicting_profiles')),
  candidate_ids        uuid[] not null default '{}',
  detail               jsonb,
  run_id               bigint references ingest.ingestion_runs(id),
  status               text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  resolved_at          timestamptz,
  resolution           jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
-- Re-applying the same document never piles up duplicate open holds.
create unique index player_merge_holds_open_unique
  on ingest.player_merge_holds (league, trigger_feed, trigger_document_id, trigger_reference, reason)
  where status = 'open';
create index player_merge_holds_run_id_idx on ingest.player_merge_holds (run_id);
create index player_merge_holds_candidate_ids_idx on ingest.player_merge_holds using gin (candidate_ids);
create trigger player_merge_holds_set_updated_at
  before update on ingest.player_merge_holds for each row execute function public.set_updated_at();

comment on table ingest.player_merge_holds is
  'References identity.ts would not link or merge automatically. unknown_scope: references[].scope is not a league alias we know; unknown_id_type: id_type outside league_profile / sport_profile / external; id_type_mismatch: the id string is already stored in that league under another id_type; tombstone_owner: the stored id belongs to a player that is itself merged (a data inconsistency, never followed blindly); conflicting_profiles: the two canonical rows each own a profile-sourced league_profile id in the same league (or different sport_profile ids), so merging would give one person two provider profiles. candidate_ids lists the canonical rows involved. Held, never merged, until an operator resolves the row. Service role only.';

revoke all on ingest.player_merges, ingest.player_merge_holds from anon, authenticated;

-------------------------------------------------------------------------------
-- 4. Roster data: who writes player_team_seasons
-------------------------------------------------------------------------------
comment on table public.player_team_seasons is
  'Roster membership (player, team, season) with jersey/status. Reference data, NOT live-game state: it carries no seq and never produces a game_change, so it sits outside the apply-changes.ts single-writer rule. Writers: identity.ts ensurePlayerTeamSeason (profile seasons[], seasonal statistics and league leaders through reference.ts) and identity.ts mergePlayers (repoint on an identity merge; a loser row colliding with the survivor''s is preserved in ingest.player_merges.conflicts before it is dropped).';

-- v_boxscore: full_name is now the line's own name (as the provider reported it for that
-- provider id); canonical_full_name is players.full_name through player_id. Recreated because a
-- view cannot change a column's source expression or gain a middle column with `or replace`.
drop view public.v_boxscore;
create view public.v_boxscore with (security_invoker = true) as
select
  ps.game_id,
  ps.team_id,
  tm.provider_team_id,
  (ps.team_id = g.home_team_id)            as is_home,
  tm.name                                  as team_name,
  tm.market                                as team_market,
  tm.alias                                 as team_alias,
  ps.player_id,
  ps.provider_player_id,
  ps.full_name,
  p.full_name                              as canonical_full_name,
  ps.jersey,
  ps.position,
  ps.starter,
  ps.played,
  ps.on_court,
  ps.not_playing_reason,
  ps.minutes,
  ps.points, ps.fgm, ps.fga, ps.tpm, ps.tpa, ps.ftm, ps.fta,
  ps.off_rebounds, ps.def_rebounds, ps.rebounds,
  ps.assists, ps.steals, ps.blocks, ps.turnovers, ps.personal_fouls,
  ps.plus_minus,
  ps.efficiency,
  ps.extra,
  ps.observed_at,
  ps.updated_at
from public.game_player_stats ps
join public.games g on g.id = ps.game_id
join public.players p on p.id = ps.player_id
join public.teams tm on tm.id = ps.team_id;

grant select on public.v_boxscore to anon, authenticated;
revoke insert, update, delete, truncate, references, trigger, maintain
  on public.v_boxscore from anon, authenticated;
comment on view public.v_boxscore is
  'One row per (game, provider player id) from game_player_stats (PostgREST). full_name is the provider line''s own name, canonical_full_name the merged player''s. Two provider ids merged into one player stay two rows (player_id equal); never sum rows by player_id without grouping. Team totals are read from game_team_stats directly.';
