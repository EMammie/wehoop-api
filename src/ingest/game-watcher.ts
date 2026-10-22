import type { ZodType } from 'zod';
import type { Db } from '../db/client.js';
import type { LeagueAdapter, NormalizeContext } from '../leagues/adapter.js';
import type { PulseSender } from '../live/pulse.js';
import type { Logger } from '../logger.js';
import {
  type FetchedDocument,
  ProviderHttpError,
  type SportradarHttp,
} from '../providers/sportradar/http.js';
import { BoxscoreDocumentSchema } from '../providers/sportradar/schemas/boxscore.js';
import { PbpDocumentSchema } from '../providers/sportradar/schemas/pbp.js';
import { SummaryDocumentSchema } from '../providers/sportradar/schemas/summary.js';
import { type Feed, type FeedParams, isGameFeed } from '../providers/sportradar/urls.js';
import { type ApplyDeps, type ApplyResult, applyChanges, ensureGame } from './apply-changes.js';
import type { Cadence } from './cadence.js';
import { ensurePlayers, ensureSeason, ensureTeams } from './identity.js';
import { QuotaRefusedError } from './quota-guard.js';
import {
  appendRecordedDocument,
  type RecordedDocument,
  readRecording,
  toRecordedDocument,
} from './recording.js';
import type { ReferenceIngester } from './reference.js';
import type { RunHandle } from './runs.js';
import type { NormalizedDocument, ObservationSource } from './types.js';

export { type RecordedDocument, readRecording };

/** Where documents come from: the simulation service (polling) or a recording on disk. */
export interface DocumentSource {
  readonly observationSource: ObservationSource;
  fetch<T>(feed: Feed, schema: ZodType<T>): Promise<FetchedDocument<T>>;
}

export class HttpDocumentSource implements DocumentSource {
  constructor(
    private readonly http: SportradarHttp,
    readonly observationSource: ObservationSource,
    private readonly recordTo: string | null = null,
    /** Feed parameters (the provider game id for production URLs; ignored by the simulation resolver). */
    private readonly params: FeedParams = {},
  ) {}
  async fetch<T>(feed: Feed, schema: ZodType<T>): Promise<FetchedDocument<T>> {
    const doc = await this.http.getJson(feed, schema, this.params);
    if (this.recordTo) appendRecordedDocument(this.recordTo, toRecordedDocument(feed, doc));
    return doc;
  }
}

export interface WatcherDeps {
  db: Db;
  log: Logger;
  adapter: LeagueAdapter;
  run: RunHandle;
  apply: ApplyDeps;
  pulse: PulseSender | null;
  onGameKnown?: (gameId: string) => void;
}

export interface ProcessOutcome {
  gameId: string;
  status: string;
  result: ApplyResult;
}

/**
 * Processes one provider document through normalize -> ensure rows -> applyChanges.
 * Shared by the polling loop and the recording replay.
 */
export class GameWatcher {
  gameId: string | null = null;
  lastStatus: string | null = null;
  stale = 0;
  applied = 0;
  batches = 0;

  constructor(private readonly deps: WatcherDeps) {}

  parse(feed: Feed, body: unknown) {
    switch (feed) {
      case 'pbp':
        return { feed, doc: PbpDocumentSchema.parse(body) } as const;
      case 'summary':
        return { feed, doc: SummaryDocumentSchema.parse(body) } as const;
      case 'boxscore':
        return { feed, doc: BoxscoreDocumentSchema.parse(body) } as const;
      default:
        throw new Error(`feed ${feed} is not a game feed`);
    }
  }

  normalize(feed: Feed, body: unknown, ctx?: NormalizeContext): NormalizedDocument {
    const parsed = this.parse(feed, body);
    switch (parsed.feed) {
      case 'pbp':
        return this.deps.adapter.normalizePbp(parsed.doc, ctx);
      case 'summary':
        return this.deps.adapter.normalizeSummary(parsed.doc, ctx);
      case 'boxscore':
        return this.deps.adapter.normalizeBoxscore(parsed.doc, ctx);
    }
  }

  /**
   * The stored `games.coverage` for this watcher's game (null before its row exists), read
   * fresh each time: a document that omits `coverage` is gated by what the schedule or an
   * earlier document stated, never by `full`.
   */
  private async storedCoverage(): Promise<string | null> {
    if (!this.gameId) return null;
    const [row] = await this.deps.db<{ coverage: string }[]>`
      select coverage::text as coverage from public.games where id = ${this.gameId}`;
    return row?.coverage ?? null;
  }

