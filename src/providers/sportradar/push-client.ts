import type { Db } from '../../db/client.js';
import {
  countsTowardQuota,
  needsRateLimit,
  type QuotaGuard,
  QuotaRefusedError,
} from '../../ingest/quota-guard.js';
import type { LeagueCode } from '../../leagues/codes.js';
import type { Logger } from '../../logger.js';
import { claimSlot, type RateLimiter } from './rate-limiter.js';
import {
  type PushClockMessage,
  PushClockMessageSchema,
  type PushEventMessage,
  PushEventMessageSchema,
  PushHeartbeatSchema,
} from './schemas/push.js';
import { type PushFeed, type PushParams, type PushUrlResolver, redactUrl } from './urls.js';

/**
 * Sportradar push client (plan §4 "Push client"). One `PushStream` per feed
 * (`push_events`, `push_clock`, `push_statistics`): a chunked `fetch`, the body
 * consumed as an async iterator, split on newlines (a line may span chunks),
 * every line Zod-parsed against the `PushLineSchema` members. Unknown line shapes are logged
 * and skipped, never thrown. Any 15 s without a byte (heartbeats count) trips
 * the watchdog, which aborts the request; a disconnect or watchdog trip goes
 * through a jittered exponential backoff between 1 s and 30 s and reconnects;
 * on every reconnect `onReconnect` is called (the worker's `backfill(gameId)`).
 *
 * Accounting mirrors `SportradarHttp`: one `ingest.provider_calls` row per
 * connection attempt (`feed` = the push feed, `quota_counted` only for trial /
 * production, never for a loopback rehearsal), a rate-limiter slot claimed per
 * connection, and the quota guard consulted first for rate-limited sources.
 */

export type PushLine =
  | { kind: 'heartbeat'; interval: number }
  | { kind: 'event'; message: PushEventMessage }
  | { kind: 'clock'; message: PushClockMessage };

/** Zod-parse one decoded line; null when the shape is not one we know (caller logs and skips). */
export function classifyPushLine(json: unknown): PushLine | null {
  const hb = PushHeartbeatSchema.safeParse(json);
  if (hb.success) return { kind: 'heartbeat', interval: hb.data.heartbeat.interval };
  const clock = PushClockMessageSchema.safeParse(json);
  if (clock.success) return { kind: 'clock', message: clock.data };
  const event = PushEventMessageSchema.safeParse(json);
  if (event.success) return { kind: 'event', message: event.data };
  return null;
}

export type PushStreamStatus = 'idle' | 'connecting' | 'connected' | 'backoff' | 'stopped';

export interface PushStreamState {
  feed: PushFeed;
  status: PushStreamStatus;
  /** Connection attempts that reached the connected state. */
  connections: number;
  /** Connections after the first one (each triggers `onReconnect`). */
  reconnects: number;
  /** Connection attempts (incl. failed ones). */
  attempts: number;
  lines: number;
  heartbeats: number;
  /** Lines that were not JSON or not a known push shape (logged, skipped). */
  skipped: number;
  /** Lines whose handler threw (logged, stream kept). */
  handlerErrors: number;
  bytes: number;
  connectedAt: Date | null;
  lastByteAt: Date | null;
  lastHeartbeatAt: Date | null;
  /** When the current outage began; null while connected. */
  disconnectedSince: Date | null;
  lastError: string | null;
  /** Watchdog trips (no bytes for `watchdogMs`). */
  watchdogTrips: number;
  /** Slots abandoned because the send would have left more than PUSH_SEND_TOLERANCE_MS late. */
  slotReclaims: number;
}

