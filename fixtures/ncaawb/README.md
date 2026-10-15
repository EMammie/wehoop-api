# NCAAWB fixtures

## Recorded simulation (`sim-d9b71fe0-*`)

Recorded from the Sportradar simulation service (`playback.sportradar.com`, no API key, never
counts quota) on 2026-10-14 from recording `d9b71fe0-0cbf-11f1-bf29-5913e6df42d2`
(Northwestern Wildcats at Michigan State Spartans, scheduled 2026-02-18T23:30Z, Big Ten,
`conference_game: true`, provider game id `2e36b340-9277-4b99-af20-b7ff7e86640e`; season
`ec6ca218-4496-4d67-99e5-95bea992f4bf` = 2025 REG). The recording exposes the REST feeds
`boxscore`, `game`, `pbp` (no push). **Coverage is `full`** on every document; none of the 38
NCAAWB recordings listed on 2026-10-14 is an `extended_boxscore` game, so the score-only path is
covered by tests that set `coverage` on these documents (`test/unit/leagues/coverage.test.ts`,
`test/integration/coverage.test.ts`). Nothing is edited; the moment documents below are lines of
the raw recording pretty-printed.

| File | Feed | Moment | Used by |
|---|---|---|---|
| `sim-d9b71fe0-pbp-created.json` | pbp | pregame, `status=created`, no periods | schema tests |
| `sim-d9b71fe0-summary-created.json` | game summary (`feed=game`) | pregame rosters (15 players a side, `rank`, `market`) | identity from rosters |
| `sim-d9b71fe0-boxscore-created.json` | boxscore | pregame | schema tests |
| `sim-d9b71fe0-pbp-q1.json` | pbp | Q1 in progress, 30 events | normalizer, mutated-fixture schema test, coverage tests |
| `sim-d9b71fe0-summary-q1.json` | game summary | Q1 (team + player statistics) | `stats_player`, coverage tests |
| `sim-d9b71fe0-boxscore-q1.json` | boxscore | Q1 | line score |
| `sim-d9b71fe0-pbp-halftime.json` | pbp | halftime, 143 events, 28-55 | freshness (halftime -> Q3) |
| `sim-d9b71fe0-pbp-closed.json` | pbp | final, `status=closed`, 306 events, Northwestern 68 at Michigan State 104, no `deleted_events` | full-document replay |
| `sim-d9b71fe0-summary-closed.json` | game summary | final | final team + player stats |
| `sim-d9b71fe0-boxscore-closed.json` | boxscore | final | "final score matches recording boxscore" |

## Replay fixture

Produced exactly like the WNBA one (`fixtures/wnba/README.md`, "Replay fixture"):

1. `pnpm sim record --league ncaawb --recording d9b71fe0-0cbf-11f1-bf29-5913e6df42d2 --out fixtures/ncaawb/sim-d9b71fe0-replay.raw.jsonl`
   (natural pace, DB-free; `*.raw.jsonl` is git-ignored)
2. `pnpm sim compact --in fixtures/ncaawb/sim-d9b71fe0-replay.raw.jsonl --out fixtures/ncaawb/sim-d9b71fe0-replay.compact.jsonl.gz --every-pbp 50 --every-summary 10 --target-mb 4`

Replay: `pnpm dev:worker --mode sim --league ncaawb --replay-file fixtures/ncaawb/sim-d9b71fe0-replay.compact.jsonl.gz --pace 0 --until closed`

| File | Source | Documents | sha256 |
|---|---|---|---|
| `sim-d9b71fe0-replay.compact.jsonl.gz` | `pnpm sim record` + `pnpm sim compact` as above (recorded 2026-10-14/15, session at natural pace, 3,047 raw documents: 2,537 pbp / 255 summary / 255 boxscore, 455,957,681 bytes raw) | 138 documents (64 pbp, 37 summary, 37 boxscore), 1,176,200 bytes | sha256: 6a9872607adf1478a50c7b404fca066a000f9ec5bef8eb381159d5ab5469d8c0 |

## Docs samples (`docs-*`)

The `Result` example payloads embedded in Sportradar's public NCAAWB v8 reference pages
(`https://developer.sportradar.com/basketball/reference/ncaawb-<feed>`), extracted on 2026-10-14
from the page's embedded OpenAPI definition, pretty-printed, otherwise unedited. They are **not**
captured responses and describe 2022–2024 seasons.

| File | Page | Notable |
|---|---|---|
| `docs-player-profile-stuelke.json` | `ncaawb-player-profile` | only a `sport_profile` reference (no cross-league link) |
| `docs-schedule-2022-REG.json` | `ncaawb-schedule` | a game with `coverage: "boxscore"` (score-only in `v_schedule`) |
| `docs-standings-2023-REG.json` | `ncaawb-standings` | `conference_rank`, conference-specific `records[]` |
| `docs-hierarchy.json` | `ncaawb-league-hierarchy` | `divisions[] > conferences[] > teams[]` (D1-W) |
| `docs-seasonal-stats-6e0c5edc.json` | `ncaawb-seasonal-statistics` | team + player season lines |
| `docs-tournament-list-2022-PST.json` | `ncaawb-tournament-list` | three tournaments |
| `docs-tournament-schedule-c4903014.json` | `ncaawb-tournament-schedule` | Final Four games with `seed` and `source` |