  async process(
    feed: Feed,
    body: unknown,
    observedAt: Date,
    source: ObservationSource,
  ): Promise<ProcessOutcome | null> {
    // Every document goes through applyChanges: freshness (incl. rule 2d for summary-only
    // documents after a restart) is decided inside the transaction, never here.
    const nd = this.normalize(feed, body, { storedCoverage: await this.storedCoverage() });
    const gameId = await this.ensure(nd);
    // Identity before state: every player the document names gets a canonical row, so
    // applyChanges can resolve play_events.player_id / game_player_stats.player_id (bodies
    // stay provider-keyed).
    if (nd.players.length > 0)
      await ensurePlayers(this.deps.db, this.deps.adapter.league, nd.players);
    const result = await applyChanges(this.deps.apply, gameId, nd.batch, {
      source,
      runId: this.deps.run.id,
      watchId: this.deps.run.watchId,
      observedAt,
      isComplete: nd.isComplete,
      gameView: nd.gameView,
    });
    this.batches++;
    const status = nd.gameView?.status ?? this.lastStatus ?? 'unknown';
    if (result.outcome === 'stale') {
      this.stale++;
      this.deps.log.warn({ feed, reason: result.reason, detail: result.detail, status }, 'stale');
    } else {
      this.applied += result.changes.length;
      if (nd.gameView?.status && result.gameLevel === 'write') this.lastStatus = nd.gameView.status;
      this.deps.log.info(
        {
          feed,
          status,
          events: nd.batch.events.length,
          changes: result.changes.length,
          seq: result.firstSeq ? `${result.firstSeq}..${result.lastSeq}` : `=${result.lastSeq}`,
          counts: result.counts,
          gameLevel: result.gameLevel,
          clock: nd.gameView?.clock ?? null,
          score: nd.gameView ? `${nd.gameView.score.away}-${nd.gameView.score.home}` : null,
        },
        'applied',
      );
    }
    return { gameId, status: this.lastStatus ?? status, result };
  }

  /**
   * Bind the watcher to a game row that already exists (trial mode: `pnpm trial plan` created it
   * from the schedule; no automatic discovery). Same side effects as the first document's
   * `ensure`, without needing a document.
   */
  async attach(gameId: string): Promise<void> {
    if (this.gameId === gameId) return;
    if (this.gameId) throw new Error(`watcher already bound to game ${this.gameId}`);
    const [row] = await this.deps.db<{ id: string; status: string }[]>`
      select id, status::text as status from public.games where id = ${gameId}`;
    if (!row) throw new Error(`game ${gameId} does not exist`);
    await this.deps
      .db`update ingest.ingestion_runs set game_id = ${gameId} where id = ${this.deps.run.id}`;
    this.gameId = gameId;
    this.lastStatus = row.status;
    this.deps.log.info({ gameId, status: row.status }, 'watcher attached to game row');
    this.deps.onGameKnown?.(gameId);
    this.deps.pulse?.start(gameId);
  }

  private async ensure(nd: NormalizedDocument): Promise<string> {
    if (this.gameId) return this.gameId;
    const teamIds = await ensureTeams(this.deps.db, this.deps.adapter.league, nd.teams);
    const home = nd.teams.find((t) => t.isHome);
    const away = nd.teams.find((t) => !t.isHome);
    const seasonId = nd.gameView?.season
      ? await ensureSeason(
          this.deps.db,
          this.deps.adapter.league,
          nd.gameView.season,
          this.deps.log,
        )
      : null;
    const { id, created } = await ensureGame(
      this.deps.db,
      {
        league: this.deps.adapter.league,
        providerGameId: nd.providerGameId,
        scheduledAt: nd.gameView?.scheduledAt ?? null,
        status: nd.gameView?.status ?? null,
        coverage: nd.gameView?.coverage ?? null,
        homeTeamId: home ? (teamIds.get(home.providerTeamId) ?? null) : null,
        awayTeamId: away ? (teamIds.get(away.providerTeamId) ?? null) : null,
        venue: nd.gameView?.venue ?? null,
        broadcasts: nd.gameView?.broadcasts ?? null,
        seasonId,
        title: nd.gameView?.title ?? null,
      },
      this.deps.log,
    );
    await this.deps
      .db`update ingest.ingestion_runs set game_id = ${id} where id = ${this.deps.run.id}`;
    this.gameId = id;
    this.deps.log.info(
      { gameId: id, providerGameId: nd.providerGameId, created },
      'game row ready',
    );
    this.deps.onGameKnown?.(id);
    this.deps.pulse?.start(id);
    return id;
  }
}

export interface PollLoopOptions {
  pollIntervalMs: number;
  summaryEvery: number;
  maxPolls: number | null;
  untilClosed: boolean;
  isStopped: () => boolean;
}

/**
 * Simulation / REST loop: pbp every `pollIntervalMs`, summary every
 * `summaryEvery` polls, and on close one summary + boxscore. Returns the final
 * status seen.
 */
