import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readRecording } from '../../ingest/recording.js';
import type { Logger } from '../../logger.js';
import { buildPushTimelines, type PushTimelines, type TimedLine } from './fake-push.js';
import { SummaryDocumentSchema } from './schemas/summary.js';
import type { Feed } from './urls.js';

/**
 * A local stand-in for api.sportradar.com used to rehearse the trial flow
 * without a key, a live game, or quota (plan §7 M3; the live-run acceptance
 * rows are NOT RUN until November). It serves a recorded replay file
 * (`pnpm sim record` / `pnpm sim compact` output) over the production URL
 * shape, time-scaled: the document returned for a feed is the newest one whose
 * recorded offset from the first document is <= elapsed * speed.
 *
 * It enforces what the real host enforces, so the evidence is about our side:
 *   - 401 without an `x-api-key` header (any value is accepted; the value is never logged);
 *   - 429 when two accepted requests arrive closer than `minSpacingMs` (default 1 s),
 *     which is what a missing RateLimiter would produce against a trial key.
 * The season schedule feed is synthesized from the recording's first summary
 * (one game, its real coverage and teams) so `pnpm trial plan` can be rehearsed.
 *
 * M4: the push streams `/{league}/{access}/stream/en/{events|clock}/subscribe`
 * replay the recording's pbp deltas as chunked NDJSON lines (fake-push.ts),
 * time-scaled with the same `speed`, with a heartbeat line every `heartbeatMs`.
 * A connection receives only lines whose offset is AFTER the moment it
 * connected (a real stream has no history), so whatever a client misses while
 * disconnected is recoverable only by its REST backfill. Fault switch for the
 * acceptance test: `pushDrop` closes every open push socket and refuses push
 * connections (socket reset) for `forMs` starting `afterMs` after start
 * (repeating every `everyMs` when set); `POST /_fault/push-drop?for=<ms>`
 * starts a window on demand. The statistics stream is not mocked (no recorded
 * sample to pin its shape): it answers 404.
 */
export interface FakeProviderOptions {
  replayFile: string;
  /** Time scale: 60 = one recorded hour per minute. */
  speed: number;
  port?: number;
  host?: string;
  minSpacingMs?: number;
  requireKey?: boolean;
  log?: Logger;
  now?: () => number;
  /** Heartbeat line interval on the push streams (default 5000 ms, as the recorded sample announces). */
  heartbeatMs?: number;
  /** Push fault: refuse / cut push connections for `forMs`, first at `afterMs`, then every `everyMs`. */
  pushDrop?: { afterMs: number; forMs: number; everyMs?: number };
}

export interface FakeProviderStats {
  requests: number;
  served: number;
  rejected401: number;
  rejected429: number;
  byFeed: Record<string, number>;
  /** Push connections accepted (per feed in byFeed as push_events / push_clock). */
  pushConnections: number;
  /** Push connections refused or cut by the drop fault. */
  pushDrops: number;
  pushLinesSent: number;
  pushHeartbeatsSent: number;
}

export interface FakeProvider {
  url: string;
  port: number;
  providerGameId: string;
  documents: number;
  /** Push lines derived from the recording (events incl. deletes, clock lines). */
  pushLines: { events: number; clocks: number };
  stats: FakeProviderStats;
  /** Start a push outage now (what POST /_fault/push-drop does). */
  dropPush(forMs: number): void;
  close(): Promise<void>;
}

interface TimedDocument {
  offsetMs: number;
  body: unknown;
}

