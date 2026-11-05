import { parseArgs } from 'node:util';
import { loadConfig } from '../config.js';
import { createDb } from '../db/client.js';
import {
  gameIdOfChannel,
  outboxLag,
  outboxStatus,
  parseSince,
  requeueDead,
} from '../live/outbox-admin.js';

/**
 * pnpm outbox status [--json]
 *   Pending / dead / published totals and every channel with unpublished rows (head seq,
 *   next attempt, last error).
 * pnpm outbox requeue --channel game:<uuid> | --all
 *   Dead-letter recovery (plan §4): clears dead_at, resets attempts and next_attempt_at,
 *   drops last_error and NOTIFYs the publisher. Dead rows only.
 * pnpm outbox lag [--since 24h|30m|7d|<ISO>] [--json]
 *   p50 / p95 / max of published_at - created_at over rows published in the window
 *   (the "outbox lag p95" acceptance row).
 * Exit codes: 0 ok; 64 usage; 1 error. Reads DATABASE_URL (export the dev .env first, or
 * use the *:rehearsal / *:live script pattern for other stacks).
 */
async function main() {
  const { values: args, positionals } = parseArgs({
    options: {
      channel: { type: 'string' },
      all: { type: 'boolean', default: false },
      since: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  const cmd = positionals[0];
  const usage = (msg: string): never => {
    console.error(msg);
    process.exit(64);
  };
  const config = loadConfig();
  const db = createDb(config.db.url, { max: 2 });
  try {
    switch (cmd) {
      case 'status': {
        const s = await outboxStatus(db);
        if (args.json) console.log(JSON.stringify(s));
        else {
          console.log(
            `outbox: pending ${s.pending}, dead ${s.dead}, published ${s.published}, oldest pending ${s.oldestPendingMs === null ? '-' : `${s.oldestPendingMs} ms`}`,
          );
          if (s.channels.length === 0) console.log('no channel has unpublished rows');
          for (const c of s.channels) {
            console.log(
              `  ${c.channel}  pending ${c.pending}  dead ${c.dead}  head seq ${c.headSeq ?? '-'}  next attempt ${c.nextAttemptAt?.toISOString() ?? '-'}  attempts ${c.maxAttempts}${c.lastError ? `  last error: ${c.lastError.slice(0, 120)}` : ''}`,
            );
          }
        }
        break;
      }
      case 'requeue': {
        if (!args.channel && !args.all) usage('--channel game:<uuid> or --all is required');
        const target = args.all
          ? ({ all: true } as const)
          : { gameId: gameIdOfChannel(args.channel ?? '') };
        const r = await requeueDead(db, target);
        console.log(
          `requeued ${r.requeued} dead row(s) on ${r.channels.length} channel(s)${r.channels.length ? `: ${r.channels.join(', ')}` : ''}; publisher notified`,
        );
        break;
      }
      case 'lag': {
        const since = args.since ? parseSince(args.since) : parseSince('24h');
        const l = await outboxLag(db, since);
        if (args.json) console.log(JSON.stringify({ ...l, since: l.since?.toISOString() ?? null }));
        else {
          console.log(
            `outbox lag (published_at - created_at) since ${since.toISOString()}: n=${l.n} p50 ${fmt(l.p50Ms)} p95 ${fmt(l.p95Ms)} max ${fmt(l.maxMs)}`,
          );
        }
        break;
      }
      default:
        usage(
          'usage: pnpm outbox <status|requeue|lag> [--channel game:<uuid>|--all] [--since 24h] [--json]',
        );
    }
  } finally {
    await db.end({ timeout: 2 });
  }
}

function fmt(ms: number | null): string {
  return ms === null ? '-' : `${ms} ms`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
