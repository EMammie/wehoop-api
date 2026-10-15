# One player, three leagues, one id

**Milestone:** M2 · **Date:** 2026-10-14 · **Commit:** 7e94217

## Post draft (long form, ~200–300 words)

Aliyah Boston has three different Sportradar ids: one in the WNBA feed, one in NCAA women's, one in Unrivaled. As of this week, `/v1/players/` answers all three with the same uuid.

wehoop-api is the backend for Wehoop, a women's basketball stats app; Sportradar is the data provider. M2 adds the NCAA women's and Unrivaled adapters next to WNBA, the reference feeds (schedules, standings, profiles, season stats, tournaments), a player identity table linking one person across leagues, read-only client views, and `/v1/players/:id`.

Three games replayed into one database: WNBA `changes: 1233`, final 85–93; NCAAWB (Northwestern at Michigan State) `changes: 667`, 68–104; Unrivaled `changes: 12`, 84–80 with an `elam` period row and target 84. Outbox parity `1912|1912|0`.

Then identity: a WNBA profile, an Unrivaled league-leaders document, an Unrivaled profile. The worker logged `players: 1  merged: 1`. Curl by Unrivaled id, WNBA id, NCAAWB id, canonical uuid, or the merged-away uuid: same `"id":"fd1861e9-…"` every time, 6 external ids, 5 season lines, one tombstone owning nothing. Arrival order does not matter; the older row survives:

```ts
  const rows = await tx<{ id: string; createdAt: Date }[]>`
    select id, created_at as "createdAt" from public.players where id in (${a}, ${b}) and merged_into is null
    order by created_at, id`;
  if (rows.length !== 2) throw new Error(`mergePlayers: ${a} / ${b} are not two canonical rows`);
  const survivor = rows[0]?.id;
  const loser = rows[1]?.id;
```

Limits, plainly. The WNBA and NCAAWB replays are Sportradar simulation recordings, not live data. Unrivaled has no simulation recording and we used no API key, so its game documents are hand-assembled from Sportradar's public docs samples; the target 84 is derived from the sample's own numbers and the field name is unconfirmed. The identity proof pairs a captured league-leaders document with docs-sample ids. This proves the code path, not provider data.

What broke: the first review found two blockers. The identity merge wrote play rows outside the single writer, and canonical uuids sat inside the player-stats hash, so a merge would have produced spurious change rows. Second loop: stats bodies carry provider ids only, migration 0006 to match, and the SQL check for leaked uuids returns `0`. One reference test is order-dependent after a worker OOT replay on the same DB (passes fresh); follow-up filed.

`36/36 invariants hold`, `97 passed (97)` integration. Next: M3, NCAAWB live on a trial key in November (not yet requested).

## Short version (≤ 280 chars)

wehoop-api M2: three leagues, one player id. WNBA + NCAAWB simulation replays (1233 + 667 changes), a hand-assembled Unrivaled Elam game (12). Aliyah Boston's WNBA, NCAAWB and Unrivaled ids resolve to one uuid: 6 external ids, 1 tombstone. 36/36 invariants. Not live data.

## Three alternative hooks

1. Five different ids for the same player (three provider ids, a canonical uuid, and a merged-away uuid) all return `fd1861e9-…` from `/v1/players/`. Whichever profile arrived first, the older row survives.
2. Unrivaled's Elam ending has no simulation recording and we have no key, so we built the game from Sportradar's docs samples. Target 84, derived, unconfirmed. Here is what that evidence proves and what it does not.
3. The first review found that merging two player rows would have rewritten the stats history: canonical uuids were inside the content hash. Now the hash holds provider ids only, and the SQL check for leaked uuids returns 0.

## Capture checklist

