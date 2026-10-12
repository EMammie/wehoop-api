-- wehoop-api core schema
-- Two schemas:
--   public  : client-readable through RLS (select only for anon/authenticated)
--   ingest  : private operational data, service_role only, never exposed via PostgREST
--
-- Invariants this migration encodes (see CLAUDE.md):
--   * play_events holds CURRENT state only, one row per (game, provider_event_id). No seq.
--   * game_changes is the append-only, gap-free per-game change stream. Never updated or deleted by code.
--   * Exactly one ingest.broadcast_outbox row per game_changes row (PK is the change id).
--   * Clock is an observation, never a durable change.

-------------------------------------------------------------------------------
-- Schemas, roles, defaults
-------------------------------------------------------------------------------
create schema if not exists ingest;

revoke all on schema ingest from public;
revoke all on schema ingest from anon, authenticated;
grant usage on schema ingest to service_role;
alter default privileges in schema ingest grant all on tables to service_role;
alter default privileges in schema ingest grant all on sequences to service_role;
alter default privileges in schema ingest grant execute on functions to service_role;

-- Clients may only read public tables. Remove the default write grants Supabase ships with.
alter default privileges in schema public revoke insert, update, delete, truncate, references, trigger, maintain on tables from anon, authenticated;

-------------------------------------------------------------------------------
-- Types
-------------------------------------------------------------------------------
create type public.league_code as enum ('wnba', 'ncaawb', 'unrivaled');
create type public.season_type as enum ('PRE', 'REG', 'OOT', 'PST');
create type public.game_status as enum (
  'scheduled', 'created', 'inprogress', 'halftime', 'complete', 'closed',
  'cancelled', 'postponed', 'delayed', 'unnecessary', 'if_necessary', 'time_tbd'
);
create type public.coverage_level as enum ('full', 'extended_boxscore', 'boxscore', 'unknown');
create type public.period_type as enum ('quarter', 'half', 'overtime', 'elam');
create type public.change_type as enum (
  'event_insert', 'event_update', 'event_delete',
  'status', 'period', 'stats_team', 'stats_player'
);
create type ingest.ingest_source as enum ('production', 'trial', 'simulation', 'fixture');
-- Where a normalized batch came from (plan §4 Observation.source). Distinct from
-- ingest_source, which classifies runs/calls for quota purposes.
create type public.observation_source as enum ('push', 'rest', 'simulation', 'fixture');

-------------------------------------------------------------------------------
-- Helpers
-------------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
revoke execute on function public.set_updated_at() from public, anon, authenticated;

-- game_changes is append-only. Updates are never allowed; deletes only by the
-- retention job for rows already below games.retained_from_seq.
create or replace function public.game_changes_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
declare floor_seq bigint;
begin
  if tg_op = 'UPDATE' then
    raise exception 'game_changes is append-only (game %, seq %)', old.game_id, old.seq
      using errcode = 'restrict_violation';
  end if;
  select retained_from_seq into floor_seq from public.games where id = old.game_id;
  if floor_seq is null or old.seq >= floor_seq then
    raise exception 'game_changes rows at or above retained_from_seq cannot be deleted (game %, seq %, floor %)',
      old.game_id, old.seq, floor_seq using errcode = 'restrict_violation';
  end if;
  return old;
end;
$$;
revoke execute on function public.game_changes_append_only() from public, anon, authenticated;

