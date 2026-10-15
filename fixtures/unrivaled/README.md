# Unrivaled fixtures

No Unrivaled simulation recording exists on `playback.sportradar.com` (`pnpm sim list --league
unrivaled` → 0 recordings, checked 2026-10-14) and no API key was used for M2. Every file here
is therefore one of three kinds, stated per file:

- **captured**: a real response captured by the Wehoop iOS app with its own trial key (before
  this backend existed). Nothing edited.
- **docs sample**: the `Result` example payload embedded in Sportradar's public v8 reference
  page for that feed (`https://developer.sportradar.com/basketball/reference/unrivaled-<feed>`),
  extracted on 2026-10-14 from the page's embedded OpenAPI definition
  (`document.api.schema.paths[*].get.responses.200.content['application/json'].examples.Result`),
  pretty-printed, otherwise unedited. A docs sample is **not** a captured response: Sportradar
  trims them (the game documents carry only the `home` side) and they describe one game of the
  2025 season.
- **hand-assembled**: built from docs samples and captured data as described per file. Every
  id and every number comes from one of those sources; the file states which.

The sample game is `838316ea-ab7b-4581-a1dd-74229d1970d5`, Lunar Owls at Mist, 2025-01-18,
closed 84–80 after an Elam period (the docs samples for summary, pbp and boxscore all describe it).

