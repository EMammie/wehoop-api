# WNBA fixtures

Recorded from the Sportradar simulation service (`playback.sportradar.com`, no API key, never
counts quota) on 2026-10-13 from recording `93ee7c68-28d8-4ae8-b54a-974a551aa1f6`
(Las Vegas Aces at New York Liberty, 2026-06-30, "2026 Commissioner's Cup Final",
provider game id `40bea3f6-68c0-4f3b-96fa-336dfb7a9034`). Nothing is edited; documents are
pretty-printed JSON exactly as returned.

| File | Feed | Moment | Used by |
|---|---|---|---|
| `sim-93ee7c68-pbp-created.json` | pbp (`/replay/wnba/<rec>?feed=pbp`) | pregame, `status=created`, no periods | schema tests, freshness "replay restart from 0-0" |
| `sim-93ee7c68-summary-created.json` | game summary (`feed=game`) | pregame | schema tests |
| `sim-93ee7c68-boxscore-created.json` | boxscore | pregame | schema tests |
| `sim-93ee7c68-pbp-q1.json` | pbp | Q1 in progress, 20 events incl. shots, rebounds, lineup changes, a review, a stoppage | normalizer, applyChanges, API, outbox, Realtime tests |
| `sim-93ee7c68-summary-q1.json` | game summary | Q1 (team statistics + players) | stats_team diffing |
| `sim-93ee7c68-boxscore-q1.json` | boxscore | Q1 | line score |
| `sim-93ee7c68-pbp-halftime.json` | pbp | halftime | freshness (halftime -> Q3) |
| `sim-93ee7c68-pbp-closed.json` | pbp | final, `status=closed` | full-document replay, equivalence |
| `sim-93ee7c68-summary-closed.json` | game summary | final | final team stats |
| `sim-93ee7c68-boxscore-closed.json` | boxscore | final | "final score matches recording boxscore" |
| `sim-93ee7c68-push-events-sample.json` | push `events` (`/subscribe/events?recording_id=<rec>`) | first lines incl. a heartbeat | push schema (M4 client) |
| `sim-93ee7c68-push-clock-sample.json` | push `clock` | first clock messages (`running` true/false) | push schema (M4 client) |

Observations worth knowing (all from this recording):
- Events are revised after the fact without a bump of `updated` (e.g. a rebound gains its
  `statistics[]` attribution later). Rule 3's hash fallback exists for exactly this.
- The pbp `deleted_events[]` entries carry only `id`, no `updated` (five markers in
  `sim-93ee7c68-pbp-closed.json`). A marker without a revision is applied and recorded with
  `play_events.deleted_revision_at = null`; the revision-carrying marker path is covered by unit
  tests only until a feed that sends `updated` on markers is recorded.
