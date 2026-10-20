import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { createDb } from '../db/client.js';
import { budgetFor, TRIAL_PROFILES, type TrialProfile } from '../ingest/cadence.js';
import { runPreflight } from '../ingest/preflight.js';
import { QuotaGuard, QuotaRefusedError } from '../ingest/quota-guard.js';
import {
  assertSpeedAllowed,
  gamesOn,
  heldProfileImpact,
  lagFromRecord,
  planDay,
  planWatch,
  providerRevisions,
  resolveGame,
} from '../ingest/trial-mode.js';
import { LeagueCodeSchema } from '../leagues/codes.js';
import { adapterFor } from '../leagues/registry.js';
import { createLogger } from '../logger.js';

/**
 * Trial mode operator CLI (plan §4 "Trial mode"; CLAUDE.md non-negotiable 8).
 *
 * pnpm trial plan --league ncaawb --date 2026-11-08 [--season [--season-year 2026 --season-type REG]]
 *   Exactly one call (quota-counted in trial/production): the DAILY schedule for
 *   the date by default (coverage as it stands that day; `full` follows AP Top 25
 *   teams and can change until tip-off, so run it on game day), or the whole
 *   season schedule with --season. Ingested generation-less; prints the date's
 *   games with coverage and its client label, the profile each defaults to, and
 *   its computed budget. MODE=trial|production only.
 * pnpm trial watch --league ncaawb --game <uuid|providerId> [--profile full|extended|lean-full]
 *     [--note "..."] [--speed N] [--dry-run] [--mode sim --recording <id>]
 *   Computes the profile budget from the cadence constants, reserves it
 *   (refused when remaining - reserved < reserve), then watches the game at
 *   that cadence through the worker (lock, outbox publisher, pulses). The
 *   reservation and the watch run are linked; the reservation is released when
 *   the watch ends. `--speed` compresses the cadence for a rehearsal against
 *   `pnpm sim serve`; never use it on a live game.
 * pnpm trial status [--json]        ingest.v_quota (with QUOTA_* overrides applied) and reservations
 * pnpm trial release --reservation <id> | --stale
 *   Release a reservation a killed watcher left open (the next worker start and every new
 *   reservation do this for runs that are no longer running; this is the manual escape).
 * pnpm trial holds [--json]         open player_merge_holds and whether they touch a watched game
 * pnpm trial lag --record <jsonl> [--game <uuid>]
 *   median / p95 subscriber lag from a `pnpm subscribe --record` file (plan §7 M3, rev 4.6):
 *   pipeline lag (change.ts -> receivedAt) is the acceptance measure; provider-revision lag
 *   (receivedAt - `updated`, needs --game) where the feed carries `updated`; wall_clock lag only
 *   where the feed carries wall_clock (WNBA push; NCAAWB carries none, stated, not failed)
 * pnpm trial quota --product ncaawb --limit-30d 1000 [--reserve 100] [--note "console 2026-11-01"]
 *   Operator confirmation of the console limit: writes ingest.product_quotas
 *   and stamps verified_at. QuotaGuard refuses every call until this is done
 *   (or QUOTA_<PRODUCT> is set in env).
 * pnpm trial preflight              (pnpm preflight:live / preflight:rehearsal)
 *   What a live run would do, with no secret in the output: mode, access level, provider
 *   hostname, key present/missing per product, quota state per product, database host:port and
 *   whether it is the dev stack. Exit 0 when ready, 65 with one line per problem otherwise.
 *
 * Environment files are loaded by the scripts, not here (`tsx` loads no .env):
 *   pnpm trial:live <cmd>       node --env-file=.env --env-file=.env.trial --import tsx src/bin/trial.ts
 *   pnpm trial:rehearsal <cmd>  node --env-file=.env --env-file=.env.rehearsal --import tsx src/bin/trial.ts
 */
