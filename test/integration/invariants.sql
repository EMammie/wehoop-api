-- Change-stream and access-control invariants. Run with `pnpm invariants`.
-- Format: each block starts with `-- check: <name> | expect: <value>` and is one
-- statement returning exactly one row with one column.

-- check: play_events_no_duplicate_provider_ids | expect: 0
select count(*) from (
  select game_id, provider_event_id
  from public.play_events
  group by 1, 2
  having count(*) > 1
) d;

-- check: game_changes_no_gaps_in_retained_history | expect: 0
select count(*)
from public.game_changes c
join public.games g on g.id = c.game_id
where c.seq > g.retained_from_seq
  and not exists (
    select 1 from public.game_changes p
    where p.game_id = c.game_id and p.seq = c.seq - 1
  );

-- check: games_last_seq_matches_max_change | expect: 0
select count(*)
from public.games g
left join (
  select game_id, max(seq) as max_seq from public.game_changes group by game_id
) m on m.game_id = g.id
where g.last_seq <> coalesce(m.max_seq, g.retained_from_seq - 1);

-- check: outbox_matches_changes_exactly | expect: 0
select count(*)
from public.game_changes c
full outer join ingest.broadcast_outbox o on o.change_id = c.id
where c.id is null
   or o.change_id is null
   or o.game_id <> c.game_id
   or o.seq <> c.seq
   or o.channel <> 'game:' || c.game_id::text;

-- check: outbox_no_dead_letters | expect: 0
select count(*) from ingest.broadcast_outbox where dead_at is not null;

-- check: outbox_no_duplicate_game_seq | expect: 0
select count(*) from (
  select game_id, seq from ingest.broadcast_outbox group by 1, 2 having count(*) > 1
) d;

-- check: outbox_channel_is_generated | expect: 1
select count(*)
from information_schema.columns
where table_schema = 'ingest'
  and table_name = 'broadcast_outbox'
  and column_name = 'channel'
  and is_generated = 'ALWAYS';

-- check: outbox_has_composite_routing_fk | expect: 1
select count(*)
from pg_constraint
where conname = 'broadcast_outbox_routes_its_change'
  and contype = 'f';

-- check: games_has_no_progress_key | expect: 0
select count(*)
from information_schema.columns
where table_schema = 'public'
  and table_name = 'games'
  and column_name = 'progress_key';

-- check: generation_fks_restrict_delete | expect: 2
select count(*)
from pg_constraint
where contype = 'f'
  and confdeltype = 'r'
  and conname in ('games_watch_run_id_fkey', 'ingestion_runs_parent_run_id_fkey');

-- check: outbox_has_single_fk | expect: 1
select count(*)
from pg_constraint
where conrelid = 'ingest.broadcast_outbox'::regclass
  and contype = 'f';

-- check: anon_cannot_select_ingest_tables | expect: 0
select count(*)
from information_schema.role_table_grants
where grantee in ('anon', 'authenticated')
  and table_schema = 'ingest';

-- check: anon_has_no_write_grants_on_public | expect: 0
select count(*)
from information_schema.role_table_grants
where grantee in ('anon', 'authenticated')
  and table_schema = 'public'
  and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE');

-- check: public_tables_all_have_rls | expect: 0
select count(*)
from pg_tables t
where t.schemaname = 'public'
  and not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = t.schemaname and c.relname = t.tablename and c.relrowsecurity
  );

-- check: retained_head_exists | expect: 0
select count(*)
from public.games g
where g.last_seq >= g.retained_from_seq
  and not exists (
    select 1 from public.game_changes c
    where c.game_id = g.id and c.seq = g.retained_from_seq
  );

-- check: anon_has_no_maintain_privilege_on_public | expect: 0
select count(*)
from pg_tables t
where t.schemaname = 'public'
  and (
    has_table_privilege('anon', format('%I.%I', t.schemaname, t.tablename), 'MAINTAIN')
    or has_table_privilege('authenticated', format('%I.%I', t.schemaname, t.tablename), 'MAINTAIN')
  );

-- check: anon_has_no_usage_on_ingest_schema | expect: 0
select (has_schema_privilege('anon', 'ingest', 'USAGE')::int
      + has_schema_privilege('authenticated', 'ingest', 'USAGE')::int);

-- check: public_schema_has_no_client_write_policies | expect: 0
select count(*)
from pg_policies
where schemaname = 'public'
  and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  and (roles::text[] && array['anon', 'authenticated', 'public']);

-- check: realtime_has_no_client_insert_policy | expect: 0
select count(*)
from pg_policies
where schemaname = 'realtime'
  and tablename = 'messages'
  and cmd in ('INSERT', 'ALL')
  and (roles::text[] && array['anon', 'authenticated', 'public']);

-- check: game_changes_has_append_only_trigger | expect: 1
select count(*)
from pg_trigger
where tgrelid = 'public.game_changes'::regclass
  and tgname = 'game_changes_append_only'
  and not tgisinternal;

