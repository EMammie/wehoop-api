import type { Db } from '../db/client.js';
import type { Logger } from '../logger.js';
import { CHECK_ID_PREFIX, type PurgeResult } from './demo-purge.js';

const DAY_MS = 86_400_000;
/** Replays quiet for this long are deleted when the purge runs. */
export const AUTO_PURGE_KEEP_MS = 7 * DAY_MS;
/** The purge runs about this often. */
export const AUTO_PURGE_PERIOD_MS = 7 * DAY_MS;
/** How often the job asks whether the purge is due. */
export const AUTO_PURGE_CHECK_MS = 6 * 3_600_000;
/** Delay of the first check: the restart's orphan cleanup and first schedule poll go first. */
export const AUTO_PURGE_FIRST_CHECK_MS = 5 * 60_000;
/** /health alerts when the oldest replay is older than this: the purge is a day overdue. */
export const AUTO_PURGE_OVERDUE_MS = AUTO_PURGE_KEEP_MS + AUTO_PURGE_PERIOD_MS + DAY_MS;

/**
 * Weekly without a stored schedule: the purge is due once the oldest replay is keep + period old
 * (14 days); it then deletes everything past `keep`, so the oldest one left is 7 days old and the
 * next run is a week away. The state is the data itself, so a redeploy never resets or repeats it.
 * A game the purge must skip (unpublished outbox rows, say) keeps it due: the other games are then
 * purged at every check, and /health alerts after a day.
 */
export function autoPurgeDue(oldestTipOff: Date | null, now: Date): boolean {
  if (oldestTipOff === null) return false;
  return now.getTime() - oldestTipOff.getTime() >= AUTO_PURGE_KEEP_MS + AUTO_PURGE_PERIOD_MS;
}

/** Tip-off of the oldest replay slot game (verify-slot check games excluded). */
export async function oldestReplayTipOff(db: Db): Promise<Date | null> {
  const [row] = await db<{ oldest: Date | null }[]>`
    select min(scheduled_at) as oldest from public.games
    where replay is not null and not starts_with(provider_game_id, ${CHECK_ID_PREFIX})`;
  return row?.oldest ?? null;
}

export interface AutoPurgeOptions {
  log: Logger;
  oldest: () => Promise<Date | null>;
  /** Purge games quiet since `cutoff`; ask `isStopped` between games. */
  purge: (cutoff: Date, isStopped: () => boolean) => Promise<PurgeResult>;
  checkEveryMs?: number;
  firstCheckMs?: number;
  now?: () => Date;
}

export interface AutoPurgeJob {
  /** No further check; resolves once a running purge has finished its current game. */
  stop(): Promise<void>;
}

/**
 * The hosted demo's weekly `pnpm demo purge --older-than 7d` (`demo run --auto-purge`), in the
 * worker process, the single lock holder. A failure is logged and retried at the next check; it
 * never reaches the scheduler.
 */
export function startAutoPurge(o: AutoPurgeOptions): AutoPurgeJob {
  const { log } = o;
  const now = o.now ?? (() => new Date());
  const checkEveryMs = o.checkEveryMs ?? AUTO_PURGE_CHECK_MS;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> = Promise.resolve();

  const check = async (): Promise<void> => {
    try {
      const oldest = await o.oldest();
      const at = now();
      if (stopped) return;
      if (!autoPurgeDue(oldest, at)) {
        log.info({ oldestReplay: oldest?.toISOString() ?? null }, 'auto purge: not due');
        return;
      }
      const started = Date.now();
      const out = await o.purge(new Date(at.getTime() - AUTO_PURGE_KEEP_MS), () => stopped);
      log.info(
        {
          oldestReplay: oldest?.toISOString() ?? null,
          candidates: out.candidates,
          purged: out.purged.length,
          leftAlone: out.leftAlone.length,
          orphanSlots: out.orphanSlots,
          durationMs: Date.now() - started,
        },
        'auto purge: done',
      );
      if (out.skipped.length > 0)
        log.warn({ skipped: out.skipped }, 'auto purge: games skipped; retried at the next check');
    } catch (err) {
      log.error({ err }, 'auto purge failed; retried at the next check');
    }
  };
  const schedule = (ms: number) => {
    timer = setTimeout(() => {
      running = check().then(() => {
        if (!stopped) schedule(checkEveryMs);
      });
    }, ms);
  };
  schedule(o.firstCheckMs ?? AUTO_PURGE_FIRST_CHECK_MS);
  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running;
    },
  };
}
