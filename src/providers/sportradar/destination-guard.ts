import type { Logger } from '../../logger.js';

/**
 * Demo-mode destination guard (plan rev 4.15 (4)): in a demo process every
 * provider request must go to the in-process demo host, so a misconfiguration
 * can never fall back to api.sportradar.com. The lock is process-wide and
 * one-way: `lockDestination(origin)` is called by `createResolver` for
 * MODE=demo (and by `pnpm demo run` before the worker starts), and from then
 * on `SportradarHttp.getJson` and `PushStream` refuse, before any network
 * I/O, a URL whose origin is anything else, however the resolver that built
 * it was made. A refused request is not a provider call: nothing is sent and
 * nothing is written to `ingest.provider_calls`.
 */
export class DestinationRefusedError extends Error {
  constructor(
    /** Origin of the refused URL (scheme://host:port; never a path, query or key). */
    readonly origin: string,
    readonly allowedOrigin: string,
  ) {
    super(
      `demo mode: refused a provider request to ${origin}; only the demo host ${allowedOrigin} is allowed`,
    );
  }
}

let locked: string | null = null;

/** `scheme://host:port` of a URL; `<unparseable>` when it is not one (also refused). */
export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '<unparseable>';
  }
}

/** Restrict every provider request of this process to `url`'s origin. Locking to a second origin throws. */
export function lockDestination(url: string): void {
  const origin = originOf(url);
  if (origin === '<unparseable>' || origin === 'null') {
    throw new Error(`demo mode: cannot lock provider requests to ${url}`);
  }
  if (locked !== null && locked !== origin) {
    throw new Error(
      `demo mode: provider requests are already locked to ${locked}; refusing to re-lock to ${origin}`,
    );
  }
  locked = origin;
}

/** The locked origin, or null when this process is not in demo mode. */
export function lockedDestination(): string | null {
  return locked;
}

/**
 * Throw DestinationRefusedError (and log it) when a lock is in place and `url` is elsewhere.
 * `allowed` overrides the process lock (unit tests); null/undefined = use the lock.
 */
export function assertDestination(url: string, log?: Logger, allowed?: string | null): void {
  const allowedOrigin = allowed === undefined || allowed === null ? locked : originOf(allowed);
  if (allowedOrigin === null) return;
  const origin = originOf(url);
  if (origin === allowedOrigin) return;
  const err = new DestinationRefusedError(origin, allowedOrigin);
  log?.error({ origin, allowedOrigin }, err.message);
  throw err;
}

/** Tests only: drop the process lock so one test file can exercise several configurations. */
export function unlockDestinationForTests(): void {
  locked = null;
}
