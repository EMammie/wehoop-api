-- M5 B4 (plan rev 4.15, owner decisions 2026-11-05/06): a separate demo
-- environment replays committed recordings on a loop until production keys
-- exist. Three pieces of schema:
--
-- 1. `games.replay`: `recorded` (a Sportradar Simulations recording) or
--    `synthetic` (the hand-assembled Unrivaled replay); null for a real game.
--    It is set in the transaction that creates the game row, by a BEFORE INSERT
--    trigger that looks the game up in `ingest.replay_slots` (2). Why a trigger
--    and not a column in `ensureGame`: every path that creates a game
--    (ReferenceIngester's schedule ingest, GameWatcher's first document, a push
--    batch) goes through one `insert ... on conflict` in apply-changes.ts; the
--    trigger labels all of them in that same statement without a provider-side
--    flag travelling through normalization, and it cannot be forgotten by a
--    future insert path. The demo host writes the provenance row BEFORE a slot is
--    listed in any document, so the row always exists when the game is created.
--    The label is never written afterwards: `on conflict do update` does not
--    touch it.
-- 2. `ingest.replay_slots`: provenance of every replay slot, keyed like games
--    (league, provider game id): which recording and fixture file (with its
--    sha256) the slot replays, the recorded game id and tip-off, the slot
--    tip-off and the shift applied to every timestamp of the served documents.
--    No foreign key to games: the row precedes the game.
-- 3. `ingest.environment`: one row naming what this database is (`dev`, `demo`,
--    `production`). Demo mode runs only on the dev stack or a database marked
--    `demo`; production mode refuses a database marked `demo`. No row = unmarked
--    (every database before 0014); `pnpm demo init` writes `demo`.
--
-- `ingest` stays private (0001): RLS on, nothing granted to anon/authenticated.
-- `v_schedule` gains `replay` as its last column (create or replace keeps the
-- grants and security_invoker).

-------------------------------------------------------------------------------
-- 1. The label
-------------------------------------------------------------------------------
alter table public.games
  add column replay text check (replay in ('recorded', 'synthetic'));

comment on column public.games.replay is 'Demo environment (rev 4.15): recorded | synthetic for a replayed slot (ingest.replay_slots), null for a real game. Set at row creation by the games_replay_label trigger, never afterwards.';

-------------------------------------------------------------------------------
-- 2. Provenance
-------------------------------------------------------------------------------
create table ingest.replay_slots (
  league               public.league_code not null references public.leagues(code),
  provider_game_id     text not null,
  recording_id         text not null,
  fixture_path         text not null,
  fixture_sha256       text not null check (fixture_sha256 ~ '^[0-9a-f]{64}$'),
  provenance           text not null check (provenance in ('recorded', 'synthetic')),
  recorded_game_id     text not null,
  recorded_tip_off     timestamptz not null,
  slot_tip_off         timestamptz not null,
  shift_ms             bigint not null,
  created_at           timestamptz not null default now(),
  primary key (league, provider_game_id),
  -- The shift is exactly slot - recorded, so the originals are recoverable from the row.
  constraint replay_slots_shift_matches
    check (shift_ms = (extract(epoch from (slot_tip_off - recorded_tip_off)) * 1000)::bigint)
);
create index replay_slots_slot_tip_off_idx on ingest.replay_slots (slot_tip_off);

comment on table ingest.replay_slots is 'Demo environment (rev 4.15): one row per replay slot the demo host serves, written before the slot appears in any document. Served timestamps = recorded + shift_ms.';

-------------------------------------------------------------------------------
-- 3. Environment marker
-------------------------------------------------------------------------------
create table ingest.environment (
  singleton   boolean primary key default true check (singleton),
  kind        text not null check (kind in ('dev', 'demo', 'production')),
  note        text,
  updated_at  timestamptz not null default now()
);
create trigger environment_set_updated_at
  before update on ingest.environment
  for each row execute function public.set_updated_at();

comment on table ingest.environment is 'What this database is (rev 4.15): dev | demo | production; at most one row, none = unmarked. Demo mode needs dev stack or demo; production refuses demo.';

alter table ingest.replay_slots enable row level security;
alter table ingest.environment enable row level security;
revoke all on ingest.replay_slots from anon, authenticated;
revoke all on ingest.environment from anon, authenticated;

-------------------------------------------------------------------------------
-- 4. Label trigger (in the private schema: never an RPC endpoint)
-------------------------------------------------------------------------------
create or replace function ingest.games_replay_label()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.replay is null then
    select s.provenance into new.replay
    from ingest.replay_slots s
    where s.league = new.league and s.provider_game_id = new.provider_game_id;
  end if;
  return new;
end;
$$;
revoke execute on function ingest.games_replay_label() from public, anon, authenticated;

create trigger games_replay_label
  before insert on public.games
  for each row execute function ingest.games_replay_label();

-------------------------------------------------------------------------------
-- 5. v_schedule carries the label (last column: create or replace appends only)
-------------------------------------------------------------------------------
create or replace view public.v_schedule with (security_invoker = true) as
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
  g.updated_at,
  g.replay
from public.games g
left join public.seasons s on s.id = g.season_id
left join public.tournaments t on t.id = g.tournament_id
left join public.teams h on h.id = g.home_team_id
left join public.teams a on a.id = g.away_team_id;

comment on view public.v_schedule is 'Client schedule/scoreboard rows (PostgREST). security_invoker; never exposes games.watch_run_id. `replay` labels demo replays (0014).';
