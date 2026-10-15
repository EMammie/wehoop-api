# One player, three leagues, one id

**Milestone:** M2 · **Date:** 2026-10-15 · **Commit:** aa6aff6 (first validation at 7e94217; corrective pass before merge)

## Post draft (long form, ~200–300 words)

Aliyah Boston has three different Sportradar ids: WNBA, NCAA women's, Unrivaled. `/v1/players/` answers all three with the same uuid. Then, after the milestone had passed validation, we found that merging her rows could quietly delete a stats line.

wehoop-api is the backend for Wehoop, a women's basketball stats app; Sportradar is the data provider. M2 adds the NCAA women's and Unrivaled adapters next to WNBA, reference feeds (schedules, standings, profiles, season stats, tournaments), a cross-league player identity table, read-only client views, and `/v1/players/:id`.

Three games replayed into one database: WNBA `changes: 1233`, final 85–93; NCAAWB (Northwestern at Michigan State) `changes: 667`, 68–104; Unrivaled `changes: 12`, 84–80 with an `elam` period row and target 84. Outbox parity `1912|1912|0`. Five routes to Boston (Unrivaled, WNBA and NCAAWB ids, canonical uuid, merged-away uuid) all return `5 7d759b1e-…`: 6 external ids, 5 season lines, one tombstone owning nothing.

Limits, plainly. The WNBA and NCAAWB replays are Sportradar simulation recordings, not live data. Unrivaled is partly synthetic: no simulation recording exists and we used no key, so its game documents are hand-assembled from Sportradar's public docs samples; target 84 is derived and the field name unconfirmed; the three-id Boston example pairs a captured league-leaders document with docs-sample ids. It proves the pipeline, not the provider's shapes.

What broke, round two. The first battery passed `36/36`. Then PR review found `game_player_stats` keyed on our canonical uuid: merging two provider ids that both had a line in one game deleted a row, and nothing was broadcast, so a connected client's fold no longer matched a fresh snapshot. Fix: key the table on provider id and let a merge only repoint `player_id`:

```sql
alter table public.game_player_stats add primary key (game_id, provider_player_id);
```

