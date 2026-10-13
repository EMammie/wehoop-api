import { z } from 'zod';

/**
 * Crash-point fault injection for the M1 crash tests (plan §7):
 *   WEHOOP_FAULT=before_commit[:seq]   SIGKILL inside applyChanges after every
 *                                      write of the batch has been issued but
 *                                      before COMMIT, once last_seq would reach <seq>.
 *   WEHOOP_FAULT=after_publish[:seq]   SIGKILL in the outbox publisher after the
 *                                      HTTP publish succeeded and before
 *                                      published_at is written, once a published
 *                                      row's seq reaches <seq>.
 * <seq> defaults to 1 (fire at the first opportunity). Never set in production.
 */
export const FaultSpecSchema = z.object({
  kind: z.enum(['before_commit', 'after_publish']),
  atSeq: z.int().positive().default(1),
});
export type FaultSpec = z.infer<typeof FaultSpecSchema>;

export function parseFault(value: string | undefined): FaultSpec | null {
  if (!value) return null;
  const [kind, seq] = value.split(':');
  return FaultSpecSchema.parse({ kind, ...(seq ? { atSeq: Number(seq) } : {}) });
}

export interface FaultInjector {
  /** Returns true (and kills the process) when the fault should fire now. */
  maybeFire(kind: FaultSpec['kind'], seq: number): void;
}

export function createFaultInjector(
  spec: FaultSpec | null,
  kill: (pid: number, signal: NodeJS.Signals) => void = (pid, sig) => process.kill(pid, sig),
  log: (msg: string) => void = (m) => console.error(m),
): FaultInjector {
  return {
    maybeFire(kind, seq) {
      if (!spec || spec.kind !== kind || seq < spec.atSeq) return;
      log(`WEHOOP_FAULT ${kind} firing at seq ${seq}: SIGKILL self`);
      kill(process.pid, 'SIGKILL');
    },
  };
}
