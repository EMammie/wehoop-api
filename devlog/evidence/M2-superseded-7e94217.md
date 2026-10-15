> Superseded by M2.md at aa6aff6 (2026-10-15): corrective pass (plan rev 4.4) changed the identity-merge contract (provider-keyed `game_player_stats`, `ingest.player_merges` / `player_merge_holds`, migration 0007); evidence regenerated at the new HEAD.

# M2 — Three leagues + identity — validation evidence (at HEAD 7e94217)

Review verdict before this battery: APPROVED-WITH-SHOULDS after one blocker loop; `7e94217` is the final commit of the milestone.

## Environment

| Field | Value |
|---|---|
| Date | 2026-10-14 22:28–22:35 EDT (worker log timestamps are UTC, 02:29–02:35) |
| Commit | `7e94217c7121b7ed1072cae43d21e7bb401e3fe1` (`m2-three-leagues`); `git status --porcelain` empty at start and at the end (apart from this file) |
| `node --version` | v25.9.0 |
| `pnpm supabase --version` | 2.120.0 |
| Supabase stack | running (`pnpm supabase status` exit 0; output not pasted). `pnpm supabase db reset` run twice: `#1` before the replays, `#2` before the full `pnpm test:int`. Both applied `0001_core` … `0006_provider_keyed_stats` (captured under "db reset" below) |
| SQL access | no `psql` on the host; every `$PSQL` below is `docker exec -i supabase_db_wehoop-api psql -U postgres -d postgres -At -c "<sql>"` (wrapper script `psql.sh` in the scratchpad) |
| Env loading | `set -a; . ./.env; set +a` before every `pnpm dev:worker` / `dev:api` / `invariants` (loaded cleanly; no value printed) |
| External services | none beyond the local stack. No Sportradar call of any kind was made during this battery (all replays are from committed files); no key, no trial |
| Full log | `<scratchpad>/validator-M2.log` plus per-command logs `replay-*.log`, `int-item*.log`, `testint.log`, `check.log` |

### Fixture provenance (limits of this evidence)

| League | Replay file | Provenance |
|---|---|---|
| WNBA | `fixtures/wnba/sim-93ee7c68-replay.compact.jsonl.gz` | compact recording of a real Sportradar **simulation** session (`playback.sportradar.com`, no key), M1 fixture. `shasum -a 256` = `7be194ab80d0ca885a12d802702d046f73e8ab9c13763af13d5a4527c5b0481c` (unchanged since M1) |
| NCAAWB | `fixtures/ncaawb/sim-d9b71fe0-replay.compact.jsonl.gz` | recorded 2026-10-14 from simulation recording `d9b71fe0-0cbf-11f1-bf29-5913e6df42d2` (Northwestern at Michigan State), compacted with `pnpm sim compact`. `shasum -a 256 fixtures/ncaawb/sim-d9b71fe0-replay.compact.jsonl.gz` → `6a9872607adf1478a50c7b404fca066a000f9ec5bef8eb381159d5ab5469d8c0`; `fixtures/ncaawb/README.md` row "sim-d9b71fe0-replay.compact.jsonl.gz" states `sha256: 6a9872607adf1478a50c7b404fca066a000f9ec5bef8eb381159d5ab5469d8c0`. **Match.** |
| Unrivaled | `fixtures/unrivaled/docs-838316ea-replay.jsonl`, `docs-oot-replay.jsonl`, `identity-replay.jsonl.gz`, `fixtures/wnba/docs-identity-replay.jsonl` | **No Unrivaled simulation recording exists and no API key was used.** The game documents are hand-assembled from Sportradar's public docs samples (`fixtures/unrivaled/README.md`: `home` side from the sample, `away` block and the Elam target added by hand). `elam_target_score: 84` is **derived** (leading score after Q3 + 11 from the sample's own numbers) and the field name is **not confirmed by any real response**. The identity fixtures combine a captured 2026 league-leaders document (Wehoop iOS app, M0) with docs-sample ids for Aliyah Boston. The WNBA identity replay is the WNBA docs profile sample. Everything below about Unrivaled and about cross-league identity therefore proves the code path against those assembled shapes, not against provider data. |

Order actually run: `db reset #1` → WNBA replay → NCAAWB replay → Unrivaled replay → row-count / change-type / Elam / view queries → identity replays (WNBA, Unrivaled) → OOT replay → `dev:api` probes → identity / OOT / anon queries → `pnpm invariants` (pass 1) → unit schema test → `pnpm check` → item integration suites → `db reset #2` → full `pnpm test:int` → `pnpm invariants` (final).