-- check: views_use_security_invoker | expect: 0
select count(*)
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where c.relkind = 'v'
  and n.nspname in ('public', 'ingest')
  and not coalesce(
    (select option_value::boolean
     from pg_options_to_table(c.reloptions)
     where option_name = 'security_invoker'),
    false
  );

-- check: event_changes_reference_their_play_row | expect: 0
select count(*)
from public.game_changes c
where c.change_type in ('event_insert', 'event_update', 'event_delete')
  and (c.play_event_id is null
       or c.provider_event_id is null
       or not exists (
         select 1 from public.play_events p
         where p.id = c.play_event_id and p.game_id = c.game_id and p.provider_event_id = c.provider_event_id
       ));

-- check: outbox_published_rows_have_no_error | expect: 0
select count(*)
from ingest.broadcast_outbox
where published_at is not null and (dead_at is not null or last_error is not null);

-- check: deleted_revision_only_on_deleted_events | expect: 0
select count(*)
from public.play_events
where deleted_revision_at is not null and deleted_at is null;

-- check: stats_observed_at_set | expect: 0
select count(*) from public.game_team_stats where observed_at is null;

-- check: client_views_use_security_invoker | expect: 4
select count(*)
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where c.relkind = 'v'
  and n.nspname = 'public'
  and c.relname in ('v_schedule', 'v_boxscore', 'v_standings', 'v_player_seasons')
  and coalesce(
    (select option_value::boolean
     from pg_options_to_table(c.reloptions)
     where option_name = 'security_invoker'),
    false
  );

-- check: views_do_not_expose_watch_run_id | expect: 0
select count(*)
from information_schema.columns c
join pg_class r on r.relname = c.table_name
join pg_namespace n on n.oid = r.relnamespace and n.nspname = c.table_schema
where c.table_schema = 'public'
  and r.relkind = 'v'
  and c.column_name = 'watch_run_id';

-- check: anon_can_select_every_client_view | expect: 4
select count(*)
from information_schema.role_table_grants
where grantee = 'anon'
  and table_schema = 'public'
  and privilege_type = 'SELECT'
  and table_name in ('v_schedule', 'v_boxscore', 'v_standings', 'v_player_seasons');

-- check: external_ids_point_at_canonical_players | expect: 0
select count(*)
from public.player_external_ids e
join public.players p on p.id = e.player_id
where p.merged_into is not null;

-- check: merged_players_point_at_canonical_survivors | expect: 0
select count(*)
from public.players l
join public.players s on s.id = l.merged_into
where s.merged_into is not null;

-- check: tombstoned_players_own_nothing | expect: 0
select count(*)
from public.players l
where l.merged_into is not null
  and (exists (select 1 from public.player_season_stats x where x.player_id = l.id)
    or exists (select 1 from public.player_team_seasons x where x.player_id = l.id)
    or exists (select 1 from public.game_player_stats x where x.player_id = l.id)
    or exists (select 1 from public.play_events x where x.player_id = l.id));

-- check: player_stats_observed_at_set | expect: 0
select count(*) from public.game_player_stats where observed_at is null;

-- check: elam_games_have_a_target | expect: 0
select count(*)
from public.games g
where g.period_type = 'elam'
  and g.elam_target_score is null;

-- check: oot_games_belong_to_a_tournament | expect: 0
select count(*)
from public.games g
join public.seasons s on s.id = g.season_id
where s.type = 'OOT'
  and g.tournament_id is null;

-- check: stats_bodies_carry_no_canonical_uuid | expect: 0
select count(*)
from public.game_changes c
where c.change_type in ('stats_player', 'stats_team')
  and (c.body ? 'playerId' or c.body ? 'teamId');

-- check: player_stats_provider_id_resolves_to_row_player | expect: 0
select count(*)
from public.game_player_stats ps
join public.games g on g.id = ps.game_id
where not exists (
  select 1 from public.player_external_ids e
  where e.provider = 'sportradar'
    and e.league = g.league
    and e.external_id = ps.provider_player_id
    and e.player_id = ps.player_id
);

-- check: game_player_stats_pk_is_provider_keyed | expect: 1
select count(*)
from pg_constraint c
where c.conrelid = 'public.game_player_stats'::regclass
  and c.contype = 'p'
  and (select array_agg(a.attname::text order by a.attnum)
       from pg_attribute a where a.attrelid = c.conrelid and a.attnum = any(c.conkey))
      = array['game_id', 'provider_player_id'];

-- check: game_player_stats_one_row_per_provider_id_per_game | expect: 0
select count(*) from (
  select game_id, provider_player_id from public.game_player_stats group by 1, 2 having count(*) > 1
) d;

-- check: game_player_stats_never_point_at_tombstones | expect: 0
select count(*)
from public.game_player_stats s
join public.players p on p.id = s.player_id
where p.merged_into is not null;

-- check: tombstones_have_merge_provenance | expect: 0
select count(*)
from public.players l
where l.merged_into is not null
  and not exists (select 1 from ingest.player_merges m where m.loser_id = l.id);

