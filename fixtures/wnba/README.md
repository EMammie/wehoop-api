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
- Season `type` is `"CC"` (Commissioner's Cup), which the `season_type` enum does not yet cover;
  M1 leaves `games.season_id` null.
- The pbp header `clock` is the clock of the latest event, not a live clock; `clock_running`
  is derived (see `src/ingest/clock.ts`). Push `clock` messages carry `running` directly.
