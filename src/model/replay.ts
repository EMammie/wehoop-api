import { z } from 'zod';

/**
 * `games.replay` (plan rev 4.15 (3), migration 0014): a demo-environment game replayed from a
 * committed recording. `recorded` = a Sportradar Simulations recording, `synthetic` = the
 * hand-assembled Unrivaled replay; null (never absent) for a real game. Carried by `v_schedule`,
 * the snapshot's `game`, every pulse and every `league:*:scores` delta, so the app's **Replay**
 * badge survives reconnects and screen changes. `GameChange` bodies do not carry it: a client
 * folds changes only onto a snapshot, which does.
 */
export const ReplayKindSchema = z.enum(['recorded', 'synthetic']);
export type ReplayKind = z.infer<typeof ReplayKindSchema>;
