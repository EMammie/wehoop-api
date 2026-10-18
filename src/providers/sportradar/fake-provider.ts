import { createServer, type Server } from 'node:http';
import { readRecording } from '../../ingest/recording.js';
import type { Logger } from '../../logger.js';
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
}

export interface FakeProviderStats {
  requests: number;
  served: number;
  rejected401: number;
  rejected429: number;
  byFeed: Record<string, number>;
}

export interface FakeProvider {
  url: string;
  port: number;
  providerGameId: string;
  documents: number;
  stats: FakeProviderStats;
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
  };
  let lastAcceptedAt: number | null = null;

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
    const game = /\/games\/[^/]+\/(pbp|summary|boxscore)\.json$/.exec(url.pathname);
    const sched = /\/games\/\d+\/[A-Z]+\/schedule\.json$/.exec(url.pathname);
    const daily = /\/games\/(\d{4})\/(\d{2})\/(\d{2})\/schedule\.json$/.exec(url.pathname);
    let body: unknown;
    let feed: string;
    if (game) {
      feed = game[1] ?? 'pbp';
      body = pick(feed as 'pbp' | 'summary' | 'boxscore');
    } else if (daily) {
      // The recording's one game, listed only on its calendar day: assumed UTC day until the first
      // live daily call is captured (the real feed's boundary is likely the Eastern calendar day).
      // `planDay` lists what the document returned, so this choice never changes the operator's list.
      feed = 'daily_schedule';
      const date = `${daily[1]}-${daily[2]}-${daily[3]}`;
      body = {
        league: schedule.league,
        date,
        season: schedule.season,
        games: schedule.games.filter((g) => String(g.scheduled).slice(0, 10) === date),
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
    { port, speed: opts.speed, documents: total, providerGameId, minSpacingMs },
    'fake provider listening',
  );
  return {
    url: `http://${host}:${port}`,
    port,
    providerGameId,
    documents: total,
    stats,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      }),
  };
}
