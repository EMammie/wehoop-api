import type { TransactionSql } from 'postgres';
import type { Db } from '../db/client.js';
import type { LeagueCode } from '../leagues/codes.js';
import type { Logger } from '../logger.js';
import type { PlayerProfileDocument } from '../providers/sportradar/schemas/profile.js';
import {
  applyPlayerSeasonStats,
  type PlayerSeasonLine,
  type RepointCounts,
  repointPlayerReferences,
} from './apply-changes.js';
import type { DocumentPlayer } from './types.js';

/**
 * Reference-row identity: teams, seasons, tournaments, and the canonical
 * player behind every provider id (plan §2 `players` + `player_external_ids`).
 *
 * Players: one canonical `players` row, many `(provider, league, external_id)`
 * rows. A game feed creates a player the first time it names one (source
 * `game`). A profile document owns its id (source `profile`) and links every
 * `references[]` entry (source `reference`): a league profile id under that
 * league, the sport-wide profile id under the profile's own league with
 * id_type `sport_profile`. A profile first resolves every id it carries; it
 * creates a row only when none resolves, and when two distinct canonical rows
 * resolve the two are MERGED: the survivor is the older row (created_at, then
 * id: deterministic for any replay order), the loser gets `merged_into` (and
 * earlier tombstones pointing at the loser are flattened onto the survivor, so
 * chains stay depth 1), and every FK that referenced the loser is repointed in
 * the same transaction. Canonical uuids never enter change bodies or content
 * hashes, so a merge never rewrites history. Re-applying the same profile is a
 * no-op.
 *
 * None of this is game state: nothing here writes games, play_events,
 * game_changes, game_periods or the stats tables; the merge repoint and the
 * season lines go through apply-changes.ts (repointPlayerReferences,
 * applyPlayerSeasonStats).
 */

type Sql = Db | TransactionSql;
const PROVIDER = 'sportradar';

/** Provider `scope` aliases → our league codes (profile references[], league headers). */
export const SCOPE_TO_LEAGUE: Record<string, LeagueCode> = {
  WNBA: 'wnba',
  NCAAW: 'ncaawb',
  NCAAWB: 'ncaawb',
  UNRIVALED: 'unrivaled',
};

/* ------------------------------------------------------------------------- */
/* Teams                                                                      */
/* ------------------------------------------------------------------------- */

export interface TeamFacts {
  providerTeamId: string;
  name: string;
  market: string | null;
  alias: string | null;
  conference?: string | null;
  division?: string | null;
  colors?: unknown[] | null;
  venue?: Record<string, unknown> | null;
}

/** Upsert teams by (league, provider_team_id); omitted facts never overwrite stored ones. */
export async function ensureTeams(
  db: Sql,
  league: LeagueCode,
  teams: TeamFacts[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const t of teams) {
    const [row] = await db<{ id: string }[]>`
      insert into public.teams (league, provider_team_id, name, market, alias, conference, division, colors, venue)
      values (${league}, ${t.providerTeamId}, ${t.name}, ${t.market}, ${t.alias},
              ${t.conference ?? null}, ${t.division ?? null},
              ${t.colors ? db.json(t.colors as never) : null},
              ${t.venue ? db.json(t.venue as never) : null})
      on conflict (league, provider_team_id) do update
        set name = excluded.name,
            market = coalesce(excluded.market, public.teams.market),
            alias = coalesce(excluded.alias, public.teams.alias),
            conference = coalesce(excluded.conference, public.teams.conference),
            division = coalesce(excluded.division, public.teams.division),
            colors = coalesce(excluded.colors, public.teams.colors),
            venue = coalesce(excluded.venue, public.teams.venue)
      returning id`;
    if (!row) throw new Error(`team upsert failed for ${t.providerTeamId}`);
    out.set(t.providerTeamId, row.id);
  }
  return out;
}