export interface PushStreamDeps {
  /** Null only for DB-free unit tests; a quota-counted source always needs the ledger. */
  db: Db | null;
  log: Logger;
  resolver: PushUrlResolver;
  league: LeagueCode;
  /** Sportradar product (quota bucket); defaults to the league code. */
  product?: string;
  runId: number | null;
  reservationId?: number | null;
  /** Required for trial / production / rehearsal sources, like every other call. */
  limiter?: RateLimiter;
  guard?: QuotaGuard;
  feed: PushFeed;
  params?: PushParams;
  fetchImpl?: typeof fetch;
  /** Called for every parsed line with its receipt time (push `observedAt`). Errors are logged, never fatal. */
  onLine: (line: PushLine, receivedAt: Date) => Promise<void> | void;
  /**
   * Called after every reconnection (connection 2, 3, ...); `downMs` is the outage length and
   * `reconnectedAt` the moment the new connection answered: the database `now()` read once the
   * response headers arrived when the stream has a database (so it compares with
   * `provider_calls.called_at`, the slot on the database clock), the local clock otherwise;
   * `null` when the stream has a database but the read failed (the moment is unknown on the
   * database clock, so the caller must not use it to skip a backfill).
   */
  onReconnect?: (info: {
    connections: number;
    downMs: number;
    reconnectedAt: Date | null;
  }) => Promise<void> | void;
  onStateChange?: (state: PushStreamState) => void;
  watchdogMs?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  /**
   * Connection attempts this stream may still make, shared with the other streams of one watch
   * (PUSH_CONNECTION_ALLOWANCE): every attempt decrements it; at zero the stream stops for good
   * (status `stopped`, `lastError` says why) and the REST cadence stays in charge.
   */
  attemptBudget?: { remaining: number };
  random?: () => number;
  now?: () => number;
  /** Local sleep (tests drive a fake clock through it); default setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** The database clock (tests stub it); default `select now()` when the stream has a database. */
  dbNow?: () => Promise<Date>;
}

/**
 * A push connection must leave on its slot. If it would leave later than this after the slot
 * (timer lateness, an event-loop stall, a slow claim round trip), the slot is abandoned and a new
 * one claimed: a late send can land on the NEXT holder's slot and draw a 429 even though the
 * recorded slots are correctly spaced (validator M4 §2e: a push_clock send 1.206 s after its slot,
 * 1 ms before a REST pbp).
 */
export const PUSH_SEND_TOLERANCE_MS = 200;
/** Re-claims per connection attempt before sending anyway (logged). */
export const PUSH_MAX_SLOT_RECLAIMS = 4;

export const PUSH_WATCHDOG_MS = 15_000;
/** A single NDJSON line longer than this is a broken stream, not a message: abort and reconnect. */
export const PUSH_MAX_LINE_BYTES = 1024 * 1024;
export const PUSH_BACKOFF_MIN_MS = 1_000;
export const PUSH_BACKOFF_MAX_MS = 30_000;

/** Jittered exponential backoff: `min * 2^(failures-1)`, scaled by [0.5, 1.5), clamped to [min, max]. */
export function backoffDelayMs(
  consecutiveFailures: number,
  random: () => number,
  minMs = PUSH_BACKOFF_MIN_MS,
  maxMs = PUSH_BACKOFF_MAX_MS,
): number {
  const base = minMs * 2 ** Math.max(0, consecutiveFailures - 1);
  const jittered = base * (0.5 + random());
  return Math.round(Math.min(maxMs, Math.max(minMs, jittered)));
}

export class PushStream {
  readonly state: PushStreamState;
  private stopped = false;
  private controller: AbortController | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private wakeBackoff: (() => void) | null = null;
  private consecutiveFailures = 0;
  private hooks: Promise<void>[] = [];
  private running: Promise<void> | null = null;
  readonly product: string;

  constructor(private readonly deps: PushStreamDeps) {
    const source = deps.resolver.source;
    if (deps.db === null && countsTowardQuota(source)) {
      throw new Error('PushStream for a quota-counted source needs the database (provider_calls)');
    }
    if (needsRateLimit(source) && (!deps.limiter || !deps.guard)) {
      throw new Error(`PushStream for a ${source} source needs a RateLimiter and a QuotaGuard`);
    }
    if (needsRateLimit(source) && deps.db !== null && !deps.limiter?.shared) {
      throw new Error(
        'rate-limited sources must claim slots from ingest.provider_rate_slots (rateLimiterFor(product, { db }))',
      );
    }
    this.product = deps.product ?? deps.league;
    this.state = {
      feed: deps.feed,
      status: 'idle',
      connections: 0,
      reconnects: 0,
      attempts: 0,
      lines: 0,
      heartbeats: 0,
      skipped: 0,
      handlerErrors: 0,
      bytes: 0,
      connectedAt: null,
      lastByteAt: null,
      lastHeartbeatAt: null,
      disconnectedSince: null,
      lastError: null,
      watchdogTrips: 0,
      slotReclaims: 0,
    };
  }

