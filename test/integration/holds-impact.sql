-- Held-profile impact (plan §7 M3, rev 4.5 checkpoint). Same query as
-- `heldProfileImpact` in src/ingest/trial-mode.ts (`pnpm trial holds`).
-- Evidence: run after the live run, even when it returns 0 rows:
--   docker exec -i supabase_db_wehoop-api psql -U postgres -d postgres -At -f /dev/stdin < test/integration/holds-impact.sql
select h.id as hold_id, h.league, h.reason,
       h.trigger_document_id as document_id,
       h.document->>'full_name' as document_name,
       h.created_at,
       (select json_agg(json_build_object('id', p.id, 'full_name', p.full_name, 'merged_into', p.merged_into) order by p.created_at)
          from public.players p where p.id = any(h.candidate_ids)) as candidates,
       (select array_agg(distinct s.game_id)
          from public.game_player_stats s join public.games g on g.id = s.game_id
         where g.watch_run_id is not null and g.league = h.league
           and s.provider_player_id = h.trigger_document_id) as document_in_watched_games,
       (select array_agg(distinct s.game_id)
          from public.game_player_stats s join public.games g on g.id = s.game_id
         where g.watch_run_id is not null and s.player_id = any(h.candidate_ids)) as candidates_in_watched_games
from ingest.player_merge_holds h
where h.status = 'open'
order by h.created_at, h.id;
