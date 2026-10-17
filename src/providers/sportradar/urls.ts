import { inspect } from 'node:util';
import type { LeagueCode } from '../../leagues/codes.js';

/** Game feeds (per game) and reference feeds (per season / tournament / player / team). */
export const GAME_FEEDS = ['pbp', 'summary', 'boxscore'] as const;
export const REFERENCE_FEEDS = [
  'schedule',
  'tournament_list',
  'tournament_schedule',
  'standings',
  'hierarchy',
  'player_profile',
  'seasonal_stats',
  'league_leaders',
] as const;
export const FEEDS = [...GAME_FEEDS, ...REFERENCE_FEEDS] as const;
export type Feed = (typeof FEEDS)[number];
export type GameFeed = (typeof GAME_FEEDS)[number];
export type ReferenceFeed = (typeof REFERENCE_FEEDS)[number];

export function isGameFeed(feed: Feed): feed is GameFeed {
  return (GAME_FEEDS as readonly string[]).includes(feed);
}

export interface FeedParams {
  gameId?: string;
  seasonYear?: number;
  seasonType?: string;
  tournamentId?: string;
  playerId?: string;
  teamId?: string;
}

export interface ResolvedUrl {
  url: string;
  /** Headers to send (production keys go here, never in the URL). */
  headers: Record<string, string>;
}

/**
 * UrlResolver: builds request URLs for one league. Production and simulation
 * differ only here; SportradarHttp is identical for both.
 */
/**
 * Where calls go, for quota and rate-limit purposes: `trial`/`production` count
 * toward the product quota; `rehearsal` is the production URL shape against a
 * local stand-in host (rate-limited, never counted); `simulation` is the replay
 * service (neither).
 */
export type ResolverSource = 'production' | 'trial' | 'rehearsal' | 'simulation';

export interface UrlResolver {
  readonly source: ResolverSource;
  resolve(feed: Feed, params: FeedParams): ResolvedUrl;
}

/**
 * Simulation replay URLs. The replay service exposes the v8 game feeds under
 * `/replay/{league}/{recordingId}?feed={feed}&contentType=json&sessionId={id}`.
 * Feed name mapping: our `summary` is the replayer's `game` feed. Reference
 * feeds are not replayed by the simulation service.
 */
export class SimulationUrlResolver implements UrlResolver {
  readonly source = 'simulation' as const;
  constructor(
    private readonly opts: {
      playbackUrl: string;
      league: LeagueCode;
      recordingId: string;
      sessionId: string;
    },
  ) {}

  resolve(feed: Feed, _params: FeedParams = {}): ResolvedUrl {
    if (!isGameFeed(feed)) throw new Error(`simulation recordings do not replay the ${feed} feed`);
    const feedName = feed === 'summary' ? 'game' : feed;
    const u = new URL(
      `/replay/${this.opts.league}/${encodeURIComponent(this.opts.recordingId)}`,
      this.opts.playbackUrl,
    );
    u.searchParams.set('feed', feedName);
    u.searchParams.set('contentType', 'json');
    u.searchParams.set('sessionId', this.opts.sessionId);
    return { url: u.toString(), headers: {} };
  }
}

/**
 * Production / trial URLs: `https://api.sportradar.com/{league}/{access}/v8/en/...`
 * with the key in the `x-api-key` header. Paths follow the public v8 docs for
 * all three products (identical shapes). Nothing here performs a request;
 * SportradarHttp puts the rate limiter and quota guard in front of it.
 * The key is held in a non-enumerable field: `util.inspect`, `JSON.stringify`
 * and error messages never show it.
 */
export const SPORTRADAR_DEFAULT_BASE_URL = 'https://api.sportradar.com';

export class ProdUrlResolver implements UrlResolver {
  /** `trial`/`production` against the real host; `rehearsal` when `baseUrl` is a local stand-in. */
  readonly source: 'production' | 'trial' | 'rehearsal';
  readonly league: LeagueCode;
  readonly accessLevel: 'trial' | 'production';
  readonly baseUrl: string;
  /** True when calls go to a stand-in host (`pnpm sim serve`), not api.sportradar.com. */
  readonly rehearsal: boolean;
  private readonly apiKey!: string;

  constructor(opts: {
    league: LeagueCode;
    accessLevel: 'trial' | 'production';
    apiKey: string;
    baseUrl?: string;
  }) {
    if (!opts.apiKey)
      throw new Error(`${opts.league} ${opts.accessLevel} resolver needs an API key`);
    this.league = opts.league;
    this.accessLevel = opts.accessLevel;
    this.baseUrl = opts.baseUrl ?? SPORTRADAR_DEFAULT_BASE_URL;
    this.rehearsal = this.baseUrl !== SPORTRADAR_DEFAULT_BASE_URL;
    this.source = this.rehearsal ? 'rehearsal' : opts.accessLevel;
    Object.defineProperty(this, 'apiKey', {
      value: opts.apiKey,
      enumerable: false,
      writable: false,
    });
  }

  [inspect.custom]() {
    return {
      ProdUrlResolver: {
        league: this.league,
        accessLevel: this.accessLevel,
        baseUrl: this.baseUrl,
        source: this.source,
        apiKey: '[redacted]',
      },
    };
  }

  toJSON() {
    return { league: this.league, accessLevel: this.accessLevel, baseUrl: this.baseUrl };
  }

  resolve(feed: Feed, params: FeedParams): ResolvedUrl {
    const root = `${this.baseUrl}/${this.league}/${this.accessLevel}/v8/en`;
    const need = <K extends keyof FeedParams>(key: K): NonNullable<FeedParams[K]> => {
      const v = params[key];
      if (v === undefined) throw new Error(`${feed} needs ${key}`);
      return v;
    };
    const enc = (v: string | number) => encodeURIComponent(String(v));
    let path: string;
    switch (feed) {
      case 'pbp':
      case 'summary':
      case 'boxscore':
        path = `/games/${enc(need('gameId'))}/${feed}.json`;
        break;
      case 'schedule':
        path = `/games/${enc(need('seasonYear'))}/${enc(need('seasonType'))}/schedule.json`;
        break;
      case 'tournament_list':
        path = `/tournaments/${enc(need('seasonYear'))}/${enc(need('seasonType'))}/schedule.json`;
        break;
      case 'tournament_schedule':
        path = `/tournaments/${enc(need('tournamentId'))}/schedule.json`;
        break;
      case 'standings':
        path = `/seasons/${enc(need('seasonYear'))}/${enc(need('seasonType'))}/standings.json`;
        break;
      case 'hierarchy':
        path = '/league/hierarchy.json';
        break;
      case 'player_profile':
        path = `/players/${enc(need('playerId'))}/profile.json`;
        break;
      case 'seasonal_stats':
        path = `/seasons/${enc(need('seasonYear'))}/${enc(need('seasonType'))}/teams/${enc(need('teamId'))}/statistics.json`;
        break;
      case 'league_leaders':
        path = `/seasons/${enc(need('seasonYear'))}/${enc(need('seasonType'))}/leaders.json`;
        break;
    }
    return { url: `${root}${path}`, headers: { 'x-api-key': this.apiKey } };
  }
}

/** Strip anything that looks like a credential before a URL is persisted or logged. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const key of ['api_key', 'apikey', 'key', 'token', 'access_token']) {
      if (u.searchParams.has(key)) u.searchParams.set(key, 'redacted');
    }
    return u.toString();
  } catch {
    return url;
  }
}
