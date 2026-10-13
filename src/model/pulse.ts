import { z } from 'zod';
import { GameStatusSchema } from './live-event.js';

/**
 * Pulse: the clock heartbeat (plan §3). Sent every 10 s per live game and once
 * on close, straight to the transport. Never stored, never numbered. Clients
 * ignore a pulse whose observedAt <= the last applied one, fetch /changes when
 * latestSeq > their last durable seq, and count down only when clockRunning
 * is exactly true.
 */
export const PulseSchema = z.object({
  v: z.literal(1),
  type: z.literal('pulse'),
  gameId: z.uuid(),
  latestSeq: z.int().nonnegative(),
  status: GameStatusSchema,
  clock: z.string().nullable(),
  clockDecimal: z.string().optional(),
  clockRunning: z.boolean().nullable(),
  clockAsOf: z.iso.datetime({ offset: true }).nullable(),
  observedAt: z.iso.datetime({ offset: true }),
});
export type Pulse = z.infer<typeof PulseSchema>;