Every automatic merge now records what it moved (and the full content of any season line it dropped) in `ingest.player_merges`; references the code cannot resolve are held in `ingest.player_merge_holds` instead of merged; the order-dependent in-batch duplicate guard is gone; `player_team_seasons` is classified as roster data with named writers. The flaky tournament test from the first pass was test contamination (a suffixed test season clashing with the worker's), not ingestion, and now passes in both orders. Invariants 36 → `44/44 invariants hold`; integration 97 → `103 passed (103)`.

Next: M3, NCAAWB live on a trial key in November (not yet requested).

## Short version (≤ 280 chars)

wehoop-api M2, take two: three leagues, one player id. Caught pre-merge: an identity merge could delete a stats row with no broadcast change, so clients drifted from snapshots. Stats now keyed by provider id; a merge only repoints. 44/44 invariants, 103 int tests. Not live data.

## Three alternative hooks

1. Five different ids for the same player (three provider ids, a canonical uuid, and a merged-away uuid) all return `7d759b1e-…` from `/v1/players/`. Whichever profile arrived first, the older row survives, and now the merge leaves every stats row in place.
2. The milestone passed 36/36 invariants. Then we noticed a merge could delete a player's game line without telling any connected client. Why we re-keyed stats on provider id and added 8 more invariants before merging.
3. Unrivaled's Elam ending has no simulation recording and we have no key, so we built the game from Sportradar's docs samples. Target 84, derived, unconfirmed. Here is what that evidence proves and what it does not.

## Capture checklist

- [ ] Terminal recording: `pnpm supabase db reset`, then the three replays in order: `pnpm dev:worker --mode sim --league wnba --replay-file fixtures/wnba/sim-93ee7c68-replay.compact.jsonl.gz --pace 0 --until closed`, `pnpm dev:worker --mode sim --league ncaawb --replay-file fixtures/ncaawb/sim-d9b71fe0-replay.compact.jsonl.gz --pace 0 --until closed`, `pnpm dev:worker --mode sim --league unrivaled --replay-file fixtures/unrivaled/docs-838316ea-replay.jsonl --pace 0 --until closed`. Visible: the migration list ending `0007_merge_provenance.sql`, then each tail with `finalStatus: "closed"`, `changes: 1233` / `changes: 667` / `changes: 12`, `stale: 0`, `"pending": 0, "dead": 0`.
- [ ] Terminal recording (identity, two panes): pane one `pnpm dev:api`. Pane two: `pnpm dev:worker --mode sim --league wnba --replay-file fixtures/wnba/docs-identity-replay.jsonl --pace 0 --until closed`, then `pnpm dev:worker --mode sim --league unrivaled --replay-file fixtures/unrivaled/identity-replay.jsonl.gz --pace 0 --until closed` (visible: `INFO: players merged` with its `repoint:` block showing `"gamePlayerStats": { "repointed": 0 }` and `"playerSeasonStats": { "repointed": 1, "dropped": 0 }`, then `reference document applied   merged: 1`), then the five-route loop from evidence item 2 (`unrivaled:54b8a881-…`, `wnba:63dde7d8-…`, `ncaawb:d8f2f455-…`, `7d759b1e-…`, `7b7229c8-…`) piped through `jq -r .player.id | sort | uniq -c`. Visible: `5 7d759b1e-f56f-4172-94fc-1dcf39474351`.
- [ ] Terminal recording (the fix): `VITEST_INTEGRATION=1 pnpm vitest run test/integration/identity-merge.test.ts --reporter=verbose`. Visible: the test name "two provider ids merged into one person keep two provider-keyed rows: [A,B] then [B,A] after the merge yields zero changes, a connected client and a fresh snapshot agree" and `Tests  10 passed (10)`.
- [ ] Terminal recording: `pnpm invariants` ending in `44/44 invariants hold`, exit 0 (new rows include `game_player_stats_pk_is_provider_keyed`, `game_player_stats_one_row_per_provider_id_per_game`, `game_player_stats_never_point_at_tombstones`, `tombstones_have_merge_provenance`, `merge_losers_are_tombstones`, `merge_tables_closed_to_clients`).
- [ ] Screenshot: Supabase Studio (`http://127.0.0.1:54323`) on `player_external_ids` filtered to Aliyah Boston's canonical id, showing 6 rows across `wnba`, `ncaawb`, `unrivaled`; and `players` showing the two rows, one with `merged_into` set.
- [ ] Screenshot: Studio on `ingest.player_merges` (service role view) showing the single replay-path row: `trigger_source reference`, the `repoint` json, `conflicts []`, `run_id 8`.
- [ ] Screenshot: Studio on `games` for the Unrivaled game: `status closed`, `period_type elam`, `elam_target_score 84`, `clock` null, `clock_running false`, `clock_extra {"clockType": "elam", "clockDirectional": "+00:19"}`.
- [ ] Code snippet to show: `supabase/migrations/0007_merge_provenance.sql:35-38` (the provider-keyed primary key). Alternative: `src/ingest/apply-changes.ts:1086-1127` (`repointPlayerReferences`: `game_player_stats` repointed in place, never dropped; `player_season_stats` conflicts returned as provenance). Survivor rule, if needed: `src/ingest/identity.ts:421-427` (older row wins, `order by created_at, id`).

## Evidence used

- Milestone scope, hook "One player, three leagues, one id", and the rev 4.4 corrective-pass acceptance items — `docs/PLAN.md` §7 M2 row and rev 4.4 note. Corrective commits `04362f7`, `9a804c8`, `aa6aff6` on `m2-three-leagues` — `devlog/evidence/M2.md` header; "Review verdict before this battery: APPROVED-WITH-SHOULDS, 0 blockers".
- Defect statement: "an identity merge deleted a `game_player_stats` row without a durable change, so a connected client's fold diverged from a fresh snapshot" — evidence header.
- WNBA replay `changes: 1233`, `stale: 0`, `pending: 0`, `dead: 0`; row `wnba|…|closed|85-93|408|1233|4|26|1233` — §1 Replays and §1 Row counts per league. The NCAAWB matchup (Northwestern at Michigan State) is from `fixtures/ncaawb/README.md` line 7; not in the evidence file.
- NCAAWB replay `docs: 138`, `changes: 667`; row `ncaawb|…|closed|68-104|306|667|4|31|667` — §1.
- Unrivaled replay `docs: 8`, `changes: 12`; row `unrivaled|…|closed|84-80|4|12|2|1|12` — §1.
- Outbox parity `1912|1912|0`; change-type sum 1912 = 1233 + 667 + 12; "Identical to the superseded battery at `7e94217`" — §1 and Findings item 4.
- Stats bodies carry no canonical uuid: SQL count → `0`; invariant `stats_bodies_carry_no_canonical_uuid 0/0 PASS` — §1 and §`pnpm invariants`.
- Identity replays: worker log `INFO: players merged` with `survivor: "7d759b1e-…"`, `loser: "7b7229c8-…"`, `repoint: { "playEvents": 0, "gamePlayerStats": { "repointed": 0 }, "playerSeasonStats": { "repointed": 1, "dropped": 0 }, "playerTeamSeasons": { "repointed": 1, "dropped": 0 } }`, then `reference document applied   merged: 1` — §2.
- `/v1/players/` five routes → one id: `5 7d759b1e-f56f-4172-94fc-1dcf39474351`; by Unrivaled id → `"name":"Aliyah Boston"`, 6 external ids, `"mergedIds":["7b7229c8-…"]`, 5 seasons; canonical and merged-away uuids both `http=200` — §2.
- `player_external_ids`: 6 rows across 3 leagues; `players`: survivor `6|5`, tombstone `0|0`, "the loser is a tombstone owning nothing" — §2 SQL queries.
- Survivor is the older row — `src/ingest/identity.ts:421-427` (`order by created_at, id`); plan rev 4.4 "an identity merge keeps the oldest row and tombstones the loser".
- Elam: `closed|elam|84||f|{"clockType": "elam", "clockDirectional": "+00:19"}|4|elam|7|17`; status changes carry `elamTargetScore` 84 from seq 7 on; target "**derived** from the sample's own numbers under the league rule (leading score after Q3 + 11), not captured, and the field name is not confirmed by a real response" — §3 and §Environment › "Unrivaled evidence is partly synthetic".
- Provenance: "No Unrivaled simulation recording and no key exist for the product"; game documents "hand-assembled from Sportradar docs samples"; the Boston example "combines a captured leaders document (`fixtures/unrivaled/2026-REG-league-leaders.json`) with docs-sample ids"; "The WNBA and NCAAWB rows rest on real simulation recordings"; "Items 2, 3 and 4 below therefore prove the pipeline, not the provider's shapes"; "no Sportradar call, no key, no trial" — §Environment.
- Fix, PK: `PRIMARY KEY (game_id, provider_player_id)` from `pg_get_constraintdef`; `grep -n seenPlayers src/ingest/apply-changes.ts` → "(no output, grep exit=1)" — §7.
- Fix, fold == snapshot: `identity-merge.test.ts` `Tests  10 passed (10)`; test 2 asserts `repoint.gamePlayerStats` equals `{ repointed: 1 }`, both provider rows kept, `game_changes` count unchanged, `canonicalState(client) === canonicalState(stateFromSnapshot(snapAfter))`; `[A,B]` then `[B,A]` with a later `observedAt` → `r2.changes` equals `[]` — §7 and §8.
- Fix, provenance and holds: replay DB `merges|tombstones|holds` = `1|1|0`, the one `ingest.player_merges` row with `conflicts []` and `run_id 8`; test DB `6|6|0` tombstones/merges/without-provenance; all five hold reasons (`unknown_scope`, `unknown_id_type`, `conflicting_profiles`, `id_type_mismatch`, `tombstone_owner`) each `open` once; conflicts test row "1 season line + 1 team season dropped with 2 `conflicts` entries holding their content" — §9.
- `player_team_seasons` classified as roster data with named writers — `docs/PLAN.md` rev 4.4 note; `supabase/migrations/0007_merge_provenance.sql:121` (table comment). Not a number; no evidence line needed.
- OOT flake resolved: "`reference.test.ts` order dependence from the superseded battery is gone … because the suffixed season was an `ensureSeason` clash and the test games were written with null `season_id`"; (A), (B), (C) all `5 passed (5)`; `games where tournament_id is not null and season_id is null` = `0` in both orders — §4 and §Findings item 1.
- `44/44 invariants hold` on both the post-test DB and the final populated DB; "36 at `7e94217`, +8 from the corrective pass" — §`pnpm invariants`.
- `Tests  103 passed (103)`, `14 passed (14)` files, fresh DB; "97 tests at `7e94217`; +6 from the corrective pass" — §Full `pnpm test:int`. `pnpm check`: `18 passed (18)` files, `130 passed (130)` unit tests (not quoted in the post) — §`pnpm check`.
- Migration `0007_merge_provenance` applied on every reset (`grep -c Applying` = 7) — §db reset.
- Schema test 13/13 families reject a mutated and a dropped persisted field (not quoted in the post) — §5. Views `security_invoker` 4/4, anon denied on all five `ingest` tables including `player_merges` and `player_merge_holds` (not quoted in the post) — §6.
- Only WARN in the battery, `aborted orphaned runs` after a test left a running `ingestion_runs` row, "Expected worker behaviour (orphan cleanup), no effect on any count" (not quoted in the post) — §Findings item 2.
- Next milestone M3 "NCAAWB live (trial key, Nov)"; "Trial key requested when live-validation tooling (M3) is ready" — `docs/PLAN.md` §7 M3 row and Phase 0 note.
- Before/after numbers (36 invariants, 97 integration tests) are quoted from the new file's own Findings item 4 and section footers; `devlog/evidence/M2-superseded-7e94217.md` is referenced for context only.
- Buffer: skipped, `DEVLOG_BUFFER` unset in this environment.
