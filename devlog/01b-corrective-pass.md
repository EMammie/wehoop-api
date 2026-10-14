# The bug the first evidence could not see

**Milestone:** M1 corrective pass · **Date:** 2026-10-14 · **Commit:** 17913b8 (evidence captured there; `e53ce5e` adds only `devlog/evidence/M1.md`)

## Post draft (long form, ~200–300 words)

M1 was green and the PR was open when an outside reviewer and the user both said "don't merge yet." One more loop on PR #3. Good call.

wehoop-api is the backend for Wehoop, a women's basketball stats app (WNBA, NCAA women's, Unrivaled); Sportradar is the data provider. Still a simulation recording of a 2026 game (Las Vegas Aces at New York Liberty), not live data.

The loop ratified three contract decisions: opening a new watch generation moved inside the transaction as freshness rule 2(d), which positions a lower score by the clock (more time remaining than stored is stale; equal or less is a correction); every id in an event body is a provider id; lineup changes carry the on-court set. It closed five holes: unknown status no longer defaults to `scheduled`, deletion markers carry a revision, a newer revision with an unchanged body writes no change row, omitted metadata no longer overwrites stored values, one blocked outbox head no longer starves the others. Freshness cases: 13 to 23.

Then the awkward part. The first M1 evidence pointed at a 470,299,576-byte replay file in a deleted scratchpad. Nobody could rerun it. A DB-free recorder and a deterministic compactor turned a natural-pace recording of `3,350 raw documents` into a committed fixture: `158 docs, 2.4 MB`.

The fresh run on that fixture failed. Replaying the finished game a second time wrote `4 stats_team changes`. The plan said stats are "always applied, including on closed games," so an older post-game summary (document 142) overwrote the final stats and document 146 put them back. Net no-op, but not `0 new changes`. The plan was the bug.

Fix: stats follow observation precedence like game-level fields.

```ts
export function decideStats(stored, incoming): StatsAction {
  if (!stored) return 'insert';
  if (stored.observedAt !== null && incoming.observedAt.getTime() <= stored.observedAt.getTime()) {
    return 'ignore_older';
  }
  return stored.contentHash === incoming.contentHash ? 'touch' : 'update';
}
```

Final run: `changes: 0   stale: 140`, score `85|93` unchanged, `24/24 invariants hold`. At `--pace 0` the local Realtime answered `429` four times with `pending: 333` rows; the worker now waits out the backoff (`pending 0, dead 0`, exit 0) and both subscribers finished `"contiguous":true,"duplicates":0`.

Limits: the 429s came from the local stack with no `Retry-After`, so only the doubling backoff ran live. Next: M2, three leagues and player identity.

## Short version (≤ 280 chars)

wehoop-api M1 corrective pass: held PR #3 one more loop. 5 holes closed, 3,350 raw docs → committed 158-doc fixture, and the fresh run caught a new bug: re-replaying a finished game wrote 4 stats changes. Stats now follow observation time. 0 changes, 24/24 invariants.

## Three alternative hooks

1. The first M1 evidence pointed at a 470 MB file in a scratchpad that no longer existed. "All PASS" you cannot rerun is a claim, not evidence. So we made the replay a 2.4 MB committed fixture, ran it again, and it failed.
2. Replay a finished game a second time and an older summary overwrote the final stats, then a newer one put them back. Four changes, net zero, still wrong. The plan had said "stats: always applied by hash." The plan was the bug.
3. Two reviewers said "don't merge yet" on a green PR. One loop later: three contract decisions ratified, five correctness holes closed, one brand-new bug found. Here is what holding the merge bought.

## Capture checklist

