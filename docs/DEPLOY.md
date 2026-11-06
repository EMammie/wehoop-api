# Deploying wehoop-api (M4)

Status (2026-11-05): **built, rehearsed locally, NOT deployed.** The owner decision of
2026-10-18 kept the live runs on the M3 commit and the polling path until M3 was validated. M3
is done: merged in PR #5 (`c48edec`), final evidence summary in PR #7, tag `m3` on `0e9be72`
(2026-11-04). The Fly deploy now waits on a payment card on the Fly account and the owner's go;
the deploy itself has NOT been run. The `ANTHROPIC_API_KEY` repository secret is needed only for
the hosted review row, not for the deploy. No production Sportradar key exists yet, so the first
deploy is a **quiet deploy** (below): it proves the deploy, the lock and the restart, not
ingestion. Every step below that needs a
Fly account is written as the exact command and marked NOT RUN; the restart check has a local
rehearsal the validator can run against the dev stack today.

## What runs where

| Process group (`fly.toml`) | Entrypoint | Does |
|---|---|---|
| `api` | `node src/bin/api.js` | Hono: `/health`, `/v1/games/:id/snapshot`, `/v1/games/:id/changes`, `/v1/players/:id`, `/v1/admin/quota`. Fly's HTTP check hits `/health` every 15 s. |
| `worker` (exactly one machine) | `node src/bin/worker.js` | Takes the single-ingester advisory lock on the **session** connection (exits 2 if another holds it; Fly restarts it, so two workers can never ingest at once), drains the outbox on start / NOTIFY / 30 s, sends pulses and (with the scheduler, or `--scores`) the `league:*:scores` scoreboard, and in `MODE=production` runs the scheduler (`src/ingest/scheduler.ts`): daily schedule for today + tomorrow per league with a key (06:00 ET, hourly inside game windows), a coverage-aware watch for every game within 10 min of tip-off, **push mode** (events + WNBA clock streams, REST pbp + summary every 5 min as reconciliation, backfill on every stream reconnect) where the league offers push events and the game has play-by-play coverage. |

The demo environment (`fly.demo.toml`, app `wehoop-demo`, NOT deployed) runs the same `api`
group and a `worker` group of `node src/bin/demo.js run` (section "Demo environment" below).

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
DATABASE_SESSION_URL         SESSION mode, never the transaction pooler (6543 / pgbouncer=true): config
                             refuses it; the advisory lock and LISTEN need a session. Use the DIRECT
                             connection (db.<ref>.supabase.co:5432, IPv6, which Fly machines have):
                             through the session pooler the lock lives on a pooled server connection,
                             and how the pooler resets that connection after a client dies is not
                             verified, so a dead worker's lock could outlive it.
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

## Runbook (NOT RUN; waits on the prerequisites below and the owner's go)

Fly account and app exist since 2026-10-21: org `personal` ("WBB", dedicated to this project), app
`wehoop-api` created empty with `fly apps create wehoop-api --org personal` (no machines, no IPs).
A payment card must be on the account before `fly deploy` can start machines.

**Prerequisites before the first `fly deploy`** (the M3 polling validation they waited on is done:
tag `m3`, 2026-11-04):
1. ~~The `RateLimiter.waitForSlot()` concurrency defect is fixed~~ **Done** (M3 `d34931a`, plan rev 4.8
   (3), carried into M4 by the rebase onto `m3-ncaawb-live`): one process's store claims are chained in
   call order, with a unit test of concurrent callers whose claims finish out of order. Each claim is
   also bounded (`DEFAULT_CLAIM_TIMEOUT_MS`, 10 s), so one hung claim fails its caller instead of
   stalling every later claim of the process.
2. `ingest.product_quotas` verified for every product the deployment has a **production** key for
   (the guard refuses every call otherwise). For the quiet deploy they stay unverified on purpose.
3. A payment card on the Fly account.
4. The owner's go for the deploy and, once production keys exist, for switching live ingestion to push.

