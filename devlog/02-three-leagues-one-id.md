# One player, three leagues, one id

**Milestone:** M2 · **Date:** 2026-10-16 · **Commit:** 75d69ff (first validation at 7e94217; three corrective passes before merge, aa6aff6, d3d194c, then 75d69ff)

## Post draft (long form, ~200–300 words)

Aliyah Boston has three different Sportradar ids: WNBA, NCAA women's, Unrivaled. `/v1/players/` answers all three with the same uuid. Then, after validation, we found that merging her rows could quietly delete a stats line.

wehoop-api is the backend for Wehoop, a women's basketball stats app; Sportradar is the data provider. M2 adds the NCAA women's and Unrivaled adapters next to WNBA, reference feeds, a cross-league player identity table, read-only client views, and `/v1/players/:id`.

Three games replayed into one database: WNBA `changes: 1233`, final 85–93; NCAAWB (Northwestern at Michigan State) `changes: 667`, 68–104; Unrivaled `changes: 12`, 84–80 with an `elam` period row and target 84. Outbox parity `1912|1912|0`. Five routes to Boston (Unrivaled, WNBA and NCAAWB ids, canonical uuid, merged-away uuid) all return `5 272a3704-…`: 6 external ids, 5 season lines, one tombstone owning nothing.

Limits, plainly. The WNBA and NCAAWB replays are Sportradar simulation recordings, not live data. Unrivaled is partly synthetic: no simulation recording exists and we used no key, so its game documents are hand-assembled from Sportradar's public docs samples; target 84 is derived and the field name unconfirmed; the three-id Boston example pairs a captured league-leaders document with docs-sample ids. It proves the pipeline, not the provider's shapes.

What broke, round two. The first battery passed `36/36`. Then PR review found `game_player_stats` keyed on our canonical uuid: merging two provider ids that both had a line in one game deleted a row, and nothing was broadcast, so a connected client's fold no longer matched a fresh snapshot. Fix: key the table on provider id and let a merge only repoint `player_id`:

```sql
alter table public.game_player_stats add primary key (game_id, provider_player_id);
```

Every automatic merge now records what it moved and dropped in `ingest.player_merges`. A second pass made contradictory ids (two different sport-wide ids, or a profile landing on a row that claims another) leave a `conflicting_profiles` hold in `ingest.player_merge_holds` and change nothing.

Round three. The reviewer caught an evidence-free tie-break: a profile whose references pointed at contradicting rows was held, yet still landed on the oldest candidate. Now the whole document is skipped, the hold names every row involved, and it keeps the parsed document with its observed time, so a later provisional-profiles milestone can replay the backlog without refetching. The plan carries the checkpoint: M3 measures held profiles on the live run; before the M5 beta we decide whether provisional profiles are needed. `identity-merge.test.ts` `16 passed (16)`; invariants 44 → `45/45 invariants hold`; integration 106 → `110 passed (110)`.

Next: M3, NCAAWB live on a trial key in November (not yet requested).

## Short version (≤ 280 chars)

wehoop-api M2, take three: three leagues, one player id. Caught pre-merge: a merge could delete a stats row unbroadcast; a contradictory profile landed by guess. Now stats are provider-keyed; contradictions are held, skipped, kept for replay. 45/45 invariants. Not live data.

## Three alternative hooks

1. Five different ids for the same player (three provider ids, a canonical uuid, and a merged-away uuid) all return `272a3704-…` from `/v1/players/`. Whichever profile arrived first, the older row survives, and now the merge leaves every stats row in place.
2. The milestone passed 36/36 invariants. Then we noticed a merge could delete a player's game line without telling any connected client. Why we re-keyed stats on provider id and added 9 more invariants before merging.
3. Unrivaled's Elam ending has no simulation recording and we have no key, so we built the game from Sportradar's docs samples. Target 84, derived, unconfirmed. Here is what that evidence proves and what it does not.