export async function pollLoop(
  watcher: GameWatcher,
  source: DocumentSource,
  log: Logger,
  opts: PollLoopOptions,
): Promise<string | null> {
  let polls = 0;
  let status: string | null = null;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  while (!opts.isStopped()) {
    const started = Date.now();
    polls++;
    try {
      const pbp = await source.fetch('pbp', PbpDocumentSchema);
      const out = await watcher.process(
        'pbp',
        JSON.parse(pbp.rawText),
        pbp.requestedAt,
        source.observationSource,
      );
      status = out?.status ?? status;
      // Polls 1, 1+N, 1+2N, ... (`polls % N === 1` never fires for N = 1).
      if ((polls - 1) % opts.summaryEvery === 0) {
        const summary = await source.fetch('summary', SummaryDocumentSchema);
        await watcher.process(
          'summary',
          JSON.parse(summary.rawText),
          summary.requestedAt,
          source.observationSource,
        );
      }
      if (status === 'closed' && opts.untilClosed) {
        const summary = await source.fetch('summary', SummaryDocumentSchema);
        await watcher.process(
          'summary',
          JSON.parse(summary.rawText),
          summary.requestedAt,
          source.observationSource,
        );
        const box = await source.fetch('boxscore', BoxscoreDocumentSchema);
        await watcher.process(
          'boxscore',
          JSON.parse(box.rawText),
          box.requestedAt,
          source.observationSource,
        );
        log.info({ polls }, 'game closed');
        return status;
      }
    } catch (err) {
      log.error({ err, polls }, 'poll failed; retrying');
    }
    if (opts.maxPolls !== null && polls >= opts.maxPolls) {
      log.info({ polls }, 'max polls reached');
      return status;
    }
    const elapsed = Date.now() - started;
    await sleep(Math.max(0, opts.pollIntervalMs - elapsed));
  }
  return status;
}

