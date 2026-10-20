# Deploying wehoop-api (M4)

Status (2026-10-18): **built, rehearsed locally, NOT deployed.** The owner decision of
2026-10-18 keeps the live WNBA Finals run on the fixed M3 commit and the polling path; the
Fly deploy and the switch of live ingestion to push wait until the M3 live rows pass. Every
step below that needs a Fly account is written as the exact command and marked NOT RUN; the
restart check has a local rehearsal the validator can run against the dev stack today.

## What runs where

| Process group (`fly.toml`) | Entrypoint | Does |
|---|---|---|
| `api` | `node src/bin/api.js` | Hono: `/health`, `/v1/games/:id/snapshot`, `/v1/games/:id/changes`, `/v1/players/:id`, `/v1/admin/quota`. Fly's HTTP check hits `/health` every 15 s. |
| `worker` (exactly one machine) | `node src/bin/worker.js` | Takes the single-ingester advisory lock on the **session** connection (exits 2 if another holds it; Fly restarts it, so two workers can never ingest at once), drains the outbox on start / NOTIFY / 30 s, sends pulses and (with the scheduler, or `--scores`) the `league:*:scores` scoreboard, and in `MODE=production` runs the scheduler (`src/ingest/scheduler.ts`): daily schedule for today + tomorrow per league with a key (06:00 ET, hourly inside game windows), a coverage-aware watch for every game within 10 min of tip-off, **push mode** (events + WNBA clock streams, REST pbp + summary every 5 min as reconciliation, backfill on every stream reconnect) where the league offers push events and the game has play-by-play coverage. |

The image is one multi-stage build (`Dockerfile`): `pnpm install --frozen-lockfile`, `tsc` to
`dist/`, `pnpm prune --prod`, runtime `node:22-alpine` as user `node` with `dist/src` copied to
`/app/src`. Verified locally on 2026-10-18: `pnpm build` produces `dist/src/bin/{api,worker,
outbox,retention,health,...}.js`; `docker build -t wehoop-api:m4-local .` succeeds (263 MB), and
`docker run ... node src/bin/worker.js` in `MODE=production` without `--game` passes config and
proceeds to the database connection (the scheduler path; it used to exit 64).

## Secrets and config (names only; values never in the repo)

Set as Fly secrets (`fly secrets set NAME=value -a wehoop-api`), both process groups share them:

```
MODE=production
DATABASE_URL                 Supabase cloud: the SESSION pooler or the direct connection (port 5432).
DATABASE_SESSION_URL         Same host, SESSION mode (5432). NEVER the transaction pooler (6543 /
                             pgbouncer=true): config refuses it; the advisory lock and LISTEN need a session.
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY    Publisher credential for Realtime Broadcast (private channels).
SUPABASE_ANON_KEY            Only needed by `pnpm subscribe` / tests; harmless on the server.
SPORTRADAR_WNBA_KEY          One per product; a missing key simply excludes the league from scheduling.
SPORTRADAR_NCAAWB_KEY
SPORTRADAR_UNRIVALED_KEY
SPORTRADAR_ACCESS_LEVEL=production   Required when MODE=production.
ADMIN_BEARER_TOKEN           Bearer for GET /v1/admin/quota (route answers 503 without it).
QUOTA_WNBA / QUOTA_NCAAWB / QUOTA_UNRIVALED   Leave blank; verify limits in the DB with
                             `pnpm trial quota --product <p> --limit-30d N` (QuotaGuard refuses unverified products).
LOG_LEVEL, PORT, NODE_ENV    Non-secret, set in fly.toml [env].
```

Everything else in `.env.example` is local-only (`SPORTRADAR_BASE_URL` is refused in production;
`WEHOOP_FAULT` is refused in production; `TRIAL_ALLOW_DEV_DB` is meaningless there).

Supabase cloud rules (from `.env.example`): pooled `DATABASE_URL` may be any mode, but the worker's
`DATABASE_SESSION_URL` must be session mode; `prepare: false` is already set for poolers; migrations
are applied with `supabase db push` against the linked project, never by the app.

## Runbook (NOT RUN; needs a Fly account)

