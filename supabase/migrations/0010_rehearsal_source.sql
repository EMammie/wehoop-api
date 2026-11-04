-- M3 review (should 4, should 1).
--
-- 1. `rehearsal`: a trial/production-shaped run that talks to a local stand-in
--    for api.sportradar.com (`pnpm sim serve`, SPORTRADAR_BASE_URL on a loopback
--    host). It is rate-limited like the real host but never counts toward quota,
--    so a rehearsal cannot consume a month of `v_quota.used_30d` or reserve budget.
-- 2. `v_quota.reserved` ignores reservations whose watch run is no longer
--    running: a worker killed with SIGKILL never reaches its release, and the
--    next lock holder marks the run aborted. QuotaGuard.reserve() also releases
--    such reservations explicitly (`released_at`), and `pnpm trial release`
--    exists for the operator.
alter type ingest.ingest_source add value if not exists 'rehearsal';

drop view ingest.v_quota;
create view ingest.v_quota with (security_invoker = true) as
select
  q.product,
  q.limit_30d,
  q.reserve,
  q.verified_at,
  coalesce(c.used, 0)::int                              as used_30d,
  (q.limit_30d - coalesce(c.used, 0))::int              as remaining,
  coalesce(r.reserved, 0)::int                          as reserved,
  (q.limit_30d - coalesce(c.used, 0) - coalesce(r.reserved, 0) - q.reserve)::int as spendable
from ingest.product_quotas q
left join lateral (
  select count(*) as used
  from ingest.provider_calls pc
  where pc.product = q.product
    and pc.quota_counted
    and pc.called_at > now() - interval '30 days'
) c on true
left join lateral (
  select sum(greatest(br.reserved_calls - br.used_calls, 0)) as reserved
  from ingest.budget_reservations br
  where br.product = q.product
    and br.released_at is null
    and br.source in ('trial', 'production')
    and (br.run_id is null
         or exists (select 1 from ingest.ingestion_runs ir where ir.id = br.run_id and ir.status = 'running'))
) r on true;
revoke all on ingest.v_quota from anon, authenticated;
