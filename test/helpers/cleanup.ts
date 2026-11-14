import type { Db } from '../../src/db/client.js';

/** The recording's tip-off: where every other test game of these fixtures sits, out of any scheduler range. */
const PARKED_AT = '2026-06-30T23:00:00Z';

/**
 * Leave no watchable game behind (the validator runs `worker:rehearsal --schedule` on the same dev
 * database right after `test:int`, and its scheduler loads every WNBA game in range). The test
 * games a file made that are not final get their `scheduled_at` moved back to the recording's
 * tip-off: past every bound the scheduler applies (maxLateStartMs for a live game, the 24 h cap
 * COMPLETE_REWATCH_CAP_MS for a `complete` one, whatever its completion marker says).
 *
 * Deliberately not "closing" them through applyChanges: a closing document adds hundreds of
 * game_changes and outbox rows per game, and the next test that drains the whole outbox to the
 * real Realtime (realtime-auth) then misses its own deliveries. `scheduled_at` is a schedule fact
 * (no seq, no change row), and nothing is deleted.
 */
export async function parkTestGames(db: Db, gameIds: string[]): Promise<number> {
  if (gameIds.length === 0) return 0;
  const rows = await db`
    update public.games set scheduled_at = ${PARKED_AT}
    where id = any(${gameIds}::uuid[])
      and status not in ('closed', 'cancelled', 'postponed', 'unnecessary')
    returning id`;
  return rows.length;
}