(The `ANTHROPIC_API_KEY` repository secret belongs to the hosted review row, not to this list.)

### Quiet deploy (until production keys exist)

`MODE=production` requires `SPORTRADAR_ACCESS_LEVEL=production` (`src/config.ts`), and the Fly
worker has no other way to start: its command has no `--game`, and `MODE=trial` without one exits
64 on every restart. The keys that exist are trial keys, so the first deploy runs production mode
without being able to ingest:

- set `SPORTRADAR_WNBA_KEY` to a placeholder (e.g. `placeholder-until-production`), never a trial
  key, so no real key is ever on Fly;
- leave every `ingest.product_quotas.verified_at` null on the cloud database: the QuotaGuard refuses
  each call before it claims a slot or sends, so nothing reaches Sportradar;
- expect `schedule poll failed` (a quota refusal) in the worker log every hour. No game is
  discovered, so no watch starts and `/health` stays free of `watch_without_provider_calls`.
- expect, on the first start against the (unmarked, migration 0014) cloud database, the warning
  `database was unmarked; marked production (pnpm demo init now refuses it)`: the production
  worker writes `ingest.environment = production` before it takes the lock (rev 4.15 review), so an
  empty production project can never be turned into the demo by a mis-pointed `pnpm demo init`
  (which also refuses any database with quota-counted calls or an operator-verified limit).
  Every non-demo mode (production, trial, sim) refuses a database marked `demo`. The marker is
  written in one statement that only touches a row of the same kind, so a `demo init` racing a
  production start loses with a refusal instead of believing it marked the database. A database
  marked `production` by mistake (a demo project a production worker was pointed at before
  `demo init`) is unmarked by the owner only, by hand, after checking it holds no production data:
  `delete from ingest.environment;` in the SQL editor of that project, then `pnpm demo init`.

What it proves: the image boots on Fly, the worker takes the lock over the cloud connection,
`/health` is clean, and a restart re-acquires the lock. What it does not prove: resuming a watched
game after a restart on Fly (covered locally by the rehearsal below and
`test/integration/scheduler-resume.test.ts`) and the production scheduler end to end, which waits
for a production key. Plan rev 4.15 (B4) adds a separate demo environment (its own Fly app and
Supabase project, demo configuration of the same code) that runs the scheduler continuously
against committed recordings; its acceptance includes the restart check with a game mid-watch.
Switching to production never depends on the demo: it selects this app and its own project.

Cost: two shared-cpu-1x machines (512 MB worker, 256 MB api), roughly $5 a month (estimate, not
checked against current Fly pricing); `fly scale count api=0 worker=0` stops both.

```
fly auth login                    # the project's own Fly account (fly auth whoami)
# app already created (see above); fly.toml carries app name and region, so no `fly launch`
# the owner writes the secrets (NAME=value per line, names above) to a file outside the repo, so the
# values never enter shell history, imports it and deletes it:
fly secrets import -a wehoop-api < ~/wehoop-fly.env && rm ~/wehoop-fly.env
fly deploy --ha=false             # builds the Dockerfile, deploys both process groups; without
                                  # --ha=false Fly starts 2 machines per group and the 2nd worker
                                  # exits 2 and restarts forever
fly scale count api=1 worker=1    # exactly one worker (the lock makes a second exit 2)
fly status
fly logs -a wehoop-api --process-group worker | grep -E "worker lock acquired|scheduler started"
curl -s https://wehoop-api.fly.dev/health | jq '{ok, degraded, alerts, worker}'
pnpm health check --url https://wehoop-api.fly.dev      # exit 0 = healthy, 1 = degraded or down
```

