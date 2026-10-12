import { Hono } from 'hono';
import type { AppEnv } from '../server.js';

/**
 * GET /health
 * Liveness + a cheap readiness probe. M4 extends this with outbox lag, dead
 * count, worker lock holder, and last ingest tick.
 */
export function healthRoutes() {
  const r = new Hono<AppEnv>();

  r.get('/health', async (c) => {
    const { db, config } = c.get('deps');
    try {
      const [row] = await db<{ now: Date }[]>`select now() as now`;
      return c.json({
        ok: true,
        mode: config.mode,
        db: 'ok',
        serverTime: row?.now.toISOString() ?? null,
      });
    } catch (err) {
      c.get('deps').log.error({ err }, 'health: db unreachable');
      return c.json({ ok: false, mode: config.mode, db: 'unreachable' }, 503);
    }
  });

  return r;
}