- [ ] Terminal recording: `pnpm supabase db reset`, then the three replays in order: `pnpm dev:worker --mode sim --league wnba --replay-file fixtures/wnba/sim-93ee7c68-replay.compact.jsonl.gz --pace 0 --until closed`, `pnpm dev:worker --mode sim --league ncaawb --replay-file fixtures/ncaawb/sim-d9b71fe0-replay.compact.jsonl.gz --pace 0 --until closed`, `pnpm dev:worker --mode sim --league unrivaled --replay-file fixtures/unrivaled/docs-838316ea-replay.jsonl --pace 0 --until closed`. Visible: the migration list ending `0006_provider_keyed_stats.sql`, then each tail with `finalStatus: "closed"`, `changes: 1233` / `changes: 667` / `changes: 12`, `stale: 0`, `"pending": 0, "dead": 0`.
- [ ] Terminal recording (identity, two panes): pane one `pnpm dev:api`. Pane two: `pnpm dev:worker --mode sim --league wnba --replay-file fixtures/wnba/docs-identity-replay.jsonl --pace 0`, then `pnpm dev:worker --mode sim --league unrivaled --replay-file fixtures/unrivaled/identity-replay.jsonl.gz --pace 0` (visible: `feed: "league_leaders"  players: 45`, then `INFO: players merged` and `feed: "player_profile"  players: 1  merged: 1`), then the five curls from evidence item 2 (`unrivaled:54b8a881-…`, `wnba:63dde7d8-…`, `ncaawb:d8f2f455-…`, `fd1861e9-…`, `76d77567-…`) each piped to `jq -c '{id: .player.id, name: .player.fullName, leagues: ([.externalIds[].league]|unique)}'`. Visible: the same `"id":"fd1861e9-3764-4281-b342-9558b9c68366"` five times, `"name":"Aliyah Boston"`, three leagues.
- [ ] Terminal recording: `pnpm invariants` ending in `36/36 invariants hold`, exit 0 (new rows include `external_ids_point_at_canonical_players`, `tombstoned_players_own_nothing`, `elam_games_have_a_target`, `oot_games_belong_to_a_tournament`, `stats_bodies_carry_no_canonical_uuid`).
- [ ] Screenshot: Supabase Studio (`http://127.0.0.1:54323`) on `player_external_ids` joined or filtered to Aliyah Boston's canonical id, showing 6 rows across `wnba`, `ncaawb`, `unrivaled`; and `players` showing the two rows, one with `merged_into` set.
- [ ] Screenshot: Studio on `games` for the Unrivaled game: `status closed`, `period_type elam`, `elam_target_score 84`, `clock` null, `clock_running false`, `clock_extra {"clockType": "elam", "clockDirectional": "+00:19"}`.
- [ ] Code snippet to show: `src/ingest/identity.ts:332-337` (the survivor rule in `mergePlayers`: older row wins, order by `created_at, id`). Alternative: `src/api/routes/players.ts:82-90` (`:id` accepted as a uuid or `<league>:<provider id>`).

## Evidence used