Before the first deploy the Supabase project must carry migrations `0001..0013` (M4 alone needs `0001..0011`; `0012` and `0013` are additive, so M4 code also runs on a database that has them)
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
# optional, the crash path (the lock lingers until Postgres notices the dead socket; flags checked
# on flyctl v0.5.4):
fly machine stop <worker-machine-id> --signal SIGKILL -a wehoop-api && fly machine start <worker-machine-id> -a wehoop-api
```

`fly machine restart` sends `kill_signal` (SIGTERM): the worker drains and releases the lock, so the
new process usually takes it at once. In the quiet deploy there is no run to abort, so the
"aborted orphaned ..." lines may report nothing.

A restart during a game's complete -> closed wait resumes that game: the scheduler watches a game
stored as `complete` again, as a new generation starting in the slow after-complete phase, until
the later of (a) 120 min after the game became complete (`COMPLETE_CLOSE_WAIT_MS`, the budgeted
wait; the moment is the `created_at` of the first `status` change to `complete` in `game_changes`
after the game's last `status` change to any other status, so play re-opened after `complete`
restarts it and a score correction while complete does not move it)
and (b) 270 min after its scheduled tip-off (`COMPLETE_REWATCH_MS`: 150 min horizon + 120 min
wait, the floor when that moment is unknown), never later than 24 h after the scheduled tip-off
(`COMPLETE_REWATCH_CAP_MS`). A late tip-off or overtime therefore keeps the whole wait. Expect
"scheduler: resuming the watch of a complete game (waiting for closed)" with `completedAt` and
`until` in the log line. Covered on the dev stack by `test/integration/scheduler-resume.test.ts`.

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

## Demo environment (plan rev 4.15, M5 B4)

Until production keys exist, TestFlight runs against a **separate demo environment**: the same
code with demo configuration, in its own Supabase project and its own Fly app (`wehoop-demo`,
`fly.demo.toml`). One worker process (`pnpm demo run`, `src/bin/demo.ts`) runs the demo host
(`src/providers/sportradar/demo-host.ts`) on loopback and the production scheduler against it.
Nothing here needs, accepts or reaches a Sportradar key: `MODE=demo` refuses to start with any
`SPORTRADAR_*_KEY` set, and `SportradarHttp` / `PushStream` refuse, before any network I/O, every
request whose origin is not the demo host (`DestinationRefusedError`). It does **not** establish
real-provider push availability or latency.

What the demo host serves:

| | |
|---|---|
| Rotation | one slot every `--interval` (default 180 min) on a fixed grid (`SLOT_ORIGIN` 2026-01-01 00:00 ET + k x interval), today and tomorrow (US Eastern), alternating `fixtures/wnba/sim-93ee7c68-replay.compact.jsonl.gz` and `fixtures/ncaawb/sim-d9b71fe0-replay.compact.jsonl.gz` (`recorded`); `--include-synthetic` adds `fixtures/unrivaled/docs-838316ea-replay.jsonl` (`synthetic`). Each league's daily schedule lists only its own slots, and a slot only until its `closed` document is served: a host started mid-day never creates that morning's finished slots as closed 0-0 games, while a game listed earlier is resumed from the database (the scheduler loads games, not listings) and its documents stay served. |
| Identity | `replay-<rec8>-<yyyymmddHHMM>` (tip-off in UTC), from the recording and the slot only. |
| Timeline | every ISO timestamp shifted by slot tip-off - recorded tip-off (the recording's `scheduled`), recorded game id replaced; a document is served from tip-off + (its request time - the recording's request/game-clock lead - recorded tip-off), so no served revision is later than the moment it is served (WNBA plays begin about 16 min after the tip-off, as in the recorded game; NCAAWB about 3 min). Before the first document: the first (pregame) one; after the last: `closed`. A restarted host serves the same documents at the same moments. |
| Spans | WNBA 140 min, NCAAWB 127 min (first document to `closed`); the host refuses an interval at or below the longest span, or below the served windows' footprint (153 min for the default rotation). |
| Provenance | `ingest.replay_slots` (recording id, fixture path + sha256, recorded game id and tip-off, slot tip-off, shift), upserted (re-checked on every request, never cached) before a slot appears in any document; a different existing row is refused: that slot answers 409 and is left out of its league's listing, the process logs it and carries on. Migration 0014's trigger labels the game row `games.replay` from it when the schedule ingest creates the game. |
| Label | `replay` (`recorded` / `synthetic` / null) on `v_schedule`, the snapshot's `game`, every `pulse` and every `league:*:scores` delta; generated into Contracts (`ReplayKind`). |
| Calls | source `rehearsal` (rate-limited, guarded, logged in `provider_calls`, never quota-counted); the host answers 401 without a key header (the demo resolver sends a placeholder) and 429 on two calls of one product within 1 s. |

### Local rehearsal on the dev stack (runnable today)

```
pnpm supabase db reset                       # 0014 applied; the dev stack is regenerable
set -a; source .env; set +a                  # MODE=sim in .env is overridden: pnpm demo is always MODE=demo
pnpm demo init                               # marks the database demo, synthetic limits, reference fixtures (exit 65 if it holds games)
pnpm demo run                                # real time: one replay every 3 h; Ctrl-C drains and exits 0
curl -s 127.0.0.1:8790/_demo/status          # listed slots, their status, host counters (no key)
```

Restart-continuity rehearsal at compressed speed (about 4 minutes; the automated version is
`test/integration/demo-restart.test.ts`). Run from the repo root after the four setup lines above
(`db reset`, `source .env`, `demo init`), with no other `demo run` or worker running:

```
L=${L:-$(mktemp -d)}; echo "logs in $L"                       # outside the repo
q() { docker exec supabase_db_wehoop-api psql -U postgres -Atc "$1"; }
T0=$(q "select now()")                                         # for the no-traffic check below
EP=$(pnpm -s demo epoch --speed 60 --lead 12 --league wnba)
E=$(echo "$EP" | sed -n 's/^DEMO_EPOCH=//p'); SLOT=$(echo "$EP" | sed -n 's/^next slot \([^ ]*\).*/\1/p')
pnpm api > "$L/api.log" 2>&1 & API=$!                               # the Hono API on :3000 (non-watch), for the subscriber
pnpm demo run --league wnba --speed 60 --epoch "$E" > "$L/demo1.log" 2>&1 &
until [ -n "$(q "select id from public.games where provider_game_id = '$SLOT'")" ]; do sleep 1; done
GAME=$(q "select id from public.games where provider_game_id = '$SLOT'")
pnpm subscribe --game "$GAME" --record "$L/sub.jsonl" --settle-ms 5000 > "$L/sub.log" 2>&1 & SUB=$!   # connected throughout
until [ "$(q "select count(*) >= 120 from public.play_events where game_id = '$GAME'")" = t ]; do sleep 1; done
kill -9 "$(sed -n 's/^WORKER_PID=//p' "$L/demo1.log")"              # mid-game, no tail runs
pnpm demo run --league wnba --speed 60 --epoch "$E" > "$L/demo2.log" 2>&1 & RUN2=$!   # SAME --speed and --epoch
until [ "$(q "select status from ingest.ingestion_runs where kind = 'watch_game' and game_id = '$GAME' order by id desc limit 1")" = ok ]; do sleep 2; done
until [ "$(q "select count(*) from ingest.broadcast_outbox where game_id = '$GAME' and published_at is null")" = 0 ]; do sleep 1; done
kill -TERM "$(sed -n 's/^WORKER_PID=//p' "$L/demo2.log")"; wait $RUN2; echo demo2 exit=$?   # drains, exits 0
wait $SUB                                                      # the subscriber exits after closed + settle
q "select id, status from ingest.ingestion_runs where kind = 'watch_game' and game_id = '$GAME' order by id"   # aborted, then ok
pnpm demo verify-slot --slot "$SLOT"; echo exit=$?            # PASS, exit 0 (the polling-only comparison)
grep '"kind":"pulse"' "$L/sub.jsonl" | tail -1                      # the pulse carries "replay":"recorded"
tail -3 "$L/sub.log"                                                # summary: contiguous, derived state equals the final snapshot
pnpm invariants
kill $API                                                      # the API
```

`verify-slot` replays the closed slot's shifted documents polling-only (pace 0, in-process,
through applyChanges) into a check game `check-<slot id>` and compares the canonical state of the
two games: status, score, periods, the non-deleted events (count, bodies, ordering key), team and
player stats. It deliberately does not compare `last_seq` or the number of changes, `deleted_at`
rows, or stale observations, which legitimately differ between ingestion paths of one recording:
the 3 s polling replay numbers every intermediate revision it sees, the push watch with 5-minute
REST reconciliation sees fewer intermediate states but adds clock-carried score steps, and the
restarted watch re-reads documents (logged stale, never written twice). In the validator's run of
this rehearsal `last_seq` was 999 for the restarted demo game, 1022 for an uninterrupted demo
replay and 1233 for the polling-only replay, with events, periods, score and status equal. A play inserted and
retracted between two REST reconciliations is never observed by the push path, so it has no
`deleted_at` row there. `verify-slot` takes no ingester lock (the check game has its own provider
id, row and generation; the demo scheduler never watches a `check-` game and the host never lists
one), so it can run next to `demo run`, e.g. as the hosted demo's periodic self-check; while the
check game exists (seconds) `v_schedule` shows it as a second replay of the slot. It is purged with
every dependent row afterwards unless `--keep`; it refuses a slot that is not `closed` (exit 65).
It prints one verdict line (plus the first differences on FAIL) at `LOG_LEVEL=info` or above; `debug`
(what the dev `.env` sets) also shows the replay's per-document log. On the dev stack it takes about
5 s for the WNBA slot.

No-traffic check (every provider call of the demo is on the demo host and uncounted):

```
T0=$(docker exec supabase_db_wehoop-api psql -U postgres -Atc "select now()")    # BEFORE the first pnpm demo run
# ... the demo runs ...
docker exec supabase_db_wehoop-api psql -U postgres -Atc "select count(*) from ingest.provider_calls where called_at >= '$T0' and (url not like 'http://127.0.0.1:8790/%' or quota_counted or source <> 'rehearsal')"   # expect 0: EVERY call since the demo started (schedule polls with no game included)
docker exec supabase_db_wehoop-api psql -U postgres -Atc "select count(*) from ingest.provider_calls where called_at >= '$T0'"   # expect > 0 (the check above is not vacuous)
docker exec supabase_db_wehoop-api psql -U postgres -Atc "select count(*) from ingest.provider_calls where quota_counted and source = 'rehearsal'"   # expect 0
SPORTRADAR_WNBA_KEY=x pnpm demo run; echo exit=$?                               # refused: exit 65
SPORTRADAR_BASE_URL=https://api.sportradar.com pnpm demo run; echo exit=$?      # refused: exit 65
```

Cleanup: `pnpm demo purge --older-than 7d [--dry-run]` (or `--all`) deletes, with every dependent
row, one transaction per game, in foreign-key order (`src/ingest/demo-purge.ts`): closed replay
games quiet for that long, and replay games that never closed whose tip-off is that old. Whatever
the flags, it never touches a slot inside the listing horizon (the latest `closed` moment of any
known recording plus 30 min after its tip-off, about 3 h 6 min), never a game that is not closed
while the scheduler could still resume it (30 h after its tip-off: the 6 h late-start bound plus the
24 h `complete` re-watch cap), and skips a game with a `running` run or with unpublished or dead
outbox rows; it prints what it did and, dry run or not, every replay game it left alone, counted
by the rule that kept it (inside the listing horizon, inside the 30 h resume window, a running run,
unpublished outbox rows, not quiet since the cutoff). Dead rows are requeued with the ordinary maintenance CLI in
demo mode, the only mode allowed to write to a demo database (the same CLIs, not demo-specific
wrappers: one code path for outbox and retention in every environment):
`MODE=demo SPORTRADAR_BASE_URL=http://127.0.0.1:8790 pnpm outbox requeue --channel game:<uuid>`
(likewise `pnpm outbox status` and `pnpm retention run ...`); on Fly the demo app's `[env]`
already sets both, so `fly ssh console -a wehoop-demo -C "node src/bin/outbox.js requeue --channel game:<uuid>"`
(NOT RUN). Under the default `MODE=sim` those CLIs refuse a demo database (exit 65). A rotation, `--interval` or
`--league` change in a later deploy orphans the slots already listed under the old grid (their ids
no longer parse on the new one, so their documents answer 404 and they never close): purge removes
them once they are older than the cutoff. Demo databases and the dev stack only. Besides the retention job it is the only code that
deletes `game_changes`. Switching to production selects the production app and project; it never
depends on a purge.

