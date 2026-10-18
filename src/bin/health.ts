import { parseArgs } from 'node:util';
import { z } from 'zod';

/**
 * pnpm health check [--url http://127.0.0.1:3000] [--json]
 *   External-monitor probe of GET /health: exit 0 when the API answers 200 with
 *   `ok: true` and no alerts, 1 when it is unreachable, not ok, or degraded
 *   (the alerts are printed one per line). Needs no database: the URL comes from
 *   --url, else API_BASE_URL, else http://127.0.0.1:$PORT.
 */
const HealthBody = z
  .object({
    ok: z.boolean(),
    db: z.string().optional(),
    degraded: z.boolean().optional(),
    alerts: z.array(z.string()).optional(),
    worker: z.object({ lockHeld: z.boolean().optional() }).loose().optional(),
    outbox: z
      .object({ pending: z.number(), lagMs: z.number().nullable(), dead: z.number() })
      .loose()
      .optional(),
  })
  .loose();

async function main() {
  const { values: args, positionals } = parseArgs({
    options: { url: { type: 'string' }, json: { type: 'boolean', default: false } },
    allowPositionals: true,
    strict: true,
  });
  if (positionals[0] !== 'check') {
    console.error('usage: pnpm health check [--url http://host:port] [--json]');
    process.exit(64);
  }
  const env = z
    .object({
      API_BASE_URL: z.preprocess((v) => (v === '' ? undefined : v), z.url().optional()),
      PORT: z.coerce.number().int().positive().default(3000),
    })
    .parse(process.env);
  const base = args.url ?? env.API_BASE_URL ?? `http://127.0.0.1:${env.PORT}`;
  let res: Response;
  try {
    res = await fetch(new URL('/health', base), { signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    console.error(`health: ${base} unreachable (${(err as Error).message})`);
    process.exit(1);
  }
  const text = await res.text();
  let body: z.infer<typeof HealthBody> | null = null;
  try {
    body = HealthBody.parse(JSON.parse(text));
  } catch {
    console.error(`health: HTTP ${res.status}, body not a health document: ${text.slice(0, 200)}`);
    process.exit(1);
  }
  if (args.json) console.log(JSON.stringify({ httpStatus: res.status, ...body }));
  else {
    console.log(
      `health: HTTP ${res.status} ok=${body.ok} db=${body.db ?? '?'} degraded=${body.degraded ?? false} lockHeld=${body.worker?.lockHeld ?? '?'} outbox pending=${body.outbox?.pending ?? '?'} dead=${body.outbox?.dead ?? '?'} lagMs=${body.outbox?.lagMs ?? '-'}`,
    );
    for (const a of body.alerts ?? []) console.log(`  alert: ${a}`);
  }
  process.exit(res.status === 200 && body.ok && !body.degraded ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
