import { Hono } from 'hono';
import { z } from 'zod';
import { WORKER_LOCK_KEY } from '../../db/session-client.js';
import { QuotaGuard } from '../../ingest/quota-guard.js';
import type { AppEnv } from '../server.js';

/** Alert thresholds (docs/DEPLOY.md "Alerts"). */
export const HEALTH_THRESHOLDS = {
  outboxLagMs: 30_000,
  watchWithoutCallMs: 5 * 60_000,
  pushDisconnectedMs: 60_000,
  consecutiveRegressions: 3,
} as const;

/** The push state a push_stream sub-run mirrors into its meta (src/ingest/trial-mode.ts). */
const PushRunMetaSchema = z.object({
  runId: z.string(),
  gameId: z.string().nullable(),
  push: z
    .record(
      z.string(),
      z
        .object({
          status: z.string(),
          disconnectedSince: z.iso.datetime({ offset: true }).nullable().optional(),
        })
        .loose(),
    )
    .nullable()
    .optional(),
});

export interface HealthFacts {
  now: Date;
  outboxPending: number;
  outboxLagMs: number | null;
  outboxDead: number;
  lockHeld: boolean;
  lastCallAt: Date | null;
  lastObservedAt: Date | null;
  runningRuns: number;
  /** Running root watches whose source makes provider calls (fixture replays make none). */
  runningWatches: number;
  pushRuns: unknown;
  /** Games whose newest 3 stale_observations rows of the last 24 h are all run_regresses_state (plan §4 rule 2). */
  regressingGames: string[];
}

/**
 * Alert conditions from the facts (pure, unit-tested): outbox lag > 30 s; dead
 * outbox rows; a running watch with no provider call for > 5 min; three
 * consecutive run_regresses_state rows for one game within 24 h (plan §4); a push stream
 * disconnected for > 60 s. Degraded keeps HTTP 200: Fly restarts only on 503,
 * which is reserved for an unreachable database.
 */
export function healthAlerts(f: HealthFacts): string[] {
  const alerts: string[] = [];
  if (f.outboxLagMs !== null && f.outboxLagMs > HEALTH_THRESHOLDS.outboxLagMs)
    alerts.push(
      `outbox_lag: oldest unpublished row is ${Math.round(f.outboxLagMs / 1000)} s old (> 30 s)`,
    );
  if (f.outboxDead > 0)
    alerts.push(`outbox_dead: ${f.outboxDead} dead-lettered row(s); run pnpm outbox requeue`);
  if (f.runningWatches > 0) {
    const age = f.lastCallAt === null ? null : f.now.getTime() - f.lastCallAt.getTime();
    if (age === null || age > HEALTH_THRESHOLDS.watchWithoutCallMs)
      alerts.push(
        `watch_without_provider_calls: ${f.runningWatches} running watch(es) but ${age === null ? 'no provider call ever' : `last provider call ${Math.round(age / 1000)} s ago`} (> 5 min)`,
      );
  }
  for (const gameId of f.regressingGames)
    alerts.push(
      `consecutive_regressions: game ${gameId} logged ${HEALTH_THRESHOLDS.consecutiveRegressions} run_regresses_state rows in a row; escape is pnpm game rebuild`,
    );
  const runs = z.array(PushRunMetaSchema).safeParse(f.pushRuns);
  if (runs.success) {
    for (const run of runs.data) {
      for (const [feed, st] of Object.entries(run.push ?? {})) {
        if (st.status === 'stopped' || !st.disconnectedSince) continue;
        const downMs = f.now.getTime() - Date.parse(st.disconnectedSince);
        if (downMs > HEALTH_THRESHOLDS.pushDisconnectedMs)
          alerts.push(
            `push_stream_disconnected: ${feed} of game ${run.gameId ?? '?'} (run ${run.runId}) down for ${Math.round(downMs / 1000)} s (> 60 s)`,
          );
      }
    }
  }
  return alerts;
}

/**
 * GET /health (plan §5): liveness + outbox lag, dead count, whether the
 * single-ingester lock is held, the last ingest tick (newest provider call
 * and newest game observation), push stream state, and `alerts` / `degraded`
 * from the thresholds above. Public, no secrets. 200 even when degraded; 503
 * only when the database is unreachable.
 */
export function healthRoutes() {
  const r = new Hono<AppEnv>();

  r.get('/health', async (c) => {
    const { db, config, log } = c.get('deps');
    try {
      const [row] = await db<HealthFacts[]>`
        select now() as now,
          (select count(*)::int from ingest.broadcast_outbox where published_at is null and dead_at is null) as "outboxPending",
          (select (extract(epoch from (now() - min(created_at))) * 1000)::bigint::int
             from ingest.broadcast_outbox where published_at is null and dead_at is null) as "outboxLagMs",
          (select count(*)::int from ingest.broadcast_outbox where dead_at is not null) as "outboxDead",
          exists(select 1 from pg_locks where locktype = 'advisory' and granted and objsubid = 1
                   and ((classid::bigint << 32) | objid::bigint) = hashtext(${WORKER_LOCK_KEY})::bigint) as "lockHeld",
          (select max(called_at) from ingest.provider_calls) as "lastCallAt",
          (select max(observed_at) from public.games) as "lastObservedAt",
          (select count(*)::int from ingest.ingestion_runs where status = 'running') as "runningRuns",
          (select count(*)::int from ingest.ingestion_runs
             where status = 'running' and kind in ('watch_game', 'replay') and source <> 'fixture') as "runningWatches",
          (select coalesce(json_agg(json_build_object('runId', id::text, 'gameId', game_id::text, 'push', meta->'push')), '[]'::json)
             from ingest.ingestion_runs where status = 'running' and kind = 'push_stream') as "pushRuns",
          (select coalesce(array_agg(game_id::text), '{}'::text[]) from (
             select game_id from (
               select game_id, reason, row_number() over (partition by game_id order by id desc) as rn
               from ingest.stale_observations
               where created_at > now() - interval '24 hours') s
             where rn <= ${HEALTH_THRESHOLDS.consecutiveRegressions}
             group by game_id
             having count(*) = ${HEALTH_THRESHOLDS.consecutiveRegressions} and bool_and(reason = 'run_regresses_state')) g) as "regressingGames"`;
      if (!row) throw new Error('health query returned no row');
      const alerts = healthAlerts(row);
      const pushRuns = z.array(PushRunMetaSchema).safeParse(row.pushRuns);
      return c.json({
        ok: true,
        mode: config.mode,
        db: 'ok',
        degraded: alerts.length > 0,
        alerts,
        serverTime: row.now.toISOString(),
        outbox: { pending: row.outboxPending, lagMs: row.outboxLagMs, dead: row.outboxDead },
        worker: {
          lockHeld: row.lockHeld,
          runningRuns: row.runningRuns,
          runningWatches: row.runningWatches,
          lastTick: {
            providerCallAt: row.lastCallAt?.toISOString() ?? null,
            observedAt: row.lastObservedAt?.toISOString() ?? null,
          },
          regressingGames: row.regressingGames,
        },
        push: pushRuns.success
          ? pushRuns.data.map((p) => ({ runId: p.runId, gameId: p.gameId, streams: p.push ?? {} }))
          : [],
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
