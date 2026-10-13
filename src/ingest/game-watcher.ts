import { appendFileSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { ZodType } from 'zod';
import type { Db } from '../db/client.js';
import type { LeagueAdapter } from '../leagues/adapter.js';
import type { PulseSender } from '../live/pulse.js';
import type { Logger } from '../logger.js';
import type { FetchedDocument, SportradarHttp } from '../providers/sportradar/http.js';
import { BoxscoreDocumentSchema } from '../providers/sportradar/schemas/boxscore.js';
import { PbpDocumentSchema } from '../providers/sportradar/schemas/pbp.js';
import { SummaryDocumentSchema } from '../providers/sportradar/schemas/summary.js';
import type { Feed } from '../providers/sportradar/urls.js';
import { type ApplyDeps, type ApplyResult, applyChanges, ensureGame } from './apply-changes.js';
import { ensureTeams } from './identity.js';
import type { RunHandle } from './runs.js';
import type { NormalizedDocument, ObservationSource } from './types.js';

/** A recorded document line (`--record-to` writes these, `--replay-file` reads them). */
export interface RecordedDocument {
  feed: Feed;
  requestedAt: string;
  receivedAt: string;
  status: number;
  body: unknown;
}

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
  ) {}
  async fetch<T>(feed: Feed, schema: ZodType<T>): Promise<FetchedDocument<T>> {
    const doc = await this.http.getJson(feed, schema);
    if (this.recordTo) {
      const line: RecordedDocument = {
        feed,
        requestedAt: doc.requestedAt.toISOString(),
        receivedAt: doc.receivedAt.toISOString(),
        status: 200,
        body: JSON.parse(doc.rawText),
      };
      appendFileSync(this.recordTo, `${JSON.stringify(line)}\n`);
    }
    return doc;
  }
}

/** Reads a jsonl recording in order. `observedAt` is the recorded request time (fixture semantics). */
export async function* readRecording(path: string): AsyncGenerator<RecordedDocument> {
  const rl = createInterface({
    input: createReadStream(path),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    yield JSON.parse(line) as RecordedDocument;
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
  skipped = 0;
  /**
   * A watch generation is opened only by an event-bearing batch (a complete
   * pbp document that passed rule 2c, or a push event). Freshness rule 2 gates
   * a bare gameView on phase and period only, so a summary polled by a
   * restarted replay inside the same period would otherwise advance the
   * generation and then write its lagging score as the newest observation.
   * Until the generation is open, summary/boxscore documents are skipped
   * (not evaluated, not logged as stale); the next one arrives 30 s later.
   */
  generationOpen = false;

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

  normalize(feed: Feed, body: unknown): NormalizedDocument {
    const parsed = this.parse(feed, body);
    switch (parsed.feed) {
      case 'pbp':
        return this.deps.adapter.normalizePbp(parsed.doc);
      case 'summary':
        return this.deps.adapter.normalizeSummary(parsed.doc);
      case 'boxscore':
        return this.deps.adapter.normalizeBoxscore(parsed.doc);
    }
  }

  async process(
    feed: Feed,
    body: unknown,
    observedAt: Date,
    source: ObservationSource,
  ): Promise<ProcessOutcome | null> {
    const nd = this.normalize(feed, body);
    const gameId = await this.ensure(nd);
    if (
      !this.generationOpen &&
      nd.batch.events.length === 0 &&
      nd.batch.deletedEventIds.length === 0
    ) {
      this.skipped++;
      this.deps.log.info(
        { feed },
        'generation not yet opened by an event-bearing batch; document skipped',
      );
      return null;
    }
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
      if (nd.batch.events.length > 0 || nd.batch.deletedEventIds.length > 0)
        this.generationOpen = true;
      if (nd.gameView && result.gameLevel === 'write') this.lastStatus = nd.gameView.status;
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

  private async ensure(nd: NormalizedDocument): Promise<string> {
    if (this.gameId) return this.gameId;
    const teamIds = await ensureTeams(this.deps.db, this.deps.adapter.league, nd.teams);
    const home = nd.teams.find((t) => t.isHome);
    const away = nd.teams.find((t) => !t.isHome);
    const { id, created } = await ensureGame(this.deps.db, {
      league: this.deps.adapter.league,
      providerGameId: nd.providerGameId,
      scheduledAt: nd.gameView?.scheduledAt ?? new Date().toISOString(),
      status: nd.gameView?.status ?? 'scheduled',
      coverage: nd.gameView?.coverage ?? null,
      homeTeamId: home ? (teamIds.get(home.providerTeamId) ?? null) : null,
      awayTeamId: away ? (teamIds.get(away.providerTeamId) ?? null) : null,
      venue: nd.gameView?.venue ?? null,
      broadcasts: nd.gameView?.broadcasts ?? null,
    });
    await this.deps
      .db`update ingest.ingestion_runs set game_id = ${id} where id = ${this.deps.run.id}`;
    // A game with no durable history has nothing to regress: pregame documents may flow.
    const [state] = await this.deps.db<{ lastSeq: string }[]>`
      select last_seq::text as "lastSeq" from public.games where id = ${id}`;
    if (Number(state?.lastSeq ?? 0) === 0) this.generationOpen = true;
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
      if (polls % opts.summaryEvery === 1) {
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

/** Replay a recording file through the watcher; `paceMs` between documents (0 = as fast as possible). */
export async function replayRecording(
  watcher: GameWatcher,
  path: string,
  log: Logger,
  opts: { paceMs: number; untilClosed: boolean; isStopped: () => boolean; maxDocs: number | null },
): Promise<string | null> {
  let status: string | null = null;
  let docs = 0;
  for await (const line of readRecording(path)) {
    if (opts.isStopped()) break;
    docs++;
    try {
      const out = await watcher.process(
        line.feed,
        line.body,
        new Date(line.requestedAt),
        'fixture',
      );
      status = out?.status ?? status;
    } catch (err) {
      log.error({ err, feed: line.feed, docs }, 'recorded document failed');
    }
    if (status === 'closed' && opts.untilClosed) break;
    if (opts.maxDocs !== null && docs >= opts.maxDocs) break;
    if (opts.paceMs > 0) await new Promise((r) => setTimeout(r, opts.paceMs));
  }
  log.info({ docs, status }, 'recording replay finished');
  return status;
}