## Capture checklist

- [ ] Terminal recording: `pnpm supabase db reset`, then the three replays in order: `pnpm dev:worker --mode sim --league wnba --replay-file fixtures/wnba/sim-93ee7c68-replay.compact.jsonl.gz --pace 0 --until closed`, `pnpm dev:worker --mode sim --league ncaawb --replay-file fixtures/ncaawb/sim-d9b71fe0-replay.compact.jsonl.gz --pace 0 --until closed`, `pnpm dev:worker --mode sim --league unrivaled --replay-file fixtures/unrivaled/docs-838316ea-replay.jsonl --pace 0 --until closed`. Visible: the migration list ending `0008_hold_documents.sql`, then each tail with `finalStatus: "closed"`, `changes: 1233` / `changes: 667` / `changes: 12`, `stale: 0`, `"pending": 0, "dead": 0`.
- [ ] Terminal recording (identity, two panes): pane one `pnpm dev:api`. Pane two: `pnpm dev:worker --mode sim --league wnba --replay-file fixtures/wnba/docs-identity-replay.jsonl --pace 0 --until closed`, then `pnpm dev:worker --mode sim --league unrivaled --replay-file fixtures/unrivaled/identity-replay.jsonl.gz --pace 0 --until closed` (visible: `INFO: players merged` with its `repoint:` block showing `"gamePlayerStats": { "repointed": 0 }` and `"playerSeasonStats": { "repointed": 1, "dropped": 0 }`, then `reference document applied   merged: 1   held: 0`; the `trigger` object now embeds the whole parsed profile, so scroll or crop past it), then the five-route loop from evidence item 2 (`unrivaled:54b8a881-…`, `wnba:63dde7d8-…`, `ncaawb:d8f2f455-…`, canonical uuid, merged-away uuid) piped through `jq -r .player.id | sort | uniq -c`. Visible: `5 <canonical uuid>` (the evidence run printed `5 272a3704-0ea7-4f1f-9ef0-4a7f0071aef3`; player uuids are generated per reset, so read them from the `players merged` line).
- [ ] Terminal recording (the fixes): `VITEST_INTEGRATION=1 pnpm vitest run test/integration/identity-merge.test.ts --reporter=verbose`. Visible: the test name "two provider ids merged into one person keep two provider-keyed rows: [A,B] then [B,A] after the merge yields zero changes, a connected client and a fresh snapshot agree", the describe block "conflicting profiles are held with their evidence and change nothing" with its six `✓` lines (including "a held document is replayable from player_merge_holds.document alone" and "three references, two agreeing and one contradicting the second: one hold names all three rows"), and `Tests  16 passed (16)`.
- [ ] Terminal recording: `pnpm invariants` ending in `45/45 invariants hold`, exit 0 (identity rows include `game_player_stats_pk_is_provider_keyed`, `game_player_stats_never_point_at_tombstones`, `tombstones_have_merge_provenance`, `merge_losers_are_tombstones`, `open_hold_candidates_are_distinct_canonical_rows`, `open_holds_preserve_their_document`, `merge_tables_closed_to_clients`).
- [ ] Screenshot: Supabase Studio (`http://127.0.0.1:54323`) on `player_external_ids` filtered to Aliyah Boston's canonical id, showing 6 rows across `wnba`, `ncaawb`, `unrivaled`; and `players` showing the two rows, one with `merged_into` set.
- [ ] Screenshot: Studio on `ingest.player_merges` (service role view) showing the single replay-path row: `trigger_source reference`, the `repoint` json, `conflicts []`, `run_id 8`.
- [ ] Screenshot: Studio on `ingest.player_merge_holds` after `identity-merge.test.ts`: the `conflicting_profiles` rows with `status open`, `candidate_ids` (one, two or three rows) and `detail.conflicts` in the `{theirs, against: {claim, owner}}` shape, `owner` naming the row that holds the counter-claim.
- [ ] Screenshot (new): Studio on one `ingest.player_merge_holds` row with `document` non-null, e.g. after `VITEST_INTEGRATION=1 pnpm vitest run test/integration/reference.test.ts -t "player profile"` on the populated DB: `conflicting_profiles`, `open`, `document` expanded (`full_name` `Ref C`), `document_observed_at` `2025-01-17 23:01:30+00` next to a `created_at` from today, `document_updated_at` set.
- [ ] Screenshot: Studio on `games` for the Unrivaled game: `status closed`, `period_type elam`, `elam_target_score 84`, `clock` null, `clock_running false`, `clock_extra {"clockType": "elam", "clockDirectional": "+00:19"}`.
- [ ] Code snippet to show: `supabase/migrations/0007_merge_provenance.sql:35-38` (the provider-keyed primary key). Alternatives: `supabase/migrations/0008_hold_documents.sql:18-21` (the three document columns); `src/ingest/apply-changes.ts:1101-1127` (`repointPlayerReferences`: `game_player_stats` repointed in place, never dropped); `src/ingest/identity.ts:572-590` (`contradicts` + `claimConflicts`: same id type, different id, sport-wide ids compared regardless of league, each conflict paired with its owner); `src/ingest/identity.ts:1039-1071` (`replayHeldDocument`). Survivor rule, if needed: `src/ingest/identity.ts:430-434` (older row wins, `order by created_at, id`).

