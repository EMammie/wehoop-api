import type { TransactionSql } from 'postgres';
import type { Db } from '../db/client.js';
import type { LeagueCode } from '../leagues/codes.js';
import type { Logger } from '../logger.js';
import type { PlayerProfileDocument } from '../providers/sportradar/schemas/profile.js';
import {
  applyPlayerSeasonStats,
  type MergeConflict,
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
 * id_type `sport_profile`. A profile first resolves every id it carries and
 * writes nothing until it has; it creates a row only when none resolves, and
 * when ids resolve to two distinct canonical rows the two are MERGED: the
 * survivor is the older row (created_at, then id: deterministic for any
 * replay order), the loser gets `merged_into` (earlier tombstones pointing at
 * the loser are flattened onto the survivor, so chains stay depth 1), every
 * FK that referenced the loser is repointed in the same transaction, and the
 * merge is recorded in ingest.player_merges with the reference that triggered
 * it and the full content of any loser row that had to be dropped. Only
 * references in a known league scope with a supported id type are linked
 * automatically; anything ambiguous (unknown scope or type, an id stored under
 * another type, an id owned by a tombstone, two provider profiles of one
 * league ending up on one person) is HELD in ingest.player_merge_holds and
 * never merged. Canonical uuids never enter change bodies or content hashes,
 * so a merge never rewrites history. Re-applying the same profile is a no-op.
 *
 * None of this is live-game state: nothing here writes games, play_events,
 * game_changes, game_periods or the stats tables; the merge repoint of those
 * and the season lines go through apply-changes.ts (repointPlayerReferences,
 * applyPlayerSeasonStats). player_team_seasons is roster data outside that
 * single-writer rule and is written here only (ensurePlayerTeamSeason and the
 * merge repoint); reference.ts calls ensurePlayerTeamSeason.
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

/**
 * Reference id types identity.ts links automatically. `league_profile` is a
 * player id in the referenced league's own id space, `sport_profile` the
 * sport-wide id that profiles of every league carry, `external` a provider-side
 * external id scoped to a league (present in the WNBA docs sample). Anything
 * else is held (ingest.player_merge_holds), never linked.
 */
export const SUPPORTED_ID_TYPES: ReadonlySet<string> = new Set([
  'league_profile',
  'sport_profile',
  'external',
]);

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

/* ------------------------------------------------------------------------- */
/* Roster data (player_team_seasons): reference data outside the live-game    */
/* single-writer rule. This is its only writer besides mergePlayers below.    */
/* ------------------------------------------------------------------------- */

export interface PlayerTeamSeasonFacts {
  playerId: string;
  teamId: string;
  seasonId: string;
  jersey?: string | null | undefined;
  status?: string | null | undefined;
}

/** Upsert a roster membership; omitted facts never overwrite stored ones. */
export async function ensurePlayerTeamSeason(db: Sql, f: PlayerTeamSeasonFacts): Promise<void> {
  await db`insert into public.player_team_seasons (player_id, team_id, season_id, jersey, status)
           values (${f.playerId}, ${f.teamId}, ${f.seasonId}, ${f.jersey ?? null}, ${f.status ?? null})
           on conflict (player_id, team_id, season_id) do update
             set jersey = coalesce(excluded.jersey, public.player_team_seasons.jersey),
                 status = coalesce(excluded.status, public.player_team_seasons.status)`;
}

async function repointPlayerTeamSeasons(
  tx: TransactionSql,
  loser: string,
  survivor: string,
): Promise<{ repointed: number; dropped: number; conflicts: MergeConflict[] }> {
  const moved =
    await tx`update public.player_team_seasons s set player_id = ${survivor}, updated_at = now()
                         where s.player_id = ${loser}
                           and not exists (select 1 from public.player_team_seasons t
                                           where t.player_id = ${survivor} and t.team_id = s.team_id and t.season_id = s.season_id)`;
  const dropped = await tx<{ row: Record<string, unknown> }[]>`
    delete from public.player_team_seasons s where s.player_id = ${loser} returning to_jsonb(s) as row`;
  return {
    repointed: moved.count,
    dropped: dropped.length,
    conflicts: dropped.map((d) => ({ table: 'player_team_seasons', row: d.row })),
  };
}

/* ------------------------------------------------------------------------- */
/* Merges, provenance and holds                                               */
/* ------------------------------------------------------------------------- */

export type MergeTriggerSource = 'profile' | 'reference' | 'game' | 'manual';

/** What caused a merge or a hold: the document and the reference entry inside it. */
export interface MergeTrigger {
  league: LeagueCode;
  feed: 'player_profile' | 'manual';
  documentId: string | null;
  source: MergeTriggerSource;
  /** The references[] entry as the provider sent it, or the equivalent built from the document's own id. */
  reference: Record<string, unknown>;
  runId: number | null;
}

export interface MergeResult {
  survivor: string;
  loser: string;
  /** ingest.player_merges.id */
  mergeId: string;
  repoint: RepointCounts;
  /** Loser rows dropped because the survivor owned the same key; persisted in player_merges.conflicts. */
  conflicts: MergeConflict[];
}

/**
 * Merge two canonical players. Survivor = the older row (created_at, then id),
 * so the outcome does not depend on which profile arrived first. External ids
 * move to the survivor; play_events, game_player_stats and player_season_stats
 * are repointed by apply-changes.ts and player_team_seasons here; a season line
 * or team season of the loser whose key the survivor already owns is dropped
 * but its full content is kept in ingest.player_merges.conflicts, together
 * with the trigger (document + reference entry), so nothing a merge removes is
 * lost. game_player_stats is provider-keyed and never dropped. The survivor's
 * blank attributes are filled from the loser; the loser is tombstoned and any
 * tombstone that pointed at the loser is flattened onto the survivor so
 * `merged_into` chains never exceed depth 1.
 */
export async function mergePlayers(
  tx: TransactionSql,
  a: string,
  b: string,
  trigger: MergeTrigger,
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
  const owned = await repointPlayerReferences(tx, loser, survivor);
  const roster = await repointPlayerTeamSeasons(tx, loser, survivor);
  const repoint: RepointCounts = {
    ...owned.counts,
    playerTeamSeasons: { repointed: roster.repointed, dropped: roster.dropped },
  };
  const conflicts = [...owned.conflicts, ...roster.conflicts];
  const [merge] = await tx<{ id: string }[]>`
    insert into ingest.player_merges (survivor_id, loser_id, league, trigger_feed, trigger_document_id,
      trigger_source, trigger_reference, run_id, repoint, conflicts)
    values (${survivor}, ${loser}, ${trigger.league}, ${trigger.feed}, ${trigger.documentId}, ${trigger.source},
      ${tx.json(trigger.reference as never)}, ${trigger.runId}, ${tx.json(repoint as never)},
      ${tx.json(conflicts as never)})
    returning id`;
  if (!merge) throw new Error('player_merges insert returned no row');
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
  if (conflicts.length > 0) {
    log?.warn(
      {
        survivor,
        loser,
        mergeId: merge.id,
        conflicts: conflicts.length,
        metric: 'merge_conflicts',
      },
      'identity merge dropped loser rows that collided with the survivor; content kept in ingest.player_merges',
    );
  }
  log?.info({ survivor, loser, mergeId: merge.id, repoint, trigger }, 'players merged');
  return { survivor, loser, mergeId: merge.id, repoint, conflicts };
}

export type HoldReason =
  | 'unknown_scope'
  | 'unknown_id_type'
  | 'id_type_mismatch'
  | 'tombstone_owner'
  | 'conflicting_profiles';

export interface Hold {
  reason: HoldReason;
  reference: Record<string, unknown>;
  candidateIds: string[];
  detail?: Record<string, unknown>;
}

/** Record a reference identity.ts refuses to act on; re-applying the document never duplicates an open hold. */
async function holdReference(
  tx: TransactionSql,
  trigger: Omit<MergeTrigger, 'source' | 'reference'> & { documentId: string },
  hold: Hold,
  log?: Logger,
): Promise<void> {
  await tx`insert into ingest.player_merge_holds (league, trigger_feed, trigger_document_id, trigger_reference,
             reason, candidate_ids, detail, run_id)
           values (${trigger.league}, ${trigger.feed}, ${trigger.documentId}, ${tx.json(hold.reference as never)},
             ${hold.reason}, ${hold.candidateIds}::uuid[], ${hold.detail ? tx.json(hold.detail as never) : null},
             ${trigger.runId})
           on conflict (league, trigger_feed, trigger_document_id, trigger_reference, reason)
             where status = 'open' do nothing`;
  log?.warn(
    { league: trigger.league, documentId: trigger.documentId, ...hold, metric: 'merge_held' },
    'identity reference held for reconciliation',
  );
}

/* ------------------------------------------------------------------------- */
/* Player profiles                                                            */
/* ------------------------------------------------------------------------- */

interface ExternalRef {
  league: LeagueCode;
  externalId: string;
  idType: string;
  source: 'profile' | 'reference';
  /** The entry as the provider sent it (for provenance). */
  raw: Record<string, unknown>;
}

/**
 * A profile-level id claim: one person may own at most one profile-owned
 * `league_profile` id per league and at most one `sport_profile` id overall.
 * `league` is where the row stores the id: for a sport-wide id that is the
 * league of the profile that carried it, which is why sport ids are compared
 * without it.
 */
interface ProfileClaim {
  league: LeagueCode;
  idType: 'league_profile' | 'sport_profile';
  externalId: string;
}

function claimConflicts(a: ProfileClaim[], b: ProfileClaim[]): ProfileClaim[] {
  const out: ProfileClaim[] = [];
  for (const x of a)
    for (const y of b)
      if (
        x.idType === y.idType &&
        x.externalId !== y.externalId &&
        (x.idType === 'sport_profile' || x.league === y.league)
      )
        out.push(y);
  return out;
}

/** The ids of a row that a merge may never duplicate: profile-owned league ids and sport-wide ids. */
async function profileClaimsOf(tx: TransactionSql, playerId: string): Promise<ProfileClaim[]> {
  return tx<ProfileClaim[]>`
    select league, id_type as "idType", external_id as "externalId" from public.player_external_ids
    where player_id = ${playerId} and provider = ${PROVIDER}
      and ((id_type = 'league_profile' and source = 'profile') or id_type = 'sport_profile')`;
}

export interface ProfileResult {
  /** The canonical row the profile was applied to; null when the document's own id was held. */
  playerId: string | null;
  /** Canonical rows that were folded into playerId by this profile. */
  mergedFrom: string[];
  merges: MergeResult[];
  /** References held for reconciliation (ingest.player_merge_holds) instead of linked or merged. */
  held: Hold[];
  externalIds: ExternalIdRow[];
  seasonLines: number;
}

export interface ProfileOptions {
  /** ingest.ingestion_runs.id attributed on merge and hold rows. */
  runId?: number | null;
}

/**
 * Apply a player profile document from `league`: canonical row, attributes,
 * references, seasons and season lines. Deterministic and idempotent. The
 * profile's own id and every reference are RESOLVED before anything is
 * written; then:
 * - a reference with an unknown scope or id type, an id stored under another
 *   id type, or an id owned by a tombstone is HELD (never linked);
 * - the profile lands on the row its own id resolves to, else on the oldest
 *   row a reference resolves to, else on a new row;
 * - every other row a reference resolves to is MERGED into it, with the
 *   reference recorded as the trigger, unless the two rows (plus this
 *   document's own claims) would give one person two provider profiles in
 *   one league or two sport-wide ids: that is a contradiction in the
 *   provider's data and is held as `conflicting_profiles`;
 * - ids nobody knew are linked to the row.
 */
export async function applyPlayerProfile(
  db: Db,
  league: LeagueCode,
  doc: PlayerProfileDocument,
  log?: Logger,
  opts: ProfileOptions = {},
): Promise<ProfileResult> {
  return db.begin(async (tx) => {
    const trigger = {
      league,
      feed: 'player_profile' as const,
      documentId: doc.id,
      runId: opts.runId ?? null,
    };
    const held: Hold[] = [];
    const hold = async (h: Hold) => {
      held.push(h);
      await holdReference(tx, trigger, h, log);
    };

    // 1. Every id the profile carries, classified: the own id, then references (league profiles
    //    under their league, the sport profile under ours).
    const own: ExternalRef = {
      league,
      externalId: doc.id,
      idType: 'league_profile',
      source: 'profile',
      raw: { scope: league, id_type: 'league_profile', source_id: doc.id },
    };
    const refs: ExternalRef[] = [];
    for (const ref of doc.references ?? []) {
      const raw = { scope: ref.scope, id_type: ref.id_type, source_id: ref.source_id };
      if (!SUPPORTED_ID_TYPES.has(ref.id_type)) {
        await hold({ reason: 'unknown_id_type', reference: raw, candidateIds: [] });
        continue;
      }
      if (ref.id_type === 'sport_profile') {
        refs.push({
          league,
          externalId: ref.source_id,
          idType: 'sport_profile',
          source: 'reference',
          raw,
        });
        continue;
      }
      const scoped = SCOPE_TO_LEAGUE[ref.scope.toUpperCase()];
      if (!scoped) {
        await hold({ reason: 'unknown_scope', reference: raw, candidateIds: [] });
        continue;
      }
      refs.push({
        league: scoped,
        externalId: ref.source_id,
        idType: ref.id_type,
        source: 'reference',
        raw,
      });
    }
    const claims: ProfileClaim[] = [
      { league, idType: 'league_profile', externalId: doc.id },
      ...refs
        .filter((r) => r.idType === 'sport_profile')
        .map((r) => ({ league, idType: 'sport_profile' as const, externalId: r.externalId })),
    ];

    // 2. Resolve, write nothing. A stored id under another type or owned by a tombstone is held.
    const resolve = async (ref: ExternalRef): Promise<string | null | 'held'> => {
      const [stored] = await tx<
        { playerId: string; idType: string | null; mergedInto: string | null }[]
      >`
        select e.player_id as "playerId", e.id_type as "idType", p.merged_into as "mergedInto"
        from public.player_external_ids e join public.players p on p.id = e.player_id
        where e.provider = ${PROVIDER} and e.league = ${ref.league} and e.external_id = ${ref.externalId}`;
      if (!stored) return null;
      if (stored.mergedInto !== null) {
        await hold({
          reason: 'tombstone_owner',
          reference: ref.raw,
          candidateIds: [stored.playerId, stored.mergedInto],
          detail: { storedPlayerId: stored.playerId, mergedInto: stored.mergedInto },
        });
        return 'held';
      }
      if (stored.idType !== null && stored.idType !== ref.idType) {
        await hold({
          reason: 'id_type_mismatch',
          reference: ref.raw,
          candidateIds: [stored.playerId],
          detail: { storedIdType: stored.idType },
        });
        return 'held';
      }
      return stored.playerId;
    };
    const ownRow = await resolve(own);
    if (ownRow === 'held') {
      log?.warn({ league, playerId: doc.id }, 'profile skipped: its own id is held');
      return { playerId: null, mergedFrom: [], merges: [], held, externalIds: [], seasonLines: 0 };
    }
    /** canonical row -> the references of this document that resolved to it */
    const candidates = new Map<string, ExternalRef[]>();
    const unresolved: ExternalRef[] = [];
    const note = (id: string, ref: ExternalRef) => {
      if (id === ownRow) return;
      candidates.set(id, [...(candidates.get(id) ?? []), ref]);
    };
    for (const ref of refs) {
      const id = await resolve(ref);
      if (id === 'held') continue;
      if (id === null) unresolved.push(ref);
      else note(id, ref);
      // The same sport-wide id seen from another league's profile is the same person.
      if (ref.idType === 'sport_profile') {
        const peers = await tx<{ playerId: string; mergedInto: string | null }[]>`
          select e.player_id as "playerId", p.merged_into as "mergedInto"
          from public.player_external_ids e join public.players p on p.id = e.player_id
          where e.provider = ${PROVIDER} and e.id_type = 'sport_profile' and e.external_id = ${ref.externalId}
            and e.league <> ${league}`;
        for (const peer of peers) {
          if (peer.mergedInto !== null) {
            await hold({
              reason: 'tombstone_owner',
              reference: ref.raw,
              candidateIds: [peer.playerId, peer.mergedInto],
              detail: { storedPlayerId: peer.playerId, mergedInto: peer.mergedInto },
            });
            continue;
          }
          note(peer.playerId, ref);
        }
      }
    }

    // 3. Home row: the own id's row, else the oldest candidate this document may claim, else new.
    const ordered = async (ids: string[]): Promise<string[]> =>
      ids.length === 0
        ? []
        : (
            await tx<{ id: string }[]>`
              select id from public.players where id = any(${ids}::uuid[]) order by created_at, id`
          ).map((r) => r.id);
    let playerId: string | null = ownRow;
    const mergedFrom: string[] = [];
    const merges: MergeResult[] = [];
    const absorb = async (other: string, viaRefs: ExternalRef[]): Promise<boolean> => {
      if (!playerId) throw new Error('absorb before a home row exists');
      const conflicts = claimConflicts(
        [...claims, ...(await profileClaimsOf(tx, playerId))],
        await profileClaimsOf(tx, other),
      );
      const via = viaRefs[0] ?? own;
      if (conflicts.length > 0) {
        await hold({
          reason: 'conflicting_profiles',
          reference: via.raw,
          candidateIds: [playerId, other],
          detail: { conflicts },
        });
        return false;
      }
      const m = await mergePlayers(
        tx,
        playerId,
        other,
        { ...trigger, source: via.source, reference: via.raw },
        log,
      );
      mergedFrom.push(m.loser);
      merges.push(m);
      playerId = m.survivor;
      return true;
    };
    if (!playerId) {
      for (const id of await ordered([...candidates.keys()])) {
        const conflicts = claimConflicts(claims, await profileClaimsOf(tx, id));
        if (conflicts.length === 0) {
          playerId = id;
          candidates.delete(id);
          break;
        }
        const via = candidates.get(id)?.[0] ?? own;
        await hold({
          reason: 'conflicting_profiles',
          reference: via.raw,
          candidateIds: [id],
          detail: { conflicts },
        });
        candidates.delete(id);
      }
    }
    if (!playerId) {
      const [row] = await tx<{ id: string }[]>`
        insert into public.players (full_name) values (${doc.full_name}) returning id`;
      if (!row) throw new Error('players insert returned no row');
      playerId = row.id;
    }
    // The own id is this document's: insert it, or upgrade a game/reference-sourced row to profile.
    const [ownLinked] = await tx<{ playerId: string }[]>`
      insert into public.player_external_ids (provider, league, external_id, player_id, id_type, source)
      values (${PROVIDER}, ${league}, ${doc.id}, ${playerId}, 'league_profile', 'profile')
      on conflict (provider, league, external_id) do update set source = 'profile'
      returning player_id as "playerId"`;
    if (ownLinked && ownLinked.playerId !== playerId) {
      // Lost a race: another writer linked our id since we resolved it. Treat its row as a candidate.
      const theirs = await resolveCanonical(tx, ownLinked.playerId);
      if (theirs !== playerId) {
        await tx`update public.player_external_ids set player_id = ${playerId}
                 where provider = ${PROVIDER} and league = ${league} and external_id = ${doc.id}`;
        note(theirs, own);
      }
    }

    // 4. Merge every other row a reference resolved to (oldest first: deterministic), then link
    //    the ids nobody knew. A link that loses a race re-resolves and is absorbed the same way.
    for (const id of await ordered([...candidates.keys()])) {
      const viaRefs = candidates.get(id) ?? [];
      if ((await resolveCanonical(tx, id)) === playerId) continue; // folded by an earlier merge
      await absorb(id, viaRefs);
    }
    for (const ref of unresolved) {
      const [linked] = await tx<{ playerId: string }[]>`
        insert into public.player_external_ids (provider, league, external_id, player_id, id_type, source)
        values (${PROVIDER}, ${ref.league}, ${ref.externalId}, ${playerId}, ${ref.idType}, ${ref.source})
        on conflict (provider, league, external_id) do nothing
        returning player_id as "playerId"`;
      if (linked) continue;
      const theirs = await resolve(ref);
      if (theirs === 'held' || theirs === null || theirs === playerId) continue;
      await absorb(await resolveCanonical(tx, theirs), [ref]);
    }

    // 5. Attributes: the profile is the authority on what it carries; omissions keep stored values.
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

    // 6. Seasons, team seasons, season lines.
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
        await ensurePlayerTeamSeason(tx, { playerId, teamId, seasonId, jersey: doc.jersey_number });
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
      merges,
      held,
      externalIds: await externalIdsOf(tx, playerId),
      seasonLines,
    };
  }) as Promise<ProfileResult>;
}