export async function teamIdsFor(
  db: Sql,
  league: LeagueCode,
  providerTeamIds: string[],
): Promise<Map<string, string>> {
  if (providerTeamIds.length === 0) return new Map();
  const rows = await db<{ id: string; providerTeamId: string }[]>`
    select id, provider_team_id as "providerTeamId" from public.teams
    where league = ${league} and provider_team_id = any(${providerTeamIds})`;
  return new Map(rows.map((r) => [r.providerTeamId, r.id]));
}

/* ------------------------------------------------------------------------- */
/* Seasons and tournaments                                                    */
/* ------------------------------------------------------------------------- */

const SEASON_TYPES = new Set(['PRE', 'REG', 'OOT', 'PST', 'CC']);

export interface SeasonFacts {
  providerSeasonId: string;
  year: number;
  type: string;
  startsOn?: string | null;
  endsOn?: string | null;
}

/**
 * Upsert a season by (league, provider_season_id). A provider season type the
 * enum does not know is not invented: the season is skipped (null) and logged.
 * A (league, year, type) already stored under a different provider id is a
 * clash, not the same season: null is returned (the caller leaves its
 * season_id unset) and the clash is logged, so a game is never silently linked
 * to a season the provider did not name.
 */
export async function ensureSeason(
  db: Sql,
  league: LeagueCode,
  season: SeasonFacts,
  log?: Logger,
): Promise<string | null> {
  if (!SEASON_TYPES.has(season.type)) {
    log?.warn({ league, season }, 'unknown provider season type; games.season_id left null');
    return null;
  }
  const [existing] = await db<{ id: string }[]>`
    select id from public.seasons where league = ${league} and provider_season_id = ${season.providerSeasonId}`;
  if (existing) {
    await db`update public.seasons set
               starts_on = coalesce(${season.startsOn ?? null}::date, starts_on),
               ends_on = coalesce(${season.endsOn ?? null}::date, ends_on)
             where id = ${existing.id}`;
    return existing.id;
  }
  const [inserted] = await db<{ id: string }[]>`
    insert into public.seasons (league, year, type, provider_season_id, starts_on, ends_on)
    values (${league}, ${season.year}, ${season.type}::public.season_type, ${season.providerSeasonId},
            ${season.startsOn ?? null}, ${season.endsOn ?? null})
    on conflict (league, year, type) do nothing
    returning id`;
  if (inserted) return inserted.id;
  const [clash] = await db<{ id: string; providerSeasonId: string }[]>`
    select id, provider_season_id as "providerSeasonId" from public.seasons
    where league = ${league} and year = ${season.year} and type = ${season.type}::public.season_type`;
  log?.warn(
    { league, season, stored: clash?.providerSeasonId, metric: 'season_provider_id_clash' },
    'season (league, year, type) already exists under another provider id; not linked',
  );
  return null;
}

export interface TournamentFacts {
  providerTournamentId: string;
  name: string;
  location: string | null;
  status: string | null;
  startsOn: string | null;
  endsOn: string | null;
  providerParentId: string | null;
}

export async function ensureTournament(
  db: Sql,
  league: LeagueCode,
  seasonId: string | null,
  t: TournamentFacts,
): Promise<string> {
  const [row] = await db<{ id: string }[]>`
    insert into public.tournaments (league, season_id, provider_tournament_id, name, location, starts_on, ends_on, status, provider_parent_id)
    values (${league}, ${seasonId}, ${t.providerTournamentId}, ${t.name}, ${t.location}, ${t.startsOn}, ${t.endsOn}, ${t.status}, ${t.providerParentId})
    on conflict (league, provider_tournament_id) do update
      set season_id = coalesce(excluded.season_id, public.tournaments.season_id),
          name = excluded.name,
          location = coalesce(excluded.location, public.tournaments.location),
          starts_on = coalesce(excluded.starts_on, public.tournaments.starts_on),
          ends_on = coalesce(excluded.ends_on, public.tournaments.ends_on),
          status = coalesce(excluded.status, public.tournaments.status),
          provider_parent_id = coalesce(excluded.provider_parent_id, public.tournaments.provider_parent_id)
    returning id`;
  if (!row) throw new Error(`tournament upsert failed for ${t.providerTournamentId}`);
  return row.id;
}

