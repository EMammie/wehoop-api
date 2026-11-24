-- M5 B2 (plan rev 4.10 (2), §2 `leagues`): the app's `League` value is read from
-- this row, never from a switch, so the row carries what the league switch and
-- brand colours need; and a leaders view so the Leaders screen orders by a typed
-- numeric column instead of a jsonb path over every season line.

-- 1. League display data. `short_name` is what a segmented control shows;
--    `colors` is `{primary, secondary}` as #rrggbb (null = the app's default
--    palette for a code it does not know, which is also what a fourth league
--    gets until someone fills the row).
alter table public.leagues
  add column short_name text,
  add column colors     jsonb;

update public.leagues set short_name = 'WNBA',      colors = '{"primary": "#FF6A13", "secondary": "#1D1D1B"}' where code = 'wnba';
update public.leagues set short_name = 'NCAAW',     colors = '{"primary": "#0057B8", "secondary": "#FFFFFF"}' where code = 'ncaawb';
update public.leagues set short_name = 'Unrivaled', colors = '{"primary": "#000000", "secondary": "#F5F5F0"}' where code = 'unrivaled';

alter table public.leagues alter column short_name set not null;
alter table public.leagues
  add constraint leagues_colors_shape check (
    colors is null
    or (jsonb_typeof(colors) = 'object'
        and colors ? 'primary'
        and colors->>'primary' ~ '^#[0-9A-Fa-f]{6}$'
        and (not colors ? 'secondary' or colors->>'secondary' ~ '^#[0-9A-Fa-f]{6}$'))
  );

comment on column public.leagues.short_name is 'Short label for the league switch (the app never hardcodes one).';
comment on column public.leagues.colors is '{primary, secondary} as #rrggbb; null = the app''s default palette. Approximate brand colours, not a licence.';

-- 2. Leaders. One row per (season line, category), value computed from the
--    typed totals so every product ranks the same way regardless of what its
--    `averages` document carries. Counting stats are per game; percentages are
--    made/attempted; a line with no games or no attempts in a category has no
--    row for it. `rank` is dense over the season and category (ties share a
--    rank). The client filters by league, season_id and category and orders by
--    rank; the season filter is served by player_season_stats_season_team_idx.
create view public.v_leaders with (security_invoker = true) as
with lines as (
  select
    pss.player_id, pss.season_id, pss.team_id, pss.games_played,
    pss.minutes, pss.points, pss.rebounds, pss.assists, pss.steals, pss.blocks, pss.turnovers,
    pss.fgm, pss.fga, pss.tpm, pss.tpa, pss.ftm, pss.fta,
    s.league, s.year as season_year, s.type as season_type
  from public.player_season_stats pss
  join public.seasons s on s.id = pss.season_id
  where pss.games_played > 0
),
cats as (
  select l.*, c.category, c.value
  from lines l
  cross join lateral (values
    ('points',    l.points::numeric    / l.games_played),
    ('rebounds',  l.rebounds::numeric  / l.games_played),
    ('assists',   l.assists::numeric   / l.games_played),
    ('steals',    l.steals::numeric    / l.games_played),
    ('blocks',    l.blocks::numeric    / l.games_played),
    ('minutes',   l.minutes            / l.games_played),
    ('turnovers', l.turnovers::numeric / l.games_played),
    ('fg_pct',    l.fgm::numeric       / nullif(l.fga, 0)),
    ('three_pct', l.tpm::numeric       / nullif(l.tpa, 0)),
    ('ft_pct',    l.ftm::numeric       / nullif(l.fta, 0))
  ) as c(category, value)
  where c.value is not null
)
select
  c.league,
  c.season_id,
  c.season_year,
  c.season_type,
  c.category,
  round(c.value, 3)                        as value,
  rank() over (partition by c.season_id, c.category order by c.value desc) as rank,
  c.player_id,
  p.full_name,
  c.team_id,
  tm.provider_team_id,
  tm.name                                  as team_name,
  tm.market                                as team_market,
  tm.alias                                 as team_alias,
  c.games_played
from cats c
join public.players p on p.id = c.player_id
join public.teams tm on tm.id = c.team_id;

grant select on public.v_leaders to anon, authenticated;
revoke insert, update, delete, truncate, references, trigger, maintain
  on public.v_leaders from anon, authenticated;

comment on view public.v_leaders is 'Season leaders (PostgREST): one row per season line and category, value from the typed totals, rank per season and category. security_invoker.';