- [ ] Terminal recording: `pnpm supabase db reset`, then `pnpm dev:worker --mode sim --league wnba --replay-file fixtures/wnba/sim-93ee7c68-replay.compact.jsonl.gz --pace 0 --until closed` twice against the same database. Visible first run: `recording replay finished   docs: 158   closedAtDoc: 156` and `changes: 675   stale: 0`. Visible second run: `WARN: stale batch` lines, then `changes: 0   stale: 140` and `"ignoredOlderStats": 2`.
- [ ] Terminal recording: `git show 85967d4:devlog/evidence/M1.md | sed -n '170,197p'`. Visible: the four `stats_team` rows `676`..`679` (`document 142 again: older stats re-applied over the stored newer ones`, then `document 146: back to the stored stats`) and `Result: **FAIL** on "0 new changes" (4 `stats_team` changes ...)`.
- [ ] Terminal recording: `shasum -a 256 fixtures/wnba/sim-93ee7c68-replay.compact.jsonl.gz; gunzip -c fixtures/wnba/sim-93ee7c68-replay.compact.jsonl.gz | wc -l`. Visible: `7be194ab80d0ca885a12d802702d046f73e8ab9c13763af13d5a4527c5b0481c` and `158`. Optional, needs the git-ignored raw file (record first with `pnpm sim record --league wnba --recording 93ee7c68-28d8-4ae8-b54a-974a551aa1f6 --out fixtures/wnba/sim-93ee7c68-replay.raw.jsonl`, natural pace, hours): `pnpm sim compact --in fixtures/wnba/sim-93ee7c68-replay.raw.jsonl --out fixtures/wnba/sim-93ee7c68-replay.compact.jsonl.gz --every-pbp 50 --every-summary 10 --target-mb 4` printing kept/total per feed and the same sha256.
- [ ] Terminal recording (429 path, three panes): `pnpm dev:api`; `pnpm dev:worker --mode sim --league wnba --replay-file fixtures/wnba/sim-93ee7c68-replay.compact.jsonl.gz --pace 0 --max-docs 1` to seed the game at seq 0 (prints `GAME_ID=`); `pnpm subscribe --game <GAME_ID> --auth anon` and `pnpm subscribe --game <GAME_ID> --auth guest`; then `pnpm dev:worker --mode sim --league wnba --replay-file fixtures/wnba/sim-93ee7c68-replay.compact.jsonl.gz --pace 0 --until closed`. Visible: `WARN: outbox publish rate limited (429); backing off`, `WARN: outbox not fully published; waiting for backoff before exit   pending: 333`, then `unpublished: { "pending": 0, "dead": 0 }` with exit 0, and each subscriber's `summary {"applied":675,...,"contiguous":true,"duplicates":0,...}`.
- [ ] Terminal recording: `pnpm invariants` ending in `24/24 invariants hold`, exit 0 (the new row is `deleted_revision_only_on_deleted_events`).
- [ ] Screenshot: `pnpm test test/unit/ingest/freshness.test.ts --reporter=verbose` showing the five `(rev 4.3) > 2d:` lines, `unknown provider status makes no phase claim`, `freshness rule 3: stats observation precedence`, and `Tests  29 passed (29)`.
- [ ] Code snippet to show: `src/ingest/freshness.ts:419-428` (`decideStats`: insert / ignore_older / touch / update).

## Evidence used