  get source() {
    return this.deps.resolver.source;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private setStatus(status: PushStreamStatus) {
    this.state.status = status;
    this.deps.onStateChange?.(this.state);
  }

  /** Connect and keep reconnecting until `stop()`. Resolves once stopped. */
  start(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.loop();
    return this.running;
  }

  /** Abort the current connection, cancel any backoff, wait for the loop and the reconnect hooks. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.clearWatchdog();
    this.controller?.abort(new Error('push stream stopped'));
    this.wakeBackoff?.();
    await this.running;
    await Promise.allSettled(this.hooks);
    this.setStatus('stopped');
  }

  private clearWatchdog() {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  private resetWatchdog(controller: AbortController) {
    this.clearWatchdog();
    const ms = this.deps.watchdogMs ?? PUSH_WATCHDOG_MS;
    this.watchdog = setTimeout(() => {
      this.state.watchdogTrips++;
      this.deps.log.warn({ feed: this.deps.feed, watchdogMs: ms }, 'push watchdog: no bytes');
      controller.abort(new Error(`push watchdog: no bytes for ${ms} ms`));
    }, ms);
  }

  private async loop(): Promise<void> {
    const { log, feed } = this.deps;
    const { url, headers } = this.deps.resolver.resolvePush(feed, this.deps.params ?? {});
    const source = this.deps.resolver.source;
    const limited = needsRateLimit(source);
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    while (!this.stopped) {
      const budget = this.deps.attemptBudget;
      if (budget && budget.remaining <= 0) {
        this.state.lastError = 'connection allowance exhausted; REST reconciliation continues';
        log.error(
          { feed, attempts: this.state.attempts },
          'push stream stopped: connection allowance exhausted',
        );
        break;
      }
      if (budget) budget.remaining--;
      this.state.attempts++;
      this.setStatus('connecting');
      const controller = new AbortController();
      this.controller = controller;
      let callId: number | null = null;
      let status = 0;
      let bytesThisConnection = 0;
      let linesThisConnection = 0;
      /** Set once the request is sent: a failed attempt is still a provider call (status null). */
      let requestedAt: Date | null = null;
      const started = performance.now();
      try {
        if (limited && this.deps.guard) {
          try {
            await this.deps.guard.assertCall(this.product, source, this.deps.reservationId ?? null);
          } catch (err) {
            if (err instanceof QuotaRefusedError) {
              // No budget: retrying every 30 s would only repeat the refusal; REST decides when to stop.
              this.state.lastError = err.message.slice(0, 500);
              log.error({ feed, reason: err.reason }, 'push stream stopped: quota refused');
              this.stopped = true;
              break;
            }
            throw err;
          }
        }
        // Every awaited step (guard above, slot claim) is done; nothing awaited sits between the
        // slot and the send.
        const slotAt = limited ? await this.acquireSlot() : new Date(this.now());
        if (this.stopped) break;
        requestedAt = slotAt;
        // Connection phase is covered by the same watchdog: a host that accepts and never answers trips it.
        this.resetWatchdog(controller);
        const res = await fetchImpl(url, {
          headers: { accept: 'application/json', ...headers },
          signal: controller.signal,
        });
        status = res.status;
        // Only a reconnect needs the moment (one database round trip per reconnect).
        const reconnectedAt = this.state.connections >= 1 ? await this.clockNow() : null;
        callId = await this.logCall(
          url,
          status,
          Math.round(performance.now() - started),
          requestedAt,
        );
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`sportradar ${feed} -> HTTP ${res.status}: ${text.slice(0, 200)}`);
        }
        if (!res.body) throw new Error(`sportradar ${feed}: response has no body`);
        const downMs =
          this.state.disconnectedSince === null
            ? 0
            : this.now() - this.state.disconnectedSince.getTime();
        this.state.connections++;
        this.state.connectedAt = new Date(this.now());
        this.state.disconnectedSince = null;
        this.state.lastError = null;
        // consecutiveFailures resets only once this connection delivers a line: a host that
        // accepts and closes immediately keeps backing off instead of reconnecting every second.
        this.setStatus('connected');
        log.info(
          { feed, connections: this.state.connections, downMs, status },
          this.state.connections === 1 ? 'push stream connected' : 'push stream reconnected',
        );
        if (this.state.connections > 1) {
          this.state.reconnects++;
          const hook = this.deps.onReconnect;
          if (hook) {
            const p = Promise.resolve()
              .then(() =>
                hook({
                  connections: this.state.connections,
                  downMs,
                  reconnectedAt,
                }),
              )
              .catch((err) => log.error({ err, feed }, 'push reconnect hook (backfill) failed'));
            this.hooks.push(p);
            void p.finally(() => {
              this.hooks = this.hooks.filter((h) => h !== p);
            });
          }
        }
        this.resetWatchdog(controller);
        const decoder = new TextDecoder();
        let buffer = '';
        for await (const chunk of res.body) {
          const receivedAt = new Date(this.now());
          bytesThisConnection += chunk.byteLength;
          this.state.bytes += chunk.byteLength;
          this.state.lastByteAt = receivedAt;
          this.resetWatchdog(controller);
          buffer += decoder.decode(chunk, { stream: true });
          if (buffer.length > PUSH_MAX_LINE_BYTES) {
            throw new Error(
              `sportradar ${feed}: push line too long (${buffer.length} bytes without a newline)`,
            );
          }
          let nl = buffer.indexOf('\n');
          while (nl >= 0) {
            const raw = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            if (raw.trim()) {
              linesThisConnection++;
              if (linesThisConnection === 1) this.consecutiveFailures = 0;
            }
            // The handler may wait on the database; that is not the provider going silent.
            this.clearWatchdog();
            await this.handleLine(raw, receivedAt);
            if (!controller.signal.aborted) this.resetWatchdog(controller);
            nl = buffer.indexOf('\n');
          }
        }
        const tail = buffer + decoder.decode();
        if (tail.trim()) await this.handleLine(tail, new Date(this.now()));
        throw new Error(`sportradar ${feed}: stream ended`);
      } catch (err) {
        this.clearWatchdog();
        if (this.stopped) break;
        const message = (err as Error).message.slice(0, 500);
        this.consecutiveFailures++;
        this.state.lastError = message;
        if (this.state.disconnectedSince === null)
          this.state.disconnectedSince = new Date(this.now());
        const delay = backoffDelayMs(
          this.consecutiveFailures,
          this.deps.random ?? Math.random,
          this.deps.backoffMinMs ?? PUSH_BACKOFF_MIN_MS,
          this.deps.backoffMaxMs ?? PUSH_BACKOFF_MAX_MS,
        );
        this.setStatus('backoff');
        log.warn(
          { feed, err: message, failures: this.consecutiveFailures, retryInMs: delay, status },
          'push stream disconnected; backing off',
        );
        await this.sleepInterruptible(delay);
      } finally {
        // A request that never got an answer (watchdog on connect, socket/TLS error, stop
        // mid-connect) is still a provider call: log it with a null status, like SportradarHttp.
        if (callId === null && requestedAt !== null) {
          callId = await this.logCall(url, 0, Math.round(performance.now() - started), requestedAt);
        }
        if (callId !== null) await this.updateCallBytes(callId, bytesThisConnection);
        if (this.controller === controller) this.controller = null;
      }
    }
    this.setStatus('stopped');
  }

  /**
   * Claim a slot straight from the shared ledger and leave on it. A connection attempt has no
   * deadline of its own, so a send that would leave more than PUSH_SEND_TOLERANCE_MS after its
   * slot (a late timer, a slow claim) gives that slot up and claims a new one, up to
   * PUSH_MAX_SLOT_RECLAIMS times; RateLimiter.waitForSlot() has no re-claim, which is why it is not
   * used here. The ledger alone serializes claimants across every process (and, since plan rev 4.8,
   * waitForSlot chains this process's claims too); the wait is the ledger's delay (database clock).
   */
  private async acquireSlot(): Promise<Date> {
    const limiter = this.deps.limiter;
    if (!limiter) return new Date(this.now());
    const store = limiter.slotStore;
    if (!store || limiter.product === null) return new Date(await limiter.waitForSlot());
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let attempt = 0; ; attempt++) {
      const claim = await claimSlot(store, limiter.product, limiter.minIntervalMs);
      const sendAt = this.now() + Math.max(0, claim.delayMs);
      for (let t = this.now(); t < sendAt && !this.stopped; t = this.now()) await sleep(sendAt - t);
      const lateMs = this.now() - sendAt;
      if (lateMs <= PUSH_SEND_TOLERANCE_MS || attempt >= PUSH_MAX_SLOT_RECLAIMS || this.stopped) {
        if (lateMs > PUSH_SEND_TOLERANCE_MS)
          this.deps.log.warn(
            { feed: this.deps.feed, lateMs, attempt },
            'push send late after the maximum re-claims; sending',
          );
        return claim.slotAt;
      }
      this.state.slotReclaims++;
      this.deps.log.warn(
        { feed: this.deps.feed, lateMs, slotAt: claim.slotAt.toISOString(), attempt },
        'push send would leave late after its slot; claiming a new slot',
      );
    }
  }

  /**
   * The reconnect moment on the clock `provider_calls.called_at` uses: the database clock when the
   * stream has a database, the local clock otherwise. `null` when the database read fails: the
   * local clock is not a substitute, because a skewed process clock could place the reconnect
   * before a pbp request that actually followed it and skip a backfill the gap needed.
   */
  private async clockNow(): Promise<Date | null> {
    const { db, dbNow } = this.deps;
    if (!dbNow && db === null) return new Date(this.now());
    try {
      if (dbNow) return await dbNow();
      if (db === null) return null;
      const [row] = await db<{ now: Date }[]>`select now() as now`;
      return row?.now ?? null;
    } catch (err) {
      this.deps.log.warn({ err, feed: this.deps.feed }, 'reconnect: database clock read failed');
      return null;
    }
  }

  private async handleLine(raw: string, receivedAt: Date): Promise<void> {
    const text = raw.trim();
    if (!text) return;
    this.state.lines++;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      this.state.skipped++;
      this.deps.log.warn(
        { feed: this.deps.feed, snippet: text.slice(0, 120) },
        'push line not JSON',
      );
      return;
    }
    const line = classifyPushLine(json);
    if (line === null) {
      this.state.skipped++;
      const keys = typeof json === 'object' && json !== null ? Object.keys(json) : typeof json;
      this.deps.log.warn({ feed: this.deps.feed, keys }, 'push line of unknown shape skipped');
      return;
    }
    if (line.kind === 'heartbeat') {
      this.state.heartbeats++;
      this.state.lastHeartbeatAt = receivedAt;
    }
    try {
      await this.deps.onLine(line, receivedAt);
    } catch (err) {
      this.state.handlerErrors++;
      this.deps.log.error(
        { err, feed: this.deps.feed, kind: line.kind },
        'push line handler failed',
      );
    }
  }

  private sleepInterruptible(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        this.wakeBackoff = null;
        resolve();
      }, ms);
      this.wakeBackoff = () => {
        clearTimeout(t);
        this.wakeBackoff = null;
        resolve();
      };
    });
  }

  private async logCall(
    url: string,
    status: number,
    durationMs: number,
    calledAt: Date,
  ): Promise<number | null> {
    if (this.deps.db === null) return null;
    const source = this.deps.resolver.source;
    const reservationId = this.deps.reservationId ?? null;
    try {
      const [row] = await this.deps.db<{ id: string }[]>`
        insert into ingest.provider_calls
          (run_id, source, product, league, feed, url, status, duration_ms, bytes, quota_counted,
           called_at, reservation_id)
        values (${this.deps.runId}, ${source}, ${this.product}, ${this.deps.league}, ${this.deps.feed},
                ${redactUrl(url)}, ${status || null}, ${durationMs}, 0, ${countsTowardQuota(source)},
                ${calledAt}, ${reservationId})
        returning id::text`;
      if (reservationId !== null && this.deps.guard) await this.deps.guard.recordUse(reservationId);
      return row ? Number(row.id) : null;
    } catch (err) {
      this.deps.log.error({ err, feed: this.deps.feed }, 'provider_calls insert failed');
      return null;
    }
  }

  private async updateCallBytes(id: number, bytes: number): Promise<void> {
    if (this.deps.db === null) return;
    try {
      await this.deps.db`update ingest.provider_calls set bytes = ${bytes} where id = ${id}`;
    } catch (err) {
      this.deps.log.error({ err, feed: this.deps.feed }, 'provider_calls bytes update failed');
    }
  }
}