| File | Kind | Source | Used by |
|---|---|---|---|
| `2026-REG-league-leaders.json` | captured | `/seasons/2026/REG/leaders.json`, captured by the Wehoop iOS app (`Resources/MockData/leagueleaders.json`), committed in M0 | `league_leaders` ingest: 45 players, 2026 REG season lines; schema test |
| `docs-player-profile-collier.json` | docs sample | `unrivaled-player-profile` | profile schema; `references[]` with `sport_profile`, WNBA and NCAAW `league_profile` ids |
| `docs-tournament-list-2025-OOT.json` | docs sample | `unrivaled-tournament-list` | season type `OOT`, `tournaments[]` |
| `docs-tournament-schedule-28d4af13.json` | docs sample | `unrivaled-tournament-schedule` | OOT games (1-on-1, bracketed rounds) attached to their tournament |
| `docs-standings-2025-REG.json` | docs sample | `unrivaled-standings` | standings ingest |
| `docs-hierarchy.json` | docs sample | `unrivaled-league-hierarchy` | teams with colors and venue |
| `docs-schedule-2025-REG.json` | docs sample | `unrivaled-schedule` | generation-less schedule ingest (three games, one closed) |
| `docs-seasonal-stats-67c22115.json` | docs sample | `unrivaled-seasonal-statistics` | team + player season lines |
| `docs-838316ea-pbp-closed.json` | hand-assembled | the `unrivaled-game-play-by-play` docs sample (status `closed`, periods Q1 with 3 events and `elam` with 1 event, `home` only) **plus** (a) an `away` block `{Lunar Owls, LNR, 67c22115…, points 84, remaining_timeouts 0}` whose id/name/alias come from the sample's own `periods[].scoring.away` and `on_court.away`, and whose 84 points are the sample schedule's `away_points` for this game; (b) `elam_target_score: 84`. **The target-score field name is not in any public sample**: the Unrivaled docs ("How Elam Ending Appears in the API") only say "use the score + target score fields (when available)". The name follows the plan (`games.elam_target_score`, §2) and the normalizer also accepts `target_score` (§9). The value is the league rule applied to the sample's own numbers: leading score after Q3 (home 20+26+27 = 73 from the boxscore sample) + 11 = 84 = the away final | Elam period row + target; schema test; replay |
| `docs-838316ea-pbp-q1.json` | hand-assembled | the closed pbp above cut to its first Q1 event: `status inprogress`, `quarter 1`, header clock = that event's clock (`6:48`), score 2–0, period scoring 2–0, no target | regulation-phase gameView (clock live, no target) |
| `docs-838316ea-pbp-elam.json` | hand-assembled | the closed pbp above with `status inprogress`, `quarter 4`, header clock = the Elam event's clock (`00:19`), score 75–67 = that event's `home_points`/`away_points`, Elam period scoring 2–0 (the single sample event), target 84 | Elam gameView: clock null, `clock_running=false`, `clock_extra`, `elamTargetScore` |
| `docs-838316ea-summary-closed.json` | hand-assembled | the `unrivaled-game-summary` docs sample (`home` only: statistics, one player line, coaches) plus the same `away` block and target as the pbp. The sample's `home.scoring` lists only Q1; the file lists **Q1 (20) and Elam (7)** for home and **Q1 (19) and Elam (17)** for away, all four from the pbp sample's `periods[].scoring`. Q2/Q3 are omitted on purpose (the away split is in no sample), so period rows 2 and 3 are simply absent rather than invented | `stats_team` + `stats_player` on a closed Elam game |
| `docs-838316ea-boxscore-closed.json` | hand-assembled | the `unrivaled-game-boxscore` docs sample (`home` only, leaders) with the same `away` block, target and the same Q1/Elam-only `scoring` on both sides (the sample's home scoring has all four periods; Q2/Q3 dropped for the reason above) | line score with an `elam` period |
| `hand-player-profile-boston.json` | hand-assembled | an Unrivaled profile for Aliyah Boston. Unrivaled id `54b8a881…`, name, position, jersey, team Phantom (`e5be75a6…`), season `e8440860…` (2026 REG) and the `total`/`average` lines: all from the **captured** league leaders. `height`, `weight`, `college`, `birthdate`, `abbr_name`: from the WNBA docs profile sample of the same player (`fixtures/wnba/docs-player-profile-boston.json`). `references[]`: WNBA `league_profile` = that sample's own id `63dde7d8…`; `sport_profile` `ea798cfb…` and NCAAW `league_profile` `d8f2f455…` = that sample's `references[]`. `league` block: from the Collier docs sample. `updated` is synthetic (2026-10-14) | "one Unrivaled profile links WNBA + NCAAW ids" |
| `docs-838316ea-replay.jsonl` | hand-assembled | replay file (`RecordedDocument` lines, `requestedAt` synthetic and increasing): hierarchy, schedule, Collier profile, then pbp Q1 → pbp Elam → pbp closed → summary → boxscore (the files above, byte-identical bodies) | `pnpm dev:worker --league unrivaled --replay-file …` |
| `docs-oot-replay.jsonl` | hand-assembled | replay file: tournament list, tournament schedule (docs samples) | "OOT game attached to tournament" |
| `identity-replay.jsonl.gz` | hand-assembled | replay file: the captured league leaders, then the Boston profile. Gzipped because the leaders document is 4.4 MB | identity merge across three leagues |

Shapes **not** sourced and therefore not modelled: an Elam target field name confirmed by a real
response (see above), a 1-on-1 tournament game pbp (`awarded_point` stays an unused `LiveEvent`
variant), `clock_fraction` semantics, and a `deleted_events[]` marker from this product.

## Replay

```
pnpm dev:worker --mode sim --league unrivaled --replay-file fixtures/unrivaled/docs-838316ea-replay.jsonl --pace 0 --until closed
pnpm dev:worker --mode sim --league unrivaled --replay-file fixtures/unrivaled/docs-oot-replay.jsonl --pace 0 --until closed
pnpm dev:worker --mode sim --league wnba      --replay-file fixtures/wnba/docs-identity-replay.jsonl --pace 0 --until closed
pnpm dev:worker --mode sim --league unrivaled --replay-file fixtures/unrivaled/identity-replay.jsonl.gz --pace 0 --until closed
```

A replay file may mix game feeds (`pbp`, `summary`, `boxscore`: through `GameWatcher` and
`applyChanges`) with reference feeds (`schedule`, `tournament_list`, `tournament_schedule`,
`standings`, `hierarchy`, `player_profile`, `seasonal_stats`, `league_leaders`: through
`ReferenceIngester`). Reference documents never produce `game_changes`; schedule entries reach
`applyChanges` as generation-less batches (plan §4).