- PR #3 held for "user + external review"; three contract questions ratified (rule 2(d) in `freshness.ts`, `provider…Id` naming, `lineup_change` carries the on-court set); five holes closed (unknown status, deletion revision, revision-only updates, omitted metadata, outbox head starvation) — `docs/PLAN.md` "Rev 4.3" paragraph at the top; commits `12a457c`, `99a2e32`, `f08e33d`, `91a68e0`, `712283d`, `5e27718` (`git log a71fbfb..HEAD`).
- Rule 2(d) wording "more time remaining than stored is run_regresses_state (2d); equal or less is a downward correction"; the old watcher-side guard "lived outside the transaction, dropped documents without a log row" — commit `12a457c` body; `docs/PLAN.md` §4 rule 2(d).
- Unknown status "never scheduled" — commit `f08e33d`. Deletion revision and revision-only `touch` — commit `91a68e0`. "omission is not change for coverage, provider_updated_at, venue, broadcasts" — commit `712283d`. "A blocked head or a 300-row backlog can no longer fill the batch and starve healthy channels" — commit `5e27718`.
- Freshness cases 13 → 23: `M1-superseded-fe529cf.md` §"Freshness cases" ("**13/13** §4 cases", `Tests  20 passed (20)`); `M1.md` §"Freshness cases" ("23 cases in the §4 sentence (rev 4.3)", `Tests  29 passed (29)`, "23/23 mapped and passing").
- First evidence's replay source was a deleted scratchpad file: `M1-superseded-fe529cf.md` §Environment › Replay source (`/private/tmp/.../scratchpad/replay-full.jsonl`, `470,299,576 bytes, 1,342 documents`); header line "Superseded by M1.md at 631ff1c (2026-10-14): replay source was a deleted scratchpad file".
- DB-free recorder and deterministic compactor — commit `cc22fe8` ("DB-free natural-pace recorder", "deterministic down-sampler to gzip with per-feed kept/total, size, sha256"); commit `8b263a9`.
- Fixture numbers: `3,350 raw documents`, "158 docs, 2.4 MB, sha256 7be194ab…", "Replays to closed 93-85 in ~2 s with --pace 0" — commit `631ff1c` subject and body. 158 documents (76 pbp / 41 summary / 41 boxscore), sha256 `7be194ab…c5b0481c` equal to the README row — `M1.md` §Environment › Replay source and §"Reproducible replay". Recording duration is not in the evidence files; `fixtures/wnba/README.md` estimates "~2.5-3 h" (not quoted as a number in the post).
- First pass on the fixture: "20 PASS, 1 FAIL (stats regress on post-closed re-run)" — commit `85967d4` subject. The 4 `stats_team` changes seq `676`..`679`, "document 142 again: older stats re-applied over the stored newer ones" then "document 146: back to the stored stats", and the old rule 3 text "stats: content-hash compare, always applied, including on closed games" — `git show 85967d4:devlog/evidence/M1.md` §"No regression" (lines 170–197); `Result: **FAIL**`; "**M1 at 631ff1c: NOT DONE.**".
- Fix: "stats follow observation precedence (migration 0004, decideStats)"; "A replay re-run over a finished game no longer oscillates stats; later official corrections on closed games still apply" — commit `e59d2c2`; `docs/PLAN.md` §4 rule 3 "Stats" bullet ("the M1 evidence at 631ff1c caught exactly this: a re-run wrote 4 `stats_team` changes, two regressions and two restorations"); `src/ingest/freshness.ts:419-428`.
- Final no-regression run: `changes: 0   stale: 140`, `"ignoredOlderStats": 2`, `run_regresses_state|140`, 675 → 675 changes, score `85|93` unchanged, `diff a.json a_after.json: identical` — `M1.md` §"No regression".
- `24/24 invariants hold` incl. `deleted_revision_only_on_deleted_events` — `M1.md` §`pnpm invariants` (also after corrections, Replay B, each crash restart).
- 429 path: `4 WARN: outbox publish rate limited (429); backing off`, `pending: 333`, "waited on the backoff (~14 s) instead of exiting", `unpublished: { "pending": 0, "dead": 0 }`, `exit=0`, both subscribers `"applied":675,...,"contiguous":true,"duplicates":0`, `receivedEqualsApi: true` — `M1.md` §"Contiguity" and "429 handled without stranding subscribers". Contrast: the superseded run "exited 0 with a skipped channel" leaving `445 unpublished` — `M1-superseded-fe529cf.md` §Observations item 1. Worker behaviour (bounded `--drain-timeout`, exit 75 if rows remain) — commit `33e4fb9`.
- Limit: `retryAfterMs: null` on all four 429s, "only the 1 s-doubling path was exercised live" — `M1.md` §Observations item 2. Case 23 integration-only — §Observations item 4. `watch_run_id` advances 1 → 2 on the re-run — §Observations item 3.
- Replay of a recorded 2026 game, Las Vegas Aces at New York Liberty, Sportradar simulation, not live — `M1-superseded-fe529cf.md` §Environment (`pnpm sim list --league wnba`, scheduled `2026-06-30`); `docs/PLAN.md` Context.
- Test totals: `Tests  99 passed (99)` (`pnpm check`), `Tests  64 passed (64)` (`pnpm test:int`) — `M1.md` §Gates; the superseded run had `Tests  48 passed (48)` integration.
- Next milestone M2 "Three leagues + identity" — `docs/PLAN.md` §7 M2 row.
- Buffer: skipped, `DEVLOG_BUFFER=0` in `.env`.
