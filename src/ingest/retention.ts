import type { Db } from '../db/client.js';
import type { Logger } from '../logger.js';

/**
 * Retention job (plan §2 `games.retained_from_seq`, §9 "game_changes growth";
 * CLAUDE.md non-negotiable 5). For a closed game whose history has been quiet
 * since `closedBefore`, move `retained_from_seq` to `last_seq + 1` and delete
 * the `game_changes` rows below it, together with their `broadcast_outbox`
 * rows (which must all be published: unpublished or dead rows make the game
 * ineligible until the publisher or `pnpm outbox requeue` has dealt with
 * them). `/changes` then answers `changes=[]` with `retainedFrom` set and the
 * client re-snapshots; `last_seq` never moves, so a later correction on the
 * closed game continues the same sequence.
 *
 * THIS IS THE ONLY CODE ALLOWED TO DELETE game_changes ROWS. The database
 * enforces it: `game_changes_append_only` (0001) refuses any UPDATE and any
 * DELETE of a row at or above `games.retained_from_seq`, so the floor must be
 * moved first, inside the same transaction, under the game row lock.
 * `broadcast_outbox` rows are removed explicitly before the changes they route,
 * even though 0002's composite FK (`broadcast_outbox_routes_its_change`) is
 * ON DELETE CASCADE and would remove them anyway: the publication check and the
 * delete count must be visible in the result, not implied by a cascade.
 *
 * `ingest.play_event_raw` (the provider payload copy behind each play) is kept
 * for `rawRetentionDays` after its last revision for closed games; `pnpm sim
 * inject --mutate-event` needs the raw copy, so it is only ever dropped for
 * games long closed.
 */
export interface RetentionOptions {
  /** Closed games whose newest change (or row update) is older than this are eligible. */
  closedBefore: Date;
  dryRun: boolean;
  /** play_event_raw rows of closed games older than this many days are deleted (default 30). */
  rawRetentionDays?: number;
  /** Restrict to these games (operator `--game`; tests). Every eligible closed game when omitted. */
  gameIds?: string[];
  now?: () => Date;
}

export interface RetainedGame {
  gameId: string;
  /** The new `retained_from_seq` (= last_seq + 1). */
  floor: number;
  deletedChanges: number;
  deletedOutbox: number;
}

export type SkipReason = 'unpublished_outbox_rows' | 'dead_outbox_rows' | 'changed_since_selection';

export interface RetentionResult {
  dryRun: boolean;
  closedBefore: Date;
  candidates: number;
  retained: RetainedGame[];
  skipped: Array<{ gameId: string; reason: SkipReason; detail: string }>;
  rawDeleted: number;
}