export async function startFakeProvider(opts: FakeProviderOptions): Promise<FakeProvider> {
  const docs: Record<'pbp' | 'summary' | 'boxscore', TimedDocument[]> = {
    pbp: [],
    summary: [],
    boxscore: [],
  };
  let first: number | null = null;
  let total = 0;
  let firstSummary: unknown = null;
  for await (const line of readRecording(opts.replayFile)) {
    const feed = line.feed as Feed;
    if (feed !== 'pbp' && feed !== 'summary' && feed !== 'boxscore') continue;
    const t = Date.parse(line.requestedAt);
    if (first === null) first = t;
    docs[feed].push({ offsetMs: t - first, body: line.body });
    if (feed === 'summary' && firstSummary === null) firstSummary = line.body;
    total++;
  }
  if (total === 0 || first === null) throw new Error(`${opts.replayFile}: no game documents`);
  for (const list of Object.values(docs)) list.sort((a, b) => a.offsetMs - b.offsetMs);
  const summary = SummaryDocumentSchema.parse(
    firstSummary ?? docs.pbp[0]?.body ?? docs.boxscore[0]?.body,
  );
  const providerGameId = summary.id;
  const schedule = {
    league: summary.league ?? { id: 'fake', name: 'fake', alias: 'FAKE' },
    season: summary.season,
    games: [
      {
        id: summary.id,
        status: summary.status,
        coverage: summary.coverage,
        scheduled: summary.scheduled,
        home: {
          id: summary.home.id,
          name: summary.home.name,
          alias: summary.home.alias,
          market: summary.home.market,
        },
        away: {
          id: summary.away.id,
          name: summary.away.name,
          alias: summary.away.alias,
          market: summary.away.market,
        },
        ...(summary.venue ? { venue: summary.venue } : {}),
        ...(summary.broadcasts ? { broadcasts: summary.broadcasts } : {}),
      },
    ],
  };

  const now = opts.now ?? (() => Date.now());
  const startedAt = now();
  const minSpacingMs = opts.minSpacingMs ?? 1000;
  const requireKey = opts.requireKey ?? true;
  const stats: FakeProviderStats = {
    requests: 0,
    served: 0,
    rejected401: 0,
    rejected429: 0,
    byFeed: {},
    pushConnections: 0,
    pushDrops: 0,
    pushLinesSent: 0,
    pushHeartbeatsSent: 0,
  };
  let lastAcceptedAt: number | null = null;
  const push: PushTimelines = buildPushTimelines(docs.pbp);
  const heartbeatMs = opts.heartbeatMs ?? 5000;
  const elapsedMs = () => (now() - startedAt) * opts.speed;

  // Push outage windows (wall clock, not time-scaled): [start, start + forMs).
  let dropWindow: { start: number; end: number } | null = null;
  let nextScheduledDrop: number | null = opts.pushDrop ? startedAt + opts.pushDrop.afterMs : null;
  const openPush = new Set<ServerResponse>();
  const dropPush = (forMs: number) => {
    const t = now();
    dropWindow = { start: t, end: t + forMs };
    for (const res of openPush) {
      stats.pushDrops++;
      res.destroy();
    }
    openPush.clear();
    opts.log?.warn({ forMs }, 'fake provider: push drop window opened');
  };
  const dropActive = (): boolean => {
    const t = now();
    if (nextScheduledDrop !== null && t >= nextScheduledDrop && opts.pushDrop) {
      dropPush(opts.pushDrop.forMs);
      nextScheduledDrop =
        opts.pushDrop.everyMs !== undefined ? nextScheduledDrop + opts.pushDrop.everyMs : null;
    }
    if (dropWindow && t >= dropWindow.end) dropWindow = null;
    return dropWindow !== null;
  };

  const streamPush = (
    req: IncomingMessage,
    res: ServerResponse,
    feed: 'push_events' | 'push_clock',
    lines: TimedLine[],
  ) => {
    stats.pushConnections++;
    stats.byFeed[feed] = (stats.byFeed[feed] ?? 0) + 1;
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
    res.flushHeaders();
    openPush.add(res);
    // No history: only lines after the moment of connection.
    const connectedAt = elapsedMs();
    let i = lines.findIndex((l) => l.offsetMs > connectedAt);
    if (i < 0) i = lines.length;
    const write = (line: unknown) => {
      if (res.destroyed || res.writableEnded) return;
      res.write(`${JSON.stringify(line)}\n`);
    };
    const hb = setInterval(() => {
      stats.pushHeartbeatsSent++;
      write({ heartbeat: { interval: heartbeatMs } });
    }, heartbeatMs);
    const tick = setInterval(() => {
      if (dropActive()) return; // dropPush() already destroyed this response
      const e = elapsedMs();
      while (i < lines.length && (lines[i]?.offsetMs ?? Number.POSITIVE_INFINITY) <= e) {
        stats.pushLinesSent++;
        write(lines[i]?.line);
        i++;
      }
    }, 50);
    const done = () => {
      clearInterval(hb);
      clearInterval(tick);
      openPush.delete(res);
    };
    // `res` 'close' is the connection going away; `req` 'close' would fire as soon as the (empty) request body is read.
    res.on('close', done);
    opts.log?.info(
      { feed, connectedAtOffsetMs: Math.round(connectedAt) },
      'fake provider: push connected',
    );
  };

  const pick = (feed: 'pbp' | 'summary' | 'boxscore'): unknown => {
    const elapsed = (now() - startedAt) * opts.speed;
    const list = docs[feed];
    let chosen = list[0];
    for (const d of list) {
      if (d.offsetMs <= elapsed) chosen = d;
      else break;
    }
    return chosen?.body ?? null;
  };

  const server: Server = createServer((req, res) => {
    stats.requests++;
    const send = (status: number, body: unknown) => {
      const text = JSON.stringify(body);
      res.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(text),
      });
      res.end(text);
    };
    const url = new URL(req.url ?? '/', 'http://fake');
    if (req.method === 'POST' && url.pathname === '/_fault/push-drop') {
      // Loopback control endpoint for rehearsals: no key, no spacing check.
      const forMs = Number(url.searchParams.get('for') ?? '30000');
      if (!Number.isFinite(forMs) || forMs <= 0) return send(400, { message: 'for=<ms> required' });
      dropPush(forMs);
      return send(200, { dropped: true, forMs, until: new Date(now() + forMs).toISOString() });
    }
    if (requireKey && !req.headers['x-api-key']) {
      stats.rejected401++;
      return send(401, { message: 'Unauthorized' });
    }
    const t = now();
    if (lastAcceptedAt !== null && t - lastAcceptedAt < minSpacingMs) {
      stats.rejected429++;
      opts.log?.warn({ spacingMs: t - lastAcceptedAt, path: url.pathname }, 'fake provider: 429');
      return send(429, { message: 'Too Many Requests: developer over QPS' });
    }
    const stream = /\/stream\/[a-z]{2}\/(events|clock|statistics)\/subscribe$/.exec(url.pathname);
    if (stream) {
      lastAcceptedAt = t;
      if (stream[1] === 'statistics') return send(404, { message: 'push statistics not mocked' });
      if (dropActive()) {
        stats.pushDrops++;
        opts.log?.warn(
          { path: url.pathname },
          'fake provider: push connection refused (drop window)',
        );
        req.socket.destroy();
        return;
      }
      stats.served++;
      return stream[1] === 'events'
        ? streamPush(req, res, 'push_events', push.events)
        : streamPush(req, res, 'push_clock', push.clocks);
    }
    const game = /\/games\/[^/]+\/(pbp|summary|boxscore)\.json$/.exec(url.pathname);
    const sched = /\/games\/\d+\/[A-Z]+\/schedule\.json$/.exec(url.pathname);
    const daily = /\/games\/(\d{4})\/(\d{2})\/(\d{2})\/schedule\.json$/.exec(url.pathname);
    let body: unknown;
    let feed: string;
    if (game) {
      feed = game[1] ?? 'pbp';
      body = pick(feed as 'pbp' | 'summary' | 'boxscore');
    } else if (daily) {
      // The recording's one game, listed only on its US Eastern calendar day, like the real feed:
      // the first live daily call (WNBA, 2026-10-19) listed a game tipping at 2026-10-20T00:00Z
      // under 2026-10-19. `planDay` lists what the document returned either way.
      feed = 'daily_schedule';
      const date = `${daily[1]}-${daily[2]}-${daily[3]}`;
      body = {
        league: schedule.league,
        date,
        season: schedule.season,
        games: schedule.games.filter((g) => easternDate(String(g.scheduled)) === date),
      };
    } else if (sched) {
      feed = 'schedule';
      body = schedule;
    } else {
      return send(404, { message: 'not found' });
    }
    if (body === null) return send(404, { message: `no ${feed} document in the recording` });
    lastAcceptedAt = t;
    stats.served++;
    stats.byFeed[feed] = (stats.byFeed[feed] ?? 0) + 1;
    return send(200, body);
  });

  const host = opts.host ?? '127.0.0.1';
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : (opts.port ?? 0);
  opts.log?.info(
    {
      port,
      speed: opts.speed,
      documents: total,
      providerGameId,
      minSpacingMs,
      pushLines: { events: push.events.length, clocks: push.clocks.length },
      pushDrop: opts.pushDrop ?? null,
    },
    'fake provider listening',
  );
  return {
    url: `http://${host}:${port}`,
    port,
    providerGameId,
    documents: total,
    pushLines: { events: push.events.length, clocks: push.clocks.length },
    stats,
    dropPush,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const res of openPush) res.destroy();
        openPush.clear();
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      }),
  };
}

const EASTERN_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** `YYYY-MM-DD` of an ISO instant on the US Eastern calendar (the daily feed's day boundary). */
export function easternDate(iso: string): string {
  return EASTERN_DAY.format(new Date(iso));
}
