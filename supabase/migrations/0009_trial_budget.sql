-- M3: trial mode budgeting (plan §2 `budget_reservations`, §4 "Rate/quota", "Trial mode").
--
-- 1. A reservation records which watch run spends it (`run_id`), the source it
--    was made under (`source`: a `simulation` rehearsal writes a reservation too,
--    so the trial flow is exercised end to end, but its calls never count), and
--    an operator note.
-- 2. Every provider call made under a reservation references it
--    (`provider_calls.reservation_id`), so "per-game call totals vs reservation"
--    is a join, and `used_calls` is checkable against it (invariant).
-- 3. `provider_calls.called_at` is the request START time (the rate limiter
--    grants slots on request start; insert time would blur the spacing check).
--    The default stays for rows written by hand.
-- 4. `v_quota` gains the outstanding reservation total: the guard refuses when
--    `remaining - reserved < reserve` (plan §4), so `spendable` must subtract
--    what is already promised to running watchers.

alter table ingest.budget_reservations
  add column source  ingest.ingest_source not null default 'trial',
  add column run_id  bigint references ingest.ingestion_runs(id) on delete set null,
  add column note    text,
  add constraint budget_reservations_reserved_positive check (reserved_calls > 0),
  add constraint budget_reservations_used_non_negative check (used_calls >= 0);
create index budget_reservations_run_id_idx on ingest.budget_reservations (run_id);
create index budget_reservations_open_idx on ingest.budget_reservations (product) where released_at is null;
comment on column ingest.budget_reservations.source is 'trial/production: counts against the product quota; simulation/fixture: rehearsal only, never counted.';
comment on column ingest.budget_reservations.run_id is 'The watch_game run that spends this reservation (null until the watcher starts, or for a plan-only reservation).';

alter table ingest.provider_calls
  add column reservation_id bigint references ingest.budget_reservations(id) on delete set null;
create index provider_calls_reservation_id_idx on ingest.provider_calls (reservation_id);
comment on column ingest.provider_calls.called_at is 'Request start time (the rate limiter slot), supplied by the client; default now() only for rows written by hand.';

drop view ingest.v_quota;
create view ingest.v_quota with (security_invoker = true) as
select
  q.product,
  q.limit_30d,
  q.reserve,
  q.verified_at,                                        -- QuotaGuard refuses while null (unless a config override names the product)
  coalesce(c.used, 0)::int                              as used_30d,
  (q.limit_30d - coalesce(c.used, 0))::int              as remaining,
  coalesce(r.reserved, 0)::int                          as reserved,          -- outstanding: reserved - used on open, counted reservations
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
) r on true;
revoke all on ingest.v_quota from anon, authenticated;
