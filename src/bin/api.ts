import { serve } from '@hono/node-server';
import { createApp } from '../api/server.js';
import { loadConfig } from '../config.js';
import { createDb } from '../db/client.js';
import { createLogger } from '../logger.js';

const config = loadConfig();
const log = createLogger({ level: config.logLevel });
const db = createDb(config.db.url);
const app = createApp({ db, config, log });

const server = serve({ fetch: app.fetch, port: config.api.port }, (info) => {
  log.info({ port: info.port, mode: config.mode }, 'api listening');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    log.info({ signal }, 'api shutting down');
    server.close();
    await db.end({ timeout: 5 });
    process.exit(0);
  });
}