-------------------------------------------------------------------------------
-- Reference data
-------------------------------------------------------------------------------
create table public.leagues (
  code            public.league_code primary key,
  name            text not null,
  provider_alias  text not null unique,             -- Sportradar URL path segment
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table public.seasons (
  id                  uuid primary key default gen_random_uuid(),
  league              public.league_code not null references public.leagues(code),
  year                int not null,
  type                public.season_type not null,
  provider_season_id  text not null,
  starts_on           date,
  ends_on             date,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (league, provider_season_id),
  unique (league, year, type)
);

create table public.teams (
  id                uuid primary key default gen_random_uuid(),
  league            public.league_code not null references public.leagues(code),
  provider_team_id  text not null,
  name              text not null,
  market            text,
  alias             text,
  conference        text,
  division          text,
  colors            jsonb,
  venue             jsonb,
  logo_url          text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (league, provider_team_id)
);
create index teams_league_alias_idx on public.teams (league, alias);

create table public.tournaments (
  id                       uuid primary key default gen_random_uuid(),
  league                   public.league_code not null references public.leagues(code),
  season_id                uuid references public.seasons(id),
  provider_tournament_id   text not null,
  name                     text not null,
  location                 text,
  starts_on                date,
  ends_on                  date,
  status                   text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (league, provider_tournament_id)
);
create index tournaments_season_id_idx on public.tournaments (season_id);

-------------------------------------------------------------------------------
-- Players and cross-league identity
-------------------------------------------------------------------------------
create table public.players (
  id            uuid primary key default gen_random_uuid(),
  full_name     text not null,
  first_name    text,
  last_name     text,
  birthdate     date,
  height_in     int,
  weight_lb     int,
  position      text,
  college       text,
  headshot_url  text,
  merged_into   uuid references public.players(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index players_full_name_fts_idx on public.players using gin (to_tsvector('simple', full_name));
create index players_merged_into_idx on public.players (merged_into) where merged_into is not null;

-- One canonical player, many provider/league ids. Unrivaled ids are a separate
-- id space from WNBA/NCAAW; the Unrivaled profile `references[]` links them.
create table public.player_external_ids (
  provider     text not null default 'sportradar',
  league       public.league_code not null,
  external_id  text not null,
  player_id    uuid not null references public.players(id) on delete cascade,
  id_type      text,
  source       text not null check (source in ('profile', 'reference', 'manual')),
  created_at   timestamptz not null default now(),
  primary key (provider, league, external_id)
);
create index player_external_ids_player_id_idx on public.player_external_ids (player_id);

create table public.player_team_seasons (
  player_id   uuid not null references public.players(id) on delete cascade,
  team_id     uuid not null references public.teams(id),
  season_id   uuid not null references public.seasons(id),
  jersey      text,
  status      text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (player_id, team_id, season_id)
);
create index player_team_seasons_team_season_idx on public.player_team_seasons (team_id, season_id);
create index player_team_seasons_season_id_idx on public.player_team_seasons (season_id);

create table public.player_season_stats (
  player_id       uuid not null references public.players(id) on delete cascade,
  season_id       uuid not null references public.seasons(id),
  team_id         uuid not null references public.teams(id),
  games_played    int,
  games_started   int,
  minutes         numeric(8,2),
  points          int,
  rebounds        int,
  off_rebounds    int,
  def_rebounds    int,
  assists         int,
  steals          int,
  blocks          int,
  turnovers       int,
  personal_fouls  int,
  fgm int, fga int, tpm int, tpa int, ftm int, fta int,
  plus_minus      int,
  averages        jsonb,                            -- per-game averages as provided
  extra           jsonb,                            -- anything not typed above
  content_hash    text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (player_id, season_id, team_id)
);
create index player_season_stats_season_team_idx on public.player_season_stats (season_id, team_id);
create index player_season_stats_team_id_idx on public.player_season_stats (team_id);

create table public.team_season_stats (
  team_id       uuid not null references public.teams(id),
  season_id     uuid not null references public.seasons(id),
  games_played  int,
  totals        jsonb,
  averages      jsonb,
  extra         jsonb,
  content_hash  text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (team_id, season_id)
);
create index team_season_stats_season_id_idx on public.team_season_stats (season_id);

-------------------------------------------------------------------------------
-- Games
-------------------------------------------------------------------------------
create table public.games (
  id                 uuid primary key default gen_random_uuid(),
  league             public.league_code not null references public.leagues(code),
  season_id          uuid references public.seasons(id),
  tournament_id      uuid references public.tournaments(id),
  provider_game_id   text not null,
  scheduled_at       timestamptz not null,
  status             public.game_status not null default 'scheduled',
  coverage           public.coverage_level not null default 'unknown',
  home_team_id       uuid references public.teams(id),
  away_team_id       uuid references public.teams(id),
  home_points        int not null default 0,
  away_points        int not null default 0,
  current_period     int,
  period_type        public.period_type,
  possession_arrow   text,
  elam_target_score  int,
  venue              jsonb,
  broadcasts         jsonb,
  -- change stream bookkeeping
  last_seq           bigint not null default 0,
  retained_from_seq  bigint not null default 1,
  stats_final_at     timestamptz,
  -- observation columns (refreshed without incrementing seq)
  clock              text,
  clock_decimal      text,
  clock_running      boolean,                       -- null = unknown: display last observed clock frozen
  clock_as_of        timestamptz,
  clock_extra        jsonb,
  progress_key       jsonb,                         -- [statusRank, periodSequence, -clockSeconds, eventCount]
  observed_at        timestamptz,
  observed_source    public.observation_source,
  provider_updated_at timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (league, provider_game_id),
  check (retained_from_seq >= 1 and retained_from_seq <= last_seq + 1)
);
create index games_league_scheduled_at_idx on public.games (league, scheduled_at);
create index games_live_idx on public.games (league, scheduled_at) where status in ('inprogress', 'halftime', 'delayed');
create index games_season_id_idx on public.games (season_id);
create index games_tournament_id_idx on public.games (tournament_id) where tournament_id is not null;
create index games_home_team_id_idx on public.games (home_team_id);
create index games_away_team_id_idx on public.games (away_team_id);

create table public.game_periods (
  game_id      uuid not null references public.games(id) on delete cascade,
  sequence     int not null,
  number       int not null,
  type         public.period_type not null,
  home_points  int not null default 0,
  away_points  int not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (game_id, sequence)
);

create table public.game_team_stats (
  game_id        uuid not null references public.games(id) on delete cascade,
  team_id        uuid not null references public.teams(id),
  is_home        boolean not null,
  points int, fgm int, fga int, tpm int, tpa int, ftm int, fta int,
  off_rebounds int, def_rebounds int, rebounds int,
  assists int, steals int, blocks int, turnovers int, personal_fouls int,
  fast_break_pts int, paint_pts int, second_chance_pts int, bench_pts int, biggest_lead int,
  extra          jsonb,
  content_hash   text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (game_id, team_id)
);
create index game_team_stats_team_id_idx on public.game_team_stats (team_id);

create table public.game_player_stats (
  game_id        uuid not null references public.games(id) on delete cascade,
  player_id      uuid not null references public.players(id),
  team_id        uuid not null references public.teams(id),
  starter        boolean,
  played         boolean,
  on_court       boolean,
  minutes        text,
  points int, fgm int, fga int, tpm int, tpa int, ftm int, fta int,
  off_rebounds int, def_rebounds int, rebounds int,
  assists int, steals int, blocks int, turnovers int, personal_fouls int,
  plus_minus     int,
  efficiency     int,
  extra          jsonb,
  content_hash   text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (game_id, player_id)
);
create index game_player_stats_player_id_idx on public.game_player_stats (player_id);
create index game_player_stats_team_id_idx on public.game_player_stats (team_id);

-- CURRENT state of each play. One row per provider event. No seq column.
create table public.play_events (
  id                   uuid primary key default gen_random_uuid(),
  game_id              uuid not null references public.games(id) on delete cascade,
  provider_event_id    text not null,
  provider_number      int,
  provider_sequence    bigint,
  period_sequence      int,
  period_number        int,
  period_type          public.period_type,
  clock                text,
  clock_decimal        text,
  wall_clock           timestamptz,
  event_type           text not null,              -- our LiveEvent discriminator
  provider_event_type  text,
  team_id              uuid references public.teams(id),
  player_id            uuid references public.players(id),
  home_points          int,
  away_points          int,
  payload              jsonb not null,             -- normalized LiveEvent body (no envelope)
  content_hash         text not null,
  provider_updated_at  timestamptz,
  deleted_at           timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (game_id, provider_event_id)
);
create index play_events_game_order_idx on public.play_events (game_id, period_sequence, provider_sequence);
create index play_events_team_id_idx on public.play_events (team_id);
create index play_events_player_id_idx on public.play_events (player_id);

-- APPEND-ONLY change stream. seq is gap-free per game by construction (allocated
-- under the game row lock for exactly the number of real changes).
create table public.game_changes (
  game_id            uuid not null references public.games(id) on delete cascade,
  seq                bigint not null,
  id                 uuid not null default gen_random_uuid(),   -- stable message id
  change_type        public.change_type not null,
  play_event_id      uuid references public.play_events(id),
  provider_event_id  text,
  body               jsonb not null,
  content_hash       text,
  created_at         timestamptz not null default now(),
  primary key (game_id, seq),
  unique (id),
  check (seq >= 1)
);
create index game_changes_play_event_id_idx on public.game_changes (play_event_id) where play_event_id is not null;
create trigger game_changes_append_only
  before update or delete on public.game_changes
  for each row execute function public.game_changes_append_only();

create table public.standings (
  season_id    uuid not null references public.seasons(id),
  team_id      uuid not null references public.teams(id),
  wins         int,
  losses       int,
  win_pct      numeric(5,3),
  games_behind numeric(5,1),
  conf_wins    int,
  conf_losses  int,
  streak       text,
  rank         int,
  records      jsonb,
  as_of        timestamptz,
  content_hash text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (season_id, team_id)
);
create index standings_team_id_idx on public.standings (team_id);

-------------------------------------------------------------------------------
-- updated_at triggers
-------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'leagues','seasons','teams','tournaments','players','player_team_seasons',
    'player_season_stats','team_season_stats','games','game_periods',
    'game_team_stats','game_player_stats','play_events','standings'
  ] loop
    execute format('create trigger %I_set_updated_at before update on public.%I for each row execute function public.set_updated_at()', t, t);
  end loop;
end $$;

-------------------------------------------------------------------------------
-- ingest schema: private operational tables
-------------------------------------------------------------------------------
create table ingest.play_event_raw (
  play_event_id        uuid primary key references public.play_events(id) on delete cascade,
  raw                  jsonb not null,
  provider_updated_at  timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index play_event_raw_created_at_idx on ingest.play_event_raw (created_at);
create trigger play_event_raw_set_updated_at before update on ingest.play_event_raw for each row execute function public.set_updated_at();

create table ingest.ingestion_runs (
  id               bigint generated always as identity primary key,
  kind             text not null check (kind in ('poll_schedule','watch_game','push_stream','replay','backfill','changes','profile')),
  league           public.league_code,
  game_id          uuid references public.games(id) on delete set null,
  source           ingest.ingest_source not null,
  started_at       timestamptz not null default now(),
  ended_at         timestamptz,
  status           text not null default 'running' check (status in ('running','ok','error','aborted')),
  events_inserted  int not null default 0,
  events_updated   int not null default 0,
  events_deleted   int not null default 0,
  stale_batches    int not null default 0,
  error            text,
  meta             jsonb
);
create index ingestion_runs_game_id_idx on ingest.ingestion_runs (game_id);
create index ingestion_runs_started_at_idx on ingest.ingestion_runs (started_at);

-- Quota limits per Sportradar API product, seeded from the console. Never assumed.
create table ingest.product_quotas (
  product     text primary key,                    -- e.g. 'wnba', 'ncaawb', 'unrivaled'
  limit_30d   int not null,
  qps         int not null default 1,
  reserve     int not null default 100,            -- QuotaGuard refuses below remaining - reserve
  note        text,
  verified_at timestamptz,                         -- null until a human confirms the limit in the Sportradar console
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger product_quotas_set_updated_at before update on ingest.product_quotas for each row execute function public.set_updated_at();

create table ingest.provider_calls (
  id             bigint generated always as identity primary key,
  run_id         bigint references ingest.ingestion_runs(id) on delete set null,
  source         ingest.ingest_source not null,
  product        text,
  league         public.league_code,
  feed           text not null,
  url            text not null,
  status         int,
  duration_ms    int,
  bytes          int,
  quota_counted  boolean not null,
  called_at      timestamptz not null default now(),
  check (not quota_counted or product is not null)
);
comment on column ingest.provider_calls.url is 'Request URL with any api_key / token query parameters stripped before insert.';
create index provider_calls_quota_idx on ingest.provider_calls (product, called_at) where quota_counted;
create index provider_calls_run_id_idx on ingest.provider_calls (run_id);

create view ingest.v_quota with (security_invoker = true) as
select
  q.product,
  q.limit_30d,
  q.reserve,
  q.verified_at,                                        -- QuotaGuard must refuse while null
  coalesce(c.used, 0)::int                              as used_30d,
  (q.limit_30d - coalesce(c.used, 0))::int              as remaining,
  (q.limit_30d - coalesce(c.used, 0) - q.reserve)::int  as spendable
from ingest.product_quotas q
left join lateral (
  select count(*) as used
  from ingest.provider_calls pc
  where pc.product = q.product
    and pc.quota_counted
    and pc.called_at > now() - interval '30 days'
) c on true;

create table ingest.budget_reservations (
  id              bigint generated always as identity primary key,
  game_id         uuid references public.games(id) on delete cascade,
  product         text not null references ingest.product_quotas(product),
  profile         text not null,
  reserved_calls  int not null,
  used_calls      int not null default 0,
  created_at      timestamptz not null default now(),
  released_at     timestamptz
);
create index budget_reservations_game_id_idx on ingest.budget_reservations (game_id);
create index budget_reservations_product_idx on ingest.budget_reservations (product);

-- Exactly one row per durable change: the PK *is* the change id.
-- Outbox rows are for per-game channels only ('game:{uuid}'). Pulses and
-- league:{code}:scores deltas are best-effort and go straight to the transport.
create table ingest.broadcast_outbox (
  change_id        uuid primary key references public.game_changes(id) on delete cascade,
  channel          text not null,
  game_id          uuid not null,
  seq              bigint not null,
  created_at       timestamptz not null default now(),
  published_at     timestamptz,
  attempts         int not null default 0,
  next_attempt_at  timestamptz not null default now(),
  last_error       text,
  dead_at          timestamptz,
  unique (channel, seq),
  check (channel like 'game:%')
);
create index broadcast_outbox_pending_idx on ingest.broadcast_outbox (channel, seq) where published_at is null and dead_at is null;

-- Batches rejected by the freshness policy. Evidence for the no-regression test.
create table ingest.stale_observations (
  id                   bigint generated always as identity primary key,
  game_id              uuid not null references public.games(id) on delete cascade,
  source               public.observation_source not null,
  fetched_at           timestamptz not null,
  progress_key         jsonb not null,
  stored_progress_key  jsonb,
  reason               text not null,
  created_at           timestamptz not null default now()
);
create index stale_observations_game_id_idx on ingest.stale_observations (game_id);

-------------------------------------------------------------------------------
-- Row Level Security: clients read public, nothing else
-------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'leagues','seasons','teams','tournaments','players','player_external_ids',
    'player_team_seasons','player_season_stats','team_season_stats','games',
    'game_periods','game_team_stats','game_player_stats','play_events',
    'game_changes','standings'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I_read on public.%I for select to anon, authenticated using (true)', t, t);
    -- Belt and braces: strip write grants even though no write policy exists.
    execute format('revoke insert, update, delete, truncate, references, trigger, maintain on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to anon, authenticated', t);
  end loop;
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'play_event_raw','ingestion_runs','product_quotas','provider_calls',
    'budget_reservations','broadcast_outbox','stale_observations'
  ] loop
    execute format('alter table ingest.%I enable row level security', t);
    execute format('revoke all on ingest.%I from anon, authenticated', t);
  end loop;
end $$;
revoke all on ingest.v_quota from anon, authenticated;

-------------------------------------------------------------------------------
-- Realtime authorization: clients may RECEIVE game/league broadcasts on private
-- channels. There is deliberately NO insert policy, so only the service-role
-- publisher can send. Tested in M1 with both the anon key and a guest JWT.
-------------------------------------------------------------------------------
create policy "clients receive game and league broadcasts"
on realtime.messages
for select
to anon, authenticated
using (
  extension = 'broadcast'
  and (
    (select realtime.topic()) like 'game:%'
    or (select realtime.topic()) like 'league:%'
  )
);

-------------------------------------------------------------------------------
-- Seed reference rows that code depends on
-------------------------------------------------------------------------------
insert into public.leagues (code, name, provider_alias) values
  ('wnba', 'WNBA', 'wnba'),
  ('ncaawb', 'NCAA Women''s Basketball', 'ncaawb'),
  ('unrivaled', 'Unrivaled', 'unrivaled');

-- Default trial quotas. Replace with the real numbers from the Sportradar console
-- before any production/trial run (ingest/product_quotas is read, never assumed).
-- verified_at stays null here on purpose: QuotaGuard refuses to spend quota until
-- an operator sets limit_30d from the console and stamps verified_at.
insert into ingest.product_quotas (product, limit_30d, qps, reserve, note) values
  ('wnba', 1000, 1, 100, 'placeholder; set from console and stamp verified_at'),
  ('ncaawb', 1000, 1, 100, 'placeholder; set from console and stamp verified_at'),
  ('unrivaled', 1000, 1, 100, 'placeholder; set from console and stamp verified_at');
