import type { Db } from '../db/client.js';
import type { LeagueCode } from '../leagues/codes.js';
import type { Logger } from '../logger.js';
import type { GameStatus, PeriodType } from '../model/live-event.js';
import {
  leagueScoresChannel,
  type ScoreboardDelta,
  ScoreboardSchema,
} from '../model/scoreboard.js';
import type { LiveTransport } from './transport.js';

/** One changed game as the source reports it: the delta plus where it belongs and when it changed. */
export interface ChangedGame extends ScoreboardDelta {
  league: LeagueCode;
  changedAt: Date;
}

export interface ScoreboardSource {
  /** Games whose row changed after `since` (every game when null), oldest change first. */
  changedSince(since: Date | null): Promise<ChangedGame[]>;
}

/**
 * `games.updated_at` moves on every write, durable or observation (0001's
 * set_updated_at trigger), so it is the change watermark. Scheduled games are
 * included: a status flip to inprogress is exactly what a list screen wants.
 */
export class DbScoreboardSource implements ScoreboardSource {
  constructor(private readonly db: Db) {}

  async changedSince(since: Date | null): Promise<ChangedGame[]> {
    const rows = await this.db<
      {
        gameId: string;
        league: LeagueCode;
        home: number;
        away: number;
        status: GameStatus;
        periodNumber: number | null;
        periodType: PeriodType | null;
        periodSequence: number | null;
        clock: string | null;
        lastSeq: string;
        observedAt: Date | null;
        changedAt: Date;
      }[]
    >`
      select id as "gameId", league, home_points as home, away_points as away, status,
             current_period as "periodNumber", period_type as "periodType",
             current_period_sequence as "periodSequence", clock, last_seq::text as "lastSeq",
             observed_at as "observedAt", updated_at as "changedAt"
      from public.games
      where ${
        since === null
          ? this.db`true`
          : // The watermark is a JS Date (ms); compare at ms precision so the newest row of the previous
            // tick is not re-sent forever because of its microseconds. A second write inside the same
            // millisecond as the watermark is lost, which this best-effort channel tolerates.
            this.db`date_trunc('milliseconds', updated_at) > ${since}`
      }
      order by updated_at, id`;
    return rows.map((r) => ({
      gameId: r.gameId,
      league: r.league,
      score: { home: r.home, away: r.away },
      status: r.status,
      period:
        r.periodSequence === null
          ? null
          : {
              number: r.periodNumber ?? 0,
              type: r.periodType ?? 'quarter',
              sequence: r.periodSequence,
            },
      clock: r.clock,
      latestSeq: Number(r.lastSeq),
      observedAt: r.observedAt ? r.observedAt.toISOString() : null,
      changedAt: r.changedAt,
    }));
  }
}

/**
 * Scoreboard sender (plan §5 `league:{code}:scores`): every `intervalMs`
 * (5 s) publish one message per league listing the games whose row changed
 * since the previous tick, straight through the LiveTransport. Coalescing is
 * the interval itself: a game that changed ten times in 5 s appears once with
 * its latest row. The watermark starts at construction time, so a restart
 * never replays history; a failed publish is logged and the watermark still
 * moves (the next tick carries whatever changed afterwards; list screens
 * re-fetch `v_schedule` on reconnect).
 */
export class ScoreboardSender {
  private timer: NodeJS.Timeout | null = null;
  private since: Date;
  private ticking: Promise<number> | null = null;
  /** Messages published (one per league per tick with changes). */
  sent = 0;
  /** Game deltas published. */
  deltas = 0;
  failed = 0;

  constructor(
    private readonly deps: {
      transport: LiveTransport;
      log: Logger;
      source: ScoreboardSource;
      intervalMs?: number;
      now?: () => Date;
    },
  ) {
    this.since = (deps.now ?? (() => new Date()))();
  }

  /** Publish what changed since the last tick; returns the number of deltas sent. Concurrent calls coalesce. */
  tick(): Promise<number> {
    if (this.ticking) return this.ticking;
    this.ticking = this.tickOnce().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  private async tickOnce(): Promise<number> {
    const now = (this.deps.now ?? (() => new Date()))();
    const changed = await this.deps.source.changedSince(this.since);
    if (changed.length === 0) return 0;
    const byLeague = new Map<LeagueCode, ScoreboardDelta[]>();
    for (const c of changed) {
      const { league, changedAt, ...delta } = c;
      if (changedAt.getTime() > this.since.getTime()) this.since = changedAt;
      const list = byLeague.get(league) ?? [];
      list.push(delta);
      byLeague.set(league, list);
    }
    let sent = 0;
    for (const [league, deltas] of byLeague) {
      const message = ScoreboardSchema.parse({
        v: 1,
        type: 'scores',
        league,
        deltas,
        sentAt: now.toISOString(),
      });
      try {
        await this.deps.transport.publish(leagueScoresChannel(league), [
          { event: 'scores', payload: message },
        ]);
        this.sent++;
        this.deltas += deltas.length;
        sent += deltas.length;
      } catch (err) {
        this.failed++;
        this.deps.log.warn(
          { err, league, deltas: deltas.length },
          'scoreboard publish failed (harmless; next tick supersedes)',
        );
      }
    }
    return sent;
  }

  start(): void {
    this.stop();
    this.timer = setInterval(() => {
      void this.tick().catch((err) => this.deps.log.error({ err }, 'scoreboard tick failed'));
    }, this.deps.intervalMs ?? 5_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
