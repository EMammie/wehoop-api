import { Hono } from 'hono';
import { WORKER_LOCK_KEY } from '../../db/session-client.js';
import { QuotaGuard } from '../../ingest/quota-guard.js';
import type { AppEnv } from '../server.js';

/**
 * GET /health (plan §5): liveness + outbox lag, dead count, whether the
 * single-ingester lock is held, and the last ingest tick (newest provider call
 * and newest game observation). Public, no secrets.
 */
export function healthRoutes() {
  const r = new Hono<AppEnv>();

  r.get('/health', async (c) => {
    const { db, config, log } = c.get('deps');
    try {
      const [row] = await db<
        {
          now: Date;
          outboxPending: number;
          outboxLagMs: number | null;
          outboxDead: number;
          lockHeld: boolean;
          lastCallAt: Date | null;
          lastObservedAt: Date | null;
          runningRuns: number;
        }[]
      >`
        select now() as now,
          (select count(*)::int from ingest.broadcast_outbox where published_at is null and dead_at is null) as "outboxPending",
          (select (extract(epoch from (now() - min(created_at))) * 1000)::bigint::int
             from ingest.broadcast_outbox where published_at is null and dead_at is null) as "outboxLagMs",
          (select count(*)::int from ingest.broadcast_outbox where dead_at is not null) as "outboxDead",
          exists(select 1 from pg_locks where locktype = 'advisory' and granted and objsubid = 1
                   and ((classid::bigint << 32) | objid::bigint) = hashtext(${WORKER_LOCK_KEY})::bigint) as "lockHeld",
          (select max(called_at) from ingest.provider_calls) as "lastCallAt",
          (select max(observed_at) from public.games) as "lastObservedAt",
          (select count(*)::int from ingest.ingestion_runs where status = 'running') as "runningRuns"`;
      if (!row) throw new Error('health query returned no row');
      return c.json({
        ok: true,
        mode: config.mode,
        db: 'ok',
        serverTime: row.now.toISOString(),
        outbox: { pending: row.outboxPending, lagMs: row.outboxLagMs, dead: row.outboxDead },
        worker: {
          lockHeld: row.lockHeld,
          runningRuns: row.runningRuns,
          lastTick: {
            providerCallAt: row.lastCallAt?.toISOString() ?? null,
            observedAt: row.lastObservedAt?.toISOString() ?? null,
          },
        },
      });
    } catch (err) {
      log.error({ err }, 'health: db unreachable');
      return c.json({ ok: false, mode: config.mode, db: 'unreachable' }, 503);
    }
  });

  /**
   * GET /v1/admin/quota: per-product quota (ingest.v_quota with QUOTA_* overrides applied),
   * reservations and used-vs-reserved per game. Admin bearer from env (ADMIN_BEARER_TOKEN):
   * 503 when none is configured, 401 without a bearer, 403 with the wrong one. Never exposes
   * the ingest schema to clients: this route runs with the service connection.
   */
  r.get('/v1/admin/quota', async (c) => {
    const { db, config, log } = c.get('deps');
    const expected = config.api.adminBearerToken;
    if (!expected) return c.json({ error: 'admin_disabled' }, 503);
    const header = c.req.header('authorization') ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (!m) return c.json({ error: 'unauthorized' }, 401);
    if (!constantTimeEqual(m[1] ?? '', expected)) return c.json({ error: 'forbidden' }, 403);
    const guard = new QuotaGuard({ db, log, overrides: config.quotaOverrides });
    const [products, reservations, calls] = await Promise.all([
      guard.status(),
      guard.reservations(),
      db<{ reservationId: string | null; calls: number; counted: number }[]>`
        select reservation_id::text as "reservationId", count(*)::int as calls,
               count(*) filter (where quota_counted)::int as counted
        from ingest.provider_calls group by reservation_id`,
    ]);
    const byReservation = new Map(calls.map((r) => [r.reservationId, r]));
    return c.json({
      serverTime: new Date().toISOString(),
      products: products.map((p) => ({ ...p, verifiedAt: p.verifiedAt?.toISOString() ?? null })),
      reservations: reservations.map((r) => ({
        id: r.id,
        product: r.product,
        gameId: r.gameId,
        profile: r.profile,
        source: r.source,
        runId: r.runId,
        reservedCalls: r.reservedCalls,
        usedCalls: r.usedCalls,
        providerCalls: byReservation.get(String(r.id))?.calls ?? 0,
        quotaCountedCalls: byReservation.get(String(r.id))?.counted ?? 0,
        createdAt: r.createdAt.toISOString(),
        releasedAt: r.releasedAt?.toISOString() ?? null,
      })),
    });
  });

  return r;
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}
