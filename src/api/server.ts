import { Hono } from 'hono';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import type { Logger } from '../logger.js';
import { changesRoutes } from './routes/changes.js';
import { healthRoutes } from './routes/health.js';
import { snapshotRoutes } from './routes/snapshot.js';

export interface AppDeps {
  db: Db;
  config: Config;
  log: Logger;
}

export type AppEnv = { Variables: { deps: AppDeps } };

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.set('deps', deps);
    const started = performance.now();
    await next();
    deps.log.debug(
      {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms: Math.round(performance.now() - started),
      },
      'request',
    );
  });

  app.route('/', healthRoutes());
  app.route('/', snapshotRoutes());
  app.route('/', changesRoutes());

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((err, c) => {
    deps.log.error({ err, path: c.req.path }, 'unhandled error');
    return c.json({ error: 'internal' }, 500);
  });

  return app;
}
