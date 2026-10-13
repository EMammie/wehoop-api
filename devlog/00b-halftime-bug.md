# The bug that would have killed every second half

**Milestone:** M0 follow-ups (pre-M1) · **Date:** 2026-10-12 · **Commit:** 2bfccad

## Post draft (long form, ~200–300 words)

We had not written a line of ingestion code yet, and we already had a bug that would have thrown away the second half of every game.

wehoop-api is the backend for Wehoop, a women's basketball stats app (WNBA, NCAA women's, Unrivaled; Sportradar is the data provider, still on simulation recordings, nothing live yet). After the M0 scaffold shipped, an outside review found a flaw in the "freshness" rule, which decides whether a live update is newer than what we have stored. The plan ordered updates with one progress score whose status ranking was `scheduled < inprogress < halftime < complete`. Halftime scored higher than the second half, so every second-half update would have been rejected as stale. The same score would have rejected a referee restoring time to the clock and a provider deleting a mistaken play, because both lower a number.

The fix throws the score away. Freshness is now decided by watch generations (which worker run is watching this game) plus per-entity rules: events compare provider revision and content, game-level fields compare our own observation time, deletions need an explicit marker. It took two reviewer passes. Pass one caught concurrent run kinds fighting over one game; pass two caught a deleted final play poisoning the gate for later generations, and schedule polls overwriting live scores.

Second finding: the outbox rows that route each change to a Realtime channel stored their own copy of game id, sequence, and channel, which could disagree with the change they pointed at. Now `channel` is a generated column and a composite foreign key ties `(change_id, game_id, seq)` to the change itself. Insert a mis-routed row and Postgres answers `23503`. Supply the channel yourself, even correctly: `428C9`. Let the database refuse the lie.

Honesty note: this is schema and design work. The 13 behavioural test cases for the freshness rules are M1 work, and the reviewer verdicts in the evidence are caller-reported, not independently validated. Proven: 24 integration tests (up from 16) and 21/21 invariants (up from 16) pass on the branch.

Next: M1, one recorded WNBA game replayed end to end.

## Short version (≤ 280 chars)

wehoop-api, before M1: an outside review found our freshness rule ranked halftime above inprogress, so every second-half update would be stale. Replaced the score with watch generations. Outbox routing is now a generated column + composite FK. 24 int tests, 21/21 invariants.

## Three alternative hooks

1. Our plan scored halftime higher than the second half. Every update after the break would have been thrown away as stale. Caught in review, before a line of ingestion code existed.
2. A referee puts 30 seconds back on the clock. Our old freshness rule would have called that update stale. Here is why a single "progress score" cannot order a basketball game.
3. The outbox row said "game B". The change it pointed at said "game A". Now that row cannot exist: one generated column, one composite foreign key, and Postgres refuses the lie.

## Capture checklist

- [ ] Terminal recording: `git show main:docs/PLAN.md | grep -n "statusRank"` — visible: line 134 with `scheduled < inprogress < halftime < complete < closed`. Then `grep -n "halftime" docs/PLAN.md` on the branch showing the new wording ("halftime would outrank the second half").
- [ ] Terminal recording: `docker exec -i supabase_db_wehoop-api psql -U postgres -d postgres` inside a `begin; ... rollback;` block, inserting an outbox row with the wrong `game_id` — visible: `ERROR:  23503 ... broadcast_outbox_routes_its_change`; then inserting with an explicit `channel` — visible: `ERROR:  428C9: cannot insert a non-DEFAULT value into column "channel"`. End with `rollback;` and a zero count.
- [ ] Terminal recording: `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres pnpm invariants` — should end with `21/21 invariants hold`, exit 0.
- [ ] Screenshot: `pnpm test:int` summary showing `Tests  24 passed (24)`.
- [ ] Code snippet to show: `supabase/migrations/0002_freshness_and_outbox_routing.sql:106-110` (generated `channel` column, `broadcast_outbox_routes_its_change` composite FK, `(game_id, seq)` unique).

## Evidence used

- Old rule ranked `scheduled < inprogress < halftime < complete < closed` — `git show main:docs/PLAN.md` line 134 (verified directly); cited by `wehoop-design/M0_REVIEW.md` "Required before accepting M1" item 1 (`docs/PLAN.md:134 ranks halftime above inprogress, so the second half becomes stale`).
- Clock restored after a review and deleting a mistaken play would also have been rejected — `M0_REVIEW.md` item 1; restated in `docs/PLAN.md` §4 "Freshness policy" opening paragraph (branch).
- Watch generations + per-entity precedence replace the scalar — `docs/PLAN.md` §4 "Freshness policy" (branch); `devlog/evidence/M0-followups.md` row 7 (`watch_run_id` restrict FK, `parent_run_id`, no `progress_key`).
- Two reviewer passes; pass 1 shoulds = concurrent run kinds per game, pass 2 shoulds = generation-less polls never write live state and 2c ignores explicitly deleted events — `M0-followups.md` "Review history" (commits `e41e0ab`, `5d789ee`, `c861835`). The evidence states these verdicts are caller-reported, not independently validated.
- Outbox stored its own `game_id`, `seq`, `channel` which could disagree — `M0_REVIEW.md` item 2 (`0001_core.sql:517`).
- `channel` is `is_generated='ALWAYS'`; exactly one FK `broadcast_outbox_routes_its_change` on `(change_id, game_id, seq)` — `M0-followups.md` row 6.
- SQLSTATE `23503` on wrong `game_id` and wrong `seq`, `428C9` on explicit channel, `23503`/`23505` on UPDATE re-route — `M0-followups.md` row 5.
- 24 integration tests (M0 had 16) — `M0-followups.md` row 3 (`Tests  24 passed (24)`).
- 21/21 invariants (M0 had 16/16; 5 new) — `M0-followups.md` row 4 (`21/21 invariants hold`).
- 13 acceptance cases for `freshness.ts`, deferred to M1; the review's four named cases are items 1, 2, 3, and 5 — `M0-followups.md` row 12.
- Nothing live proven; finding 3 (live Realtime authorization) remains M1 — `M0-followups.md` Summary; `M0_REVIEW.md` item 3.
- Sportradar as data provider, simulation recordings first — `docs/PLAN.md` §4 (`SimulationUrlResolver`), `M0_REVIEW.md` Operations ("Do not start a Sportradar trial until M3 tooling is ready").
- Commit note: evidence rows were captured at `30eb40e` (12 commits ahead of `main`). HEAD `2bfccad` adds one docs-only commit ("docs: label plan rev 4.2", 2 lines in `docs/PLAN.md`), verified with `git show --stat HEAD`; no code or schema changed after validation.
