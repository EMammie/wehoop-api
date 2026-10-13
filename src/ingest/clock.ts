import { clockToSeconds } from '../leagues/sportradar-basketball/normalize.js';
import type { GameStatus, LiveEventType } from '../model/live-event.js';

/**
 * clock_running derivation for REST / simulation observations (plan §4):
 * true when status=inprogress and the clock advanced since the previous
 * observation, false at period end / timeouts when the feed says so, the
 * previous value while the clock is simply unchanged, null otherwise.
 * Push clocks (M4) carry `running` directly and bypass this.
 */
export function deriveClockRunning(
  prev: { status: GameStatus; clock: string | null; clockRunning: boolean | null },
  next: { status: GameStatus; clock: string | null; clockRunning: boolean | null },
  newestEventType: LiveEventType | null,
): boolean | null {
  if (next.clockRunning !== null) return next.clockRunning;
  if (next.status !== 'inprogress') {
    return next.status === 'halftime' || next.status === 'complete' || next.status === 'closed'
      ? false
      : null;
  }
  if (newestEventType === 'timeout' || newestEventType === 'period_end') return false;
  const ps = clockToSeconds(prev.clock);
  const ns = clockToSeconds(next.clock);
  if (ps !== null && ns !== null) {
    if (ns < ps) return true;
    if (ns === ps) return prev.status === 'inprogress' ? prev.clockRunning : null;
  }
  return null;
}
