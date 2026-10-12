import { loadConfig } from '../config.js';
import { createSessionDb, tryAcquireWorkerLock } from '../db/session-client.js';
import { createLogger } from '../logger.js';

/**
 * Ingestion worker entry point.
 * M0: acquires the single-ingester advisory lock on a session-mode connection
 * and exits if the connection drops. M1 adds the simulation replay loop,
 * applyChanges, the outbox publisher, and the pulse sender.
 */
async function main() {
  const config = loadConfig();
  const log = createLogger({ level: config.logLevel });

  let shuttingDown = false;
  const shutdown = (reason: string, code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ reason }, 'worker stopping');
    // Lock is released by the server when the session closes.
    process.exit(code);
  };

  const session = createSessionDb(config.db.sessionUrl, () => {
    if (!shuttingDown) {
      log.error('session connection lost; stopping ingestion');
      shutdown('session_connection_lost', 1);
    }
  });

  const locked = await tryAcquireWorkerLock(session);
  if (!locked) {
    shuttingDown = true; // closing our own session must not look like a lost connection
    log.error('another worker holds the ingester lock; exiting');
    await session.end({ timeout: 2 });
    process.exit(2);
  }
  log.info({ mode: config.mode }, 'worker lock acquired');

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => shutdown(signal));
  }

  // M1 replaces this idle loop with the scheduler / replay runner.
  await new Promise<void>(() => {
    /* run until signalled */
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