/* ------------------------------------------------------------------------- */
/* Players                                                                    */
/* ------------------------------------------------------------------------- */

/** Follow players.merged_into to the surviving row (bounded; mergePlayers keeps chains at depth 1). */
export async function resolveCanonical(db: Sql, playerId: string): Promise<string> {
  let id = playerId;
  for (let i = 0; i < 8; i++) {
    const [row] = await db<{ mergedInto: string | null }[]>`
      select merged_into as "mergedInto" from public.players where id = ${id}`;
    if (!row || row.mergedInto === null) return id;
    id = row.mergedInto;
  }
  throw new Error(`players.merged_into chain too deep from ${playerId}`);
}

/** Canonical player id for a provider id in a league, or null when unknown. */
export async function playerIdFor(
  db: Sql,
  league: LeagueCode,
  externalId: string,
): Promise<string | null> {
  const [row] = await db<{ playerId: string }[]>`
    select player_id as "playerId" from public.player_external_ids
    where provider = ${PROVIDER} and league = ${league} and external_id = ${externalId}`;
  return row ? resolveCanonical(db, row.playerId) : null;
}

/** Canonical ids for many provider ids of one league (unknown ids are absent from the map). */
export async function playerIdsFor(
  db: Sql,
  league: LeagueCode,
  externalIds: string[],
): Promise<Map<string, string>> {
  if (externalIds.length === 0) return new Map();
  const rows = await db<{ externalId: string; playerId: string; mergedInto: string | null }[]>`
    select e.external_id as "externalId", e.player_id as "playerId", p.merged_into as "mergedInto"
    from public.player_external_ids e join public.players p on p.id = e.player_id
    where e.provider = ${PROVIDER} and e.league = ${league} and e.external_id = any(${externalIds})`;
  const out = new Map<string, string>();
  for (const r of rows) {
    out.set(
      r.externalId,
      r.mergedInto === null ? r.playerId : await resolveCanonical(db, r.playerId),
    );
  }
  return out;
}

/**
 * Make sure every player a game document names has a canonical row, creating
 * missing ones with source `game`. Existing rows are not updated by game
 * feeds (a profile is the authority on names and attributes); blanks are
 * filled. Returns provider id -> canonical id.
 */
