# M3 — NCAAWB live (trial key, Nov) — validation evidence (at HEAD 6d58289, plan rev 4.5)

**Verdict: NOT DONE.** No trial key exists (`grep -c '^SPORTRADAR_NCAAWB_KEY' .env` → `0`), the NCAAWB season has not started, and this battery never contacted `api.sportradar.com`, never set `MODE=production`, and never requested or used a key. Every acceptance row that needs the real host is recorded **NOT RUN** with the November command. Everything that can be proven against the local stand-in (`pnpm sim serve`, loopback, made-up key literal `rehearsal-not-a-key`, `source = 'rehearsal'`, `quota_counted = false`) was run and is recorded below as a rehearsal, labelled as such. One **FAIL** was found in the corrective-pass battery (item 8c → item 1c): the 1 s/product spacing is enforced per process, so `pnpm trial plan` followed within 1 s by `pnpm trial watch` produced a 595 ms gap and a 429 from the fake host.

## Environment

| Field | Value |
|---|---|
| Date | 2026-10-16 23:03–23:35 EDT (DB and worker timestamps are UTC, 2026-10-17 03:03–03:35) |
| Branch / commit | `m3-ncaawb-live` @ `6d5828946b823dc45017f04020451ab2ca7bfc53` (`git rev-parse HEAD`); `git status --porcelain` empty at start and at the end (before this file was written) |
| `node --version` | v25.9.0 |
| `pnpm supabase --version` | 2.120.0 (CLI prints "A new version … v2.121.0 is available") |
| Supabase stack | running (`pnpm supabase status`: only `imgproxy`, `edge_runtime`, `pooler` stopped, as always locally). `pnpm supabase db reset` run four times: #1 (23:04:23) first pass, #2 (23:07:55) the authoritative rehearsal, #3 (23:30:40) the kill -9 battery, #4 (23:32:57) before `pnpm test:int`. Each applied 10 migrations (`grep -c "Applying migration"` → `10`) |
| Key / host | `.env` has no `SPORTRADAR_NCAAWB_KEY`, no `SPORTRADAR_BASE_URL`, no `ADMIN_BEARER_TOKEN` line (`grep -c` → `0 0 0`); `MODE=sim` in `.env`. Every rehearsal command exported `MODE=trial SPORTRADAR_NCAAWB_KEY=rehearsal-not-a-key SPORTRADAR_BASE_URL=http://127.0.0.1:8787` (or `:8788`) inline; the API was started with `ADMIN_BEARER_TOKEN=rehearsal-admin-token`. Both literals are made up. No env value is printed anywhere in this file or in the scratchpad logs (item 10) |
| External services | none beyond the local stack and the two loopback fake servers. `api.sportradar.com` appears in this battery only inside the text of the `--speed` refusal message (item 8a) |
| SQL access | no `psql` on the host; every `$PSQL` below is `docker exec -i supabase_db_wehoop-api psql -U postgres -d postgres -At -c "<sql>"` (wrapper `psql.sh` in the scratchpad) |
| Logs | scratchpad `m3v/`: `reset{1..4}.log`, `fake-8787-plan.log`, `fake-8787-full.log`, `fake-8788-plan.log`, `fake-8788-ext.log`, `fake-8787-kill9.log`, `fake-8787.log` (first pass), `api.log`, `quota.log`, `plan-full.log`, `watch-full.log`, `watch-ext.log`, `watch-kill9-{1,2}.log`, `sub-full.{jsonl,log}`, `sub-ext.{jsonl,log}`, `lag-{full,ext}.log`, `status-{afterkill,full,ext}.log`, `release1.log`, `refuse-speed.log`, `refuse-host.log`, `holds.log`, `holds-impact.out`, `evidence-{full,both}.out`, `run-{full,ext,kill9}.out`, `invariants-{rehearsal,kill9,posttest}.log`, `int-{extended-replay-fixture,holds-impact,trial-flow}.log`, `unit-cadence-loop.log`, `check.log`, `testint.log` |

### db reset applies 0001–0010