export interface CadenceLoopOptions {
  untilClosed: boolean;
  isStopped: () => boolean;
  /** Called after every fetch (budget accounting / evidence). */
  onCall?: (feed: Feed) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface CadenceOutcome {
  status: string | null;
  calls: number;
  failed: number;
  /** HTTP 429s retried at once through the next rate slot (each retry is a logged call). */
  retried429: number;
  elapsedMs: number;
}

/**
 * Cadence-driven loop (trial / production REST, plan §4): each feed is fetched
 * at its own interval from the watch start (first poll at t=0), one-off
 * boxscores at their offsets, and the closing summary + boxscore once the
 * game is `closed`. The horizon is a planning number: a game that runs long
 * (overtime) keeps being watched; the quota guard, not the horizon, is what
 * refuses calls. A fetch that fails is logged and retried at its next due time.
 * An HTTP 429 is retried at once through the next rate slot (once for a cadence
 * feed, twice for a closing feed, which has no next due time), because the
 * provider's spacing rule is not known exactly (live run 2026-10-19).
 */
export async function cadenceLoop(
  watcher: GameWatcher,
  source: DocumentSource,
  log: Logger,
  cadence: Cadence,
  opts: CadenceLoopOptions,
): Promise<CadenceOutcome> {
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const startedAt = now();
  const schemaFor = (feed: GameFeedName) =>
    feed === 'pbp'
      ? PbpDocumentSchema
      : feed === 'summary'
        ? SummaryDocumentSchema
        : BoxscoreDocumentSchema;
  let status: string | null = null;
  let calls = 0;
  let failed = 0;
  let retried429 = 0;
  let horizonWarned = false;
  const fetchOne = async (feed: GameFeedName, retriesOn429 = 1): Promise<void> => {
    for (let attempt = 0; ; attempt++) {
      try {
        const doc = await source.fetch(feed, schemaFor(feed));
        calls++;
        opts.onCall?.(feed);
        const out = await watcher.process(
          feed,
          JSON.parse(doc.rawText),
          doc.requestedAt,
          source.observationSource,
        );
        status = out?.status ?? status;
        return;
      } catch (err) {
        // No budget: stop the watch (the run ends as error, the reservation is released) instead
        // of issuing a guard query per tick forever.
        if (err instanceof QuotaRefusedError) throw err;
        if (
          err instanceof ProviderHttpError &&
          err.status === 429 &&
          attempt < retriesOn429 &&
          !opts.isStopped()
        ) {
          retried429++;
          log.warn(
            { feed, attempt: attempt + 1, calls },
            'HTTP 429; retrying at the next rate slot',
          );
          continue;
        }
        failed++;
        log.error({ err, feed, calls }, 'fetch failed; retrying at the next due time');
        return;
      }
    }
  };
  // Periodic feeds: next due time per feed. One-offs: a sorted queue of offsets.
  const periodic: Array<{ feed: GameFeedName; everyMs: number; nextAt: number }> = [];
  if (cadence.pbpMs !== null)
    periodic.push({ feed: 'pbp', everyMs: cadence.pbpMs, nextAt: startedAt });
  if (cadence.summaryMs !== null)
    periodic.push({
      feed: 'summary',
      everyMs: cadence.summaryMs,
      nextAt: startedAt + (cadence.summaryOffsetMs ?? 0),
    });
  if (cadence.boxscoreMs !== null)
    periodic.push({ feed: 'boxscore', everyMs: cadence.boxscoreMs, nextAt: startedAt });
  const oneOffs = [...cadence.boxscoreAtMs].sort((a, b) => a - b).map((ms) => startedAt + ms);
  while (!opts.isStopped()) {
    const t = now();
    for (const p of periodic) {
      if (t >= p.nextAt) {
        await fetchOne(p.feed);
        // Keep the grid anchored to the start, skipping slots a slow fetch already passed.
        // While `complete` waits for `closed`, poll at most every `afterCompleteMs` (rev 4.9).
        const everyMs =
          status === 'complete' && cadence.afterCompleteMs != null
            ? Math.max(p.everyMs, cadence.afterCompleteMs)
            : p.everyMs;
        while (p.nextAt <= now()) p.nextAt += everyMs;
      }
    }
    while (oneOffs.length > 0 && t >= (oneOffs[0] ?? Number.POSITIVE_INFINITY)) {
      oneOffs.shift();
      await fetchOne('boxscore');
    }
    if (status === 'closed' && opts.untilClosed) {
      for (const feed of cadence.closing) await fetchOne(feed, 2);
      log.info({ calls, failed, retried429, elapsedMs: now() - startedAt }, 'game closed');
      return { status, calls, failed, retried429, elapsedMs: now() - startedAt };
    }
    if (!horizonWarned && now() - startedAt >= cadence.horizonMs) {
      horizonWarned = true;
      log.warn(
        { calls, horizonMs: cadence.horizonMs },
        'watch horizon reached; game not closed, continuing under the quota guard',
      );
    }
    const dueTimes = [
      ...periodic.map((p) => p.nextAt),
      ...(oneOffs.length ? [oneOffs[0] ?? 0] : []),
    ];
    if (dueTimes.length === 0) {
      log.warn('cadence polls nothing; stopping');
      break;
    }
    const waitMs = Math.max(0, Math.min(...dueTimes) - now());
    await sleep(Math.min(waitMs, 1000));
  }
  return { status, calls, failed, retried429, elapsedMs: now() - startedAt };
}

type GameFeedName = 'pbp' | 'summary' | 'boxscore';

export interface ReplayOutcome {
  status: string | null;
  docs: number;
  /** Reference documents (schedule, profiles, ...) routed to the ReferenceIngester. */
  referenceDocs: number;
}

/**
 * Replay a recording file through the watcher; `paceMs` between documents (0 =
 * as fast as possible). The file is consumed to EOF (or `maxDocs`): a recording
 * carries the final summary and boxscore AFTER the first `closed` pbp, and a
 * worker that stops on `closed` must still take them so final stats are never
 * left behind (plan §4). Whether the worker exits afterwards is the worker's
 * decision (`--until closed`); nothing here cuts the file short.
 */
export async function replayRecording(
  watcher: GameWatcher,
  path: string,
  log: Logger,
  opts: {
    paceMs: number;
    isStopped: () => boolean;
    maxDocs: number | null;
    /** Handles non-game feeds in the file (schedule, tournament, profile, ...); without one they are skipped. */
    reference?: ReferenceIngester | null;
  },
): Promise<ReplayOutcome> {
  let status: string | null = null;
  let docs = 0;
  let referenceDocs = 0;
  let closedAt: number | null = null;
  for await (const line of readRecording(path, { warn: (m) => log.warn(m) })) {
    if (opts.isStopped()) break;
    docs++;
    try {
      if (isGameFeed(line.feed)) {
        const out = await watcher.process(
          line.feed,
          line.body,
          new Date(line.requestedAt),
          'fixture',
        );
        status = out?.status ?? status;
      } else if (opts.reference) {
        referenceDocs++;
        await opts.reference.process(line.feed, line.body, new Date(line.requestedAt));
      } else {
        log.warn({ feed: line.feed, docs }, 'reference document skipped (no ingester)');
      }
    } catch (err) {
      log.error({ err, feed: line.feed, docs }, 'recorded document failed');
    }
    if (status === 'closed' && closedAt === null) {
      closedAt = docs;
      log.info({ docs }, 'game closed; consuming the remaining documents of the recording');
    }
    if (opts.maxDocs !== null && docs >= opts.maxDocs) break;
    if (opts.paceMs > 0) await new Promise((r) => setTimeout(r, opts.paceMs));
  }
  log.info({ docs, referenceDocs, status, closedAtDoc: closedAt }, 'recording replay finished');
  return { status, docs, referenceDocs };
}