- Season `type` is `"CC"` (Commissioner's Cup), which the `season_type` enum does not yet cover;
  M1 leaves `games.season_id` null.
- The pbp header `clock` is the clock of the latest event, not a live clock; `clock_running`
  is derived (see `src/ingest/clock.ts`). Push `clock` messages carry `running` directly.

## Push mock (M4)

`pnpm sim serve` derives push lines from the compact replay fixture instead of a recorded push
stream (`src/providers/sportradar/fake-push.ts`): consecutive pbp documents are diffed, a new event
id is an `insert` line, a changed event body an `update`, a new `deleted_events[]` id a `delete`
(only when an earlier document carried the event's body: 2 of the 5 markers here), and every
header change (status, clock, score, period) a clock line with `clocks.running` derived. Every line
is Zod-parsed against the two recorded push samples above, so the mock cannot drift from the shape
the client (`src/providers/sportradar/push-client.ts`) accepts; the clock is written in the sample's
digit form (`"1000"`), which the ingester normalizes back to `m:ss`. No new committed fixture: the
timelines are built at server start (1,073 event lines + 50 clock lines from this recording).

## Replay fixture

Every replay evidence row in `devlog/evidence/M1.md` runs from a committed, reproducible
recording of the whole game, not from a temporary file. It is produced in two steps:

1. **Record** (natural pace, ~2.5-3 h, no database):
   `pnpm sim record --league wnba --recording 93ee7c68-28d8-4ae8-b54a-974a551aa1f6 --out fixtures/wnba/sim-93ee7c68-replay.raw.jsonl`
   creates a simulation session and polls the replay REST feeds exactly as the worker does in
   sim mode: pbp every poll (`--poll-interval 3000`), summary (`game`) and boxscore on poll
   1, 1+N, 1+2N, ... (`--summary-every 10`), then one final summary and boxscore after the
   first `closed` pbp. It never opens Postgres. Each line is appended synchronously, so a
   recorder killed with SIGINT/SIGTERM leaves a valid prefix. `*.raw.jsonl` is git-ignored
   (~470 MB).
2. **Compact** (deterministic, offline):
   `pnpm sim compact --in fixtures/wnba/sim-93ee7c68-replay.raw.jsonl --out fixtures/wnba/sim-93ee7c68-replay.compact.jsonl.gz --every-pbp 50 --every-summary 10 --target-mb 4`
   keeps a document when ANY of: it is the first or last of its feed; its `status` or `quarter`
   differs from the previously kept document of the same feed; (pbp) its `deleted_events` id
   set differs from the previously kept pbp; its index within its feed is a multiple of the
   stride (`--every-pbp` for pbp, `--every-summary` for summary and boxscore); it is the last
   document before, or the first after, a status or period change between consecutive
   documents of its feed. So every period boundary, halftime, `closed`, every boxscore whose
   status or period changed, and the final boxscore are all present. Kept lines are written
   byte-identical, gzip level 9; the command prints kept/total per feed, the output size and
   its sha256, and exits 3 if the output exceeds `--target-mb`. The rule is implemented once,
   in `selectCompact` (`src/ingest/recording.ts`), and unit-tested.

Replay it with `pnpm dev:worker --mode sim --league wnba --replay-file fixtures/wnba/sim-93ee7c68-replay.compact.jsonl.gz --pace 0 --until closed`
(`--replay-file` accepts `.jsonl` and `.jsonl.gz`).

**Line format** (`RecordedDocument`, `src/ingest/recording.ts`; one JSON object per line, also
what the worker's `--record-to` writes):

```json
{"feed":"pbp","status":200,"requestedAt":"2026-10-13T07:34:11.948Z","receivedAt":"2026-10-13T07:34:12.100Z","body":{...}}
```

`feed` is `pbp` | `summary` | `boxscore`; `status` is the HTTP status (always 200: failed
requests are not recorded); `requestedAt` is the request start time and becomes the
observation's `observedAt` on replay; `body` is the provider document exactly as returned.

| File | Source | Documents | sha256 |
|---|---|---|---|
| `sim-93ee7c68-replay.compact.jsonl.gz` | `pnpm sim record` + `pnpm sim compact` as above (recorded 2026-10-14, session at natural pace, 3,350 raw documents: 2,790 pbp / 280 summary / 280 boxscore, 1,802,476,345 bytes raw) | 158 documents (76 pbp, 41 summary, 41 boxscore), 2,541,778 bytes | sha256: 7be194ab80d0ca885a12d802702d046f73e8ab9c13763af13d5a4527c5b0481c |

## Docs samples (`docs-*`, M2)

The `Result` example payloads embedded in Sportradar's public WNBA v8 reference pages
(`https://developer.sportradar.com/basketball/reference/wnba-<feed>`), extracted on 2026-10-14
from the page's embedded OpenAPI definition, pretty-printed, otherwise unedited. They are **not**
captured responses.

| File | Page | Notable |
|---|---|---|
| `docs-player-profile-boston.json` | `wnba-player-profile` | Aliyah Boston: `references[]` with a WNBA `external` id, a `sport_profile` id and an NCAAW `league_profile` id; four season lines. The same player is in the captured Unrivaled league leaders, which is what `fixtures/unrivaled/hand-player-profile-boston.json` links |
| `docs-schedule-2022-PST.json` | `wnba-schedule` | playoff games with `title` and `seed` |
| `docs-standings-2022-REG.json` | `wnba-standings` | `calc_rank`, `rank.clinched` |
| `docs-hierarchy.json` | `wnba-league-hierarchy` | `conferences[] > teams[]` with colors and venue |
| `docs-seasonal-stats-6f017f37.json` | `wnba-seasonal-statistics` | team + player season lines |
| `docs-identity-replay.jsonl` | replay file: the Boston profile, then the hierarchy. The profile is a real docs sample; the three-id example it is part of is **partly synthetic** because its Unrivaled half is hand-assembled (`fixtures/unrivaled/README.md`) | `pnpm dev:worker --mode sim --league wnba --replay-file fixtures/wnba/docs-identity-replay.jsonl --pace 0` |