- Milestone scope and hook "One player, three leagues, one id" — `docs/PLAN.md` §7 M2 row. Two review blockers (merge writing play rows outside `apply-changes.ts`; canonical uuids in the stats hash) and their fixes — commits `b2e64cb` and `63d8825` on `m2-three-leagues`; evidence header "APPROVED-WITH-SHOULDS after one blocker loop".
- WNBA replay `changes: 1233`, `stale: 0`, `pending: 0`, `dead: 0`; row `wnba|…|closed|85-93|408|1233|4|26|1233` — `devlog/evidence/M2.md` §1 Replays and §1 Row counts per league.
- NCAAWB replay `docs: 138`, `changes: 667`; row `ncaawb|…|closed|68-104|306|667|4|31|667`; Northwestern at Michigan State, simulation recording `d9b71fe0…` — §1 Replays, §1 Row counts, §Environment › Fixture provenance.
- Unrivaled replay `docs: 8`, `changes: 12`; row `unrivaled|…|closed|84-80|4|12|2|1|12` — §1 Replays, §1 Row counts.
- Outbox parity `1912|1912|0`; change-type sum 1912 = 1233 + 667 + 12 — §1 "outbox parity after the three replays" and change-type table.
- Stats bodies carry no canonical uuid: `select count(*) from game_changes where change_type in ('stats_player','stats_team') and (body ? 'playerId' or body ? 'teamId')` → `0`; invariant `stats_bodies_carry_no_canonical_uuid 0/0 PASS` — §1 and §`pnpm invariants`. Migration `0006_provider_keyed_stats` applied — §db reset.
- Identity replays: WNBA `feed: "player_profile"  players: 1  merged: 0`; Unrivaled `feed: "league_leaders"  players: 45  merged: 0`, then `INFO: players merged`, `feed: "player_profile"  players: 1  merged: 1` — §2.
- `/v1/players/` by Unrivaled id → `"id": "fd1861e9-3764-4281-b342-9558b9c68366"`, `"leagues": ["ncaawb", "unrivaled", "wnba"]`, 5 seasons, `"merged": ["76d77567-…"]`; by WNBA id and by NCAAWB id → same id, `"name":"Aliyah Boston"`; by canonical uuid → `"externalIdCount":6`; by merged-away uuid → `http 200`, same id — §2 (five curl commands).
- `player_external_ids`: 6 rows across 3 leagues; `players`: canonical row `6|5` (ext ids, season lines), tombstone `0|0` — §2 SQL queries.
- Survivor is the older row, deterministic regardless of arrival order — §2 integration test line "is deterministic: the opposite arrival order yields the same linkage, with the older row surviving"; `src/ingest/identity.ts:332-337`.
- Elam: `closed|elam|84||f|{"clockType": "elam", "clockDirectional": "+00:19"}|4|elam|7|17`; status changes carry `elamTargetScore` 84 from seq 7 on; "the value 84 and the field name `elam_target_score` are derived from the docs sample (leading score after Q3 + 11) and hand-inserted into the fixture; no provider response confirms either" — §3 and §3 "Limitation stated plainly".
- Provenance: WNBA and NCAAWB fixtures are compact recordings of Sportradar simulation sessions (`playback.sportradar.com`, no key); "No Unrivaled simulation recording exists and no API key was used"; game documents "hand-assembled from Sportradar's public docs samples"; identity fixtures "combine a captured 2026 league-leaders document (Wehoop iOS app, M0) with docs-sample ids for Aliyah Boston"; "proves the code path against those assembled shapes, not against provider data"; "No Sportradar call of any kind was made during this battery" — §Environment › Fixture provenance and External services.
- Order-dependent test: `reference.test.ts` "tournament list + tournament schedule" fails on a DB that already holds the worker-path OOT rows (`1 failed | 4 passed (5)`), passes on a fresh DB; "test-isolation dependency ... not a product defect" — §4 and §Findings item 1.
- Realtime 429 warnings not quoted: "This run produced none"; "recorded for the devlog so the number is not quoted as a fact of this build" — §1 and §Findings item 2.
- `36/36 invariants hold` (pass 1 after the replays and final pass after `pnpm test:int`) — §`pnpm invariants`.
- `Tests  97 passed (97)`, `14 passed (14)` files, fresh DB — §Full `pnpm test:int`. `pnpm check`: `18 passed (18)` files, `130 passed (130)` unit tests (not quoted in the post) — §`pnpm check`.
- Schema test 13/13 families reject a mutated and a dropped persisted field (not quoted in the post) — §5. Views `security_invoker` 4/4, anon cannot read `ingest` (not quoted in the post) — §6.
- Next milestone M3 "NCAAWB live (trial key, Nov)"; "Trial key requested when live-validation tooling (M3) is ready" — `docs/PLAN.md` §7 M3 row and Phase 0 note.
- Buffer: skipped, `DEVLOG_BUFFER` unset in this environment.
