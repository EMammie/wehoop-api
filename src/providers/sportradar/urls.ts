import type { LeagueCode } from '../../leagues/codes.js';

/** Feeds the M1 replay needs. M2/M3 extend this union. */
export type Feed = 'pbp' | 'summary' | 'boxscore' | 'schedule';

export interface ResolvedUrl {
  url: string;
  /** Headers to send (production keys go here, never in the URL). */
  headers: Record<string, string>;
}

/**
 * UrlResolver: builds request URLs for one league. Production and simulation
 * differ only here; SportradarHttp is identical for both.
 */
export interface UrlResolver {
  readonly source: 'production' | 'trial' | 'simulation';
  resolve(feed: Feed, params: { gameId?: string }): ResolvedUrl;
}

/**
 * Simulation replay URLs. The replay service exposes the v8 feeds under
 * `/replay/{league}/{recordingId}?feed={feed}&contentType=json&sessionId={id}`.
 * Feed name mapping: our `summary` is the replayer's `game` feed.
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

  resolve(feed: Feed, _params: { gameId?: string } = {}): ResolvedUrl {
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
 * Production / trial URLs: `https://api.sportradar.com/{league}/{access}/v8/en/games/{id}/{feed}.json`
 * with the key in the `x-api-key` header. Only the game feeds M1 touches are
 * mapped; M3 adds schedules and profiles when the trial key exists.
 */
export class ProdUrlResolver implements UrlResolver {
  readonly source: 'production' | 'trial';
  constructor(
    private readonly opts: {
      league: LeagueCode;
      accessLevel: 'trial' | 'production';
      apiKey: string;
      baseUrl?: string;
    },
  ) {
    this.source = opts.accessLevel;
  }

  resolve(feed: Feed, params: { gameId?: string }): ResolvedUrl {
    const base = this.opts.baseUrl ?? 'https://api.sportradar.com';
    const root = `${base}/${this.opts.league}/${this.opts.accessLevel}/v8/en`;
    let path: string;
    switch (feed) {
      case 'pbp':
      case 'summary':
      case 'boxscore': {
        if (!params.gameId) throw new Error(`${feed} needs a gameId`);
        path = `/games/${encodeURIComponent(params.gameId)}/${feed}.json`;
        break;
      }
      case 'schedule':
        throw new Error('schedule feed is resolved in M3');
    }
    return { url: `${root}${path}`, headers: { 'x-api-key': this.opts.apiKey } };
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
