-- M3 corrective pass (plan rev 4.6, §4 "Rate/quota"): cross-process request spacing.
--
-- The RateLimiter used to live in one process (`rateLimiterFor`): `pnpm trial plan`
-- (a CLI process) followed within 1 s by `pnpm trial watch` (which spawns the
-- worker, a second process) produced a 595 ms gap and a 429 from the provider
-- (evidence M3 item 1c). Sportradar's 1 request/second is per product key,
-- not per process, so the slot ledger moves into the database every process
-- shares: one row per product holding the next free slot on the DATABASE clock.
--
-- A claim is one atomic statement (the row lock serializes claimants):
--   update ingest.provider_rate_slots
--      set next_slot_at = greatest(next_slot_at, clock_timestamp()) + make_interval(secs => $interval)
--    where product = $1
--   returning next_slot_at - make_interval(secs => $interval) as slot_at,
--             extract(epoch from (slot_at - clock_timestamp())) * 1000 as delay_ms
-- The process sleeps `delay_ms` locally and logs `provider_calls.called_at = slot_at`,
-- so the spacing recorded in `provider_calls` is on one clock regardless of the
-- process clocks involved.
--
-- Private schema, same posture as the rest of `ingest`: RLS on, no grants to
-- anon/authenticated. Seeded from the newest rate-limited call per product so an
-- upgrade in the middle of a watch does not hand the next process an early slot.

create table ingest.provider_rate_slots (
  product      text primary key references ingest.product_quotas(product) on delete cascade,
  next_slot_at timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
comment on table ingest.provider_rate_slots is
  'Next free request slot per Sportradar product, on the database clock; claimed atomically by every process (RateLimiter + PgSlotStore).';
comment on column ingest.provider_rate_slots.next_slot_at is
  'The earliest instant the next request to this product may start (database clock).';

alter table ingest.provider_rate_slots enable row level security;
revoke all on ingest.provider_rate_slots from anon, authenticated;

insert into ingest.provider_rate_slots (product, next_slot_at)
select q.product,
       coalesce((select max(pc.called_at) + interval '1200 milliseconds'
                   from ingest.provider_calls pc
                  where pc.product = q.product
                    and pc.source in ('trial', 'production', 'rehearsal')),
                now())
from ingest.product_quotas q;