Command:
`pnpm supabase db reset`
Output (reset #1, 23:04:23–23:04:49 EDT; resets #2–#4 printed the identical list, `grep -c "Applying migration"` → `10` each):
```
Resetting local database...
Recreating database...
Initialising schema...
Seeding globals from roles.sql...
Applying migration 0001_core.sql...
Applying migration 0002_freshness_and_outbox_routing.sql...
Applying migration 0003_corrective_pass.sql...
Applying migration 0004_stats_observed_at.sql...
Applying migration 0005_three_leagues_identity.sql...
Applying migration 0006_provider_keyed_stats.sql...
Applying migration 0007_merge_provenance.sql...
Applying migration 0008_hold_documents.sql...
Applying migration 0009_trial_budget.sql...
Applying migration 0010_rehearsal_source.sql...
Seeding data from supabase/seed.sql...
Restarting containers...
Finished supabase db reset on branch m3-ncaawb-live.
```
Result: PASS

### Fixtures

Command:
`shasum -a 256 fixtures/ncaawb/*.gz`
Output:
```
6a9872607adf1478a50c7b404fca066a000f9ec5bef8eb381159d5ab5469d8c0  fixtures/ncaawb/sim-d9b71fe0-replay.compact.jsonl.gz
bf31b04f6f67d46ab79084ee10589b382f0407530b06eb3d62327a7e7703e626  fixtures/ncaawb/sim-d9b71fe0-replay.extended.jsonl.gz
```
Both match the `sha256` rows in `fixtures/ncaawb/README.md` (compact `6a98…d8c0`, extended `bf31b04f…7703e626`). The extended file is the documented relabel of the compact one:
Command:
`gzcat fixtures/ncaawb/sim-d9b71fe0-replay.extended.jsonl.gz | grep -o '"coverage":"[a-z_]*"' | sort | uniq -c; gzcat … | grep -c 2e36b340-9277-4b99-af20-b7ff7e86640e; gzcat … | grep -c e5e5e5e5-9277-4b99-af20-b7ff7e86640e`
Output:
```
 138 "coverage":"extended_boxscore"
0
138
```
Result: PASS

### Fresh-DB baseline (after reset #2, before any rehearsal command)

Command:
`$PSQL "select * from ingest.v_quota order by product"` and `$PSQL "select (select count(*) from ingest.provider_calls), (select count(*) from ingest.budget_reservations), (select count(*) from ingest.player_merge_holds), (select count(*) from public.games)"`
Output (columns `product|limit_30d|reserve|verified_at|used_30d|remaining|reserved|spendable`):
```
ncaawb|1000|100||0|1000|0|900
unrivaled|1000|100||0|1000|0|900
wnba|1000|100||0|1000|0|900
0|0|0|0
```

### Rehearsal sequence actually run (reset #2 DB)

`pnpm sim serve --replay-file fixtures/ncaawb/sim-d9b71fe0-replay.compact.jsonl.gz --speed 60 --port 8787` (for the schedule call) → `pnpm trial quota …` → `pnpm trial plan …` → fake server restarted (its timeline starts at process start, so the watch must begin right after it) → `pnpm trial watch … --profile full --speed 60` at 23:08:49 EDT, 2.5 s after the server → `pnpm subscribe … --until closed` at 23:08:52 → watch ends 23:10:56 → `pnpm trial lag`, `pnpm trial status`, SQL → the same on port 8788 with the extended fixture: `trial plan` (second schedule call) → server restarted → `trial watch … --speed 60` at 23:18:52 (profile defaulted to `extended`) → subscribe at 23:18:55 → ends 23:21:00 → `trial lag`, `trial status`, `trial holds`, `holds-impact.sql`, `pnpm invariants` → single-file tests. The first pass on reset #1 started its watch 45 s (= 45 recording minutes at 60x) after the fake server and was repurposed for item 8b (manual release) and then discarded by reset #2; see Findings.

---

## 1. `provider_calls` min spacing ≥ 1 s

### 1a. Rehearsal: spacing query after both watches
Command:
`$PSQL "select product, source, min(gap) as min_gap, count(*) as calls, count(*) filter (where quota_counted) as counted from (select product, source, quota_counted, called_at - lag(called_at) over (partition by product, source order by called_at, id) as gap from ingest.provider_calls where source in ('trial','production','rehearsal')) g group by 1,2 order by 1,2"`
Output:
```
ncaawb|rehearsal|00:00:01.05|246|0
```
Command:
`$PSQL "select count(*) from (select called_at - lag(called_at) over (partition by product order by called_at, id) as gap from ingest.provider_calls where source in ('trial','production','rehearsal')) g where g.gap < interval '1 second'"` (the invariant body) and `$PSQL "select source, quota_counted, status, count(*) from ingest.provider_calls group by 1,2,3"`
Output:
```
0
rehearsal|f|200|246
```
Fake server summaries (printed on SIGINT; `rejected429` is the host-side count of sub-1 s arrivals):
Command:
`grep -a FAKE_PROVIDER_STATS m3v/fake-8787-plan.log m3v/fake-8787-full.log m3v/fake-8788-plan.log m3v/fake-8788-ext.log`
Output:
```
FAKE_PROVIDER_STATS={"requests":1,"served":1,"rejected401":0,"rejected429":0,"byFeed":{"schedule":1}}
FAKE_PROVIDER_STATS={"requests":122,"served":122,"rejected401":0,"rejected429":0,"byFeed":{"pbp":95,"summary":26,"boxscore":1}}
FAKE_PROVIDER_STATS={"requests":1,"served":1,"rejected401":0,"rejected429":0,"byFeed":{"schedule":1}}
FAKE_PROVIDER_STATS={"requests":122,"served":122,"rejected401":0,"rejected429":0,"byFeed":{"summary":120,"boxscore":2}}
```
1 + 122 + 1 + 122 = 246 = `provider_calls` rows, all HTTP 200.
Invariant line from `pnpm invariants` on this DB (full output in item 9c):
```
rate_limited_calls_spaced_at_least_one_second_per_product  0       0       PASS
```
Result: PASS (rehearsal, fake host, not quota-counted)

### 1b. Live
Result: NOT RUN (no trial key; NCAAWB season not started). November command, after the live watches:
`docker exec -i supabase_db_wehoop-api psql -U postgres -d postgres -At -c "select product, source, min(gap) as min_gap, count(*) as calls, count(*) filter (where quota_counted) as counted from (select product, source, quota_counted, called_at - lag(called_at) over (partition by product, source order by called_at, id) as gap from ingest.provider_calls where source in ('trial','production','rehearsal')) g group by 1,2"` — expected shape `ncaawb|trial|00:00:01.05|N|N` with `min_gap >= 00:00:01`, and `pnpm invariants` → `rate_limited_calls_spaced_at_least_one_second_per_product 0 0 PASS`.

### 1c. Cross-process spacing: `pnpm trial plan` followed within 1 s by `pnpm trial watch` (found in item 8c, reset #3 DB)
Command (from `m3v/run-kill9.sh`: `pnpm trial plan --league ncaawb --date 2026-02-18` then immediately `pnpm trial watch --league ncaawb --game 2e36b340-… --profile full --speed 60 --note "rehearsal kill-9 target"`), then:
`$PSQL "select id, reservation_id, feed, status, called_at, called_at - lag(called_at) over (order by called_at, id) as gap from ingest.provider_calls order by called_at, id"` (first three rows) and `grep -a -A3 "fake provider: 429" m3v/fake-8787-kill9.log`
Output:
```
1||schedule|200|2026-10-17 03:31:11.79+00|
2|1|pbp|429|2026-10-17 03:31:12.385+00|00:00:00.595
3|1|summary|200|2026-10-17 03:31:13.435+00|00:00:01.05
```
```
[03:31:12.403] WARN: fake provider: 429
    spacingMs: 595
    path: "/ncaawb/trial/v8/en/games/2e36b340-9277-4b99-af20-b7ff7e86640e/pbp.json"
FAKE_PROVIDER_STATS={"requests":35,"served":34,"rejected401":0,"rejected429":1,"byFeed":{"schedule":1,"summary":7,"pbp":26}}
```
Worker log (`m3v/watch-kill9-1.log` line 51–69): `ERROR: fetch failed; retrying at the next due time … "sportradar pbp -> HTTP 429: {\"message\":\"Too Many Requests: developer over QPS\"}"`; the worker recovered at the next slot (row 3, +1.05 s) and the run continued.
Command:
`pnpm invariants` (reset #3 DB, after the item 8c battery)
Output (the two spacing lines and the tally):
```
counted_calls_spaced_at_least_one_second_per_product       0       0       PASS
rate_limited_calls_spaced_at_least_one_second_per_product  0       1       FAIL
54/55 invariants hold
```
Cause (source, not opinion): `src/providers/sportradar/rate-limiter.ts` — "One limiter per product per process (`rateLimiterFor`)"; `nextSlot` starts `null`, so a new process's first slot is `now`. The `trial plan` CLI and the worker spawned by `trial watch` are two processes, and nothing seeds the worker's first slot from `max(called_at)` in `ingest.provider_calls`. In the authoritative rehearsal (1a) the plan ran ≥ 6 s before the watch, so the gap did not show. Against the real host in November, `plan` immediately followed by `watch` is exactly the operator sequence; a 429 there wastes a slot and, if Sportradar counts rejected requests, a quota call.
Result: FAIL

## 2. Per-game call totals vs reservation

### 2a. Rehearsal
Command:
`pnpm trial status` (after both watches; `MODE=trial SPORTRADAR_NCAAWB_KEY=rehearsal-not-a-key SPORTRADAR_BASE_URL=http://127.0.0.1:8788`)
Output:
```
product    limit  used  remaining  reserved  reserve  spendable  verified
ncaawb      1000     0       1000         0      100        900  2026-10-17T03:08:43.010Z
unrivaled   1000     0       1000         0      100        900  no
wnba        1000     0       1000         0      100        900  no

reservations (used = calls made under the reservation; counted = quota-counted):
  #1 ncaawb full      game=273aa916-94d5-4488-8362-f73b490363ed source=rehearsal run=2 reserved=332 used=122 provider_calls=122 counted=0 released
  #2 ncaawb extended  game=22058583-c21c-42b3-a1ff-aecb1292b999 source=rehearsal run=4 reserved=153 used=122 provider_calls=122 counted=0 released
```
Command:
`$PSQL "select b.id, b.profile, b.source, b.reserved_calls, b.used_calls, count(c.id) as provider_calls, b.released_at is not null as released, b.run_id, r.status as run_status, r.kind from ingest.budget_reservations b left join ingest.provider_calls c on c.reservation_id=b.id join ingest.ingestion_runs r on r.id=b.run_id group by b.id, r.status, r.kind order by b.id"`
Output:
```
1|full|rehearsal|332|122|122|t|2|ok|watch_game
2|extended|rehearsal|153|122|122|t|4|ok|watch_game
```
Command (implementer's `evidence.sql`, "calls by feed per reservation" and "watch runs"):
`docker exec -i supabase_db_wehoop-api psql -U postgres -d postgres -At -f /dev/stdin < scratchpad/evidence.sql`
Output:
```
== calls by feed per reservation
1|boxscore|1
1|pbp|95
1|summary|26
2|boxscore|2
2|summary|120
== watch runs
2|watch_game|rehearsal|ok|full|332
4|watch_game|rehearsal|ok|extended|153
```
Watch wall times (from `m3v/run-full.out`, `m3v/watch-full.log`, `m3v/run-ext.out`, `m3v/watch-ext.log`): full `WATCH_START=2026-10-16 23:08:49 EDT` … `WATCH_EXIT=0 WATCH_END=2026-10-16 23:10:56 EDT` (127 s); extended `WATCH_START=2026-10-16 23:18:52 EDT` … `WATCH_EXIT=0 WATCH_END=2026-10-16 23:21:00 EDT` (128 s). Watch header lines: `profile full, budget 332 calls (pbp 300, summary 30, boxscore 0, closing 2)` and `profile extended, budget 153 calls (pbp 0, summary 150, boxscore 1, closing 2)`.
Why 122 and not 332/153: at `--speed 60` the full profile's 30 s pbp cadence becomes 0.5 s, below the 1.05 s limiter slot, so the call count is wall-time-bound (~127 s / 1.05 s ≈ 121 + closing) rather than cadence-bound; the extended profile's 60 s summary cadence becomes 1 s, also limiter-bound. The reservation is computed for real time and is an upper bound; `used_calls` = `provider_calls` rows under each reservation (invariant below).
Invariant line:
```
reservation_used_calls_match_provider_calls                0       0       PASS
```
Result: PASS (rehearsal; totals are limiter-bound at 60x, not a prediction of the live count)

### 2b. Live
Result: NOT RUN (no trial key). November: `pnpm trial status` after both live watches, and the join query above; expected `#1 ncaawb full … source=trial reserved=332 used=N provider_calls=N counted=N released` and `#2 ncaawb extended … reserved=153 used=M … released`, with `N ≤ 332`, `M ≤ 153`.

## 3. `v_quota` after vs console

### 3a. Rehearsal
Command:
`$PSQL "select * from ingest.v_quota where product='ncaawb'"` (before), then `pnpm trial quota --product ncaawb --limit-30d 1000 --reserve 100 --note "rehearsal"`, then the same select (after), then again after both watches
Output:
```
ncaawb|1000|100||0|1000|0|900
ncaawb: limit_30d=1000 reserve=100 verified_at=now()
ncaawb|1000|100|2026-10-17 03:08:43.010216+00|0|1000|0|900
ncaawb|1000|100|2026-10-17 03:08:43.010216+00|0|1000|0|900
```
`used_30d` stayed `0` through 246 rehearsal calls (`quota_counted = f` on every row, item 1a); `reserved` is `0` after both releases; `spendable` 900. The product row: `$PSQL "select product, limit_30d, reserve, note, verified_at is not null from ingest.product_quotas where product='ncaawb'"` → `ncaawb|1000|100|rehearsal|t`.
Admin endpoint (API started as `ADMIN_BEARER_TOKEN=rehearsal-admin-token pnpm dev:api`):
Command:
`curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/v1/admin/quota; curl -s -o /dev/null -w '%{http_code}\n' -H 'authorization: Bearer nope' localhost:3000/v1/admin/quota; curl -s -H 'authorization: Bearer rehearsal-admin-token' localhost:3000/v1/admin/quota`
Output:
```
401
403
{"serverTime":"2026-10-17T03:28:30.873Z","products":[{"product":"ncaawb","limit30d":1000,"reserve":100,"verifiedAt":"2026-10-17T03:08:43.010Z","overridden":false,"used30d":0,"remaining":1000,"reserved":0,"spendable":900},{"product":"unrivaled",…"used30d":0,"remaining":1000,"reserved":0,"spendable":900},{"product":"wnba",…"used30d":0,"remaining":1000,"reserved":0,"spendable":900}],"reservations":[{"id":1,"product":"ncaawb","gameId":"273aa916-94d5-4488-8362-f73b490363ed","profile":"full","source":"rehearsal","runId":2,"reservedCalls":332,"usedCalls":122,"providerCalls":122,"quotaCountedCalls":0,"createdAt":"2026-10-17T03:08:49.676Z","releasedAt":"2026-10-17T03:10:56.775Z"},{"id":2,"product":"ncaawb","gameId":"22058583-c21c-42b3-a1ff-aecb1292b999","profile":"extended","source":"rehearsal","runId":4,"reservedCalls":153,"usedCalls":122,"providerCalls":122,"quotaCountedCalls":0,"createdAt":"2026-10-17T03:18:53.170Z","releasedAt":"2026-10-17T03:21:00.259Z"}]}
```
`curl -s localhost:3000/health` → `{"ok":true,"mode":"sim","db":"ok",…,"outbox":{"pending":0,"lagMs":null,"dead":0},"worker":{"lockHeld":false,"runningRuns":0,"lastTick":{"providerCallAt":"2026-10-17T03:21:00.234Z",…}}}` (the API process was started from `.env`, `MODE=sim`; reads are mode-independent).
Result: PASS (rehearsal; `used_30d` = 0 throughout, as required)

### 3b. Console comparison
Result: NOT RUN (no trial key, no console value). November: `pnpm trial quota --product ncaawb --limit-30d <console value> --reserve 100 --note "console YYYY-MM-DD"` before the run, then after the run `docker exec -i supabase_db_wehoop-api psql -U postgres -d postgres -At -c "select * from ingest.v_quota"` and compare `used_30d` with the console's used count on the same day; expected equal, or the console higher by the number of 429/non-200 responses if Sportradar counts them.

## 4. Live changes reach subscriber with median lag from `wall_clock`

### 4a. Rehearsal
Subscriber during the full watch (`pnpm subscribe --game 273aa916-94d5-4488-8362-f73b490363ed --record m3v/sub-full.jsonl --until closed`, started 23:08:52 EDT, 3 s after the watch):
Output (`m3v/sub-full.log`, first and last lines):
```
2026-10-17T03:08:52.451Z channel {"status":"SUBSCRIBED"}
2026-10-17T03:08:52.477Z snapshot {"seq":53,"reason":"start","status":"inprogress"}
2026-10-17T03:08:59.701Z catch-up {"trigger":"pulse","from":101,"to":103,"pages":1,"resnapshot":false}
2026-10-17T03:10:54.786Z summary {"applied":606,"firstSeq":54,"lastSeq":659,"contiguous":true,"duplicates":2,"catchUps":1,"derivedStateEqualsFinalSnapshot":true,"receivedEqualsApi":true}
2026-10-17T03:10:54.787Z channel {"status":"CLOSED"}
SUB_EXIT=0 SUB_END=2026-10-16 23:10:55 EDT
```
Command:
`pnpm trial lag --record m3v/sub-full.jsonl --game 273aa916-94d5-4488-8362-f73b490363ed`
Output:
```
changes received via broadcast: 604
wall_clock lag (event changes with wallClock, n=0): median n/a p95 n/a
provider revision lag (receivedAt - play_events.provider_updated_at, n=303): median 20745449485 ms p95 20748693927 ms
pipeline lag (change.ts -> received, n=604): median 57 ms p95 104 ms
```
Subscriber during the extended watch (`pnpm subscribe --game 22058583-c21c-42b3-a1ff-aecb1292b999 --record m3v/sub-ext.jsonl --until closed`, 23:18:55 EDT):
```
2026-10-17T03:18:55.922Z channel {"status":"SUBSCRIBED"}
2026-10-17T03:18:55.942Z snapshot {"seq":2,"reason":"start","status":"inprogress"}
2026-10-17T03:21:00.356Z summary {"applied":73,"firstSeq":3,"lastSeq":75,"contiguous":true,"duplicates":0,"catchUps":0,"derivedStateEqualsFinalSnapshot":true,"receivedEqualsApi":true}
2026-10-17T03:21:00.356Z channel {"status":"CLOSED"}
```
Command:
`pnpm trial lag --record m3v/sub-ext.jsonl --game 22058583-c21c-42b3-a1ff-aecb1292b999`
Output:
```
changes received via broadcast: 73
wall_clock lag (event changes with wallClock, n=0): median n/a p95 n/a
provider revision lag (receivedAt - play_events.provider_updated_at, n=0): median n/a p95 n/a
pipeline lag (change.ts -> received, n=73): median 32 ms p95 2174 ms
```
`wall_clock` does not exist in NCAAWB documents:
Command:
`gzcat fixtures/ncaawb/sim-d9b71fe0-replay.compact.jsonl.gz | grep -o '"wall_clock"' | wc -l; gzcat fixtures/ncaawb/sim-d9b71fe0-replay.extended.jsonl.gz | grep -o '"wall_clock"' | wc -l; grep -o '"wallClock":[^,}]*' m3v/sub-full.jsonl | sort | uniq -c`
Output:
```
0
0
 303 "wallClock":null
```
So the plan's "median lag from `wall_clock`" cannot be measured for NCAAWB (0 of 138 documents, 0 of 11,513 `updated` keys carry it; every event change received had `wallClock: null`). The measurable lags are the pipeline lag (change `ts` → subscriber `receivedAt`) and, live, the provider-revision lag (`receivedAt − play_events.provider_updated_at`); the latter is meaningless in a rehearsal because the recording's `updated` stamps are from 2026-02-18 (median 20,745,449,485 ms ≈ 240 days). **The plan wording needs the owner's amendment** (e.g. "median pipeline lag, and provider-revision lag where the feed carries `updated`").
Distribution check (python over the record files; `catch-up` rows are the two changes the subscriber paged from `/changes` on the pulse):
```
full:     n=606 min 24 median 57 max 2632  top3: (127, 394, period, broadcast), (2631, 102, status, catch-up), (2632, 103, period, catch-up)  via: broadcast 604, catch-up 2  duplicate seqs in record: []
extended: n=73  min 17 median 32 max 2174  top5: seq 71–75 stats_player broadcast 2174 ms each
```
Result: PASS for "changes reach the subscriber" (contiguous, 0 duplicate seqs in the record, `derivedStateEqualsFinalSnapshot: true`, `receivedEqualsApi: true`, pipeline median 57 ms / 32 ms); the `wall_clock` median is **not measurable for NCAAWB** (plan wording needs amendment, not a code defect)

### 4b. Live
Result: NOT RUN (no trial key). November: `pnpm subscribe --game <uuid> --record /tmp/live-full.jsonl --until closed` during the full watch and `--record /tmp/live-ext.jsonl` during the extended watch, then `pnpm trial lag --record /tmp/live-full.jsonl --game <uuid>`; expected `wall_clock … n=0` (NCAAWB), a provider-revision median in seconds (the real `updated` stamps), and a pipeline median under 1 s, with the subscriber summary `contiguous: true, derivedStateEqualsFinalSnapshot: true, receivedEqualsApi: true`.

## 5. Extended game emits only status/period, stats at `stats_final_at`

### 5a. Rehearsal on the relabelled fixture through `pnpm trial watch` (profile defaulted to `extended`)
`pnpm trial plan` on port 8788 listed `22058583-… e5e5e5e5-9277-4b99-af20-b7ff7e86640e … created coverage=extended_boxscore … -> profile extended (153 calls)`; the watch header: `status=created coverage=extended_boxscore: profile extended, budget 153 calls (pbp 0, summary 150, boxscore 1, closing 2)`.
Command (implementer's `evidence.sql`, "change types per rehearsal game"):
Output:
```
2e36b340-9277-4b99-af20-b7ff7e86640e|full|event_insert|306
2e36b340-9277-4b99-af20-b7ff7e86640e|full|event_update|11
2e36b340-9277-4b99-af20-b7ff7e86640e|full|status|50
2e36b340-9277-4b99-af20-b7ff7e86640e|full|period|48
2e36b340-9277-4b99-af20-b7ff7e86640e|full|stats_team|42
2e36b340-9277-4b99-af20-b7ff7e86640e|full|stats_player|211
e5e5e5e5-9277-4b99-af20-b7ff7e86640e|extended_boxscore|status|22
e5e5e5e5-9277-4b99-af20-b7ff7e86640e|extended_boxscore|period|20
e5e5e5e5-9277-4b99-af20-b7ff7e86640e|extended_boxscore|stats_team|2
e5e5e5e5-9277-4b99-af20-b7ff7e86640e|extended_boxscore|stats_player|31
```
Command:
`$PSQL "select coalesce(sum(case when change_type::text like 'event_%' then 1 else 0 end),0) as event_changes, (select count(*) from public.play_events where game_id=g.id) as play_events, count(*) as total_changes from public.game_changes c join public.games g on g.id=c.game_id where g.provider_game_id='e5e5e5e5-9277-4b99-af20-b7ff7e86640e' group by g.id"`
Output:
```
0|0|75
```
Command:
`$PSQL "select g.status, g.last_seq, g.stats_final_at, (select min(seq) … change_type='status' and body->>'status'='closed') as closed_seq, (select min(created_at) … closed) as closed_at, (select min(seq) … change_type::text like 'stats_%') as first_stats_seq, (select max(seq) …) as last_stats_seq, (select count(*) …) as stats_changes, (select min(created_at) … stats_%) as first_stats_at from public.games g where provider_game_id='e5e5e5e5-…'"`
Output:
```
closed|75|2026-10-17 03:20:58.17+00|42|2026-10-17 03:20:58.155299+00|43|75|33|2026-10-17 03:20:58.155299+00
```
`closed` is seq 42; the first of 33 `stats_*` changes is seq 43, written in the same transaction (same `created_at`), and `stats_final_at` = 03:20:58.17.
Command:
`$PSQL "select count(*) from public.game_changes c join public.games g on g.id=c.game_id where g.provider_game_id='e5e5e5e5-…' and c.change_type not in ('status','period') and c.seq < (select min(seq) … closed)"`
Output:
```
0
```
Command:
`$PSQL "select feed, count(*), min(called_at), max(called_at) from ingest.provider_calls where reservation_id=2 group by 1 order by 1"`
Output:
```
boxscore|2|2026-10-17 03:20:54.984+00|2026-10-17 03:21:00.234+00
summary|120|2026-10-17 03:18:53.178+00|2026-10-17 03:20:59.184+00
```
No `pbp` row. Status sequence of the extended game: `inprogress ×9 > halftime > inprogress ×10 > complete > closed` (22 rows, no regression). Final stats rows: `$PSQL "select (select count(*) from public.game_player_stats s where s.game_id=g.id), (select count(*) from public.game_team_stats …), home_points, away_points …"` → `31|2|104|68`.
Command:
`VITEST_INTEGRATION=1 pnpm vitest run test/integration/extended-replay-fixture.test.ts`
Output:
```
 Test Files  1 passed (1)
      Tests  1 passed (1)
```
(test: "status/period only while live, stats exactly once at close, never an event change")
Result: PASS (rehearsal on a synthetic relabel; see `fixtures/ncaawb/README.md`)

### 5b. Live extended game
Result: NOT RUN (no trial key; no `extended_boxscore` recording exists on the simulation host either). November: `pnpm trial watch --league ncaawb --game <extended_boxscore game>` and the three queries above with the live provider game id; expected `event_changes=0`, `play_events=0`, `first_stats_seq = closed_seq + 1`, `stats_final_at` set, no `pbp` feed under the reservation.

## 6. Devlog states real call counts
Result: NOT RUN (needs the live run). For the devlog agent, the **rehearsal** counts, labelled "rehearsal, fake host, not quota-counted": schedule 1 + 1, full watch 122 (pbp 95, summary 26, boxscore 1) against a 332 reservation, extended watch 122 (summary 120, boxscore 2) against 153, total 246 `provider_calls` rows, `used_30d` 0. These are 60x-compressed, limiter-bound numbers and must not be quoted as what a live game costs. November: quote `pnpm trial status` after the live run (item 2b).

## 7. Held-profile impact
Command:
`pnpm trial holds` and `pnpm trial holds --json` (rehearsal DB, after both watches)
Output:
```
open holds: 0; affected players: 0; holds touching a watched game: 0
{"openHolds":0,"affectedPlayers":0,"inWatchedGame":0,"rows":[]}
```
Command:
`docker exec -i supabase_db_wehoop-api psql -U postgres -d postgres -At -f /dev/stdin < test/integration/holds-impact.sql`
Output:
```
(0 rows; `wc -l` → 0)
```
Columns the query returns (from the file): `hold_id, league, reason, document_id, document_name, created_at, candidates (json: id, full_name, merged_into), document_in_watched_games (game ids where game_player_stats.provider_player_id = the document id, watch_run_id not null), candidates_in_watched_games`.
Command:
`$PSQL "select count(*) from ingest.player_merge_holds where status='open'"; $PSQL "select count(*) from ingest.player_merge_holds"; $PSQL "select g.provider_game_id, g.watch_run_id, count(distinct s.player_id) from public.games g left join public.game_player_stats s on s.game_id=g.id where g.watch_run_id is not null group by 1,2 order by 1"`
Output:
```
0
0
2e36b340-9277-4b99-af20-b7ff7e86640e|2|31
e5e5e5e5-9277-4b99-af20-b7ff7e86640e|4|31
```
Both watched games have 31 players with stat lines; no hold exists, so no held document and no candidate row appears in either. Invariant lines: `open_hold_candidates_are_distinct_canonical_rows 0 0 PASS`, `open_holds_preserve_their_document 0 0 PASS`.
Command:
`VITEST_INTEGRATION=1 pnpm vitest run test/integration/holds-impact.test.ts`
Output:
```
 Test Files  1 passed (1)
      Tests  2 passed (2)
```
(tests: "the function and the SQL file agree, and both work when there are no open holds"; "a hold whose document id, or whose candidate row, has a line in a watched game is flagged")
Result: PASS (rehearsal: count 0, query evidence shown)

### 7b. After the live run
Result: NOT RUN. November: `pnpm trial holds` and the `holds-impact.sql` command above after both live watches; expected the open-hold count, and per hold the document id, league, candidate rows and the `*_in_watched_games` arrays (empty arrays when the count is 0).

## 8. Corrective-pass guarantees

### 8a. `--speed 60` refused without a loopback `SPORTRADAR_BASE_URL`; non-loopback host refused by config; no call made
Command:
`$PSQL "select count(*) from ingest.provider_calls"` (before) → `0`; then with `SPORTRADAR_BASE_URL` unset: `pnpm trial watch --league ncaawb --game 2e36b340-9277-4b99-af20-b7ff7e86640e --profile full --speed 60 --note "must refuse"; echo exit=$?`
Output:
```
--speed 60 is only allowed against a rehearsal host (SPORTRADAR_BASE_URL on a loopback host, pnpm sim serve); against api.sportradar.com the cadence must be real
[ELIFECYCLE] Command failed with exit code 64.
exit=64
```
Command:
`SPORTRADAR_BASE_URL=http://evil.example.com pnpm trial plan --league ncaawb --date 2026-02-18; echo exit=$?`
Output:
```
Error: Invalid environment:
  SPORTRADAR_BASE_URL may only point at a loopback host (127.0.0.1, localhost, ::1): the API key is sent to it
    at loadConfig (/Users/emammie/Projects/wehoop-api/src/config.ts:147:34)
exit=1
```
`$PSQL "select count(*) from ingest.provider_calls"` (after) → `0`. Both refusals happen before any HTTP request (reset #1 DB, before the first `trial plan`).
Result: PASS

### 8b. Reservation released after `kill -9` of a watch — manual path (`pnpm trial release`), reset #1 DB
Watch `pnpm trial watch … --profile full --speed 60 --note "rehearsal full 60x"` started 23:05:53 EDT, `WORKER_PID=25216`, reservation #1 (332), run 2.
Command:
`$PSQL "select (select count(*) from ingest.provider_calls where reservation_id=1), (select count(*) from public.game_changes), (select used_calls from ingest.budget_reservations where id=1), (select released_at is null from ingest.budget_reservations where id=1), (select status from ingest.ingestion_runs where id=2)"` before; `kill -9 25216` at **23:06:39.097 EDT**; same query after (23:06:41) and 5 s later
Output:
```
before:  43|411|43|t|running
kill exit=0 ; pid 25216 gone ; watch log: [ELIFECYCLE] Command failed with exit code 137. WATCH_EXIT=137
after:   43|411|43|t|running
5 s later calls_res1: 43
```
Command:
`pnpm trial status`
Output:
```
  #1 ncaawb full      game=c5f0a972-44a4-4f9f-ae29-2847bb0e1600 source=rehearsal run=2 reserved=332 used=43 provider_calls=43 counted=0 open
```
`$PSQL` invariant body `no_open_reservation_for_a_finished_watch_run` → `0` (the run row still says `running`; nothing has marked it yet). `v_quota` for ncaawb stayed `…|0|1000|0|900` with #1 open: a rehearsal reservation holds no budget (migration 0010 `br.source in ('trial','production')`).
Command:
`pnpm trial release --reservation 1; pnpm trial status | grep '#1'; $PSQL "select id, released_at is not null, used_calls, (select count(*) from ingest.provider_calls c where c.reservation_id=b.id) from ingest.budget_reservations b"; $PSQL "<invariant body>"; pnpm trial release --stale`
Output:
```
reservation #1 released (reserved 332, used 43)
  #1 ncaawb full      game=c5f0a972-44a4-4f9f-ae29-2847bb0e1600 source=rehearsal run=2 reserved=332 used=43 provider_calls=43 counted=0 released
1|t|43|43
0
released 0 reservation(s) whose watch run has ended
```
Result: PASS

### 8c. Reservation released after `kill -9` — automatic path (next watch), reset #3 DB
Script `m3v/run-kill9.sh` (output `m3v/run-kill9.out`): fake server 8787 → `trial quota` → `trial plan` (game `f904777c-64e4-4f92-925d-85a13658ce2e`) → watch 1 at **23:31:11 EDT** (`WORKER_PID=29814`, reservation #1, run 2) → after 20 s:
```
before kill 2026-10-16 23:31:31 EDT: 19|166|19|t|running        (calls_res1|game_changes|used|open|run2)
kill -9 29814 at 2026-10-16 23:31:31 EDT ; kill exit=0 ; pid 29814 gone ; WATCH_EXIT=137
after kill  2026-10-16 23:31:34 EDT: 19|166|19|t|running
5 s later calls_res1=19
pnpm trial status:  #1 ncaawb full  game=f904777c-… source=rehearsal run=2 reserved=332 used=19 provider_calls=19 counted=0 open
invariant no_open_reservation_for_a_finished_watch_run: 0
```
Watch 2 (`--note "rehearsal kill-9 next watch"`) at 23:31:40, `WORKER2_PID=29974`; its log (`m3v/watch-kill9-2.log` lines 11–20):
```
[03:31:41.047] WARN: aborted orphaned runs
    runs: [ 2 ]
[03:31:41.048] WARN: released orphaned reservations
    reservations: [ 1 ]
[03:31:41.052] INFO: budget reserved
```
Command:
`$PSQL "select b.id, b.note, b.reserved_calls, b.used_calls, b.released_at is not null, b.run_id, r.status from ingest.budget_reservations b join ingest.ingestion_runs r on r.id=b.run_id order by b.id"; pnpm trial status | grep '#'; $PSQL "<invariant body>"`
Output:
```
1|rehearsal kill-9 target [released by the next lock holder: watch run died]|332|19|t|2|aborted
2|rehearsal kill-9 next watch|332|14|f|3|running
  #1 ncaawb full      game=f904777c-… source=rehearsal run=2 reserved=332 used=19 provider_calls=19 counted=0 released
  #2 ncaawb full      game=f904777c-… source=rehearsal run=3 reserved=332 used=15 provider_calls=15 counted=0 open
0
```
Then `kill -TERM 29974` at 23:31:55 (graceful; log `stoppedBy: "SIGTERM"`, `WATCH_EXIT=0`):
```
1|332|19|t|2|aborted
2|332|15|t|3|aborted
invariant no_open_reservation_for_a_finished_watch_run: 0
v_quota: ncaawb|1000|100|2026-10-17 03:31:11.512492+00|0|1000|0|900
```
`pnpm invariants` on this DB: `no_open_reservation_for_a_finished_watch_run 0 0 PASS`, `reservation_used_calls_match_provider_calls 0 0 PASS` (54/55: the one FAIL is the spacing finding, item 1c).
Result: PASS for the release guarantee (the spacing FAIL this battery surfaced is recorded under 1c)

### 8d. In-loop quota refusal ends the run
Command:
`VITEST_INTEGRATION=1 pnpm vitest run test/integration/trial-flow.test.ts` (rehearsal DB, after the SQL evidence was captured)
Output:
```
 Test Files  1 passed (1)
      Tests  4 passed (4)
```
(tests: "full game: plan makes one schedule call; watch reserves 332, rate-limits, counts and releases (rehearsal: never quota-counted)"; "a trial reservation that would dip below reserve is refused before any call"; "an in-loop quota refusal ends the watch as an error and releases the reservation"; "extended_boxscore game: profile defaults to extended (153), emits status/period only while live, stats once closed, no pbp call"). Passed on the first run; the reviewer's flaky case did not reproduce (one run only, plus the full `pnpm test:int` in 9b).
Command:
`pnpm vitest run test/unit/ingest/cadence-loop.test.ts`
Output:
```
 Test Files  1 passed (1)
      Tests  1 passed (1)
```
(test: "retries transient fetch errors at the next due time but stops on QuotaRefusedError")
Result: PASS

## 9. Gates

### 9a. `pnpm check`
Command:
`pnpm check` (23:29:48–23:29:50 EDT); separately `pnpm exec tsc --noEmit; echo exit=$?`
Output:
```
$ biome ci . && tsc --noEmit && vitest run
Checked 119 files in 57ms. No fixes applied.
 RUN  v5.0.3 /Users/emammie/Projects/wehoop-api
FAULT_FIRED=before_commit:10
 Test Files  24 passed (24)
      Tests  155 passed (155)
   Duration  497ms
exit=0
tsc exit=0 elapsed=1s
```
Result: PASS (155 unit)

### 9b. `pnpm test:int` on a fresh reset (#4)
Command:
`pnpm supabase db reset` (23:32:57–23:33:23, `grep -c "Applying migration"` → `10`; `$PSQL "select product, remaining from ingest.v_quota where product='ncaawb'"` → `ncaawb|1000`), then `pnpm test:int` (23:33:23–23:34:15 EDT)
Output:
```
 Test Files  20 passed (20)
      Tests  132 passed (132)
exit=0
```
Passed on the first run; no re-run needed.
Result: PASS (132)

### 9c. `pnpm invariants`
Command:
`pnpm invariants` on the rehearsal DB (reset #2, after both watches, 23:29:03 EDT; `m3v/invariants-rehearsal.log`)
Output:
```
check                                                      expect  actual  result
play_events_no_duplicate_provider_ids                      0       0       PASS
game_changes_no_gaps_in_retained_history                   0       0       PASS
games_last_seq_matches_max_change                          0       0       PASS
outbox_matches_changes_exactly                             0       0       PASS
outbox_no_dead_letters                                     0       0       PASS
outbox_no_duplicate_game_seq                               0       0       PASS
outbox_channel_is_generated                                1       1       PASS
outbox_has_composite_routing_fk                            1       1       PASS
games_has_no_progress_key                                  0       0       PASS
generation_fks_restrict_delete                             2       2       PASS
outbox_has_single_fk                                       1       1       PASS
anon_cannot_select_ingest_tables                           0       0       PASS
anon_has_no_write_grants_on_public                         0       0       PASS
public_tables_all_have_rls                                 0       0       PASS
retained_head_exists                                       0       0       PASS
anon_has_no_maintain_privilege_on_public                   0       0       PASS
anon_has_no_usage_on_ingest_schema                         0       0       PASS
public_schema_has_no_client_write_policies                 0       0       PASS
realtime_has_no_client_insert_policy                       0       0       PASS
game_changes_has_append_only_trigger                       1       1       PASS
views_use_security_invoker                                 0       0       PASS
event_changes_reference_their_play_row                     0       0       PASS
outbox_published_rows_have_no_error                        0       0       PASS
deleted_revision_only_on_deleted_events                    0       0       PASS
stats_observed_at_set                                      0       0       PASS
client_views_use_security_invoker                          4       4       PASS
views_do_not_expose_watch_run_id                           0       0       PASS
anon_can_select_every_client_view                          4       4       PASS
external_ids_point_at_canonical_players                    0       0       PASS
merged_players_point_at_canonical_survivors                0       0       PASS
tombstoned_players_own_nothing                             0       0       PASS
player_stats_observed_at_set                               0       0       PASS
elam_games_have_a_target                                   0       0       PASS
oot_games_belong_to_a_tournament                           0       0       PASS
stats_bodies_carry_no_canonical_uuid                       0       0       PASS
player_stats_provider_id_resolves_to_row_player            0       0       PASS
game_player_stats_pk_is_provider_keyed                     1       1       PASS
game_player_stats_one_row_per_provider_id_per_game         0       0       PASS
game_player_stats_never_point_at_tombstones                0       0       PASS
tombstones_have_merge_provenance                           0       0       PASS
merge_losers_are_tombstones                                0       0       PASS
merge_survivors_are_or_resolve_to_the_current_survivor     0       0       PASS
open_hold_candidates_are_distinct_canonical_rows           0       0       PASS
open_holds_preserve_their_document                         0       0       PASS
merge_tables_closed_to_clients                             0       0       PASS
sim_fixture_and_rehearsal_calls_never_count_quota          0       0       PASS
trial_and_production_calls_always_count_quota              0       0       PASS
quota_counted_calls_carry_a_product                        0       0       PASS
trial_watch_runs_have_a_reservation                        0       0       PASS
counted_calls_spaced_at_least_one_second_per_product       0       0       PASS
rate_limited_calls_spaced_at_least_one_second_per_product  0       0       PASS
no_open_reservation_for_a_finished_watch_run               0       0       PASS
reservation_used_calls_match_provider_calls                0       0       PASS
counted_reservations_are_trial_or_production               0       0       PASS
quota_tables_closed_to_clients                             0       0       PASS

55/55 invariants hold
```
Also: post-`test:int` DB (23:34:34) → `55/55 invariants hold`; kill-9 DB (reset #3) → `54/55 invariants hold` (item 1c).
Result: PASS on the rehearsal and post-test DBs; FAIL on the kill-9 DB (recorded as item 1c)

### 9d. Standard M1/M2 regression checks (rehearsal DB)
Command:
`$PSQL "select count(*) from public.game_changes c full outer join ingest.broadcast_outbox o on o.change_id = c.id where c.id is null or o.change_id is null or o.game_id <> c.game_id or o.seq <> c.seq or o.channel <> 'game:' || c.game_id"; $PSQL "select (select count(*) from ingest.broadcast_outbox where dead_at is not null), (select count(*) from (select channel, seq from ingest.broadcast_outbox group by 1,2 having count(*)>1) d)"; $PSQL "select count(*) from ingest.stale_observations"`
Output:
```
0
0|0
0
```
(post-`test:int` DB: unmatched `0`, `stale_observations` `321` — produced by the freshness tests, as in M1/M2; the two `quota_counted` rows there belong to the quota-guard test's synthetic product `m3-guard-a3d6789b`, and `v_quota.used_30d` is `0` for all three real products.)
Command:
`for t in v_quota provider_calls budget_reservations product_quotas player_merge_holds stale_observations; do $PSQL "set role anon; select count(*) from ingest.$t"; done; $PSQL "set role authenticated; select count(*) from ingest.v_quota"; $PSQL "select has_schema_privilege('anon','ingest','USAGE'), has_schema_privilege('authenticated','ingest','USAGE')"`
Output:
```
v_quota: ERROR:  permission denied for schema ingest
provider_calls: ERROR:  permission denied for schema ingest
budget_reservations: ERROR:  permission denied for schema ingest
product_quotas: ERROR:  permission denied for schema ingest
player_merge_holds: ERROR:  permission denied for schema ingest
stale_observations: ERROR:  permission denied for schema ingest
authenticated v_quota: ERROR:  permission denied for schema ingest
f|f
```
Command:
`$PSQL "select c.relname, coalesce((select option_value from pg_options_to_table(c.reloptions) where option_name='security_invoker'),'unset') from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='v' and n.nspname='public' order by 1"; $PSQL "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='v' and n.nspname in ('public','ingest') and coalesce((select option_value from pg_options_to_table(c.reloptions) where option_name='security_invoker'),'false') <> 'true'"; $PSQL "select count(*) from information_schema.role_table_grants where table_schema='ingest' and table_name in ('product_quotas','provider_calls','budget_reservations','v_quota') and grantee in ('anon','authenticated')"`
Output:
```
v_boxscore|true
v_player_seasons|true
v_schedule|true
v_standings|true
0
0
```
Result: PASS

## 10. Key hygiene
Command:
`grep -c "rehearsal-not-a-key" m3v/*.log m3v/*.out | grep -v ":0$"; grep -il "x-api-key" m3v/*.log m3v/*.out; grep -c "rehearsal-admin-token" m3v/*.log m3v/*.out | grep -v ":0$"; grep -l "eyJ[A-Za-z0-9_-]\{20,\}" m3v/*.log m3v/*.out; grep -l "api.sportradar.com" m3v/*.log`
Output:
```
(no log contains the literal)
(no log mentions x-api-key)
(none)
(none)
m3v/refuse-speed.log      <- line 2 is the refusal message text "… against api.sportradar.com the cadence must be real"
```
Neither the fake server, the worker, the trial CLI nor the API ever logged the made-up key or the admin token, and no JWT-like string appears in any log. In this file the literal `rehearsal-not-a-key` appears only where it was typed: the verdict paragraph (line 3), the environment header (line 14), the item 2a command line (line 151) and this item (lines 626, 635); `grep -n "rehearsal-not-a-key" devlog/evidence/M3.md` after writing listed exactly those five lines, and `grep -c "eyJ[A-Za-z0-9_-]\{20,\}" devlog/evidence/M3.md` → `0`.
Result: PASS

---

## November commands (verbatim; to run with the owner's `SPORTRADAR_NCAAWB_KEY` in `.env`, `SPORTRADAR_BASE_URL` unset, `MODE=trial`, no `--speed`)
```
pnpm trial quota --product ncaawb --limit-30d <console value> --reserve 100 --note "console YYYY-MM-DD"
pnpm trial plan --league ncaawb --date 2026-11-08
pnpm trial watch --league ncaawb --game <full-coverage game> --profile full   # + pnpm subscribe --game <uuid> --record /tmp/live-full.jsonl --until closed
pnpm trial watch --league ncaawb --game <extended_boxscore game>             # + pnpm subscribe --game <uuid> --record /tmp/live-ext.jsonl --until closed
pnpm trial lag --record /tmp/live-full.jsonl --game <uuid> ; pnpm trial status ; pnpm trial holds ; pnpm invariants
docker exec -i supabase_db_wehoop-api psql -U postgres -d postgres -At -c "select * from ingest.v_quota"   # vs console
```
Given item 1c, leave more than 1 s between `pnpm trial plan` and `pnpm trial watch` (or fix the limiter seed first), and between consecutive `pnpm trial watch` starts.

## Findings

1. **Cross-process spacing (FAIL, item 1c).** The per-product limiter lives in one process (`rateLimiterFor`, `src/providers/sportradar/rate-limiter.ts`). `pnpm trial plan` (CLI) then `pnpm trial watch` (spawns the worker) within 1 s gave a 595 ms gap, a 429 from the fake host, a `status=429` `provider_calls` row, and `rate_limited_calls_spaced_at_least_one_second_per_product 0 1 FAIL`. The worker recovered at its next slot. Two watches started back-to-back would do the same. A seed of the first slot from `max(called_at)` per product in `ingest.provider_calls` (or a DB-side slot) would close it. Not reproduced in the authoritative rehearsal because the plan preceded the watch by ≥ 6 s.
2. **Fake-server timeline starts at process start.** `pnpm sim serve --speed 60` serves document *i* once `elapsed × 60 ≥ offset_i`; the first pass (reset #1) started its watch 45 s after the server and its subscriber's first snapshot was already `seq 178, halftime`. The authoritative runs restarted the server 2.5 s before each watch (first snapshot `seq 53 inprogress` for full, `seq 2 inprogress` for extended: the recording's pregame span is short). The implementer's handoff sequence assumes the same.
3. **Status-change counts.** The full game has 50 `status` changes and the extended game 22; the `status` change body carries `status`, `score` and `period`, so every score or period movement observed through a summary/boxscore is a `status` change. Sequences: full `inprogress ×24 > halftime > inprogress ×24 > complete > closed`; extended `inprogress ×9 > halftime > inprogress ×10 > complete > closed`. **No status regression** (the pre-existing M1/M2 "lagging summary regresses status within a generation" case did not occur in these runs) and `stale_observations` = 0 on the rehearsal DB.
4. **Call totals at 60x are limiter-bound**, not cadence-bound (item 2a): both watches made 122 calls in ~127 s. The live counts will be the cadence's (≈ 300 pbp + 30 summary + closing for `full`), which is what the reservation predicts; the rehearsal cannot confirm that arithmetic.
5. **Subscriber `duplicates: 2`, `catchUps: 1`** on the full game: the pulse at 03:08:59 triggered one catch-up for seq 101–103 while broadcast delivered the same seqs; the two overlapping broadcasts were dropped as duplicates, the record file has no duplicate seq, and the stream was contiguous. The extended game had no catch-up.
6. **Pipeline-lag tails.** Full p95 104 ms; the two catch-up rows are 2.63 s (page latency, not broadcast). Extended p95 2,174 ms: the last five `stats_player` changes (seq 71–75) of the 33-change closing batch arrived 2.17 s after their `ts`, i.e. the outbox publisher paced the closing burst; no Realtime 429 or back-off line appears in either subscriber log (`grep -i "429|back.off|retry|reconnect|CHANNEL_ERROR|TIMED_OUT"` → nothing).
7. **Provider-revision lag is meaningless in a rehearsal** (median 240 days: recording `updated` stamps from 2026-02-18), and NCAAWB carries no `wall_clock` at all (item 4a); the plan's "median lag from `wall_clock`" wording needs the owner's amendment.
8. **`v_quota.reserved` ignores rehearsal reservations** (migration 0010 restricts to `trial`/`production`), so `reserved` read 0 while a rehearsal reservation was open (items 8b, 8c). Correct by design; the `reserved` arithmetic was therefore not exercised by a rehearsal and will first be seen live.
9. **Residue.** All four fake-server processes, the API (pids 24869/24875/24900/24916) and every worker/subscriber were stopped; `pgrep -fl "sim.ts serve|worker.ts|subscribe.ts|api.ts|tsx watch"` → nothing, ports 3000/8787/8788 free. The local DB is left in the post-`test:int` state (reset #4 + suite). `git status --porcelain` was empty before this file was written; the only new file is this one.

## Summary

| Item | Result |
|---|---|
| db reset applies 0001–0010; fixture hashes match README | PASS |
| 1a `provider_calls` min spacing ≥ 1 s (rehearsal: 1.05 s over 246 calls, 0 × 429) | PASS (rehearsal) |
| 1b spacing on the live run | NOT RUN (no key) |
| 1c spacing across processes (`plan` → `watch` within 1 s: 595 ms gap, 429, invariant 54/55) | **FAIL** |
| 2a per-game call totals vs reservation (122/332 full, 122/153 extended, released, runs ok) | PASS (rehearsal) |
| 2b live totals | NOT RUN (no key) |
| 3a `v_quota` before/after (`used_30d` 0 throughout, reserved 0, spendable 900; admin 401/403/200) | PASS (rehearsal) |
| 3b `v_quota` vs console | NOT RUN (no key / console) |
| 4a changes reach subscriber (contiguous, equal to API and snapshot; pipeline median 57 ms / 32 ms); `wall_clock` absent in NCAAWB | PASS (rehearsal; plan wording needs amendment) |
| 4b live lag | NOT RUN (no key) |
| 5a extended game: 0 event changes, 0 play_events, closed seq 42 → first stats seq 43, `stats_final_at` set, no pbp calls; fixture test 1/1 | PASS (rehearsal, synthetic relabel) |
| 5b live extended game | NOT RUN (no key) |
| 6 devlog states real call counts | NOT RUN (needs live run; rehearsal counts recorded and labelled) |
| 7 held-profile impact (0 open holds; `holds-impact.sql` 0 rows; both watched games have 31 players with stats; test 2/2) | PASS (rehearsal) |
| 7b held-profile impact after the live run | NOT RUN (no key) |
| 8a `--speed` and non-loopback host refused, 0 calls | PASS |
| 8b reservation released after `kill -9` (manual `trial release`) | PASS |
| 8c reservation released after `kill -9` (automatic, next watch) | PASS |
| 8d in-loop quota refusal ends the run (trial-flow 4/4, cadence-loop 1/1) | PASS |
| 9a `pnpm check` (155 unit) | PASS |
| 9b `pnpm test:int` fresh reset (132, first run) | PASS |
| 9c `pnpm invariants` (55/55 rehearsal DB and post-test DB) | PASS |
| 9d outbox parity 0, stale 0, anon denied on `ingest` incl. `v_quota`, all views `security_invoker` | PASS |
| 10 key hygiene | PASS |

## Verdict

**NOT DONE.**

FAIL:
- 1c — `provider_calls` min spacing ≥ 1 s is not guaranteed across processes: `pnpm trial plan` followed within 1 s by `pnpm trial watch` produced a 595 ms gap and a 429 (`rate_limited_calls_spaced_at_least_one_second_per_product 0 1 FAIL` on that DB). Needs a code fix (seed the worker's first slot from the product's last `called_at`) or an explicit operator rule before the November run.

NOT RUN (each needs the owner's trial key and live NCAAWB games; commands in the "November commands" block above):
- 1b live spacing — `pnpm trial watch …` then the spacing query and `pnpm invariants`
- 2b live per-game totals — `pnpm trial status` after both live watches
- 3b `v_quota` vs console — `pnpm trial quota --product ncaawb --limit-30d <console value> --reserve 100 --note "console YYYY-MM-DD"` before, `select * from ingest.v_quota` after
- 4b live subscriber lag — `pnpm subscribe … --record /tmp/live-full.jsonl --until closed`; `pnpm trial lag --record /tmp/live-full.jsonl --game <uuid>`
- 5b live extended game — `pnpm trial watch --league ncaawb --game <extended_boxscore game>` and the change-type / stats-seq queries
- 6 devlog real call counts — from `pnpm trial status` after the live run
- 7b held-profile impact after the live run — `pnpm trial holds`; `holds-impact.sql`

PASS: environment/reset/fixtures, 1a, 2a, 3a, 4a (with the `wall_clock` wording caveat), 5a, 7, 8a, 8b, 8c, 8d, 9a, 9b, 9c, 9d, 10.

Evidence file: `/Users/emammie/Projects/wehoop-api/devlog/evidence/M3.md`.