**Prerequisites before the first `fly deploy`** (all after the M3 polling validation passes):
1. ~~The `RateLimiter.waitForSlot()` concurrency defect is fixed~~ **Done** (M3 `d34931a`, plan rev 4.8
   (3), carried into M4 by the rebase onto `m3-ncaawb-live`): one process's store claims are chained in
   call order, with a unit test of concurrent callers whose claims finish out of order. Each claim is
   also bounded (`DEFAULT_CLAIM_TIMEOUT_MS`, 10 s), so one hung claim fails its caller instead of
   stalling every later claim of the process.
2. `ingest.product_quotas` verified for every product the deployment has a key for (the guard refuses
   every call otherwise).
3. The `ANTHROPIC_API_KEY` repository secret for the hosted review row.

```
fly auth login
fly launch --no-deploy --copy-config --name wehoop-api --region ewr   # reads fly.toml; say no to Postgres/Redis
fly secrets set MODE=production SPORTRADAR_ACCESS_LEVEL=production \
  DATABASE_URL=... DATABASE_SESSION_URL=... SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
  SPORTRADAR_WNBA_KEY=... ADMIN_BEARER_TOKEN=...
fly deploy                        # builds the Dockerfile, deploys both process groups
fly scale count api=1 worker=1    # exactly one worker (the lock makes a second exit 2)
fly status
fly logs -a wehoop-api --process-group worker | grep -E "worker lock acquired|scheduler started"
curl -s https://wehoop-api.fly.dev/health | jq '{ok, degraded, alerts, worker}'
pnpm health check --url https://wehoop-api.fly.dev      # exit 0 = healthy, 1 = degraded or down
```

Before the first deploy the Supabase project must carry migrations `0001..0011`
(`supabase db push`) and `ingest.product_quotas.verified_at` must be set for every product with a
key (`pnpm trial quota ...` against the cloud DB), otherwise the QuotaGuard refuses every call and
`/health` shows `watch_without_provider_calls` as soon as a game is due.

### Worker restart check (acceptance row "Fly worker restart re-acquires lock")

On Fly (NOT RUN):

```
fly machine list -a wehoop-api                     # note the worker machine id
fly machine restart <worker-machine-id> -a wehoop-api
fly logs -a wehoop-api --process-group worker       # expect, in order:
#   "another worker holds the ingester lock; retrying"  (0..n times while Postgres notices the dead socket)
#   "worker lock acquired"
#   "aborted orphaned runs" / "aborted orphaned sub-runs" / "released orphaned reservations"
#   "scheduler started"  (production) or "trial watch started" + "push streams opened"
curl -s https://wehoop-api.fly.dev/health | jq '.worker.lockHeld'   # true
```

**Local rehearsal (run this today, dev stack only).** It kills the push-mode worker with
SIGKILL mid-game and restarts it; the second worker waits for the lingering lock, takes it, aborts the
dead worker's runs and continues as a new generation. Needs `pnpm supabase start`, `.env`, and
`.env.rehearsal` (copy `.env.rehearsal.example`; fake WNBA key, `SPORTRADAR_BASE_URL=http://127.0.0.1:8787`).
Do not export `.env` into the shell that runs the `*:rehearsal` scripts (exports override the files).