### Hosted demo (NOT RUN; waits on the owner's go and a demo Supabase project)

Every command below needs a cloud project or Fly and has **not** been run.

```
# 1. Its own Supabase project (never the production one), migrations 0001..0014:
supabase link --project-ref <demo-ref> && supabase db push                       # NOT RUN
# 2. Mark it demo and load the reference fixtures, from a machine with the demo project's URLs:
DATABASE_URL=<demo session/direct URL> DATABASE_SESSION_URL=<demo direct URL> \
  SUPABASE_URL=<demo url> SUPABASE_SERVICE_ROLE_KEY=<demo key> pnpm demo init     # NOT RUN
# 3. Its own Fly app (fly.demo.toml: MODE=demo and SPORTRADAR_BASE_URL in [env]; worker = node src/bin/demo.js run):
fly apps create wehoop-demo --org personal                                       # NOT RUN
fly secrets set -a wehoop-demo DATABASE_URL=... DATABASE_SESSION_URL=... \
  SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... ADMIN_BEARER_TOKEN=...          # NOT RUN (no SPORTRADAR_* secret, ever)
fly deploy -c fly.demo.toml                                                      # NOT RUN (builds the Dockerfile `demo` target, fixtures included)
fly scale count worker=1 -a wehoop-demo                                          # NOT RUN
# 4. Weekly cleanup (cron or by hand, against the demo project only):
pnpm demo purge --older-than 7d                                                  # NOT RUN
```