export async function runRetention(
  db: Db,
  log: Logger,
  opts: RetentionOptions,
): Promise<RetentionResult> {
  const now = opts.now ?? (() => new Date());
  const rawDays = opts.rawRetentionDays ?? 30;
  const candidates = await db<{ id: string }[]>`
    select g.id
    from public.games g
    where g.status = 'closed'
      and g.last_seq >= g.retained_from_seq
      and coalesce((select max(c.created_at) from public.game_changes c where c.game_id = g.id), g.updated_at)
          < ${opts.closedBefore}
      and ${opts.gameIds ? db`g.id = any(${opts.gameIds}::uuid[])` : db`true`}
    order by g.scheduled_at, g.id`;
  const result: RetentionResult = {
    dryRun: opts.dryRun,
    closedBefore: opts.closedBefore,
    candidates: candidates.length,
    retained: [],
    skipped: [],
    rawDeleted: 0,
  };
  for (const { id: gameId } of candidates) {
    await db.begin(async (tx) => {
      const [g] = await tx<
        { lastSeq: string; floor: string; status: string; newest: Date | null }[]
      >`
        select g.last_seq::text as "lastSeq", g.retained_from_seq::text as floor, g.status::text as status,
               (select max(c.created_at) from public.game_changes c where c.game_id = g.id) as newest
        from public.games g where g.id = ${gameId} for update`;
      if (!g) return;
      const lastSeq = Number(g.lastSeq);
      if (g.status !== 'closed' || (g.newest !== null && g.newest >= opts.closedBefore)) {
        result.skipped.push({
          gameId,
          reason: 'changed_since_selection',
          detail: `status ${g.status}, newest change ${g.newest?.toISOString() ?? 'none'}`,
        });
        return;
      }
      const floor = lastSeq + 1;
      const [ob] = await tx<{ pending: number; dead: number; rows: number }[]>`
        select count(*) filter (where published_at is null and dead_at is null)::int as pending,
               count(dead_at)::int as dead,
               count(*)::int as rows
        from ingest.broadcast_outbox where game_id = ${gameId} and seq < ${floor}`;
      if ((ob?.pending ?? 0) > 0) {
        result.skipped.push({
          gameId,
          reason: 'unpublished_outbox_rows',
          detail: `${ob?.pending} outbox row(s) not yet published`,
        });
        return;
      }
      if ((ob?.dead ?? 0) > 0) {
        result.skipped.push({
          gameId,
          reason: 'dead_outbox_rows',
          detail: `${ob?.dead} dead outbox row(s); run pnpm outbox requeue --channel game:${gameId}`,
        });
        return;
      }
      const [cnt] = await tx<{ n: number }[]>`
        select count(*)::int as n from public.game_changes where game_id = ${gameId} and seq < ${floor}`;
      const changes = cnt?.n ?? 0;
      if (opts.dryRun) {
        result.retained.push({
          gameId,
          floor,
          deletedChanges: changes,
          deletedOutbox: ob?.rows ?? 0,
        });
        return;
      }
      // Floor first: the append-only trigger reads games.retained_from_seq on every delete.
      await tx`update public.games set retained_from_seq = ${floor} where id = ${gameId}`;
      const outbox =
        await tx`delete from ingest.broadcast_outbox where game_id = ${gameId} and seq < ${floor}`;
      const deleted =
        await tx`delete from public.game_changes where game_id = ${gameId} and seq < ${floor}`;
      result.retained.push({
        gameId,
        floor,
        deletedChanges: deleted.count,
        deletedOutbox: outbox.count,
      });
      log.info(
        { gameId, floor, deletedChanges: deleted.count, deletedOutbox: outbox.count },
        'history retained',
      );
    });
  }
  const rawCutoff = new Date(now().getTime() - rawDays * 86_400_000);
  if (opts.dryRun) {
    const [n] = await db<{ n: number }[]>`
      select count(*)::int as n
      from ingest.play_event_raw r
      join public.play_events p on p.id = r.play_event_id
      join public.games g on g.id = p.game_id
      where g.status = 'closed' and r.updated_at < ${rawCutoff}
        and ${opts.gameIds ? db`g.id = any(${opts.gameIds}::uuid[])` : db`true`}`;
    result.rawDeleted = n?.n ?? 0;
  } else {
    const deleted = await db`
      delete from ingest.play_event_raw r
      using public.play_events p, public.games g
      where r.play_event_id = p.id and p.game_id = g.id
        and g.status = 'closed' and r.updated_at < ${rawCutoff}
        and ${opts.gameIds ? db`g.id = any(${opts.gameIds}::uuid[])` : db`true`}`;
    result.rawDeleted = deleted.count;
  }
  log.info(
    {
      dryRun: opts.dryRun,
      candidates: result.candidates,
      retained: result.retained.length,
      skipped: result.skipped.length,
      rawDeleted: result.rawDeleted,
    },
    'retention finished',
  );
  return result;
}

/** `30d`, `12h`, `45m` relative to `now`, or an ISO timestamp. */
export function parseClosedBefore(text: string, now: Date = new Date()): Date {
  const m = /^(\d+)([mhd])$/.exec(text.trim());
  if (m) {
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'm' | 'h' | 'd'];
    return new Date(now.getTime() - Number(m[1]) * unit);
  }
  const t = Date.parse(text);
  if (Number.isNaN(t))
    throw new Error(`--closed-before must be like 30d, 12h or an ISO timestamp, got ${text}`);
  return new Date(t);
}