```
S=$(mktemp -d)
set -a; . ./.env; set +a      # only for the plain pnpm scripts below (sim serve, invariants, outbox, health)
pnpm sim relabel --in fixtures/wnba/sim-93ee7c68-replay.compact.jsonl.gz --out $S/restart.jsonl.gz \
  --coverage full --game-id 40bea3f6-68c0-4f3b-96fa-336dfb7a9034:m4restart-0000-4000-8000-000000000001
pnpm sim serve --replay-file $S/restart.jsonl.gz --speed 60 --port 8787 > $S/fake.log 2>&1 &   # 2.3 min game
(unset MODE DATABASE_URL DATABASE_SESSION_URL SUPABASE_URL SPORTRADAR_BASE_URL; \
 pnpm trial:rehearsal plan --league wnba --date 2026-06-30)                            # creates the game row
GAME=$(docker exec supabase_db_wehoop-api psql -U postgres -Atc \
  "select id from public.games where provider_game_id='m4restart-0000-4000-8000-000000000001'")
(unset MODE DATABASE_URL DATABASE_SESSION_URL SUPABASE_URL SPORTRADAR_BASE_URL; \
 LOG_LEVEL=info pnpm worker:rehearsal --league wnba --game $GAME --profile full --push --speed 60 > $S/A.log 2>&1 &)
sleep 12; kill -9 $(grep -o 'WORKER_PID=[0-9]*' $S/A.log | cut -d= -f2)             # the "machine restart"
(unset MODE DATABASE_URL DATABASE_SESSION_URL SUPABASE_URL SPORTRADAR_BASE_URL; \
 LOG_LEVEL=info pnpm worker:rehearsal --league wnba --game $GAME --profile full --push --speed 60 > $S/B.log 2>&1 &)
sleep 5; grep -E "holds the ingester lock|worker lock acquired|aborted orphaned|trial watch started|push streams opened" $S/B.log
# API on its own port (3100), so it can never be confused with another API on this machine:
(unset MODE DATABASE_URL DATABASE_SESSION_URL SUPABASE_URL SPORTRADAR_BASE_URL; \
 PORT=3100 API_BASE_URL=http://127.0.0.1:3100 pnpm api:rehearsal > $S/api.log 2>&1 &)
sleep 6; pnpm health check --url http://127.0.0.1:3100           # exit 0, lockHeld=true
curl -s http://127.0.0.1:3100/health | jq '{ok, degraded, alerts, worker: .worker.lockHeld, push: .push[0].streams}'
# wait for B to log "trial watch finished" (about 2.5 min from its start), then stop by port, never by pattern:
pnpm invariants; pnpm outbox lag --since 1h
kill $(lsof -ti tcp:3100 -sTCP:LISTEN) $(lsof -ti tcp:8787 -sTCP:LISTEN); sleep 1
grep -o 'FAKE_PROVIDER_STATS=.*' $S/fake.log                  # rejected429 must be 0
```

Re-run on 2026-10-20 at `11b0159` (2 s slots): SIGKILL at 11:11:14.606 EDT, worker B acquired the lock
1.36 s later, `/health` clean, `pnpm health check` exit 0, B closed the game 93-85, invariants 59/59, fake
provider 61/61 served with **0 x 429**, every per-product gap >= 2 s (`devlog/evidence/M4.md` R.3a-R.3e).
The figures below are the earlier run at 1.2 s slots, kept for comparison.

Observed on 2026-10-19 08:53 ET (dev stack, HEAD `0498f7d`, API on 3100): worker A killed at
08:53:37, worker B logged `worker lock acquired` at 12:53:38.113Z, then `aborted orphaned sub-runs`,
`aborted orphaned runs`, `released orphaned reservations`, `trial watch started`, `push streams
opened`; `pnpm health check --url http://127.0.0.1:3100` exited 0 with `lockHeld=true`, `runningRuns
2` (the watch and its push_stream sub-run), `alerts []`, both streams `connected`; B closed the game
93-85 (last_seq 1027 across both generations, 1 `superseded_observation`), invariants 59/59; fake
provider: 65 requests, **0 x 429**, 0 x 401, 4 push connections. (The run on 2026-10-18 showed one 429:
a push_clock connection sent 1.206 s after its slot, onto a REST pbp's slot; fixed in `b08a2d6`, see
"Rate limiting and push" below.)

## Push-mode acceptance rehearsal ("30 s stream drop -> reconnect + backfill, counts match")

Automated: `pnpm test:int` runs `test/integration/push-flow.test.ts` (fake provider with a push drop,
watch in push mode, polling-only replay of the same recording, equality of non-deleted play_events
count + bodies, game_periods and final score; >= 1 reconnect, >= 1 backfill sub-run, gap-free
stream, 0 x 401). The CLI form the validator can record:

```
set -a; . ./.env; set +a
pnpm sim serve --replay-file fixtures/wnba/sim-93ee7c68-replay.compact.jsonl.gz --speed 300 --port 8787 \
  --push-drop-after 12 --push-drop-for 3 > /tmp/fake-push.log 2>&1 &   # 3 wall seconds = 15 recorded minutes of stream outage
(unset MODE DATABASE_URL DATABASE_SESSION_URL SUPABASE_URL SPORTRADAR_BASE_URL; pnpm trial:rehearsal plan --league wnba --date 2026-06-30)
GAME=$(docker exec supabase_db_wehoop-api psql -U postgres -Atc "select id from public.games where provider_game_id='40bea3f6-68c0-4f3b-96fa-336dfb7a9034'")
(unset MODE DATABASE_URL DATABASE_SESSION_URL SUPABASE_URL SPORTRADAR_BASE_URL; \
 LOG_LEVEL=info pnpm worker:rehearsal --league wnba --game $GAME --profile full --push --speed 300 | tee /tmp/push.log)
grep -E "push stream (dis|re)connected|backfill (finished|skipped)|trial watch finished" /tmp/push.log
kill $(lsof -ti tcp:8787 -sTCP:LISTEN); sleep 1; grep -o 'FAKE_PROVIDER_STATS=.*' /tmp/fake-push.log   # rejected429 must be 0
pnpm invariants
pnpm dump-game --game $GAME > /tmp/push-dump.json
# polling-only reference of the same recording (new game id so both can coexist):
pnpm sim relabel --in fixtures/wnba/sim-93ee7c68-replay.compact.jsonl.gz --out /tmp/poll.jsonl.gz --coverage full \
  --game-id 40bea3f6-68c0-4f3b-96fa-336dfb7a9034:m4poll-00000-4000-8000-000000000001
pnpm dev:worker --mode sim --league wnba --replay-file /tmp/poll.jsonl.gz --pace 0 --until closed | grep GAME_ID
pnpm dump-game --provider-game-id m4poll-00000-4000-8000-000000000001 > /tmp/poll-dump.json
# compare: eventCount, every event body, periods and game.score must be identical; game.lastSeq and
# game.providerGameId differ by construction (see "what may differ").
python3 - <<'EOF'
import json
a=json.load(open('/tmp/push-dump.json')); b=json.load(open('/tmp/poll-dump.json'))
print('eventCount', a['eventCount'], b['eventCount'], a['eventCount']==b['eventCount'])
print('events equal', a['events']==b['events'])
print('periods equal', a['periods']==b['periods'])
print('score equal', a['game']['score']==b['game']['score'], a['game']['score'])
print('lastSeq push/poll', a['game']['lastSeq'], b['game']['lastSeq'])
EOF
```

What must match exactly: non-deleted `play_events` (count and canonical bodies), `game_periods`,
final score and status. What legitimately may differ: `game_changes` / `last_seq` (the 3 s polling
replay numbers every intermediate event revision and every summary's stats; push + 5-minute REST
sees fewer intermediate states but adds clock-carried score steps), `play_events.deleted_at` rows
(a play inserted and retracted between two reconciliations may never be seen by the push path),
`stale_observations` (push mode logs more `superseded_observation` rows: REST documents racing
newer push observations, by design), `provider_calls` (push mode makes far fewer REST calls plus
one row per stream connection).

Re-run on 2026-10-20 at `11b0159` (2 s slots): one events reconnect, reconciled by a backfill sub-run
(`backfills 1 + skipped 0 = reconnects 1`), 408 = 408 events against the polling-only replay, 93-85,
0 x 429, invariants 59/59 (`devlog/evidence/M4.md` R.2a-R.2d). With 2 s slots the backfill's own pbp
left about 6 s after the decision, behind the next cadence pbp, which already carried the missed events;
the backfill then inserted nothing (one redundant pbp call per reconnect; accepted). The figures below
are the earlier run at 1.2 s slots.

