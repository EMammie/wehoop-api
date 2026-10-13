# A WNBA game replayed, killed, and recovered

**Milestone:** M1 · **Date:** 2026-10-13 · **Commit:** fe529cf

## Post draft (long form, ~200–300 words)

We replayed a whole WNBA game into the database, killed the worker three different ways, and the final score came out 85–93 every time.

wehoop-api is the backend for Wehoop, a women's basketball stats app (WNBA, NCAA women's, Unrivaled); Sportradar is the data provider. M1 is the first real ingestion: play-by-play, summary and boxscore documents are parsed, normalized into play events, checked for freshness, and written as an append-only stream of numbered changes that clients receive over Supabase Realtime, with `/changes` for catch-up.

To be clear: this is a replay of a recorded 2026 game (Las Vegas Aces at New York Liberty) from Sportradar's simulation service, not live data. The full-game runs used a file-based replay of a session recorded at natural pace, replayed with the delays removed. Nothing live yet.

The numbers: `batches: 1316`, `changes: 1194`, final `85|93` (LVA–NYL), equal to the boxscore. Two clean replays produced byte-identical dumps (`294858` bytes, same SHA-256).

Then we broke it. `kill -9` mid-replay at seq 511. A fault just before commit at 597, so the batch heading for 600 rolled back whole. A fault after the HTTP publish at 600 with a subscriber attached: it saw `"duplicates":9` and applied each seq once. All three restarts ended at 1194 changes, `gaps → 0`, dump identical. The restart just logs:

```
[15:58:35.803] WARN: aborted orphaned runs   runs: [ 1 ]
```

Re-running the same recording from the start as a new run rejected `974` batches as `run_regresses_state` and wrote `changes: 0`.

What surprised us. The local Realtime REST endpoint answered `HTTP 429` to 50-message batches; rows stayed unpublished (`445` in one run, `100` in another), none dead-lettered, and the next start drained them while subscribers caught up from the pulse. The worker still exited 0 with a skipped channel; it should not. And anon and guest publish attempts are rejected on the socket, but the REST endpoint returns `HTTP 202` and silently drops them: `forged payload lines: 0` on both subscribers.

Next: M2, three leagues and player identity.

## Short version (≤ 280 chars)

wehoop-api M1: recorded 2026 WNBA game (Sportradar simulation, not live) replayed into 1194 changes, final 85–93. kill -9 mid-replay, fault before commit, fault after publish: all recovered to 1194, 0 gaps, same dump. Re-run from start: 974 stale, 0 changes. 23/23 invariants.

## Three alternative hooks

1. We killed the worker with `kill -9` in the second quarter. It came back, finished the game, and the dump was byte-for-byte the same as the run we never touched.
2. Replay the same game a second time and nothing should change. 974 batches were turned away as stale, zero rows written, score still 85–93.
3. The Realtime REST endpoint told an anonymous client "202 Accepted" for a forged play. Nobody ever received it. Here is why we tested the drop and not the status code.

## Capture checklist

- [ ] Terminal recording: three panes. Pane one: `pnpm dev:worker --mode sim --league wnba --replay-file <replay-full.jsonl> --pace 5 --until closed` (shows `WORKER_PID=` and `GAME_ID=`). Pane two: `pnpm subscribe --game <GAME_ID> --auth anon` streaming seq. Pane three: `kill -9 <WORKER_PID>` once `last_seq` passes 500, then restart the worker with `--pace 0 --until closed`. Visible: `Command failed with exit code 137`, then `WARN: aborted orphaned runs   runs: [ 1 ]`, then `finalStatus: "closed"`, and the subscriber's `summary {"applied":1194,...,"contiguous":true,...}` line.
- [ ] Terminal recording: `pnpm dev:worker ... --pace 0 --until closed` run a second time against the same database. Visible: `WARN: stale batch`, then `batches: 988  changes: 0  stale: 974`.
- [ ] Terminal recording: `pnpm dump-game --game <A> > a.json; pnpm dump-game --game <B> > b.json; shasum -a 256 a.json b.json; diff a.json b.json` after two clean replays. Visible: identical hashes, empty diff.
- [ ] Terminal recording: `pnpm invariants` ending in `23/23 invariants hold`, exit 0.
- [ ] Screenshot: `pnpm test test/unit/ingest/freshness.test.ts --reporter=verbose` showing the 13 `case N:` lines and `Tests  20 passed (20)`.
- [ ] Screenshot: Supabase Studio (`http://127.0.0.1:54323`) on `games` showing `status closed`, `away_points 85`, `home_points 93`, `last_seq 1194`.
- [ ] Code snippet to show: `src/bin/worker.ts:129-137` (orphaned runs marked aborted by the next lock holder), or `src/ingest/apply-changes.ts:543-544` (crash point (b) fires after every write and before commit).

## Evidence used

- Replay of a recorded 2026 WNBA game, Las Vegas Aces at New York Liberty, Sportradar simulation recording `93ee7c68…`, no API key — `devlog/evidence/M1.md` §Environment, "Recording exists on the simulation service" (`pnpm sim list --league wnba`, scheduled `2026-06-30`).
- File-based replay of a session recorded at natural pace, replayed with `--pace 0` — §Environment › Replay source (1,342 documents; worker stops at document 1,316).
- `batches: 1316`, `changes: 1194`, final `85|93`, status `closed` — §Baseline: Replay A (worker log and `games` row).
- Final score matches the boxscore, LVA 85 – NYL 93 in all six full replays — §"Final score matches recording boxscore".
- Two clean replays: `294858` bytes each, same SHA-256, `diff exit=0` — §"Equivalence".
- Crash (a): counts just before kill `508`, `511` at the kill, restart `WARN: aborted orphaned runs   runs: [ 1 ]`, after restart `1194|1194|1|1194`, `gaps → 0`, `dup_events → 0`, `diff a.json crashA.json: diff exit=0` — §"Crash points" (a).
- Crash (b): `FAULT_FIRED=before_commit:600`, state after fault `last_seq 597`, `597|597|182|597|597`, restart to 1194, `gaps → 0`, dump identical — §"Crash points" (b).
- Crash (c): `FAULT_FIRED=after_publish:600`, outbox `600|597|3|598|600|597`, subscriber `"duplicates":9`, `"applied":1194`, `"contiguous":true`, `gaps → 0`, dump identical — §"Crash points" (c).
- No-regression re-run: `batches: 988  changes: 0  stale: 974`, `run_regresses_state|974`, `1194|412|1194|85|93|2|closed` after — §"No regression".
- Realtime REST `HTTP 429 {"message":"Too many messages to broadcast, please reduce the batch size"}` for a 50-message batch; Replay B 445 unpublished, Run C 100 unpublished; `dead_at` 0; next start drained; worker exited 0 with `skippedChannels: 1` — §Observations item 1; catch-up `{"trigger":"pulse","from":1094,"to":1194,...}` — §"Contiguity" and §"Missing final change".
- Anon and guest socket publish returns `'error'`; REST `anon apikey+bearer: HTTP 202`; `forged payload lines: 0` on both recorded streams — §"Auth".
- `23/23 invariants hold` — §`pnpm invariants` (final run; also after every replay, correction and crash restart).
- Freshness: 13/13 §4 cases, `Tests  20 passed (20)` — §"Freshness cases".
- Sportradar as data provider, simulation recordings, no trial key — §Environment; `docs/PLAN.md` §7 M1 row (devlog hook: terminal recording "a WNBA game replayed, killed, and recovered").
- Next milestone M2 "Three leagues + identity" — `docs/PLAN.md` §7 M2 row.