Game ids this battery (db reset #1): WNBA `40bea3f6-68c0-4f3b-96fa-336dfb7a9034`, NCAAWB `2e36b340-9277-4b99-af20-b7ff7e86640e`, Unrivaled `838316ea-ab7b-4581-a1dd-74229d1970d5`.

---

## db reset (both runs apply 0005 and 0006)

Command:
`pnpm supabase db reset`
Output (reset #1, 22:29:08 EDT; reset #2 at 22:34:05 EDT printed the identical migration list):
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
Seeding data from supabase/seed.sql...
Restarting containers...
Finished supabase db reset on branch m2-three-leagues.
```
Command:
`$PSQL "select version, name from supabase_migrations.schema_migrations order by version"`
Output:
```
0001|core
0002|freshness_and_outbox_routing
0003|corrective_pass
0004|stats_observed_at
0005|three_leagues_identity
0006|provider_keyed_stats
```
`$PSQL "select count(*) from public.games"` → `0` (clean before the replays).
Result: PASS

---

## 1. "per-league fixture replay row counts"

### Replays (all `exit=0`, `stale: 0`, `pending: 0`, `dead: 0`)

Command:
`pnpm dev:worker --mode sim --league wnba --replay-file fixtures/wnba/sim-93ee7c68-replay.compact.jsonl.gz --pace 0 --until closed`
Output (22:29:57–22:30:01 EDT, `WORKER_PID=2529`, tail):
```
    finalStatus: "closed"
    changes: 1233
    stale: 0
    unpublished: { "pending": 0, "dead": 0, "nextAttemptAt": null }
    stoppedBy: null
```
Command:
`pnpm dev:worker --mode sim --league ncaawb --replay-file fixtures/ncaawb/sim-d9b71fe0-replay.compact.jsonl.gz --pace 0 --until closed`
Output (22:30:07–22:30:09 EDT, `WORKER_PID=2582`, tail):
```
    gameId: "ba06483d-8785-406f-a2a7-b9061e8f2083"
    finalStatus: "closed"
    docs: 138
    batches: 138
    changes: 667
    stale: 0
    unpublished: { "pending": 0, "dead": 0, "nextAttemptAt": null }
    stoppedBy: null
```
Command:
`grep -c "429" replay-ncaawb.log; grep -c "blocked head" replay-ncaawb.log; grep -ci "warn" replay-ncaawb.log`
Output:
```
0
0
0
```
(The implementer reported many `429` / `blocked head` outbox warnings from local Realtime on their NCAAWB run. **This run produced none**: 3218 log lines, zero warnings, zero unpublished rows. Either way that is M1 publisher behaviour; the outbox parity invariant is shown below.)

Command:
`pnpm dev:worker --mode sim --league unrivaled --replay-file fixtures/unrivaled/docs-838316ea-replay.jsonl --pace 0 --until closed`
Output (22:30:15–22:30:16 EDT, `WORKER_PID=2636`, tail):
```
    gameId: "f4948f4c-278b-4a64-a48b-d0c5fe4aa7af"
    finalStatus: "closed"
    docs: 8
    batches: 5
    changes: 12
    stale: 0
    unpublished: { "pending": 0, "dead": 0, "nextAttemptAt": null }
    stoppedBy: null
```

### Row counts per league

Command:
`$PSQL "select g.league, g.provider_game_id, g.status, g.away_points||'-'||g.home_points, (select count(*) from public.play_events p where p.game_id=g.id and p.deleted_at is null) events, (select count(*) from public.game_changes c where c.game_id=g.id) changes, (select count(*) from public.game_periods p where p.game_id=g.id) periods, (select count(*) from public.game_player_stats p where p.game_id=g.id) player_lines, g.last_seq from public.games g order by 1"`
Output (columns: league | provider_game_id | status | away-home | events | changes | periods | player_lines | last_seq):
```
wnba|40bea3f6-68c0-4f3b-96fa-336dfb7a9034|closed|85-93|408|1233|4|26|1233
ncaawb|2e36b340-9277-4b99-af20-b7ff7e86640e|closed|68-104|306|667|4|31|667
unrivaled|838316ea-ab7b-4581-a1dd-74229d1970d5|closed|84-80|4|12|2|1|12
unrivaled|3c58e5c2-6d7c-4797-9a43-9f3fffc536f7|scheduled|0-0|0|0|0|0|0
unrivaled|5a8f4590-601c-4ed0-88f6-df78201e0a22|scheduled|0-0|0|0|0|0|0
```
Compared with the implementer's handoff: WNBA closed home 93 – away 85, `last_seq` 1233 (match); NCAAWB closed home 104 – away 68, `last_seq` 667 (match; equals the recording's boxscore per the NCAAWB README: Northwestern 68 at Michigan State 104, 306 events); Unrivaled closed home 80 – away 84, `last_seq` 12 (match). The two `scheduled` Unrivaled rows come from the schedule docs sample inside the same replay file (README: three games, one closed).

Command:
`$PSQL "select change_type, count(*) from public.game_changes group by 1 order by 1"`
Output:
```
event_insert|720
event_update|112
event_delete|2
status|92
period|79
stats_team|122
stats_player|785
```
Implementer expected: event_insert 720, event_update 112, event_delete 2, status 92, period 79, stats_team 122, stats_player 785 → **all seven match**. Sum 1912 = 1233 + 667 + 12.

Command (per-league split, additional):
`$PSQL "select g.league, c.change_type, count(*) from public.game_changes c join public.games g on g.id=c.game_id group by 1,2 order by 1,2"`
Output:
```
wnba|event_insert|410
wnba|event_update|101
wnba|event_delete|2
wnba|status|48
wnba|period|44
wnba|stats_team|70
wnba|stats_player|558
ncaawb|event_insert|306
ncaawb|event_update|11
ncaawb|status|41
ncaawb|period|32
ncaawb|stats_team|51
ncaawb|stats_player|226
unrivaled|event_insert|4
unrivaled|status|3
unrivaled|period|3
unrivaled|stats_team|1
unrivaled|stats_player|1
```

Command (stats bodies carry no canonical uuid keys):
`$PSQL "select count(*) from game_changes where change_type in ('stats_player','stats_team') and (body ? 'playerId' or body ? 'teamId')"`
Output:
```
0
```

Command:
`$PSQL "select reason, count(*) from ingest.stale_observations group by 1"`
Output:
```
(no rows)
```

Command (outbox parity after the three replays):
`$PSQL "select (select count(*) from public.game_changes) changes, (select count(*) from ingest.broadcast_outbox) outbox, (select count(*) from ingest.broadcast_outbox where published_at is null) unpublished"`
Output:
```
1912|1912|0
```

### Replay integration suites (each includes a no-regression re-run)

Command:
`VITEST_INTEGRATION=1 pnpm vitest run test/integration/replay-fixture.test.ts test/integration/ncaawb-replay-fixture.test.ts test/integration/unrivaled-elam.test.ts --reporter=verbose`
Output:
```
 ✓ replay-fixture.test.ts > committed replay fixture through the worker path > consumes every document, including the summary and boxscore after the first closed pbp
 ✓ replay-fixture.test.ts > committed replay fixture through the worker path > final game_team_stats equal the last summary document's statistics
 ✓ replay-fixture.test.ts > committed replay fixture through the worker path > no regression: re-running the fixture as a new run writes 0 new changes (stats included), score unchanged, stale rows logged
 ✓ replay-fixture.test.ts > committed replay fixture through the worker path > an official correction on the closed game (later observedAt, differing stats) is exactly one stats_team change
 ✓ ncaawb-replay-fixture.test.ts > NCAAWB committed replay fixture through the worker path > consumes every document, closes the game, and the final score matches the recording boxscore
 ✓ ncaawb-replay-fixture.test.ts > NCAAWB committed replay fixture through the worker path > no regression: re-running the fixture as a new run writes 0 new changes (stats included), score unchanged, stale rows logged
 ✓ unrivaled-elam.test.ts > Unrivaled Elam game through the worker path > games: closed 80-84, period 4 of type elam, elam_target_score 84, clock null, clock_running false, Elam clock fields in clock_extra
 ✓ unrivaled-elam.test.ts > Unrivaled Elam game through the worker path > game_periods carries the elam row with its score
 ✓ unrivaled-elam.test.ts > Unrivaled Elam game through the worker path > status changes carry elamTargetScore from the Elam period on; event rows carry canonical player ids; stats_player is provider-keyed and its row resolves to the canonical player
 ✓ unrivaled-elam.test.ts > Unrivaled Elam game through the worker path > pulse: clock null, clockRunning false, status closed
 ✓ unrivaled-elam.test.ts > Unrivaled Elam game through the worker path > snapshot carries elamTargetScore and playerStats; folding /changes reproduces it
 ✓ unrivaled-elam.test.ts > Unrivaled Elam game through the worker path > replaying the same file as a new generation writes 0 new changes
 Test Files  3 passed (3)
      Tests  12 passed (12)
```
Result: PASS

---

## 2. "one Unrivaled profile links WNBA + NCAAW ids and `/v1/players/:id` returns all three"

Command:
`pnpm dev:worker --mode sim --league wnba --replay-file fixtures/wnba/docs-identity-replay.jsonl --pace 0`
Output (22:31:10 EDT, exit 0; profile lines):
```
    feed: "player_profile"
    players: 1
    merged: 0
```
Command:
`pnpm dev:worker --mode sim --league unrivaled --replay-file fixtures/unrivaled/identity-replay.jsonl.gz --pace 0`
Output (22:31:11 EDT, exit 0):
```
    feed: "league_leaders"
    players: 45
    merged: 0
[02:31:11.927] INFO: players merged
    feed: "player_profile"
    players: 1
    merged: 1
```

API started with `pnpm dev:api` in the background (wrapper pid 2986; `/health` → `{"ok":true,"mode":"sim","db":"ok",...}`); killed after the probes (`pgrep -fl "src/bin/(api|worker)"` → none at the end).

Command:
`curl -s localhost:3000/v1/players/unrivaled:54b8a881-27f7-4735-b499-0c3adf0286b0 | jq '{id: .player.id, leagues: ([.externalIds[].league] | unique), seasons: [.seasons[] | .league+" "+(.seasonYear|tostring)+" "+.seasonType], merged: .mergedIds}'`
Output:
```
{
  "id": "fd1861e9-3764-4281-b342-9558b9c68366",
  "leagues": ["ncaawb", "unrivaled", "wnba"],
  "seasons": ["unrivaled 2026 REG", "wnba 2024 PRE", "wnba 2024 REG", "wnba 2023 PRE", "wnba 2023 REG"],
  "merged": ["76d77567-d54b-42a9-bd5b-e0d574002591"]
}
```
(3 leagues, 5 seasons, 1 merged id, as the handoff states.)

Command:
`curl -s localhost:3000/v1/players/wnba:63dde7d8-0af8-4adb-a556-01e0d2395420 | jq -c '{id: .player.id, name: .player.fullName, leagues: ([.externalIds[].league]|unique)}'`
Output:
```
{"id":"fd1861e9-3764-4281-b342-9558b9c68366","name":"Aliyah Boston","leagues":["ncaawb","unrivaled","wnba"]}
```
Command:
`curl -s localhost:3000/v1/players/ncaawb:d8f2f455-ee4e-4061-8d1d-bd04131bd9a4 | jq -c '{id: .player.id, name: .player.fullName, leagues: ([.externalIds[].league]|unique)}'`
Output:
```
{"id":"fd1861e9-3764-4281-b342-9558b9c68366","name":"Aliyah Boston","leagues":["ncaawb","unrivaled","wnba"]}
```
Command:
`curl -s localhost:3000/v1/players/fd1861e9-3764-4281-b342-9558b9c68366 | jq -c '{id: .player.id, name: .player.fullName, leagues: ([.externalIds[].league]|unique), externalIdCount: (.externalIds|length)}'`
Output:
```
{"id":"fd1861e9-3764-4281-b342-9558b9c68366","name":"Aliyah Boston","leagues":["ncaawb","unrivaled","wnba"],"externalIdCount":6}
```
Command (the merged-away uuid still resolves to the survivor):
`curl -s -o /dev/null -w "http %{http_code}\n" localhost:3000/v1/players/76d77567-d54b-42a9-bd5b-e0d574002591; curl -s localhost:3000/v1/players/76d77567-d54b-42a9-bd5b-e0d574002591 | jq -c '{id: .player.id}'`
Output:
```
http 200
{"id":"fd1861e9-3764-4281-b342-9558b9c68366"}
```
Same `id` by all four routes (unrivaled id, wnba id, ncaawb id, canonical uuid) plus the merged id.

Command:
`$PSQL "select e.league, e.external_id, e.id_type, e.source from public.player_external_ids e join public.players p on p.id=e.player_id where p.full_name='Aliyah Boston' and p.merged_into is null order by 1,3"`
Output:
```
wnba|1642286|external|reference
wnba|63dde7d8-0af8-4adb-a556-01e0d2395420|league_profile|profile
wnba|ea798cfb-8765-4246-a428-3d451c9a935d|sport_profile|reference
ncaawb|d8f2f455-ee4e-4061-8d1d-bd04131bd9a4|league_profile|reference
unrivaled|54b8a881-27f7-4735-b499-0c3adf0286b0|league_profile|profile
unrivaled|ea798cfb-8765-4246-a428-3d451c9a935d|sport_profile|reference
```
6 rows across 3 leagues.

Command:
`$PSQL "select id, merged_into, (select count(*) from public.player_external_ids e where e.player_id=p.id) ext_ids, (select count(*) from public.player_season_stats s where s.player_id=p.id) season_lines from public.players p where full_name='Aliyah Boston' order by merged_into nulls first"`
Output:
```
fd1861e9-3764-4281-b342-9558b9c68366||6|5
76d77567-d54b-42a9-bd5b-e0d574002591|fd1861e9-3764-4281-b342-9558b9c68366|0|0
```
(one canonical row owning all 6 ids and 5 season lines; one tombstone owning nothing.)

Command:
`VITEST_INTEGRATION=1 pnpm vitest run test/integration/identity.test.ts test/integration/identity-merge.test.ts --reporter=verbose`
Output:
```
 ✓ identity-merge.test.ts > identity merge against game state > a merge repoints the loser's play_events and game_player_stats to the survivor; the identical summary is then a no-op and fold == snapshot
 ✓ identity-merge.test.ts > identity merge against game state > a merge whose loser already has a line in a game the survivor also has one in drops the loser's row and reports it; the next summary skips the duplicate line
 ✓ identity-merge.test.ts > identity merge against game state > a second merge flattens earlier tombstones onto the new survivor (chains stay depth 1)
 ✓ identity-merge.test.ts > identity merge against game state > ensureSeason: the same (league, year, type) under another provider id is a clash and is not linked
 ✓ identity.test.ts > identity: canonical players and cross-league external ids > ensurePlayers creates a row per new provider id with source=game and is idempotent
 ✓ identity.test.ts > identity: canonical players and cross-league external ids > WNBA profile then Unrivaled profile: one canonical player with ids in three leagues and season lines from two
 ✓ identity.test.ts > identity: canonical players and cross-league external ids > is deterministic: the opposite arrival order yields the same linkage, with the older row surviving
 ✓ identity.test.ts > identity: canonical players and cross-league external ids > the first profile for a player already known from another league adopts that row: no junk row, no merge
 ✓ identity.test.ts > identity: canonical players and cross-league external ids > two game-sourced rows in two leagues are merged by the first profile that references both; the older row survives
 ✓ identity.test.ts > GET /v1/players/:id > returns the canonical player with all three league ids and per-league season lines, by uuid or by league:providerId, and resolves a merged id
 Test Files  2 passed (2)
      Tests  10 passed (10)
```
Result: PASS (against hand-assembled identity fixtures; see provenance)

---

## 3. "Elam period row + target"

Captured right after the Unrivaled replay of item 1 (same game row).

Command:
`$PSQL "select g.status, g.period_type, g.elam_target_score, g.clock, g.clock_running, g.clock_extra, p.sequence, p.type, p.home_points, p.away_points from public.games g join public.game_periods p on p.game_id=g.id where g.provider_game_id='838316ea-ab7b-4581-a1dd-74229d1970d5' order by p.sequence"`
Output (columns: status | period_type | elam_target_score | clock | clock_running | clock_extra | sequence | type | home | away):
```
closed|elam|84||f|{"clockType": "elam", "clockDirectional": "+00:19"}|1|quarter|20|19
closed|elam|84||f|{"clockType": "elam", "clockDirectional": "+00:19"}|4|elam|7|17
```
`elam` period row (sequence 4, 7–17), target 84, `clock` null, `clock_running` false, `clock_extra` populated. Period rows 2 and 3 are absent by fixture design (README: the away split for Q2/Q3 is in no sample, so nothing was invented).

Command:
`$PSQL "select seq, body->>'elamTargetScore', body->>'status' from public.game_changes c join public.games g on g.id=c.game_id where g.provider_game_id='838316ea-ab7b-4581-a1dd-74229d1970d5' and change_type='status' order by seq"`
Output:
```
2||inprogress
7|84|inprogress
9|84|closed
```
(no target during Q1; target 84 from the Elam document on.)

Command:
`$PSQL "select seq, body::text from public.game_changes c join public.games g on g.id=c.game_id where g.provider_game_id='838316ea-ab7b-4581-a1dd-74229d1970d5' and change_type='period' order by seq"`
Output:
```
3|{"periods": [{"type": "quarter", "score": {"away": 0, "home": 2}, "number": 1, "sequence": 1}]}
8|{"periods": [{"type": "quarter", "score": {"away": 19, "home": 20}, "number": 1, "sequence": 1}, {"type": "elam", "score": {"away": 0, "home": 2}, "number": 4, "sequence": 4}]}
10|{"periods": [{"type": "quarter", "score": {"away": 19, "home": 20}, "number": 1, "sequence": 1}, {"type": "elam", "score": {"away": 17, "home": 7}, "number": 4, "sequence": 4}]}
```

Command:
`VITEST_INTEGRATION=1 pnpm vitest run test/integration/unrivaled-elam.test.ts`
Output: the six `unrivaled-elam.test.ts` lines quoted in item 1 (`6 passed`), including "games: closed 80-84, period 4 of type elam, elam_target_score 84, clock null, clock_running false, Elam clock fields in clock_extra" and "replaying the same file as a new generation writes 0 new changes".

Invariant `elam_games_have_a_target` → `0 / 0 PASS` (both invariant runs below).

**Limitation stated plainly:** the value 84 and the field name `elam_target_score` are derived from the docs sample (leading score after Q3 + 11) and hand-inserted into the fixture; no provider response confirms either. This evidence shows the pipeline carries an Elam target end-to-end, not that Sportradar emits it under that name.

Result: PASS (derived target; unconfirmed by provider)

---

## 4. "OOT game attached to tournament"

Command:
`pnpm dev:worker --mode sim --league unrivaled --replay-file fixtures/unrivaled/docs-oot-replay.jsonl --pace 0`
Output (22:31:11 EDT, exit 0):
```
[02:31:12.257] INFO: reference document applied
    feed: "tournament_list"
    tournaments: 1
[02:31:12.274] INFO: reference document applied
    feed: "tournament_schedule"
    tournaments: 1
    docs: 2
    referenceDocs: 2
```
Command:
`$PSQL "select g.provider_game_id, g.status, g.title, t.name, s.type, s.year from public.games g join public.tournaments t on t.id=g.tournament_id join public.seasons s on s.id=g.season_id"`
Output:
```
06dbbc3b-b5e2-444c-b70b-06465e267135|closed|First Round - Pod B - Game 1|2025 Unrivaled 1 on 1 Tournament|OOT|2025
506e7bd0-ec4e-49aa-b55c-bddd8ed41003|cancelled|First Round - Pod C - Game 2|2025 Unrivaled 1 on 1 Tournament|OOT|2025
```
Command:
`$PSQL "select provider_tournament_id, league, name, (select count(*) from public.games g where g.tournament_id=t.id) games from public.tournaments t"`
Output:
```
28d4af13-bfa1-4c95-9f1b-30af6fd5b7ee|unrivaled|2025 Unrivaled 1 on 1 Tournament|2
```
Command:
`$PSQL "select count(*) from public.games g join public.seasons s on s.id=g.season_id where s.type='OOT' and g.tournament_id is null"`
Output:
```
0
```
Invariant `oot_games_belong_to_a_tournament` → `0 / 0 PASS` (both runs below).

Command (first attempt, on the DB that already held the worker-path OOT rows above):
`VITEST_INTEGRATION=1 pnpm vitest run test/integration/reference.test.ts --reporter=verbose`
Output:
```
 ✓ reference.test.ts > ReferenceIngester > season schedule: games, teams and the season are created; a closed schedule entry sets status but never score
 ✓ reference.test.ts > ReferenceIngester > a lagging schedule entry during a live game writes nothing game-level and is logged superseded_observation
 × reference.test.ts > ReferenceIngester > tournament list + tournament schedule: OOT games attach to their tournament and OOT season
 ✓ reference.test.ts > ReferenceIngester > standings and hierarchy: standings rows per team with conference, hierarchy fills colors and venue; both idempotent
 ✓ reference.test.ts > ReferenceIngester > seasonal statistics and league leaders write season lines once; re-applying writes none
AssertionError: expected [] to deeply equal [ { …(7) }, { …(7) } ]
 ❯ test/integration/reference.test.ts:165:18
 Test Files  1 failed (1)
      Tests  1 failed | 4 passed (5)
```
Diagnosis (recorded, not interpreted from logs):
`$PSQL "select provider_game_id, status, season_id is not null as has_season, tournament_id is not null as has_tournament from public.games where provider_game_id like '506e7bd0-ec4e-49aa-b55c-bddd8ed41003-%' or provider_game_id like '06dbbc3b-b5e2-444c-b70b-06465e267135-%' order by 1"`
```
06dbbc3b-b5e2-444c-b70b-06465e267135-2e1bcbbc-9e26-44e0-963c-a03c58aa8204|closed|f|t
506e7bd0-ec4e-49aa-b55c-bddd8ed41003-2e1bcbbc-9e26-44e0-963c-a03c58aa8204|cancelled|f|t
```
`$PSQL "select provider_season_id, league, year, type from public.seasons where league='unrivaled' and year=2025 order by type, provider_season_id"`
```
c86ab7c9-5408-44e6-af06-c22636262927|unrivaled|2025|REG
04cb26c7-b1d2-4e19-8fe4-c0a30814aa5c|unrivaled|2025|OOT
```
The test suffixes every id including the season id `04cb26c7…`; because the worker replay had already created (unrivaled, 2025, OOT) under the real provider id, the suffixed season id is a provider-id clash and `ensureSeason` deliberately leaves `season_id` unset (`src/ingest/identity.ts:124-158`, metric `season_provider_id_clash`; this is the behaviour `identity-merge.test.ts` "ensureSeason: … clash and is not linked" asserts). The games were attached to their (suffixed) tournament; only the season join failed. **This is a test-isolation dependency on a DB with no pre-existing 2025 OOT season, not a product defect**; it is listed under Findings.

Command (same suite on a fresh DB, as part of the full run after `db reset #2`):
`pnpm test:int --reporter=verbose` (filtered to `reference.test.ts`)
Output:
```
 ✓ reference.test.ts > ReferenceIngester > season schedule: games, teams and the season are created; a closed schedule entry sets status but never score
 ✓ reference.test.ts > ReferenceIngester > a lagging schedule entry during a live game writes nothing game-level and is logged superseded_observation
 ✓ reference.test.ts > ReferenceIngester > tournament list + tournament schedule: OOT games attach to their tournament and OOT season
 ✓ reference.test.ts > ReferenceIngester > standings and hierarchy: standings rows per team with conference, hierarchy fills colors and venue; both idempotent
 ✓ reference.test.ts > ReferenceIngester > seasonal statistics and league leaders write season lines once; re-applying writes none
```
Result: PASS (worker path + SQL + invariant + test on a clean DB; test order-dependency noted in Findings)

---

## 5. "schema test rejects mutated fixture"

Command:
`pnpm test test/unit/providers/reference-schemas.test.ts`
Output:
```
 Test Files  1 passed (1)
      Tests  13 passed (13)
```
Command (names):
`pnpm vitest run test/unit/providers/reference-schemas.test.ts --reporter=verbose`
Output:
```
 ✓ … > Unrivaled pbp (Elam period, docs sample + away): parses the committed fixture, rejects a mutated and a dropped persisted field
 ✓ … > NCAAWB pbp (docs-free: recorded simulation): parses the committed fixture, rejects a mutated and a dropped persisted field
 ✓ … > Unrivaled summary (player statistics, period stats): parses the committed fixture, rejects a mutated and a dropped persisted field
 ✓ … > Unrivaled boxscore (elam scoring): parses the committed fixture, rejects a mutated and a dropped persisted field
 ✓ … > Unrivaled player profile (references[], seasons[]): parses the committed fixture, rejects a mutated and a dropped persisted field
 ✓ … > WNBA player profile (external + sport_profile + NCAAW references): parses the committed fixture, rejects a mutated and a dropped persisted field
 ✓ … > Unrivaled tournament schedule (OOT, bracketed rounds): parses the committed fixture, rejects a mutated and a dropped persisted field
 ✓ … > Unrivaled tournament list: parses the committed fixture, rejects a mutated and a dropped persisted field
 ✓ … > NCAAWB schedule (coverage boxscore): parses the committed fixture, rejects a mutated and a dropped persisted field
 ✓ … > WNBA standings: parses the committed fixture, rejects a mutated and a dropped persisted field
 ✓ … > NCAAWB hierarchy (divisions > conferences): parses the committed fixture, rejects a mutated and a dropped persisted field
 ✓ … > Unrivaled seasonal statistics: parses the committed fixture, rejects a mutated and a dropped persisted field
 ✓ … > Unrivaled league leaders (captured): parses the committed fixture, rejects a mutated and a dropped persisted field
 Test Files  1 passed (1)
      Tests  13 passed (13)
```
(`…` = `test/unit/providers/reference-schemas.test.ts > reference and game schemas against committed fixtures`.) 13 schema families. The test body (`reference-schemas.test.ts:195-207`) asserts, per family: `safeParse(fixture).success === true`; the undeclared field named by `c.keep` is still present after parse; `safeParse(mutated).success === false`; `safeParse(dropped).success === false`.
Result: PASS

---

## 6. "views verified `security_invoker`"

Command:
`$PSQL "select c.relname, (select option_value from pg_options_to_table(c.reloptions) where option_name='security_invoker') from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='v' order by 1"`
Output:
```
v_boxscore|true
v_player_seasons|true
v_schedule|true
v_standings|true
```
Command:
`$PSQL "select table_name, column_name from information_schema.columns where table_schema='public' and table_name like 'v\_%' and column_name='watch_run_id'"`
Output:
```
(no rows)
```
`$PSQL "select count(*) from information_schema.columns where table_schema='public' and table_name like 'v\_%' and column_name='watch_run_id'"` → `0`.

Command (anon probe: `ingest` unreadable, same shape as M0):
`$PSQL "set role anon; select count(*) from ingest.broadcast_outbox;"` / `… ingest.stale_observations` / `… ingest.ingestion_runs`
Output:
```
ERROR:  permission denied for schema ingest
ERROR:  permission denied for schema ingest
ERROR:  permission denied for schema ingest
```
Command:
`$PSQL "select has_schema_privilege('anon','ingest','usage') anon_usage_ingest, has_schema_privilege('authenticated','ingest','usage') auth_usage_ingest"`
Output:
```
f|f
```
Command (anon can read every client view, on the replay-populated DB):
`$PSQL "set role anon; select 'v_schedule', count(*) from public.v_schedule union all select 'v_boxscore', count(*) from public.v_boxscore union all select 'v_standings', count(*) from public.v_standings union all select 'v_player_seasons', count(*) from public.v_player_seasons;"`
Output:
```
v_schedule|7
v_boxscore|58
v_standings|0
v_player_seasons|50
```
Command (anon cannot write through a view):
`$PSQL "set role anon; insert into public.v_schedule default values;"`
Output:
```
ERROR:  cannot insert into view "v_schedule"
```
Invariants `client_views_use_security_invoker` 4/4, `views_do_not_expose_watch_run_id` 0/0, `anon_can_select_every_client_view` 4/4, `anon_has_no_usage_on_ingest_schema` 0/0, `anon_cannot_select_ingest_tables` 0/0 → PASS in both runs below.

Command:
`VITEST_INTEGRATION=1 pnpm vitest run test/integration/views.test.ts --reporter=verbose`
Output:
```
 ✓ views.test.ts > client views > all four views exist with security_invoker = true
 ✓ views.test.ts > client views > no view in public or ingest lacks security_invoker
 ✓ views.test.ts > client views > v_schedule does not expose watch_run_id (nor any other view)
 ✓ views.test.ts > client views > anon can select from every view and still cannot touch ingest
 ✓ views.test.ts > client views > anon has no write privilege on any view
 ✓ views.test.ts > client views > authenticated can select from every view and still cannot touch ingest
 ✓ views.test.ts > client views > authenticated has no write privilege on any view
 ✓ views.test.ts > client views > v_schedule labels non-full coverage as "score only"
 Test Files  1 passed (1)
      Tests  8 passed (8)
```
Result: PASS

---

## `pnpm check`

Command:
`pnpm check`
Output (22:32:27 EDT):
```
$ biome ci . && tsc --noEmit && vitest run
Checked 100 files in 51ms. No fixes applied.
 RUN  v5.0.3 /Users/emammie/Projects/wehoop-api
FAULT_FIRED=before_commit:10
 Test Files  18 passed (18)
      Tests  130 passed (130)
```
(`tsc --noEmit` printed nothing; the `&&` chain reached vitest.)
Result: PASS

## Full `pnpm test:int` (fresh DB, after `db reset #2`)

Command:
`pnpm test:int --reporter=verbose`
Output (22:34:32 EDT, exit 0):
```
 Test Files  14 passed (14)
      Tests  97 passed (97)
   Duration  22.04s (tests 95%, import 4%, transform 1%)
```
Per file (passing tests): api 5, apply-changes 19, coverage 1, identity-merge 4, identity 6, ncaawb-replay-fixture 2, outbox 8, provider-calls 3, realtime-auth 2, reference 5, replay-fixture 4, schema 24, unrivaled-elam 6, views 8 = 97. Matches the expected 14 files / 97 tests.
Result: PASS

---

## `pnpm invariants`

Run twice. Pass 1 at 22:32:02 EDT on the DB holding the three replays + identity + OOT rows (before any integration test): `36/36 invariants hold`, identical table to the one below. Final pass at 22:35:07 EDT after the full `pnpm test:int` on the fresh DB:

Command:
`pnpm invariants`
Output:
```
check                                            expect  actual  result
play_events_no_duplicate_provider_ids            0       0       PASS
game_changes_no_gaps_in_retained_history         0       0       PASS
games_last_seq_matches_max_change                0       0       PASS
outbox_matches_changes_exactly                   0       0       PASS
outbox_no_dead_letters                           0       0       PASS
outbox_no_duplicate_game_seq                     0       0       PASS
outbox_channel_is_generated                      1       1       PASS
outbox_has_composite_routing_fk                  1       1       PASS
games_has_no_progress_key                        0       0       PASS
generation_fks_restrict_delete                   2       2       PASS
outbox_has_single_fk                             1       1       PASS
anon_cannot_select_ingest_tables                 0       0       PASS
anon_has_no_write_grants_on_public               0       0       PASS
public_tables_all_have_rls                       0       0       PASS
retained_head_exists                             0       0       PASS
anon_has_no_maintain_privilege_on_public         0       0       PASS
anon_has_no_usage_on_ingest_schema               0       0       PASS
public_schema_has_no_client_write_policies       0       0       PASS
realtime_has_no_client_insert_policy             0       0       PASS
game_changes_has_append_only_trigger             1       1       PASS
views_use_security_invoker                       0       0       PASS
event_changes_reference_their_play_row           0       0       PASS
outbox_published_rows_have_no_error              0       0       PASS
deleted_revision_only_on_deleted_events          0       0       PASS
stats_observed_at_set                            0       0       PASS
client_views_use_security_invoker                4       4       PASS
views_do_not_expose_watch_run_id                 0       0       PASS
anon_can_select_every_client_view                4       4       PASS
external_ids_point_at_canonical_players          0       0       PASS
merged_players_point_at_canonical_survivors      0       0       PASS
tombstoned_players_own_nothing                   0       0       PASS
player_stats_observed_at_set                     0       0       PASS
elam_games_have_a_target                         0       0       PASS
oot_games_belong_to_a_tournament                 0       0       PASS
stats_bodies_carry_no_canonical_uuid             0       0       PASS
player_stats_provider_id_resolves_to_row_player  0       0       PASS

36/36 invariants hold
```
Result: PASS (36 checks, as expected)

---

## Findings (not acceptance failures)

1. **`reference.test.ts` "tournament list + tournament schedule" is order-dependent.** It fails when the DB already holds a (unrivaled, 2025, OOT) season under a provider id other than the test's suffixed one (as after the worker OOT replay), because the suffixed season id is a deliberate `ensureSeason` clash and the games are written without `season_id`. It passes on a fresh DB (full `pnpm test:int`). Suggested fix for the implementer: suffix the season `year` too, or assert against the tournament join only, or run the test in its own season. The product behaviour it collided with is the intended one.
2. The implementer's report of `429` / `blocked head` outbox warnings on the NCAAWB replay did not reproduce here (0 occurrences, 0 unpublished). No action; recorded for the devlog so the number is not quoted as a fact of this build.
3. All Unrivaled evidence rests on hand-assembled fixtures (see provenance). The first real Unrivaled document will need a `pnpm sim record`-style capture to confirm the Elam target field and the `away` block shape.

## Cleanup

`pgrep -fl "src/bin/(api|worker)"` → none. `git status --porcelain` → empty before this file was written; after: only `?? devlog/evidence/M2.md`. HEAD still `7e94217c7121b7ed1072cae43d21e7bb401e3fe1`.

## Summary

| Item | Result |
|---|---|
| db reset applies 0001–0006 cleanly (×2) | PASS |
| 1. per-league fixture replay row counts | PASS |
| 2. one Unrivaled profile links WNBA + NCAAW ids; `/v1/players/:id` returns all three | PASS |
| 3. Elam period row + target | PASS (target derived from docs sample, provider-unconfirmed) |
| 4. OOT game attached to tournament | PASS (test order-dependency noted in Findings) |
| 5. schema test rejects mutated fixture | PASS (13/13 families) |
| 6. views verified `security_invoker` | PASS |
| `pnpm check` | PASS (biome 100 files, tsc, 18 files / 130 unit tests) |
| `pnpm test:int` (fresh DB) | PASS (14 files / 97 tests) |
| `pnpm invariants` (final) | PASS (36/36) |

**M2: DONE** — every acceptance item PASS, no NOT RUN.
