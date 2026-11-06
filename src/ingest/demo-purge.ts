import type { Db } from '../db/client.js';
import type { Logger } from '../logger.js';
import { COMPLETE_REWATCH_CAP_MS, DEFAULT_MAX_LATE_START_MS } from './scheduler.js';

/**
 * How long after its tip-off the scheduler may still start or resume a watch of a game that is not
 * closed: the late-start bound plus the `complete` re-watch cap (30 h).
 */
export const SCHEDULER_RESUME_HORIZON_MS = DEFAULT_MAX_LATE_START_MS + COMPLETE_REWATCH_CAP_MS;

/**
 * `pnpm demo purge` (plan rev 4.15 (5)): delete closed replay games with every
 * dependent row, one transaction per game. Demo databases only (and the dev
 * stack); the caller checks. Besides the retention job (retention.ts) this is
 * the only code that deletes `game_changes`; it moves `retained_from_seq` past
 * `last_seq` first, under the game row lock, because the append-only trigger
 * (0001) refuses any delete at or above the floor.
 *
 * A game is eligible when it is labelled `replay`, its slot is past the host's
 * listing horizon (tip-off older than now - `listingHorizonMs`, whatever
 * `olderThan` says, `--all` included: the host could otherwise still list it
 * and a resuming watch still serve it), no run of its tree is `running`, and
 * either it is `closed` and quiet since `olderThan` (its newest change, or its
 * row update, is older), or it never closed and its tip-off is older than
 * `olderThan` (a replay orphaned by a host outage or by a rotation, interval or
 * league change in a later deploy, whose documents now answer 404 forever).
 * `olderThan` null (`--all`) drops the age condition. A game with unpublished
 * (pending or dead) outbox rows is skipped: subscribers have not seen those
 * changes.
 *
 * Order, per foreign key (0001, 0002, 0009, 0013):
 *   broadcast_outbox -> game_changes (play_event_id references play_events,
 *   no action) -> play_event_raw -> play_events -> game_player_stats ->
 *   game_team_stats -> game_periods -> stale_observations ->
 *   budget_reservations -> provider_calls of the game's runs -> games ->
 *   ingestion_runs (sub-runs before their parents: parent_run_id is ON DELETE
 *   RESTRICT) -> replay_slots.
 * `games` goes before its runs because `games.watch_run_id` references the
 * watch run ON DELETE RESTRICT (clearing it first would be a games write
 * outside apply-changes). Runs referenced by an identity merge or hold
 * (`player_merges.run_id`, `player_merge_holds.run_id`, no action) are kept
 * with `game_id` set null: identity history outlives the game. Schedule-poll
 * runs (`game_id` null) are shared by many games and never deleted here.
 *
 * Provenance rows whose game was never created (a slot listed, never watched)
 * and whose tip-off is older than both cutoffs are removed as well.
 */
export interface PurgeOptions {
  /** Quiet since (newest change or row update older than this); null = every closed replay game. */
  olderThan: Date | null;
  dryRun: boolean;
  /** The host's listing horizon (demo-host.ts `listingHorizonMs`); always applied. */
  listingHorizonMs: number;
  /** Restrict to these games (tests). */
  gameIds?: string[];
  now?: () => Date;
}

export interface PurgedGame {
  gameId: string;
  providerGameId: string;
  deleted: Record<string, number>;
}

export interface PurgeResult {
  dryRun: boolean;
  olderThan: Date | null;
  candidates: number;
  purged: PurgedGame[];
  skipped: Array<{ gameId: string; providerGameId: string; reason: string }>;
  orphanSlots: number;
}

