import type { LeagueCode } from '../leagues/codes.js';

/** The provider season a calendar date falls in. NCAAWB seasons are named by their first year. */
export function seasonFor(
  league: LeagueCode,
  date: Date,
  override?: { year?: number; type?: string },
): { year: number; type: string } {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1;
  const year = override?.year ?? (league === 'ncaawb' ? (m >= 8 ? y : y - 1) : y);
  return { year, type: override?.type ?? 'REG' };
}
