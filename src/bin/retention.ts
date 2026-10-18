import { parseArgs } from 'node:util';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { createDb } from '../db/client.js';
import { parseClosedBefore, runRetention } from '../ingest/retention.js';
import { createLogger } from '../logger.js';

/**
 * pnpm retention run --closed-before <ISO|30d> [--dry-run] [--raw-days 30] [--game <uuid>] [--json]
 *   For closed games quiet since --closed-before: set games.retained_from_seq = last_seq + 1 and
 *   delete game_changes (and their published outbox rows) below it; delete play_event_raw rows
 *   of closed games older than --raw-days. The only code allowed to delete game_changes
 *   (src/ingest/retention.ts). --dry-run reports what would happen and writes nothing.
 * Exit codes: 0 ok; 64 usage; 1 error.
 */
async function main() {
  const { values: args, positionals } = parseArgs({
    options: {
      'closed-before': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'raw-days': { type: 'string', default: '30' },
      game: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  const usage = (msg: string): never => {
    console.error(msg);
    process.exit(64);
  };
  if (positionals[0] !== 'run')
    usage(
      'usage: pnpm retention run --closed-before <ISO|30d> [--dry-run] [--raw-days 30] [--game <uuid>] [--json]',
    );
  if (!args['closed-before']) usage('--closed-before <ISO|30d> is required');
  const rawDays = z.coerce.number().int().min(1).safeParse(args['raw-days']);
  if (!rawDays.success) usage('--raw-days must be a positive integer');
  let closedBefore: Date;
  try {
    closedBefore = parseClosedBefore(args['closed-before'] ?? '');
  } catch (err) {
    usage((err as Error).message);
    return;
  }
  const config = loadConfig();
  const log = createLogger({ level: config.logLevel });
  const db = createDb(config.db.url, { max: 2 });
  try {
    const r = await runRetention(db, log, {
      closedBefore,
      dryRun: args['dry-run'],
      rawRetentionDays: rawDays.success ? rawDays.data : 30,
      ...(args.game ? { gameIds: [args.game] } : {}),
    });
    if (args.json) {
      console.log(JSON.stringify({ ...r, closedBefore: r.closedBefore.toISOString() }));
      return;
    }
    console.log(
      `${r.dryRun ? 'DRY RUN: ' : ''}${r.candidates} closed game(s) quiet since ${closedBefore.toISOString()}; retained ${r.retained.length}, skipped ${r.skipped.length}, play_event_raw ${r.dryRun ? 'would delete' : 'deleted'} ${r.rawDeleted}`,
    );
    for (const g of r.retained) {
      console.log(
        `  ${g.gameId}  retained_from_seq -> ${g.floor}  ${r.dryRun ? 'would delete' : 'deleted'} ${g.deletedChanges} game_changes, ${g.deletedOutbox} outbox rows`,
      );
    }
    for (const s of r.skipped) console.log(`  ${s.gameId}  skipped: ${s.reason} (${s.detail})`);
  } finally {
    await db.end({ timeout: 2 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
