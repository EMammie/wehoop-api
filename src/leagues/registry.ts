import type { LeagueAdapter } from './adapter.js';
import type { LeagueCode } from './codes.js';
import { ncaawbAdapter } from './ncaawb/adapter.js';
import { unrivaledAdapter } from './unrivaled/adapter.js';
import { wnbaAdapter } from './wnba/adapter.js';

const ADAPTERS: Record<LeagueCode, LeagueAdapter> = {
  wnba: wnbaAdapter,
  ncaawb: ncaawbAdapter,
  unrivaled: unrivaledAdapter,
};

export function adapterFor(league: LeagueCode): LeagueAdapter {
  return ADAPTERS[league];
}