export async function purgeReplayGames(
  db: Db,
  log: Logger,
  opts: PurgeOptions,
): Promise<PurgeResult> {
  const now = (opts.now ?? (() => new Date()))();
  const listedUntil = new Date(now.getTime() - opts.listingHorizonMs);
  // A game that is not closed may still be resumed by the scheduler (a watch in failure back-off,
  // a `complete` game between re-watches) until its tip-off is older than the latest start it
  // allows: never purge it before that, whatever the flags (review 2, nit 2).
  const resumableUntil = new Date(
    now.getTime() - Math.max(opts.listingHorizonMs, SCHEDULER_RESUME_HORIZON_MS),
  );
  const quiet = (cutoff: Date) =>
    db`coalesce((select max(c.created_at) from public.game_changes c where c.game_id = g.id), g.updated_at) < ${cutoff}`;
  const candidates = await db<{ id: string; providerGameId: string }[]>`
    select g.id, g.provider_game_id as "providerGameId"
    from public.games g
    where g.replay is not null
      and g.scheduled_at < ${listedUntil}
      and (g.status = 'closed' or g.scheduled_at < ${resumableUntil})
      and ${
        opts.olderThan === null
          ? db`true`
          : db`((g.status = 'closed' and ${quiet(opts.olderThan)})
                or (g.status <> 'closed' and g.scheduled_at < ${opts.olderThan}))`
      }
      and ${opts.gameIds ? db`g.id = any(${opts.gameIds}::uuid[])` : db`true`}
    order by g.scheduled_at, g.id`;
  const result: PurgeResult = {
    dryRun: opts.dryRun,
    olderThan: opts.olderThan,
    candidates: candidates.length,
    purged: [],
    skipped: [],
    orphanSlots: 0,
  };
  for (const c of candidates) {
    // A dry run counts inside a transaction it rolls back, so the numbers are what a real run deletes.
    try {
      await db.begin(async (tx) => {
        const [g] = await tx<{ replay: string | null; league: string }[]>`
          select replay, league::text as league
          from public.games where id = ${c.id} for update`;
        if (!g || g.replay === null) {
          result.skipped.push({ ...ids(c), reason: 'changed since selection' });
          return;
        }
        const [ob] = await tx<{ pending: number; dead: number }[]>`
          select count(*) filter (where published_at is null and dead_at is null)::int as pending,
                 count(dead_at)::int as dead
          from ingest.broadcast_outbox where game_id = ${c.id}`;
        if ((ob?.pending ?? 0) > 0 || (ob?.dead ?? 0) > 0) {
          result.skipped.push({
            ...ids(c),
            reason: `unpublished outbox rows (pending ${ob?.pending ?? 0}, dead ${ob?.dead ?? 0}); ${
              (ob?.dead ?? 0) > 0
                ? `requeue the dead rows with the demo configuration: ${demoMaintenance(`outbox requeue --channel game:${c.id}`)}`
                : 'wait for the publisher (the demo worker drains on start and every 30 s)'
            }`,
          });
          return;
        }
        const runs = await tx<{ id: string; depth: number; kept: boolean; running: boolean }[]>`
          with recursive tree as (
            select r.id, 0 as depth from ingest.ingestion_runs r where r.game_id = ${c.id}
            union
            select s.id, t.depth + 1 from ingest.ingestion_runs s join tree t on s.parent_run_id = t.id
          )
          select t.id::text, max(t.depth)::int as depth,
                 (exists (select 1 from ingest.player_merges m where m.run_id = t.id)
                  or exists (select 1 from ingest.player_merge_holds h where h.run_id = t.id)) as kept,
                 bool_or(r.status = 'running') as running
          from tree t join ingest.ingestion_runs r on r.id = t.id group by t.id`;
        // A watch (or a sub-run of one) still running is writing this game: never delete under it.
        const running = runs.filter((r) => r.running).map((r) => r.id);
        if (running.length > 0) {
          result.skipped.push({ ...ids(c), reason: `run(s) still running: ${running.join(', ')}` });
          return;
        }
        const runIds = runs.map((r) => r.id);
        // A kept run keeps its ancestors too (parent_run_id is RESTRICT).
        const keep = new Set<string>();
        if (runs.some((r) => r.kept)) {
          const ancestors = await tx<{ id: string }[]>`
            with recursive up as (
              select r.id, r.parent_run_id from ingest.ingestion_runs r
              where r.id = any(${runs.filter((r) => r.kept).map((r) => r.id)}::bigint[])
              union
              select p.id, p.parent_run_id from ingest.ingestion_runs p join up on p.id = up.parent_run_id
            ) select id::text from up`;
          for (const a of ancestors) keep.add(a.id);
        }
        const deleted: Record<string, number> = {};
        const del = async (name: string, q: Promise<{ count: number }>) => {
          deleted[name] = (await q).count;
        };
        await tx`update public.games set retained_from_seq = last_seq + 1 where id = ${c.id}`;
        await del(
          'broadcast_outbox',
          tx`delete from ingest.broadcast_outbox where game_id = ${c.id}`,
        );
        await del('game_changes', tx`delete from public.game_changes where game_id = ${c.id}`);
        await del(
          'play_event_raw',
          tx`delete from ingest.play_event_raw r using public.play_events p
             where r.play_event_id = p.id and p.game_id = ${c.id}`,
        );
        await del('play_events', tx`delete from public.play_events where game_id = ${c.id}`);
        await del(
          'game_player_stats',
          tx`delete from public.game_player_stats where game_id = ${c.id}`,
        );
        await del(
          'game_team_stats',
          tx`delete from public.game_team_stats where game_id = ${c.id}`,
        );
        await del('game_periods', tx`delete from public.game_periods where game_id = ${c.id}`);
        await del(
          'stale_observations',
          tx`delete from ingest.stale_observations where game_id = ${c.id}`,
        );
        await del(
          'budget_reservations',
          tx`delete from ingest.budget_reservations where game_id = ${c.id}
               or run_id = any(${runIds}::bigint[])`,
        );
        await del(
          'provider_calls',
          tx`delete from ingest.provider_calls where run_id = any(${runIds}::bigint[])`,
        );
        await del('games', tx`delete from public.games where id = ${c.id}`);
        let runsDeleted = 0;
        for (const r of [...runs].sort((a, b) => b.depth - a.depth)) {
          if (keep.has(r.id)) continue;
          runsDeleted += (await tx`delete from ingest.ingestion_runs where id = ${r.id}`).count;
        }
        deleted.ingestion_runs = runsDeleted;
        await del(
          'replay_slots',
          tx`delete from ingest.replay_slots
             where league = ${g.league} and provider_game_id = ${c.providerGameId}`,
        );
        result.purged.push({ ...ids(c), deleted });
        if (opts.dryRun) throw new DryRunRollback();
        log.info({ gameId: c.id, providerGameId: c.providerGameId, deleted }, 'replay game purged');
      });
    } catch (err) {
      if (!(err instanceof DryRunRollback)) throw err;
    }
  }
  if (opts.gameIds === undefined) {
    const cutoff =
      opts.olderThan === null || opts.olderThan > listedUntil ? listedUntil : opts.olderThan;
    const orphan = opts.dryRun
      ? await db<{ n: number }[]>`
          select count(*)::int as n from ingest.replay_slots s
          where s.slot_tip_off < ${cutoff}
            and not exists (select 1 from public.games g
                            where g.league = s.league and g.provider_game_id = s.provider_game_id)`
      : null;
    if (orphan) result.orphanSlots = orphan[0]?.n ?? 0;
    else
      result.orphanSlots = (
        await db`delete from ingest.replay_slots s
                 where s.slot_tip_off < ${cutoff}
                   and not exists (select 1 from public.games g
                                   where g.league = s.league and g.provider_game_id = s.provider_game_id)`
      ).count;
  }
  return result;
}

/**
 * How to run a maintenance CLI (`pnpm outbox`, `pnpm retention`) on a demo database: in MODE=demo,
 * the only mode that may write to it (review 2, nit 3). The demo app's Fly [env] already sets
 * MODE=demo and the loopback SPORTRADAR_BASE_URL; from a laptop both are passed explicitly.
 */
export function demoMaintenance(args: string): string {
  return `MODE=demo SPORTRADAR_BASE_URL=http://127.0.0.1:8790 pnpm ${args} (on Fly: fly ssh console -a wehoop-demo -C "node src/bin/${args.split(' ')[0]}.js ${args.split(' ').slice(1).join(' ')}")`;
}

class DryRunRollback extends Error {}

const ids = (c: { id: string; providerGameId: string }) => ({
  gameId: c.id,
  providerGameId: c.providerGameId,
});
