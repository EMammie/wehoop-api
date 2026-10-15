-- M2 review loop: provider-keyed stats bodies (plan §3, ratified 2026-10-14).
--
-- `stats_player` / `stats_team` bodies and their content hashes carry provider
-- ids only (`providerPlayerId`, `providerTeamId`); canonical uuids are columns.
-- An identity merge repoints `game_player_stats.player_id` without touching the
-- hash, so a byte-identical summary after a merge produces no change. For the
-- snapshot to return exactly the provider id the body carried (not a guess
-- through player_external_ids, which can hold several ids per league after a
-- merge), the line's provider id is stored on the row.
alter table public.game_player_stats add column provider_player_id text;

-- Backfill from the identity table: the league profile id under the game's
-- league, preferring the one a profile document owns. Empty on a fresh reset.
update public.game_player_stats ps
set provider_player_id = (
  select x.external_id
  from public.player_external_ids x
  join public.games g on g.id = ps.game_id
  where x.player_id = ps.player_id
    and x.league = g.league
    and x.provider = 'sportradar'
    and x.id_type = 'league_profile'
  order by (x.source = 'profile') desc, x.external_id
  limit 1
)
where ps.provider_player_id is null;

alter table public.game_player_stats alter column provider_player_id set not null;
comment on column public.game_player_stats.provider_player_id is
  'The provider player id the stats line was keyed on (the stats_player body''s providerPlayerId). player_id is the canonical uuid resolved by identity.ts and may be repointed by a merge; this column never changes.';

-- v_boxscore gains the provider id. A view cannot add a column in the middle with
-- `create or replace`, so it is recreated with its grants.
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
  p.full_name,
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
comment on view public.v_boxscore is 'One row per player per game (PostgREST). Team totals are read from game_team_stats directly.';
