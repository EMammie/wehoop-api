/**
 * Clock "m:ss" / "mm:ss.d" → seconds remaining, or null when unparsable (Elam
 * periods and some feeds carry no clock). Pure; shared by the normalizer, the
 * clock_running derivation and freshness rule 2(d).
 */
export function clockToSeconds(clock: string | null | undefined): number | null {
  if (!clock) return null;
  const m = /^(\d+):(\d{1,2})(?:\.(\d+))?$/.exec(clock.trim());
  if (!m) return null;
  const mins = Number(m[1]);
  const secs = Number(m[2]);
  const frac = m[3] ? Number(`0.${m[3]}`) : 0;
  return mins * 60 + secs + frac;
}
