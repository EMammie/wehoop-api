import type { Db } from '../db/client.js';
import type { LeagueCode } from '../leagues/codes.js';

/**
 * Reference-row identity. M1: teams only (upsert by (league, provider_team_id)).
 * Players and cross-league identity (player_external_ids) arrive in M2.
 * Teams are not game state, so this does not go through applyChanges.
 */
export async function ensureTeams(
  db: Db,
  league: LeagueCode,
  teams: Array<{
    providerTeamId: string;
    name: string;
    market: string | null;
    alias: string | null;
  }>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const t of teams) {
    const [row] = await db<{ id: string }[]>`
      insert into public.teams (league, provider_team_id, name, market, alias)
      values (${league}, ${t.providerTeamId}, ${t.name}, ${t.market}, ${t.alias})
      on conflict (league, provider_team_id) do update
        set name = excluded.name,
            market = coalesce(excluded.market, public.teams.market),
            alias = coalesce(excluded.alias, public.teams.alias)
      returning id`;
    if (!row) throw new Error(`team upsert failed for ${t.providerTeamId}`);
    out.set(t.providerTeamId, row.id);
  }
  return out;
}

export async function teamIdsFor(
  db: Db,
  league: LeagueCode,
  providerTeamIds: string[],
): Promise<Map<string, string>> {
  if (providerTeamIds.length === 0) return new Map();
  const rows = await db<{ id: string; providerTeamId: string }[]>`
    select id, provider_team_id as "providerTeamId" from public.teams
    where league = ${league} and provider_team_id = any(${providerTeamIds})`;
  return new Map(rows.map((r) => [r.providerTeamId, r.id]));
}