async function main() {
  const { values: args, positionals } = parseArgs({
    options: {
      mode: { type: 'string' },
      league: { type: 'string', default: 'ncaawb' },
      date: { type: 'string' },
      'season-year': { type: 'string' },
      'season-type': { type: 'string' },
      season: { type: 'boolean', default: false },
      game: { type: 'string' },
      profile: { type: 'string' },
      note: { type: 'string' },
      speed: { type: 'string' },
      recording: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      record: { type: 'string' },
      product: { type: 'string' },
      'limit-30d': { type: 'string' },
      reserve: { type: 'string' },
      reservation: { type: 'string' },
      stale: { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  const cmd = positionals[0];
  const env = args.mode ? { ...process.env, MODE: args.mode } : process.env;
  if (cmd === 'preflight') {
    // Before loadConfig: a refused configuration is itself a preflight finding, not a stack trace,
    // and nothing unexpected may print more than a code (a driver message could echo a URL).
    try {
      process.exit(await runPreflight(env, (line) => console.log(line)));
    } catch (err) {
      const e = err as { code?: string; name?: string };
      console.error(`preflight: unexpected error (${e.code ?? e.name ?? 'Error'})`);
      process.exit(65);
    }
  }
  const config = loadConfig(env);
  const log = createLogger({ level: config.logLevel });
  const league = LeagueCodeSchema.parse(args.league);
  const adapter = adapterFor(league);
  const usage = (msg: string): never => {
    console.error(msg);
    process.exit(64);
  };
  const intArg = (name: string, value: string | undefined, min: number): number | undefined => {
    if (value === undefined) return undefined;
    const parsed = z.coerce.number().int().min(min).safeParse(value);
    if (!parsed.success) usage(`--${name} must be an integer >= ${min}`);
    return parsed.data;
  };

  const db = createDb(config.db.url);
  if (cmd === 'lag') {
    if (!args.record) usage('--record <file.jsonl> is required');
    const lines = readFileSync(args.record ?? '', 'utf8').split('\n');
    const revisions = args.game ? await providerRevisions(db, args.game) : undefined;
    const stats = lagFromRecord(lines, revisions);
    if (args.json) console.log(JSON.stringify(stats));
    else {
      console.log(`changes received via broadcast: ${stats.changes}`);
      console.log(
        `pipeline lag [acceptance measure] (change.ts -> subscriber receivedAt, n=${stats.pipeline.n}): median ${fmt(stats.pipeline.medianMs)} p95 ${fmt(stats.pipeline.p95Ms)}`,
      );
      console.log(
        `catch-up deliveries (change.ts -> receivedAt via /changes, n=${stats.catchUp.n}): median ${fmt(stats.catchUp.medianMs)} p95 ${fmt(stats.catchUp.p95Ms)}`,
      );
      console.log(
        `provider-revision lag [reported where the feed carries updated] (last delivered change of each event: receivedAt - play_events.provider_updated_at, n=${stats.providerUpdated.n} events not re-stamped after delivery; excluded ${stats.providerUpdated.excluded} re-stamped, ${stats.providerUpdated.notBroadcast} last delivered by catch-up${args.game ? '' : '; pass --game <uuid>'}): median ${fmt(stats.providerUpdated.medianMs)} p95 ${fmt(stats.providerUpdated.p95Ms)}`,
      );
      console.log(
        stats.wallClock.n === 0
          ? 'wall_clock lag [reported only where the feed carries wall_clock]: not carried by this feed (n=0; stated, not failed)'
          : `wall_clock lag [reported only where the feed carries wall_clock] (event_insert: receivedAt - event wallClock, n=${stats.wallClock.n}): median ${fmt(stats.wallClock.medianMs)} p95 ${fmt(stats.wallClock.p95Ms)}`,
      );
    }
    await db.end({ timeout: 2 });
    return;
  }

  const guard = new QuotaGuard({ db, log, overrides: config.quotaOverrides });
  try {
    switch (cmd) {
      case 'plan': {
        if (!args.date || !/^\d{4}-\d{2}-\d{2}$/.test(args.date))
          usage('--date YYYY-MM-DD is required');
        const date = args.date ?? '';
        const seasonYear = intArg('season-year', args['season-year'], 1990);
        const out = await planDay(
          { db, log, config, adapter, guard },
          {
            date,
            season: args.season,
            ...(seasonYear !== undefined ? { seasonYear } : {}),
            ...(args['season-type'] ? { seasonType: args['season-type'] } : {}),
          },
        );
        if (args.json) console.log(JSON.stringify(out));
        else {
          const feedLabel =
            out.feed === 'schedule'
              ? `season schedule ${out.season.year} ${out.season.type}`
              : `daily schedule ${date}`;
          console.log(
            `${league}: ${out.calls} ${feedLabel} call(s), ingested ${out.ingested} game(s), ${out.games.length} game(s) listed for ${date}`,
          );
          for (const g of out.games) {
            console.log(
              `  ${g.id}  ${g.providerGameId}  ${g.scheduledAt.toISOString()}  ${g.status.padEnd(10)} coverage=${g.coverage.padEnd(17)} [${g.coverageLabel}]  ${g.away ?? '?'} at ${g.home ?? '?'}  -> profile ${g.profile} (${g.budget.total} calls)`,
            );
          }
          if (!out.games.some((g) => g.coverage === 'full')) {
            console.log(
              'no full-coverage game on this date; full coverage follows AP Top 25 teams and can change until tip-off; re-run plan on game day',
            );
          }
        }
        break;
      }
      case 'watch': {
        if (!args.game) usage('--game <uuid|providerId> is required');
        const profile = args.profile as TrialProfile | undefined;
        if (profile && !(TRIAL_PROFILES as readonly string[]).includes(profile))
          usage(`--profile must be one of ${TRIAL_PROFILES.join('|')}`);
        const speed = intArg('speed', args.speed, 1) ?? 1;
        try {
          assertSpeedAllowed(config, speed);
        } catch (err) {
          usage((err as Error).message);
        }
        if (config.mode === 'sim' && !args.recording)
          usage('MODE=sim needs --recording <id> (the trial flow against the simulation host)');
        const game = await resolveGame(db, league, args.game ?? '');
        if (!game) {
          console.error(`game ${args.game} not found for ${league}; run \`pnpm trial plan\` first`);
          process.exit(66);
        }
        const source = config.mode === 'sim' ? 'simulation' : config.mode;
        const plan = planWatch(adapter, source, game.coverage, profile);
        console.log(
          `game ${game.id} (${game.providerGameId}) status=${game.status} coverage=${game.coverage}: profile ${plan.profile}, budget ${plan.budget.total} calls (pbp ${plan.budget.pbp}, summary ${plan.budget.summary}, boxscore ${plan.budget.boxscore}, closing ${plan.budget.closing})`,
        );
        const [q] = (await guard.status()).filter((s) => s.product === adapter.product);
        if (q) {
          console.log(
            `quota ${q.product}: limit ${q.limit30d} used ${q.used30d} remaining ${q.remaining} reserved ${q.reserved} reserve ${q.reserve} spendable ${q.spendable}${q.overridden ? ' (QUOTA_* override)' : ''}${q.verifiedAt ? '' : ' UNVERIFIED'}`,
          );
        }
        if (args['dry-run']) break;
        await db.end({ timeout: 2 });
        const code = await runWorker([
          '--mode',
          config.mode,
          '--league',
          league,
          '--game',
          game.id,
          '--profile',
          plan.profile,
          '--speed',
          String(speed),
          ...(args.note ? ['--note', args.note] : []),
          ...(args.recording ? ['--recording', args.recording] : []),
        ]);
        process.exit(code);
        break;
      }
      case 'status': {
        const quota = await guard.status();
        const reservations = await guard.reservations();
        const calls = await db<{ reservationId: string | null; n: number; counted: number }[]>`
          select reservation_id::text as "reservationId", count(*)::int as n,
                 count(*) filter (where quota_counted)::int as counted
          from ingest.provider_calls group by reservation_id`;
        const byRes = new Map(calls.map((c) => [c.reservationId, c]));
        if (args.json) console.log(JSON.stringify({ quota, reservations, calls }));
        else {
          console.log('product    limit  used  remaining  reserved  reserve  spendable  verified');
          for (const q of quota) {
            console.log(
              `${q.product.padEnd(10)} ${String(q.limit30d).padStart(5)} ${String(q.used30d).padStart(5)} ${String(q.remaining).padStart(10)} ${String(q.reserved).padStart(9)} ${String(q.reserve).padStart(8)} ${String(q.spendable).padStart(10)}  ${q.verifiedAt ? q.verifiedAt.toISOString() : 'no'}${q.overridden ? ' (override)' : ''}`,
            );
          }
          console.log(
            '\nreservations (used = calls made under the reservation; counted = quota-counted):',
          );
          for (const r of reservations) {
            const c = byRes.get(String(r.id));
            console.log(
              `  #${r.id} ${r.product} ${r.profile.padEnd(9)} game=${r.gameId ?? '-'} source=${r.source} run=${r.runId ?? '-'} reserved=${r.reservedCalls} used=${r.usedCalls} provider_calls=${c?.n ?? 0} counted=${c?.counted ?? 0} ${r.releasedAt ? 'released' : 'open'}`,
            );
          }
        }
        break;
      }
      case 'release': {
        // Operator escape for a reservation left open (watcher killed before its release).
        const id = intArg('reservation', args.reservation, 1);
        if (id === undefined && !args.stale) usage('--reservation <id> or --stale is required');
        if (id !== undefined) {
          const before = await guard.reservation(id);
          if (!before) {
            console.error(`reservation ${id} not found`);
            process.exit(66);
          }
          await guard.release(id);
          console.log(
            `reservation #${id} ${before.releasedAt ? 'was already released' : 'released'} (reserved ${before.reservedCalls}, used ${before.usedCalls})`,
          );
        }
        if (args.stale) {
          const ids = await guard.releaseStale();
          console.log(
            `released ${ids.length} reservation(s) whose watch run has ended${ids.length ? `: ${ids.join(', ')}` : ''}`,
          );
        }
        break;
      }
      case 'holds': {
        const impact = await heldProfileImpact(db);
        if (args.json) console.log(JSON.stringify(impact));
        else {
          console.log(
            `open holds: ${impact.openHolds}; affected players: ${impact.affectedPlayers}; holds touching a watched game: ${impact.inWatchedGame}`,
          );
          for (const r of impact.rows) {
            console.log(
              `  hold ${r.holdId} ${r.league} ${r.reason} document=${r.documentId ?? '-'} (${r.documentName ?? '?'}) created=${r.createdAt.toISOString()}`,
            );
            for (const c of r.candidates)
              console.log(
                `    candidate ${c.id} ${c.fullName ?? '?'}${c.mergedInto ? ` (merged into ${c.mergedInto})` : ''}`,
              );
            console.log(
              `    document id in watched games: ${r.documentInWatchedGames.length ? r.documentInWatchedGames.join(', ') : 'none'}; candidates in watched games: ${r.candidatesInWatchedGames.length ? r.candidatesInWatchedGames.join(', ') : 'none'}`,
            );
          }
        }
        break;
      }
      case 'quota': {
        if (!args.product) usage('--product is required');
        const limit = intArg('limit-30d', args['limit-30d'], 1);
        if (limit === undefined) usage('--limit-30d N is required');
        const reserve = intArg('reserve', args.reserve, 0);
        const [row] = await db<{ product: string; limit: number; reserve: number }[]>`
          update ingest.product_quotas
          set limit_30d = ${limit ?? 0}, reserve = coalesce(${reserve ?? null}, reserve),
              note = coalesce(${args.note ?? null}, note), verified_at = now()
          where product = ${args.product ?? ''}
          returning product, limit_30d as limit, reserve`;
        if (!row) {
          console.error(`no ingest.product_quotas row for ${args.product}`);
          process.exit(66);
        }
        console.log(
          `${row.product}: limit_30d=${row.limit} reserve=${row.reserve} verified_at=now()`,
        );
        break;
      }
      case 'budgets': {
        for (const p of TRIAL_PROFILES)
          console.log(
            p,
            JSON.stringify(
              budgetFor(
                planWatch(adapter, 'trial', p === 'extended' ? 'extended_boxscore' : 'full', p)
                  .cadence,
              ),
            ),
          );
        break;
      }
      default:
        usage(
          'usage: pnpm trial plan|watch|status|release|holds|lag|quota|preflight (see src/bin/trial.ts)',
        );
    }
  } catch (err) {
    if (err instanceof QuotaRefusedError) {
      console.error(err.message);
      process.exit(69);
    }
    throw err;
  } finally {
    await db.end({ timeout: 2 }).catch(() => undefined);
  }
}

function fmt(ms: number | null): string {
  return ms === null ? 'n/a' : `${ms} ms`;
}

/** Run the worker in-process-group with inherited stdio; resolves with its exit code. */
function runWorker(args: string[]): Promise<number> {
  const here = dirname(fileURLToPath(import.meta.url));
  const worker = join(here, 'worker.ts');
  return new Promise((resolve) => {
    const child = spawn('pnpm', ['exec', 'tsx', worker, ...args], {
      stdio: 'inherit',
      cwd: join(here, '..', '..'),
      env: process.env,
    });
    for (const signal of ['SIGINT', 'SIGTERM'] as const)
      process.on(signal, () => child.kill(signal));
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

export { gamesOn };
