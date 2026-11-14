import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/server.js';
import { loadConfig } from '../../src/config.js';
import { endRun, startRun } from '../../src/ingest/runs.js';
import { requeueDead } from '../../src/live/outbox-admin.js';
import { OutboxPublisher } from '../../src/live/outbox-publisher.js';
import { MemoryTransport } from '../../src/live/transport.js';
import {
  apply,
  observation,
  pbpQ1,
  replayRun,
  seedGame,
  silentLog,
  testDb,
} from '../helpers/db.js';

/**
 * GET /health and GET /v1/admin/quota (plan §5): outbox lag, dead count, lock
 * held, last tick; quota per product and reservations behind the admin bearer
 * (503 unconfigured, 401 missing, 403 wrong). Anonymous clients never see the
 * ingest schema through these routes: the admin route needs the bearer.
 */
const db = testDb();
const TOKEN = `test-admin-${randomUUID()}`;
const withAdmin = createApp({
  db,
  config: loadConfig({
    ...process.env,
    MODE: 'sim',
    ADMIN_BEARER_TOKEN: TOKEN,
    QUOTA_NCAAWB: '1000/100',
  }),
  log: silentLog,
});
const withoutAdmin = createApp({
  db,
  config: loadConfig({ ...process.env, MODE: 'sim', ADMIN_BEARER_TOKEN: '' }),
  log: silentLog,
});

beforeAll(async () => {
  await db`select 1`;
});
afterAll(async () => {
  await db.end();
});

describe('GET /health', () => {
  it('reports outbox lag, dead count, lock held and the last tick', async () => {
    const res = await withAdmin.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, mode: 'sim', db: 'ok' });
    const outbox = body.outbox as Record<string, unknown>;
    expect(typeof outbox.pending).toBe('number');
    expect(typeof outbox.dead).toBe('number');
    expect(outbox.lagMs === null || typeof outbox.lagMs === 'number').toBe(true);
    const worker = body.worker as Record<string, unknown>;
    expect(typeof worker.lockHeld).toBe('boolean');
    expect(typeof worker.runningRuns).toBe('number');
    const tick = worker.lastTick as Record<string, unknown>;
    expect('providerCallAt' in tick && 'observedAt' in tick).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/key|token|secret/i);
    expect(Array.isArray(body.alerts)).toBe(true);
    expect(typeof body.degraded).toBe('boolean');
    expect(Array.isArray(body.push)).toBe(true);
  });

  it('degraded (dead outbox row, push stream down > 60 s) stays HTTP 200 with the alerts listed', async () => {
    const nd = pbpQ1();
    const { gameId } = await seedGame(db, nd);
    const run = await replayRun(db, gameId);
    await apply({ db, log: silentLog }, gameId, nd, observation(run, nd, new Date()));
    await new OutboxPublisher({ db, log: silentLog, transport: new MemoryTransport() }).drain();
    await db`update ingest.broadcast_outbox set published_at = null, dead_at = now(), attempts = 10
             where game_id = ${gameId} and seq = 1`;
    const sub = await startRun(db, {
      kind: 'push_stream',
      league: 'wnba',
      gameId,
      source: 'fixture',
      parentRunId: run.id,
      meta: {
        push: {
          push_events: {
            status: 'backoff',
            disconnectedSince: new Date(Date.now() - 120_000).toISOString(),
          },
        },
      },
    });
    try {
      const res = await withAdmin.request('/health');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { degraded: boolean; alerts: string[]; push: unknown[] };
      expect(body.degraded).toBe(true);
      expect(body.alerts.some((a) => a.startsWith('outbox_dead'))).toBe(true);
      expect(
        body.alerts.some((a) =>
          a.startsWith(`push_stream_disconnected: push_events of game ${gameId}`),
        ),
      ).toBe(true);
      expect(body.push.length).toBeGreaterThanOrEqual(1);
    } finally {
      await endRun(db, sub.id, 'aborted');
      await requeueDead(db, { gameId });
      await new OutboxPublisher({ db, log: silentLog, transport: new MemoryTransport() }).drain();
    }
  });
});

describe('GET /v1/admin/quota', () => {
  it('503 when no admin bearer is configured', async () => {
    expect((await withoutAdmin.request('/v1/admin/quota')).status).toBe(503);
  });
  it('401 without a bearer, 403 with the wrong one', async () => {
    expect((await withAdmin.request('/v1/admin/quota')).status).toBe(401);
    expect(
      (await withAdmin.request('/v1/admin/quota', { headers: { authorization: 'Bearer nope' } }))
        .status,
    ).toBe(403);
    expect(
      (await withAdmin.request('/v1/admin/quota', { headers: { authorization: `Basic ${TOKEN}` } }))
        .status,
    ).toBe(401);
  });
  it('200 with the admin bearer: products from v_quota (overrides applied) and reservations', async () => {
    const res = await withAdmin.request('/v1/admin/quota', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      products: Array<Record<string, unknown>>;
      reservations: Array<Record<string, unknown>>;
    };
    const ncaawb = body.products.find((p) => p.product === 'ncaawb');
    expect(ncaawb).toMatchObject({ limit30d: 1000, reserve: 100, overridden: true });
    expect(typeof ncaawb?.used30d).toBe('number');
    expect(typeof ncaawb?.reserved).toBe('number');
    expect(typeof ncaawb?.spendable).toBe('number');
    expect(Array.isArray(body.reservations)).toBe(true);
    for (const r of body.reservations) {
      expect(typeof r.reservedCalls).toBe('number');
      expect(typeof r.usedCalls).toBe('number');
      expect(typeof r.providerCalls).toBe('number');
    }
  });
});