export async function ensurePlayers(
  db: Db,
  league: LeagueCode,
  players: DocumentPlayer[],
): Promise<Map<string, string>> {
  const ids = [...new Set(players.map((p) => p.providerPlayerId))];
  const known = await playerIdsFor(db, league, ids);
  const missing = players.filter((p) => !known.has(p.providerPlayerId));
  if (missing.length === 0) return known;
  return db.begin(async (tx) => {
    const out = new Map(known);
    for (const p of missing) {
      if (out.has(p.providerPlayerId)) continue;
      // Someone may have inserted it since the lookup: re-check under the transaction.
      const again = await playerIdFor(tx, league, p.providerPlayerId);
      if (again) {
        out.set(p.providerPlayerId, again);
        continue;
      }
      const fullName = p.fullName ?? `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim();
      const [row] = await tx<{ id: string }[]>`
        insert into public.players (full_name, first_name, last_name, jersey, position)
        values (${fullName || p.providerPlayerId}, ${p.firstName}, ${p.lastName}, ${p.jersey}, ${p.position})
        returning id`;
      if (!row) throw new Error('players insert returned no row');
      const [linked] = await tx<{ playerId: string }[]>`
        insert into public.player_external_ids (provider, league, external_id, player_id, id_type, source)
        values (${PROVIDER}, ${league}, ${p.providerPlayerId}, ${row.id}, 'league_profile', 'game')
        on conflict (provider, league, external_id) do nothing
        returning player_id as "playerId"`;
      if (linked) {
        out.set(p.providerPlayerId, row.id);
        continue;
      }
      // Lost a race with a concurrent writer: drop the row we made and use theirs.
      await tx`delete from public.players where id = ${row.id}`;
      const winner = await playerIdFor(tx, league, p.providerPlayerId);
      if (!winner) throw new Error(`player ${league}:${p.providerPlayerId} vanished mid-insert`);
      out.set(p.providerPlayerId, winner);
    }
    return out;
  }) as Promise<Map<string, string>>;
}

export interface ExternalIdRow {
  provider: string;
  league: LeagueCode;
  externalId: string;
  idType: string | null;
  source: string;
}

export async function externalIdsOf(db: Sql, playerId: string): Promise<ExternalIdRow[]> {
  return db<ExternalIdRow[]>`
    select provider, league, external_id as "externalId", id_type as "idType", source
    from public.player_external_ids where player_id = ${playerId}
    order by league, id_type, external_id`;
}

export interface MergeResult {
  survivor: string;
  loser: string;
  repoint: RepointCounts;
}

/**
 * Merge two canonical players. Survivor = the older row (created_at, then id),
 * so the outcome does not depend on which profile arrived first. External ids
 * move to the survivor; every FK that referenced the loser is repointed by
 * apply-changes.ts (rows that would collide with the survivor's are dropped and
 * counted); the survivor's blank attributes are filled from the loser; the
 * loser is tombstoned and any tombstone that pointed at the loser is flattened
 * onto the survivor so `merged_into` chains never exceed depth 1.
 */
export async function mergePlayers(
  tx: TransactionSql,
  a: string,
  b: string,
  log?: Logger,
): Promise<MergeResult> {
  if (a === b) throw new Error(`mergePlayers: ${a} with itself`);
  const rows = await tx<{ id: string; createdAt: Date }[]>`
    select id, created_at as "createdAt" from public.players where id in (${a}, ${b}) and merged_into is null
    order by created_at, id`;
  if (rows.length !== 2) throw new Error(`mergePlayers: ${a} / ${b} are not two canonical rows`);
  const survivor = rows[0]?.id;
  const loser = rows[1]?.id;
  if (!survivor || !loser) throw new Error('mergePlayers: unreachable');
  await tx`update public.player_external_ids set player_id = ${survivor} where player_id = ${loser}`;
  const repoint = await repointPlayerReferences(tx, loser, survivor);
  const dropped =
    repoint.gamePlayerStats.dropped +
    repoint.playerSeasonStats.dropped +
    repoint.playerTeamSeasons.dropped;
  if (dropped > 0) {
    log?.warn(
      { survivor, loser, repoint, metric: 'merge_rows_dropped' },
      "identity merge dropped rows that collided with the survivor's",
    );
  }
  // Fill the survivor's blanks from the loser, then tombstone the loser.
  await tx`update public.players s set
             first_name = coalesce(s.first_name, l.first_name), last_name = coalesce(s.last_name, l.last_name),
             birthdate = coalesce(s.birthdate, l.birthdate), height_in = coalesce(s.height_in, l.height_in),
             weight_lb = coalesce(s.weight_lb, l.weight_lb), position = coalesce(s.position, l.position),
             college = coalesce(s.college, l.college), headshot_url = coalesce(s.headshot_url, l.headshot_url),
             jersey = coalesce(s.jersey, l.jersey), status = coalesce(s.status, l.status)
           from public.players l where s.id = ${survivor} and l.id = ${loser}`;
  await tx`update public.players set merged_into = ${survivor}, updated_at = now()
           where id = ${loser} or merged_into = ${loser}`;
  log?.info({ survivor, loser, repoint }, 'players merged');
  return { survivor, loser, repoint };
}

interface ExternalRef {
  league: LeagueCode;
  externalId: string;
  idType: string;
  source: 'profile' | 'reference';
}

/** The canonical player an external id currently resolves to, or null when the id is unknown. */
async function resolveRef(tx: TransactionSql, ref: ExternalRef): Promise<string | null> {
  const [existing] = await tx<{ playerId: string; idType: string | null }[]>`
    select player_id as "playerId", id_type as "idType" from public.player_external_ids
    where provider = ${PROVIDER} and league = ${ref.league} and external_id = ${ref.externalId}`;
  if (!existing) return null;
  return resolveCanonical(tx, existing.playerId);
}

/**
 * Link an external id to a canonical player. If the id already belongs to a
 * different canonical row, the two are merged and the survivor is returned.
 */
async function linkExternalId(
  tx: TransactionSql,
  playerId: string,
  ref: ExternalRef,
  log?: Logger,
): Promise<{ playerId: string; merge: MergeResult | null }> {
  const [existing] = await tx<{ playerId: string; idType: string | null }[]>`
    select player_id as "playerId", id_type as "idType" from public.player_external_ids
    where provider = ${PROVIDER} and league = ${ref.league} and external_id = ${ref.externalId}`;
  if (!existing) {
    await tx`insert into public.player_external_ids (provider, league, external_id, player_id, id_type, source)
             values (${PROVIDER}, ${ref.league}, ${ref.externalId}, ${playerId}, ${ref.idType}, ${ref.source})`;
    return { playerId, merge: null };
  }
  if (existing.idType !== null && existing.idType !== ref.idType && ref.source !== 'profile') {
    // The key is (provider, league, external_id); a reference naming a stored id under another
    // type is linked (it is the same string) but reported, since the type will not be rewritten.
    log?.warn(
      { ref, stored: existing.idType },
      'external id already stored under a different id_type; stored type kept',
    );
  }
  const other = await resolveCanonical(tx, existing.playerId);
  // A profile owns its id: upgrade a game-sourced row; references never downgrade a profile row.
  if (ref.source === 'profile') {
    await tx`update public.player_external_ids set source = 'profile', id_type = ${ref.idType}
             where provider = ${PROVIDER} and league = ${ref.league} and external_id = ${ref.externalId} and source <> 'profile'`;
  }
  if (other === playerId) return { playerId, merge: null };
  const merge = await mergePlayers(tx, playerId, other, log);
  return { playerId: merge.survivor, merge };
}

export interface ProfileResult {
  playerId: string;
  /** Canonical rows that were folded into playerId by this profile. */
  mergedFrom: string[];
  /** Rows of merge losers dropped because the survivor already owned the same key (see repointPlayerReferences). */
  dropped: { gamePlayerStats: number; playerSeasonStats: number; playerTeamSeasons: number };
  externalIds: ExternalIdRow[];
  seasonLines: number;
}

/**
 * Apply a player profile document from `league`: canonical row, attributes,
 * references, seasons and season lines. Deterministic and idempotent. The
 * profile's own id and every reference are resolved before anything is
 * written: a row is created only when none of them is known, and a merge
 * happens only when they resolve to two distinct existing rows.
 */
export async function applyPlayerProfile(
  db: Db,
  league: LeagueCode,
  doc: PlayerProfileDocument,
  log?: Logger,
): Promise<ProfileResult> {
  return db.begin(async (tx) => {
    const mergedFrom: string[] = [];
    const dropped = { gamePlayerStats: 0, playerSeasonStats: 0, playerTeamSeasons: 0 };
    const noteMerge = (m: MergeResult | null) => {
      if (!m) return;
      mergedFrom.push(m.loser);
      dropped.gamePlayerStats += m.repoint.gamePlayerStats.dropped;
      dropped.playerSeasonStats += m.repoint.playerSeasonStats.dropped;
      dropped.playerTeamSeasons += m.repoint.playerTeamSeasons.dropped;
    };

    // 1. Every id the profile carries: its own, then references (league profiles under their
    //    league, the sport profile under ours).
    const refs: ExternalRef[] = [
      { league, externalId: doc.id, idType: 'league_profile', source: 'profile' },
    ];
    const sportIds: string[] = [];
    for (const ref of doc.references ?? []) {
      if (ref.id_type === 'sport_profile') {
        refs.push({
          league,
          externalId: ref.source_id,
          idType: 'sport_profile',
          source: 'reference',
        });
        sportIds.push(ref.source_id);
        continue;
      }
      const scoped = SCOPE_TO_LEAGUE[ref.scope.toUpperCase()];
      if (!scoped) {
        log?.info(
          { league, playerId: doc.id, ref },
          'profile reference with unknown scope skipped',
        );
        continue;
      }
      refs.push({
        league: scoped,
        externalId: ref.source_id,
        idType: ref.id_type,
        source: 'reference',
      });
    }

    // 2. Resolve first, write nothing: the canonical rows these ids already belong to.
    const known = new Set<string>();
    for (const ref of refs) {
      const id = await resolveRef(tx, ref);
      if (id) known.add(id);
    }
    // The same sport-wide id seen from another league's profile is the same person.
    for (const sportId of sportIds) {
      const peers = await tx<{ playerId: string }[]>`
        select player_id as "playerId" from public.player_external_ids
        where provider = ${PROVIDER} and id_type = 'sport_profile' and external_id = ${sportId} and league <> ${league}`;
      for (const peer of peers) known.add(await resolveCanonical(tx, peer.playerId));
    }
    let playerId = [...known][0] ?? null;
    if (!playerId) {
      const [row] = await tx<{ id: string }[]>`
        insert into public.players (full_name) values (${doc.full_name}) returning id`;
      if (!row) throw new Error('players insert returned no row');
      playerId = row.id;
    }

    // 3. Link: inserts the ids that were unknown, upgrades the own id to source=profile, and
    //    merges when an id belongs to another of the known rows.
    for (const ref of refs) {
      const linked = await linkExternalId(tx, playerId, ref, log);
      noteMerge(linked.merge);
      playerId = linked.playerId;
    }
    for (const id of known) {
      const other = await resolveCanonical(tx, id);
      if (other === playerId) continue;
      const merge = await mergePlayers(tx, playerId, other, log);
      noteMerge(merge);
      playerId = merge.survivor;
    }

    // 4. Attributes: the profile is the authority on what it carries; omissions keep stored values.
    await tx`update public.players set
               full_name = ${doc.full_name},
               first_name = coalesce(${doc.first_name ?? null}, first_name),
               last_name = coalesce(${doc.last_name ?? null}, last_name),
               birthdate = coalesce(${doc.birthdate ?? null}::date, birthdate),
               height_in = coalesce(${doc.height ?? null}, height_in),
               weight_lb = coalesce(${doc.weight ?? null}, weight_lb),
               position = coalesce(${doc.position ?? null}, position),
               college = coalesce(${doc.college ?? null}, college),
               jersey = coalesce(${doc.jersey_number ?? null}, jersey),
               status = coalesce(${doc.status ?? null}, status),
               provider_updated_at = coalesce(${doc.updated ?? null}::timestamptz, provider_updated_at)
             where id = ${playerId}`;

    // 5. Seasons, team seasons, season lines.
    let seasonLines = 0;
    for (const s of doc.seasons ?? []) {
      const seasonId = await ensureSeason(
        tx,
        league,
        { providerSeasonId: s.id, year: s.year, type: s.type },
        log,
      );
      if (!seasonId) continue;
      const teamIds = await ensureTeams(
        tx,
        league,
        s.teams.map((t) => ({
          providerTeamId: t.id,
          name: t.name,
          market: t.market ?? null,
          alias: t.alias ?? null,
        })),
      );
      const lines: PlayerSeasonLine[] = [];
      for (const t of s.teams) {
        const teamId = teamIds.get(t.id);
        if (!teamId) continue;
        await tx`insert into public.player_team_seasons (player_id, team_id, season_id, jersey)
                 values (${playerId}, ${teamId}, ${seasonId}, ${doc.jersey_number ?? null})
                 on conflict (player_id, team_id, season_id) do update
                   set jersey = coalesce(excluded.jersey, public.player_team_seasons.jersey)`;
        if (t.total || t.average) {
          lines.push({
            playerId,
            seasonId,
            teamId,
            total: t.total ?? {},
            average: t.average ?? null,
          });
        }
      }
      seasonLines += await applyPlayerSeasonStats(tx, lines);
    }

    return {
      playerId,
      mergedFrom,
      dropped,
      externalIds: await externalIdsOf(tx, playerId),
      seasonLines,
    };
  }) as Promise<ProfileResult>;
}
