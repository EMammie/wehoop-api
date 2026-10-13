import postgres, { type Sql } from 'postgres';

export type SessionDb = Sql;

/**
 * A single, long-lived, session-mode connection. The worker uses it for exactly
 * two things that a transaction pooler cannot provide:
 *   1. the session-level advisory lock that guarantees one ingester, and
 *   2. LISTEN on the `outbox` channel.
 * `onclose` fires if the connection drops; the worker must stop and exit.
 */
export function createSessionDb(url: string, onClose: (err?: Error) => void): SessionDb {
  return postgres(url, {
    max: 1,
    idle_timeout: 0,
    max_lifetime: null,
    connect_timeout: 10,
    prepare: false,
    onclose: () => onClose(),
  });
}

export const WORKER_LOCK_KEY = 'wehoop-worker';

/** Try to take the single-ingester lock. Returns true if this process now holds it. */
export async function tryAcquireWorkerLock(sql: SessionDb): Promise<boolean> {
  const [row] = await sql<{ locked: boolean }[]>`
    select pg_try_advisory_lock(hashtext(${WORKER_LOCK_KEY})) as locked
  `;
  return row?.locked === true;
}
