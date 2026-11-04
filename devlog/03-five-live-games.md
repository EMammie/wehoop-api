# What five live games cost on a 1,000-call trial

**Milestone:** M3 · **Date:** 2026-11-03 · **Commit:** fd9dcba (five live runs from tags `m3-run-2026-10-19` through `m3-run-2026-11-02`; owner merge and tag still to come)

## Post draft (long form, ~200–300 words)

The plan said two live games would fit a 1,000-call trial. We watched five, and the first one taught us that Sportradar counts the calls it refuses.

wehoop-api is the backend for Wehoop, a women's basketball stats app; Sportradar is the data provider, on a trial key. M3 is the first live milestone: one rate limiter shared by every process, a quota guard that reserves a game's calls before the first one goes out, and a watcher that polls by coverage. The games: WNBA Finals Games 2, 3 and 5 (we missed Game 4), then two NCAA women's games, Villanova at Notre Dame (`full`, play-by-play) and Belmont at Princeton (`extended`, score and stats only). The ledger now reads 840 WNBA calls used and 473 NCAAWB.

What broke. Game 2 drew `8 × 429`, every one a summary call 1.2 s after a play-by-play call, and the console's 32 % matched the 318-call ledger to within its rounding, so 429s count against the quota. Two-second slots cut it to one 429 on Game 3; offsetting the summary by half the play-by-play interval removed the back-to-back pairs. `0 × 429` on the last three games.

Same night: 420 of 1,305 changes reached the subscriber by catch-up instead of Broadcast. In postgres.js, `tx.notify()` runs on the pool, not the transaction, so the wake-up fired before COMMIT and rows waited for the 30 s safety timer. The fix:

```ts
await tx`select pg_notify('outbox', ${gameId})`;
```

Zero catch-ups in every run since. Game 3 ended `closed`, then flipped back to `complete` from a cached boxscore; `complete` after `closed` is now a lagging view, though the rule hasn't fired live yet.

The wait is the cost: `closed` trailed `complete` by 13, 25, 71 and 35 minutes, and Notre Dame burned 59 calls before tip-off. Polling one feed every 5 min before play and after `complete` took Princeton's pre-game to 6 calls: 127 of 180 reserved, pipeline lag median 42 ms, p95 174 ms.

Sportradar's console agrees with our ledger on both products: 840 WNBA calls with 9 errors (the 429s), and 472 NCAAWB calls against our 473, the difference being one request that timed out before it connected. Not done: a stats-finality follow-up (Notre Dame's final validation changed both team lines; a cached `complete` document could restore the provisional values). Next: the owner's merge, then M4.

## Short version (≤ 280 chars)

wehoop-api M3: five live games on a 1,000-call Sportradar trial. Game one: 8 × 429 (they count against quota) and a NOTIFY that fired before COMMIT. Then a closed→complete flicker. Now 0 × 429 on three straight games; pre-game polling 59 calls → 6. Console matches ledger.

## Three alternative hooks

1. Our ledger said every call was at least 1.2 s apart. Sportradar still sent back 8 × HTTP 429, all on a summary call right after a play-by-play call, and the console showed it charged us for every one. Here's how we got to 0 × 429 on the next three live games.
2. 420 of 1,305 live changes reached the client by catch-up, not Broadcast. The cause was one line: in postgres.js, `tx.notify()` doesn't run inside the transaction, so the wake-up beat the COMMIT. Zero catch-ups in four runs since.
3. A basketball game ends twice. `complete` is the final buzzer; `closed` is when the stats are validated, and on our five live games it came 13, 25, 71 and 35 minutes later (we have no number for the first). On a 1,000-call trial, that wait is where the budget goes.

## Capture checklist

Everything below is read-only: no Sportradar call, no new watch, only SELECTs against the persistent trial stack. `$PSQLT` = `docker exec supabase_db_wehoop-api-trial psql -U postgres -At -c "<sql>"`. Don't put `.env.trial` on screen, and crop the terminal prompt.