Observed on 2026-10-19 08:51 ET (dev stack after `pnpm supabase db reset`, HEAD `0498f7d`, `--speed 300`,
drop after 12 s for 3 s): both streams disconnected at 12:51:26Z, events stream reconnected at
12:51:31.000 and ran `backfill started` 12:51:31.002 / `backfill finished` 12:51:33.421 (`backfills: 1,
backfillsSkipped: 0`), clock stream reconnected at 12:51:34.603, watch `closed` 93-85 with 408 live + 2
deleted play_events, 648 changes all published, invariants 59/59, `pnpm outbox lag --since 1h`: n=648
p50 22 ms p95 217 ms max 221 ms; fake provider: **0 x 429**, 0 x 401, 4 push connections, 3 drops,
`slotReclaims: 0` on every stream; `provider_calls`: pbp 8 (one of them the backfill's), summary 8,
boxscore 1, push_events 2, push_clock 3 (one null status: the attempt refused inside the drop window).
A reconnect is reconciled either by this backfill or, when an APPLIED REST pbp document of this
generation was requested at or after the reconnect, by that document (logged "backfill skipped: ...");
`test/integration/push-flow.test.ts` asserts `backfills + backfillsSkipped = reconnects` and zero 429.

### Rate limiting and push

Slots are 2 s apart per product (plan rev 4.8: 1.2 s drew 8 x 429 on the first live game, and
Sportradar counts a 429 against the quota). Every connection attempt claims one slot from
`ingest.provider_rate_slots` like any REST call, but the push client claims **straight from the
ledger** (`claimSlot`, bounded like every claim) and sends on that slot with nothing awaited in
between; if it would leave more than 200 ms after its slot (timer lateness, an event-loop stall) it
abandons the slot and claims a new one (`slotReclaims` in the stream state), up to 4 times, then sends
late rather than never. `RateLimiter.waitForSlot()` has no re-claim, which is why push does not use
it. History: before plan rev 4.8, `waitForSlot()`'s in-process floor could order two concurrent
callers of one limiter differently from the ledger, so one caller landed on the other's slot (one 429
in the 2026-10-18 restart rehearsal, with correctly spaced recorded slots, so
`rate_limited_calls_spaced_at_least_one_second_per_product` could not see it); push-mode backfills
were given their own single-caller limiter for that reason and keep it. Since M3 `d34931a` the claims
of one limiter are chained in call order, which also covers two scheduler watches of one product in
one process.

## Alerts (`GET /health`)

`/health` always answers HTTP 200 while the database is reachable, with `degraded: true` and one
line per condition in `alerts[]`; HTTP 503 only when the database is unreachable, which is the only
case Fly should restart the API on. `pnpm health check [--url]` exits 1 on 503, `ok: false` or
`degraded: true` and prints the alerts, for an external monitor (cron, Uptime Kuma, ...).

| alert | condition | threshold (`HEALTH_THRESHOLDS`, `src/api/routes/health.ts`) | first response |
|---|---|---|---|
| `outbox_lag` | oldest unpublished, non-dead outbox row age | > 30 s | `pnpm outbox status`; is the worker alive (`lockHeld`)? Realtime 429s show as `rateLimited` in worker logs |
| `outbox_dead` | rows with `dead_at` (10 failed attempts) | > 0 | fix the transport, then `pnpm outbox requeue --channel game:<id>` or `--all` |
| `watch_without_provider_calls` | a running `watch_game`/`replay` run with a provider-backed source but no `provider_calls` row for | > 5 min | quota refused (`/v1/admin/quota`), key invalid (401 in logs), provider down |
| `consecutive_regressions` | the newest 3 `stale_observations` rows of one game within the last 24 h are all `run_regresses_state` (plan §4 rule 2) | 3 | a replay/restart keeps presenting older state; escape is `pnpm game rebuild` (operator action) |
| `push_stream_disconnected` | a `push_stream` sub-run's stream (meta mirrored by the worker) has `disconnectedSince` older than | > 60 s | provider stream outage; REST reconciliation keeps the game moving every 5 min; backfill runs on reconnect (skipped only when a REST pbp document of this generation was requested at or after the reconnect: the document covers everything up to its request, the stream everything after the reconnect). A stream whose connection attempts exhaust the watch's allowance of 20 (`PUSH_CONNECTION_ALLOWANCE`, shared by both streams) stops for good with `lastError: connection allowance exhausted`; the watch continues on REST alone until it closes |

Other operator commands: `pnpm outbox lag [--since 24h]` (p50/p95/max of `published_at -
created_at`), `pnpm retention run --closed-before 30d [--dry-run]` (the only code that deletes
`game_changes`; run it from a cron or by hand, never from the worker), `pnpm trial status` /
`GET /v1/admin/quota` for quota.

## Not in this slice

- `changes(date)` every 30 min (plan §4): no daily change log feed, Zod schema or fixture exists yet.
- Push statistics ingestion: the stream URL is resolved and the fake provider answers 404 for it;
  statistics stay on the REST summary every 5 min until a recorded sample pins the message shape.
- The hosted review workflow (`.github/workflows/claude-review.yml`) needs the repository secret;
  not an implementer change.