## Evidence used

- Milestone scope and hook "One player, three leagues, one id" — `docs/PLAN.md` §7 M2 row. Third corrective pass `6f48db4`, `e6a12ba`, `d58f4ff`, `55c427f`, `b69b461`, `faf6385`, `75d69ff`; migration `0008_hold_documents.sql`; plan rev 4.5; "Review verdict on the code range before this battery: APPROVED-WITH-SHOULDS, 0 blockers" — `devlog/evidence/M2.md` header and Environment. Earlier passes `aa6aff6` and `d3d194c` are named in the same header ("replaces the `d3d194c` battery … which itself replaced the `aa6aff6` battery").
- Round-three behaviour (skip the whole document, holds name every row including the counter-claim owner, every hold preserves the parsed document with `document_observed_at` / `document_updated_at`, repeats refresh it, `replayHeldDocument` replays it) — evidence header items (1)–(4) and §11. "Evidence-free tie-break" and "landed on the oldest candidate" — `docs/PLAN.md` line 21 (rev 4.5: "not landed on the oldest candidate by an evidence-free tie-break") and commit `6f48db4` message; the evidence file states the new behaviour, not the old.
- Plan checkpoint: "M3 assesses the coverage impact of held profiles on the live run; before M5 beta the owner decides whether provisional profiles are needed" — §11k (`grep -n "provisional" docs/PLAN.md`, lines 21, 217, 219, 221).
- Held document with observed time: §11f row `conflicting_profiles|open|WNBA|2|t|Ref C|2025-01-17 23:01:30+00|2026-10-16 06:03:05.779739+00|…`; 0 open holds with null `document` — §11g, §11h, §11i.
- WNBA replay `changes: 1233`, `stale: 0`, `pending: 0`, `dead: 0`; row `wnba|…|closed|85-93|408|1233|4|26|1233` — §1 Replays and Row counts per league. The NCAAWB matchup (Northwestern at Michigan State) is from `fixtures/ncaawb/README.md` line 7; not in the evidence file.
- NCAAWB `changes: 667`, row `ncaawb|…|closed|68-104|306|667|4|31|667`; Unrivaled `changes: 12`, final 84–80 — §1.
- Outbox parity `1912|1912|0`; "Sum 1912 = 1233 + 667 + 12"; "Every number that this pass did not touch is unchanged from `d3d194c`" — §1 and Findings 8.
- Identity: worker log `INFO: players merged`, `survivor: "272a3704-…"`, `loser: "b18fca12-…"`, `repoint` `{ "playEvents": 0, "gamePlayerStats": { "repointed": 0 }, "playerSeasonStats": { "repointed": 1, "dropped": 0 }, … }`, then `merged: 1`, `held: 0`; the `trigger` now embeds the parsed profile — §2 and Findings 2.
- `/v1/players/` five routes → `5 272a3704-0ea7-4f1f-9ef0-4a7f0071aef3`; 6 external ids, `"mergedIds":["b18fca12-…"]`, 5 seasons; survivor `6|5`, tombstone `0|0`, "the loser is a tombstone owning nothing" — §2.
- Survivor is the older row — `src/ingest/identity.ts:430-434` (`order by created_at, id`).
- Elam: `closed|elam|84||f|{"clockType": "elam", "clockDirectional": "+00:19"}|4|4|elam|7|17`; target "**derived** … not captured, and the field name is not confirmed by a real response" — §3 and Environment › "Unrivaled evidence is partly synthetic".
- Provenance: "No Unrivaled simulation recording and no key exist for the product"; "hand-assembled from Sportradar docs samples"; Boston example "combines a captured leaders document … with docs-sample ids"; "The WNBA and NCAAWB rows rest on real simulation recordings"; "Items 2, 3 and 4 below therefore prove the pipeline, not the provider's shapes"; "no Sportradar call, no key, no trial" — Environment.
- PK fix: `PRIMARY KEY (game_id, provider_player_id)`; `grep -n seenPlayers` → "(no output, grep exit=1)" — §7. Fold == snapshot and `[A,B]` then `[B,A]` → `r2.changes` equals `[]` — §7 and §8.
- Provenance and holds: replay DB `1|1|0` merges/tombstones/holds, `run_id` 8, `conflicts []` — §9; all five hold reasons `open` on the test DB — §9; one open `conflicting_profiles` hold per (document, reference), `detail.conflicts[{theirs, against:{claim, owner}}]`, 3-candidate holds naming the counter-claim owner — §10c, §11d, Findings 5.
- `identity-merge.test.ts` `Tests  16 passed (16)` ("13 tests at `d3d194c`") — §7, §10a. Stability "pass count: 5/5" — §11i.
- `45/45 invariants hold` on four DB states; "44 at `d3d194c`: `open_holds_preserve_their_document` is new" — §`pnpm invariants`, §11g.
- `Tests  110 passed (110)`, `14 passed (14)` files; "106 tests at `d3d194c`; +4 from this pass" — §Full `pnpm test:int`. `pnpm check` 18 files / 130 unit tests (not quoted in the post) — §`pnpm check`.
- Migrations: every reset applied `0001_core` … `0008_hold_documents` (`grep -c Applying` → `8 8 8 8 8`) — Environment and §db reset.
- Not quoted in the post: OOT (A)/(B)/(C) "all 6/6; 1 OOT season" — §4; schema test 13/13 families — §5; views `security_invoker` 4/4 and anon denied on `ingest` including the 0008 columns — §6, §11b; local Realtime 429 back-off on the reset #5 NCAAWB replay, fully recovered (`changes: 667, stale: 0, unpublished: { pending: 0, dead: 0 }`) — Findings 1; `aborted orphaned runs` WARN, "Expected orphan cleanup, no effect on any count" — Findings 6.
- Next milestone M3 "NCAAWB live (trial key, Nov)" — `docs/PLAN.md` §7 M3 row (line 217); "Trial key requested when live-validation tooling (M3) is ready" — `docs/PLAN.md` Phase 0 note.
- Baseline 36 invariants (and "9 more invariants" in hook 2, 45 − 36) is from `devlog/evidence/M2-superseded-7e94217.md` (`36/36 invariants hold`); the current file carries the `d3d194c` baselines (44 invariants, 106 integration tests, 13 identity-merge tests).
- Buffer: skipped, `DEVLOG_BUFFER` unset in this environment.