- [ ] Terminal recording: `pnpm -s trial:live status`. Visible: the product table with `ncaawb 1000 473 527 0 100 427` and `wnba 1000 840 160 0 100 60` (column spacing as printed), then the five reservations, ending `#4 ncaawb full … reserved=347 used=338 provider_calls=338 counted=338 released` and `#5 ncaawb extended … reserved=180 used=127 provider_calls=127 counted=127 released`.
- [ ] Terminal recording (the 429s): `$PSQLT "select id, feed, status, to_char(called_at,'HH24:MI:SS.MS'), prev_feed, prev_status, to_char(gap,'SS.MS'), duration_ms from (select id, feed, status, called_at, duration_ms, lag(feed) over w prev_feed, lag(status) over w prev_status, called_at - lag(called_at) over w gap from ingest.provider_calls where product='wnba' window w as (order by called_at, id)) x where status=429 order by id"`. Visible: 9 rows, the 8 from Game 2 each `summary|429|…|pbp|200|01.200|…`, the ninth (id 322) from Game 3 at a 2 s gap; none after 2026-10-21.
- [ ] Terminal recording (pre-game cost, Princeton): `$PSQLT "select phase, feed, count(*), count(*) filter (where status=429), count(*) filter (where status is null), min(called_at), max(called_at) from (select feed, status, called_at, case when called_at < '2026-11-03 00:33:46.93Z' then '1-pregame' when called_at < '2026-11-03 02:25:46.78Z' then '2-inprogress..complete' else '3-complete..closed' end phase from ingest.provider_calls where reservation_id=5) x group by 1,2 order by 1,2"`. Visible: `1-pregame|summary|6|…`, `2-inprogress..complete|summary|112|…`, `3-complete..closed|summary|7|…` plus the boxscore rows.
- [ ] Terminal recording (the flicker, Game 3): `$PSQLT "select string_agg(s, ' > ' order by seq) from (select seq, body->>'status' s, lag(body->>'status') over (order by seq) p from public.game_changes where game_id='d3729168-3b88-4218-a0a8-5004a3c7e217' and change_type='status') x where p is distinct from s"`. Visible: `inprogress > halftime > inprogress > complete > closed > complete`.
- [ ] Terminal recording (lag, Princeton): `pnpm -s trial:live lag --league ncaawb --record <the run-5 subscriber recording, .jsonl> --game 2b129814-cbd6-4a07-87e7-92261d86dd8a`. Visible: `changes received via broadcast: 79`, `pipeline lag … n=79): median 42 ms p95 174 ms`, `catch-up deliveries … n=0`, and the `wall_clock … not carried by this feed` line. Use the recording file the run-5 script left; don't start a new subscriber or watch.
- [ ] Terminal recording: `node --env-file=.env --env-file=.env.trial --import tsx src/bin/invariants.ts` ending `57/57 invariants hold` (the three spacing rows `counted_calls_spaced_at_least_one_second_per_product`, `rate_limited_calls_spaced_at_least_one_second_per_product`, `rate_limited_calls_claimed_a_shared_slot` all `PASS`).
- [ ] Screenshot (owner): Sportradar console usage page for the WNBA and NCAAWB APIs (read 2026-11-03: WNBA 840 calls / 9 errors, NCAAWB 472 calls / 1 error). Crop or blur the account name, email, organization and the masked key before publishing; publish nothing from the console with account details visible.
- [ ] Code snippet to show: `src/ingest/apply-changes.ts:865-869` (the comment and `pg_notify` through `tx`). Alternatives: `src/ingest/freshness.ts:42` (`FINALITY`: `complete` 0, `closed` 1); `src/ingest/cadence.ts:97` and `:120` (`summaryOffsetMs` 15 s / 30 s); `src/ingest/game-watcher.ts:405-418` (summary offset, pre-game and after-complete feeds).

## Evidence used

