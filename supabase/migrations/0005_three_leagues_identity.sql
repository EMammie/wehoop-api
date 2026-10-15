-- wehoop-api: M2 three leagues + identity (docs/PLAN.md rev 4.3, §2, §5, §7 M2).
--
-- 1. season_type gains 'CC': the recorded WNBA simulation carries season type
--    "CC" (Commissioner's Cup), which the plan's four values do not cover. M1
--    left games.season_id null for it; from M2 every game document's `season`
--    header is upserted into public.seasons and linked. (Contract note: the
--    plan enumerates PRE/REG/OOT/PST; adding the value observed in real data is
--    the smallest change that keeps seasons keyed by provider id.)
-- 2. Identity: players discovered from game feeds (summary rosters, pbp
--    attributions) are created with player_external_ids.source = 'game';
--    profile feeds write 'profile' and their references[] write 'reference'.
--    players.merged_into points a duplicate at its survivor after a profile
--    links two canonical rows; every FK that referenced the duplicate is
--    repointed by identity.ts inside the same transaction.
-- 3. Games learn their season, tournament (Unrivaled OOT games come from the
--    tournament schedule feed) and provider title; game_player_stats learns
--    the roster facts the summary carries (jersey, position); standings learn
--    the conference/division they were listed under and points for/against.
-- 4. PostgREST views v_schedule, v_boxscore, v_standings, v_player_seasons,
--    all `with (security_invoker = true)`, select-only for anon/authenticated,
--    never exposing games.watch_run_id. No view hides a column: anything a
--    client must not see lives in `ingest`.

-------------------------------------------------------------------------------
-- 1. season_type: add the value observed in the recorded WNBA data
-------------------------------------------------------------------------------
-- A value added by ALTER TYPE cannot be used in the same transaction; nothing
-- below references 'CC'.
alter type public.season_type add value if not exists 'CC';

-------------------------------------------------------------------------------
-- 2. Identity
-------------------------------------------------------------------------------
alter table public.player_external_ids
  drop constraint player_external_ids_source_check,
  add constraint player_external_ids_source_check
    check (source in ('profile', 'reference', 'manual', 'game'));

alter table public.players
  add column status text,
  add column jersey text,
  add column provider_updated_at timestamptz;

comment on column public.players.merged_into is
  'Set when a later profile proved this row and another are the same person: every external id, season line, team season and play reference was repointed at merged_into inside the same transaction (identity.ts). Readers resolve a player id through this column; a row with merged_into set is a tombstone kept so old links do not dangle.';
comment on column public.player_external_ids.source is
  'profile: the id the profile document itself carries; reference: an id from a profile''s references[] (another league or the sport-wide profile); game: first seen in a game feed roster or play attribution; manual: operator.';

-------------------------------------------------------------------------------
-- 3. Games, tournaments, stats, standings
-------------------------------------------------------------------------------
alter table public.games add column title text;
comment on column public.games.title is 'Provider game title when the feed carries one (e.g. "2026 Commissioner''s Cup Final", "First Round - Pod B - Game 1").';

alter table public.tournaments add column provider_parent_id text;
comment on column public.tournaments.provider_parent_id is 'Provider id of the parent tournament (Unrivaled tournament schedule `parent_id`).';

alter table public.game_player_stats
  add column jersey text,
  add column position text,
  add column not_playing_reason text;

alter table public.standings
  add column conference text,
  add column division text,
  add column points_for numeric(8,2),
  add column points_against numeric(8,2),
  add column extra jsonb;

-------------------------------------------------------------------------------
-- 4. PostgREST views (security_invoker: RLS of the underlying tables applies)
-------------------------------------------------------------------------------
create view public.v_schedule with (security_invoker = true) as
select
  g.id,
  g.league,
  g.provider_game_id,
  g.season_id,
  s.year                                   as season_year,
  s.type                                   as season_type,
  g.tournament_id,
  t.name                                   as tournament_name,
  g.title,
  g.scheduled_at,
  g.status,
  g.coverage,
  -- Plan §9: NCAAWB partial coverage is shown as "score only" in the schedule.
  case g.coverage
    when 'full'    then 'live plays'
    when 'unknown' then 'unknown'
    else 'score only'
  end                                      as coverage_label,
  g.home_team_id,
  h.name                                   as home_name,
  h.market                                 as home_market,
  h.alias                                  as home_alias,
  g.away_team_id,
  a.name                                   as away_name,
  a.market                                 as away_market,
  a.alias                                  as away_alias,
  g.home_points,
  g.away_points,
  g.current_period,
  g.period_type,
  g.current_period_sequence,
  g.elam_target_score,
  g.clock,
  g.clock_decimal,
  g.clock_running,
  g.clock_as_of,
  g.venue,
  g.broadcasts,
  g.last_seq,
  g.retained_from_seq,
  g.stats_final_at,
  g.observed_at,
  g.updated_at
from public.games g
left join public.seasons s on s.id = g.season_id
left join public.tournaments t on t.id = g.tournament_id
left join public.teams h on h.id = g.home_team_id
left join public.teams a on a.id = g.away_team_id;

create view public.v_boxscore with (security_invoker = true) as
select
  ps.game_id,
  ps.team_id,
  (ps.team_id = g.home_team_id)            as is_home,
  tm.name                                  as team_name,
  tm.market                                as team_market,
  tm.alias                                 as team_alias,
  ps.player_id,
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

create view public.v_standings with (security_invoker = true) as
select
  st.season_id,
  s.league,
  s.year                                   as season_year,
  s.type                                   as season_type,
  st.team_id,
  tm.provider_team_id,
  tm.name                                  as team_name,
  tm.market                                as team_market,
  tm.alias                                 as team_alias,
  st.conference,
  st.division,
  st.wins,
  st.losses,
  st.win_pct,
  st.games_behind,
  st.conf_wins,
  st.conf_losses,
  st.points_for,
  st.points_against,
  st.streak,
  st.rank,
  st.records,
  st.extra,
  st.as_of,
  st.updated_at
from public.standings st
join public.seasons s on s.id = st.season_id
join public.teams tm on tm.id = st.team_id;

create view public.v_player_seasons with (security_invoker = true) as
select
  pss.player_id,
  p.full_name,
  pss.season_id,
  s.league,
  s.year                                   as season_year,
  s.type                                   as season_type,
  pss.team_id,
  tm.provider_team_id,
  tm.name                                  as team_name,
  tm.market                                as team_market,
  tm.alias                                 as team_alias,
  pss.games_played,
  pss.games_started,
  pss.minutes,
  pss.points, pss.rebounds, pss.off_rebounds, pss.def_rebounds,
  pss.assists, pss.steals, pss.blocks, pss.turnovers, pss.personal_fouls,
  pss.fgm, pss.fga, pss.tpm, pss.tpa, pss.ftm, pss.fta,
  pss.plus_minus,
  pss.averages,
  pss.extra,
  pss.updated_at
from public.player_season_stats pss
join public.players p on p.id = pss.player_id
join public.seasons s on s.id = pss.season_id
join public.teams tm on tm.id = pss.team_id;

-- Views are read through the caller's role (security_invoker), so RLS on the
-- base tables decides visibility; the grants below only let clients name them.
grant select on public.v_schedule, public.v_boxscore, public.v_standings, public.v_player_seasons
  to anon, authenticated;
revoke insert, update, delete, truncate, references, trigger, maintain
  on public.v_schedule, public.v_boxscore, public.v_standings, public.v_player_seasons
  from anon, authenticated;

comment on view public.v_schedule is 'Client schedule/scoreboard rows (PostgREST). security_invoker; never exposes games.watch_run_id.';
comment on view public.v_boxscore is 'One row per player per game (PostgREST). Team totals are read from game_team_stats directly.';
comment on view public.v_standings is 'Standings rows joined to season and team (PostgREST).';
comment on view public.v_player_seasons is 'Per-league season lines for a canonical player (PostgREST). Rows of merged players were repointed at the survivor.';
