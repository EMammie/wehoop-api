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
where c.id is null or o.change_id is null;

-- check: outbox_no_dead_letters | expect: 0
select count(*) from ingest.broadcast_outbox where dead_at is not null;

-- check: outbox_no_duplicate_channel_seq | expect: 0
select count(*) from (
  select channel, seq from ingest.broadcast_outbox group by 1, 2 having count(*) > 1
) d;

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