- Hook "What two live games cost on a 1,000-call trial" — `docs/PLAN.md` §7 M3 row. Game 4 missed — `docs/PLAN.md` rev 4.10 (commit `37a11d1` "G4 missed so G5 takes the full row"); not in the evidence file. Trial quota 1,000 per product per rolling 30 days — M3.md top-up item 15.
- WNBA 840 used, NCAAWB 473 used (527 remaining, 427 spendable), `wnba|1000|100|…|840|160|0|60` — "X1-3b".
- `8 × 429`, 30 summary calls each 1.200 s after `pbp`, 318 WNBA calls — "L2 › 1b" (G2). Console 32 % = 315–324, "Sportradar counts HTTP 429 responses against the quota" — "L2 › 3b" console addendum (2026-10-20).
- 2 s slots + one retry (`d34931a`, `b06f270`) — G2 "Post-run corrections". One 429 on G3 ("1 of 33 pbp→summary pairs at 2.000 s") — "G3 live-run findings" 2. Offset removed every close pair, `summaryOffsetMs: 30000`, `0 × 429` in 168 calls — "G5-1b". `0 × 429` in 340 calls (N1) and in 129 calls (X1) — N1 and X1 live-run summaries.
- 420 of 1,305 changes by catch-up, outbox rows at 28.6–29.8 s on the 30 s safety timer, `tx.notify` in postgres.js 3.4.9 bound to the pool, fix `f256d11` (`src/ingest/apply-changes.ts:869`) — "L2 › 4b" and "Catch-up diagnosis". 0 catch-ups on G3, G5, N1, X1 — the four live-run summaries (row 4c) and "G3 live-run findings" 6.
- Game 3 `closed > complete`, seq 1943 written 3.9 s after seq 1942 from the cached closing boxscore — "G3-9" and "G3 live-run findings" 1. Finality rule (rev 4.9 (1), `c25407f`) not exercised live; unit tests are its proof — "G5-9", "N1-9", "X1 live-run summary" row 9.
- `complete` → `closed` 13 / 25 / 71 / 35 min (G3, G5, N1, X1) — "X1-2b" ("N1 71 min, G5 25, G3 13") and "N1-2b". No G2 figure in the evidence (hook 3 says so).
- Notre Dame pre-game 59 calls (53 pbp + 6 summary) — "N1-2b" and finding N1-F4. Princeton pre-game 6 calls ("N1: 59"), rev 4.12 — "X1-2b" and "X1 live-run findings" 5.
- Princeton 127 of 180 reserved — "X1-2b". Notre Dame 338 of 347 — "N1-2b" (checklist only).
- Pipeline lag median 42 ms, p95 174 ms, n = 79, 0 catch-ups — "X1-4c".
- N1-F3: the `closed` summary changed both team lines (fast-break points 0 → 10 and 0 → 7, paint points 54 → 50) and 11 of 26 players' minutes; a cached `complete` document could restore provisional values — "N1-9", "N1 live-run findings" 4, "M3 after this run" (X1).
- Console readings: WNBA 840 calls / 9 errors = ledger — "G5-3b addendum 2"; NCAAWB 472 calls / 1 error = ledger 473 minus call 1201 (connect timeout, never reached Sportradar) — "X1-3b addendum"; G3's 671 / 9 confirmed — "G5-3b addendum". Owner merge and tag remain — "M3 after this run" (X1).
- Checklist expectations: 9 × 429 rows, ids 4 … 268 plus 322 — "G5-1b"; flicker chain and game id — "G3-9" and the G3 header; phase rows 6 / 112 / 7 — "X1-2b"; `57/57 invariants hold` — "X1 live-run summary"; console 840 / 9 errors — "G5-3b addendum 2", NCAAWB 472 / 1 error — "X1-3b addendum"; reservation rows #4 and #5 — "X1-2b".
- Not quoted in the post: Princeton `extended` row 5b (seqs 1..56 only `status`/`period`, 22 stats changes at `closed`) — "X1-5b / 6"; X1-F1 (a connect timeout counted as a call) and X1-F3 (the +120-min boxscore produced nothing) are owner options — "X1 live-run findings" 2 and 4; WNBA lag figures for G2 / G3 / G5 (46 / 105, 67 / 553, 56 / 125 ms) — "X1-4c".
- Buffer: skipped (`DEVLOG_BUFFER=0`).