The demo worker refuses a database that is neither the dev stack nor marked `demo`; the
production worker (`MODE=production`) refuses a database marked `demo`.

Known limits: at `--speed` > 1 the scheduler's complete-to-closed resume bounds compare the
compressed clock with `game_changes.created_at` (wall clock), so a restart during a compressed
`complete` phase may not resume the watch (real time, the hosted case, is unaffected). The
Unrivaled replay's docs-sample revisions are stamped after its synthetic request times, so its
served revisions lie in the future (it is `synthetic` and off by default).

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
| `push_stream_disconnected` | a `push_stream` sub-run's stream (meta mirrored by the worker) has `disconnectedSince` older than | > 60 s | provider stream outage; REST reconciliation keeps the game moving every 5 min; backfill runs on reconnect (skipped only when a REST pbp document of this generation was requested at or after the reconnect: the document covers everything up to its request, the stream everything after the reconnect). The watch's reservation covers one backfill pbp per possible events reconnect (`PUSH_BACKFILL_ALLOWANCE` = 20 - 1 = 19 whatever streams are open: a refunded clock attempt can leave all 20 attempts to the events stream; push total 94 REST + 20 connections + 19 backfills = 133, for WNBA and events-only leagues alike). A stream whose connection attempts exhaust the watch's allowance of 20 (`PUSH_CONNECTION_ALLOWANCE`, shared by both streams) stops for good with `lastError: connection allowance exhausted`; the watch continues on REST alone until it closes |

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