-- check: merge_losers_are_tombstones | expect: 0
select count(*)
from ingest.player_merges m
join public.players l on l.id = m.loser_id
where l.merged_into is null;

-- check: merge_survivors_are_or_resolve_to_the_current_survivor | expect: 0
select count(*)
from ingest.player_merges m
join public.players l on l.id = m.loser_id
join public.players s on s.id = m.survivor_id
where l.merged_into <> m.survivor_id
  and coalesce(s.merged_into, s.id) <> l.merged_into;

-- check: open_hold_candidates_are_distinct_canonical_rows | expect: 0
-- A conflict between rows that resolve to one canonical row is no conflict (own-id holds, [ownRow], are out of scope).
select count(*)
from ingest.player_merge_holds h
where h.status = 'open'
  and h.reason = 'conflicting_profiles'
  and cardinality(h.candidate_ids) >= 2
  and (select count(distinct coalesce(p.merged_into, p.id))
         from public.players p where p.id = any(h.candidate_ids)) < 2;

-- check: open_holds_preserve_their_document | expect: 0
select count(*)
from ingest.player_merge_holds
where status = 'open' and document is null;

-- check: merge_tables_closed_to_clients | expect: 0
select (has_table_privilege('anon', 'ingest.player_merges', 'SELECT')::int
      + has_table_privilege('anon', 'ingest.player_merge_holds', 'SELECT')::int
      + has_table_privilege('authenticated', 'ingest.player_merges', 'SELECT')::int
      + has_table_privilege('authenticated', 'ingest.player_merge_holds', 'SELECT')::int);

-- check: sim_fixture_and_rehearsal_calls_never_count_quota | expect: 0
select count(*)
from ingest.provider_calls
where quota_counted and source in ('simulation', 'fixture', 'rehearsal');

-- check: trial_and_production_calls_always_count_quota | expect: 0
select count(*)
from ingest.provider_calls
where not quota_counted and source in ('trial', 'production');

-- check: quota_counted_calls_carry_a_product | expect: 0
select count(*) from ingest.provider_calls where quota_counted and product is null;

-- check: trial_watch_runs_have_a_reservation | expect: 0
select count(*)
from ingest.ingestion_runs r
where r.kind = 'watch_game'
  and r.source in ('trial', 'production', 'rehearsal')
  and not exists (select 1 from ingest.budget_reservations b where b.run_id = r.id);

-- check: counted_calls_spaced_at_least_one_second_per_product | expect: 0
select count(*)
from (
  select called_at - lag(called_at) over (partition by product order by called_at, id) as gap
  from ingest.provider_calls
  where quota_counted
) g
where g.gap < interval '1 second';

-- check: rate_limited_calls_spaced_at_least_one_second_per_product | expect: 0
select count(*)
from (
  select called_at - lag(called_at) over (partition by product order by called_at, id) as gap
  from ingest.provider_calls
  where source in ('trial', 'production', 'rehearsal')
) g
where g.gap < interval '1 second';

-- check: rate_limited_calls_claimed_a_shared_slot | expect: 0
-- Every rate-limited call claims its slot from ingest.provider_rate_slots (rev 4.6), which
-- then holds at least one interval beyond that call; a call logged past that point was made
-- by a process that bypassed the shared ledger (the per-process limiter of evidence M3 1c).
select count(*)
from ingest.provider_calls pc
join ingest.provider_rate_slots s on s.product = pc.product
where pc.source in ('trial', 'production', 'rehearsal')
  and pc.called_at > s.next_slot_at - interval '1 second';

-- check: every_quota_product_has_a_rate_slot | expect: 0
-- 0011 seeds a slot row per quota row; a product added later gets one on its first rate-limited
-- call (PgSlotStore) or has made none. Any quota row that has rate-limited calls but no slot row
-- was served by a process that bypassed the shared ledger.
select count(*)
from ingest.product_quotas q
left join ingest.provider_rate_slots s on s.product = q.product
where s.product is null
  and exists (select 1 from ingest.provider_calls pc
              where pc.product = q.product and pc.source in ('trial', 'production', 'rehearsal'));

-- check: no_open_reservation_for_a_finished_watch_run | expect: 0
select count(*)
from ingest.budget_reservations b
join ingest.ingestion_runs r on r.id = b.run_id
where b.released_at is null and r.status <> 'running';

-- check: reservation_used_calls_match_provider_calls | expect: 0
select count(*)
from ingest.budget_reservations b
where b.used_calls <> (select count(*) from ingest.provider_calls c where c.reservation_id = b.id);

-- check: counted_reservations_are_trial_or_production | expect: 0
select count(*)
from ingest.budget_reservations b
join ingest.provider_calls c on c.reservation_id = b.id
where c.quota_counted <> (b.source in ('trial', 'production'));

-- check: quota_tables_closed_to_clients | expect: 0
select count(*)
from information_schema.role_table_grants
where table_schema = 'ingest'
  and table_name in ('product_quotas', 'provider_calls', 'budget_reservations', 'v_quota')
  and grantee in ('anon', 'authenticated');
