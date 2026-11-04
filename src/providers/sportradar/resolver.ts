import type { Config } from '../../config.js';
import type { LeagueCode } from '../../leagues/codes.js';
import { ProdUrlResolver, SimulationUrlResolver, type UrlResolver } from './urls.js';

/** Which env variable holds each product's key (named in errors; values never are). */
export const KEY_ENV_NAMES: Record<LeagueCode, string> = {
  wnba: 'SPORTRADAR_WNBA_KEY',
  ncaawb: 'SPORTRADAR_NCAAWB_KEY',
  unrivaled: 'SPORTRADAR_UNRIVALED_KEY',
};

/**
 * The UrlResolver for the configured MODE (plan §4): `sim` replays a recording
 * through the simulation service (no key, never counts quota); `trial` and
 * `production` build api.sportradar.com URLs with the league's key from env,
 * at the configured access level. A missing key is reported by variable name;
 * no key value ever enters a message.
 */
export function createResolver(
  config: Pick<Config, 'mode' | 'sportradar'>,
  league: LeagueCode,
  sim?: { recordingId: string; sessionId: string },
): UrlResolver {
  if (config.mode === 'sim') {
    if (!sim) throw new Error('MODE=sim needs a simulation recording and session');
    return new SimulationUrlResolver({
      playbackUrl: config.sportradar.playbackUrl,
      league,
      recordingId: sim.recordingId,
      sessionId: sim.sessionId,
    });
  }
  const apiKey = config.sportradar.keys[league];
  if (!apiKey) throw new Error(`MODE=${config.mode} needs ${KEY_ENV_NAMES[league]} to be set`);
  const accessLevel = config.mode === 'production' ? 'production' : config.sportradar.accessLevel;
  return new ProdUrlResolver({
    league,
    accessLevel,
    apiKey,
    baseUrl: config.sportradar.baseUrl,
  });
}
