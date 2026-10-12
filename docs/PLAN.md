# wehoop-api: women's basketball stats backend (rev 3)

## Context

Goal: a "Real"-style live stats app for women's basketball (WNBA, NCAA Women's, Unrivaled) on Sportradar data. The existing iOS app **Wehoop** (`~/Desktop/Development/Wehoop/Wehoop`) calls Sportradar Unrivaled directly from the phone, which Sportradar's terms forbid and which cannot scale past a trial key. It has no WNBA/NCAAWB code, no play-by-play, no storage. This plan builds the backend, with Claude Code agents doing implement → review → validate → devlog per milestone, documented for social media.

Decisions made with the user:
- New public repo `~/Projects/wehoop-api`. Node 22 + TypeScript.
- Persistent Node worker on **Fly.io** (ingestion) + **Supabase** (Postgres, Realtime Broadcast, Auth). Live delivery behind a `LiveTransport` interface so custom SSE can replace Broadcast if measurements justify it. Local dev via Supabase CLI.
- All three leagues via adapters over one shared model; prove one full path (ingest → store → broadcast → client) on one recorded game first, **including dedupe, corrections, and crash recovery**, because those determine the schema.
- Canonical player identity: `players` + `player_external_ids(provider, league, external_id)`. Verified: Unrivaled player IDs are a separate ID space; Unrivaled Player Profile `references[]` (`scope`, `id_type`, `source_id`) links to WNBA/NCAAW IDs.
- **Phase 0 needs no trial key.** Sportradar Simulations (`playback.sportradar.com`) list recordings via GraphQL, need no auth, replay WNBA/NCAAWB REST feeds at natural pacing. Push replay exists but is rolling out; availability is per recording. Trial key requested when live-validation tooling (M3) is ready. Trial quotas are **per API product** (default 1,000 / rolling 30 days, 1 QPS), read from the console, not assumed.
- Agents: `.claude/agents/` subagents + slash-command skills first; GitHub Action PR review and Buffer posting added after the local loop works. Validators produce evidence, not "tests pass".
- Devlog: `devlog/NN-slug.md` per milestone + Buffer Idea draft (gated) + public repo with tags on validated merge commits.

Rev 2 incorporates the user's review: separate current plays from the change stream, allocate sequences only for real changes, fix the reconnect contract, private channels with receive-only authorization, budget-aware trial mode, outbox/worker recovery hardening, resilience moved into M1, hosted review out of M0, OOT season type, season-stat tables, `clock_running`, 120–150 h range.
Rev 3 adds: an explicit freshness/reconciliation policy (hash alone cannot order updates), durable vs observation writes, a `pulse` message carrying `latestSeq` so a missing final change is detectable, paginated `/changes`, one canonical `GameChange` schema shared by Broadcast and REST, and stricter evidence (joins, guest-session auth test, crash points around commit/publish).

Calendar (today 2026-10-12): WNBA season over; NCAAWB tips off early Nov 2026; Unrivaled starts Jan 2027 (1-on-1 tournament Feb 10–11, 14). First live validation = NCAAWB in November.

## Reference code (read, don't copy)

| What | Where | Use |
|---|---|---|
| Unrivaled v8 Codable DTOs (~2,450 lines) | `Wehoop/Wehoop/Wehoop/Data/DTOs/Sportradar/SportradarResponseDTOs.swift` | Port game/summary/boxscore/period/profile shapes to Zod. `coverage` :589; period `type` "quarter"/"elam" :1270 (but :782 says "REG"/"ELAM" — fixture decides); `references[]` :1758. **Do not port** `SportradarStandingsDTO` (camelCase, never decoded real data). No PBP DTO exists. |
| URL builders incl. pbp/boxscore | `Unrivaled/Unrivaled/Wehoop/Data/DataSources/Sportradar/SportradarAPIClient.swift` | URL patterns for 25 feeds |
| 1 QPS actor | `Wehoop/.../Core/Networking/RateLimiter.swift` | Model for Node `RateLimiter` |
| Real captured response | `Wehoop/.../Resources/MockData/leagueleaders.json` | First fixture → `fixtures/unrivaled/` |
| Closed event enum + `AsyncStream` boundary | `Courtside/CourtsideKit/Sources/CourtsideEngine/GameEvent.swift`, `GameEventSource.swift` | `LiveEvent` union and the M5 iOS adapter mirror this |

NBA sandbox `Shared/` packages are copied employer code with hardcoded keys: never reuse.

## 1. Repo layout and toolchain

```
wehoop-api/
  CLAUDE.md  package.json  tsconfig.json  biome.json  vitest.config.ts
  Dockerfile  fly.toml  .env.example
  .github/workflows/ci.yml            # claude-review.yml added in M4
  .claude/agents/{implementer,reviewer,validator,devlog}.md
  .claude/skills/{milestone,validate-replay}/SKILL.md
  supabase/config.toml  supabase/migrations/0001_core.sql  supabase/seed.sql
  src/
    config.ts logger.ts
    db/{client,session-client,types}.ts db/queries/*.ts   # session-client = direct conn for locks/LISTEN
    model/{live-event,game-state,content-hash}.ts
    providers/sportradar/{http,urls,simulation,push-client}.ts  schemas/*.ts
    leagues/adapter.ts  leagues/{wnba,ncaawb,unrivaled}/{adapter,normalize-pbp}.ts
    ingest/{scheduler,trial-mode,game-watcher,apply-changes,backfill,identity}.ts
    live/{transport,supabase-broadcast,outbox-publisher}.ts
    api/server.ts  api/routes/{snapshot,changes,players,health}.ts
    bin/{worker,api,sim,subscribe}.ts
  fixtures/{wnba,ncaawb,unrivaled}/*.json
  test/{unit,integration}/**  test/integration/invariants.sql
  devlog/NN-slug.md  devlog/evidence/MN.md
```

| Concern | Choice | Why |
|---|---|---|
| Package manager | pnpm | strict, fast CI cache |
| Tests | Vitest | TS-native; unit + `supabase start` integration |
| Lint/format | Biome | one binary |
| Migrations | Supabase CLI SQL | RLS, Realtime policies, grants, outbox need raw SQL. No Drizzle |
| DB access | `postgres` (porsager) + `supabase gen types` | thin; clean `ON CONFLICT`; two pools: pooled (queries) and **direct/session-mode** (advisory lock + `LISTEN`), since the transaction pooler supports neither |
| HTTP | Hono + `@hono/zod-validator` | 4 routes |
| Validation | Zod, `.loose()` top-level, strict on persisted fields | Sportradar adds fields |
| Logging | pino, child loggers per `{league, gameId, runId}` | Fly logs |
| Streaming | Node 22 fetch body async iterator | chunked push |
| Container | multi-stage `node:22-alpine`; `fly.toml` process groups `api` + `worker` | worker = 1 machine + advisory lock |
| Broadcast send | Supabase REST batch `POST /realtime/v1/api/broadcast` with service key, `private=true` | no socket held by worker. Note: Broadcast Replay does **not** cover REST-published messages, so catch-up is our own `/changes` endpoint |

## 2. Database schema (`0001_core.sql`)

uuid PKs, `created_at/updated_at`, enum `league_code('wnba','ncaawb','unrivaled')`, enum `season_type('PRE','REG','OOT','PST')`.

**Two schemas**: `public` (client-readable through RLS) and `ingest` (private: never exposed via PostgREST; service role only).

| Table (schema) | Key columns | Constraints |
|---|---|---|
| `leagues` (public) | `code PK, name, provider_alias` | seeded |
| `seasons` (public) | `league, year, type season_type, provider_season_id, starts_on, ends_on` | `unique(league, provider_season_id)` |
| `teams` (public) | `league, provider_team_id, name, market, alias, conference, division, colors, venue, logo_url` | `unique(league, provider_team_id)` |
| `players` (public) | `full_name, first_name, last_name, birthdate, height_in, weight_lb, position, college, headshot_url, merged_into` | fts index |
| `player_external_ids` (public) | `player_id, provider, league, external_id, id_type, source` | `PK(provider, league, external_id)` |
| `player_team_seasons` (public) | `player_id, team_id, season_id, jersey, status` | unique triple |
| `player_season_stats` (public) | `player_id, season_id, team_id, games_played, games_started` + totals + averages (typed) + `extra jsonb` | `PK(player_id, season_id, team_id)` |
| `team_season_stats` (public) | `team_id, season_id` + totals/averages + `extra` | `PK(team_id, season_id)` |
| `tournaments` (public) | `league, season_id, provider_tournament_id, name, location, starts_on, ends_on, status` | unique provider id (Unrivaled OOT) |
| `games` (public) | `league, season_id, tournament_id null, provider_game_id, scheduled_at, status, coverage(full/extended_boxscore), home/away_team_id, home/away_points, current_period, period_type, possession_arrow, elam_target_score, venue, broadcasts, last_seq bigint default 0, retained_from_seq bigint default 1, stats_final_at` + **observation columns**: `clock, clock_decimal, clock_running bool null (null = unknown), clock_as_of timestamptz, clock_extra jsonb, progress_key jsonb, observed_at timestamptz, observed_source text, provider_updated_at` | `unique(league, provider_game_id)`; `index(league, scheduled_at)`; partial index on live statuses |
| `game_periods` (public) | `game_id, number, type(quarter/overtime/elam), sequence, home/away_points` | `PK(game_id, sequence)` |
| `game_team_stats` (public) | `game_id, team_id, is_home` + typed box columns + `extra` | `PK(game_id, team_id)` |
| `game_player_stats` (public) | `game_id, player_id, team_id, starter, played, on_court, minutes` + typed box + `extra` | `PK(game_id, player_id)` |
| **`play_events`** (public) — *current state only* | `id, game_id, provider_event_id, provider_number, provider_sequence, period_number, period_type, period_sequence, clock, clock_decimal, wall_clock, event_type, provider_event_type, team_id, player_id, home/away_points, payload jsonb (normalized LiveEvent body, no envelope), content_hash text, provider_updated_at, deleted_at` | `unique(game_id, provider_event_id)`; `index(game_id, period_sequence, provider_sequence)`. **No seq column.** |
| **`game_changes`** (public) — *append-only stream* | `id uuid (stable message id), game_id, seq bigint, play_event_id uuid null, change_type(event_insert/event_update/event_delete/status/period/stats_team/stats_player), provider_event_id text null, body jsonb, content_hash, created_at` | `PK(game_id, seq)`; `unique(id)`; never updated or deleted. Retention job may delete rows below `games.retained_from_seq` for closed games; `/changes` reports `retainedFrom` and the client re-snapshots |
| `play_event_raw` (ingest) | `play_event_id, raw jsonb, provider_updated_at` | provider forensics; 30-day retention; not client-visible |
| `standings` (public) | `season_id, team_id, wins, losses, win_pct, games_behind, conf_w/l, streak, rank, records, as_of` | `PK(season_id, team_id)` |
| `ingestion_runs` (ingest) | `kind, league, game_id, source(production/trial/simulation/fixture), started/ended, status, counts, error, meta` | |
| `provider_calls` (ingest) | `run_id, source, product text, league, feed, url, status, duration_ms, bytes, quota_counted, called_at` | view `ingest.v_quota` grouped by `product` against `ingest.product_quotas(product, limit_30d, qps, note)` seeded from the console |
| `budget_reservations` (ingest) | `game_id, product, reserved_calls, used_calls, created_at` | watcher refuses to start without a reservation |
| `broadcast_outbox` (ingest) | `change_id uuid PK references game_changes(id), channel, game_id, seq, created_at, published_at, attempts, next_attempt_at, last_error, dead_at` | one row per durable change by construction (PK = change id); index on `(channel, seq) where published_at is null` |
| `stale_observations` (ingest) | `game_id, source, fetched_at, progress_key, stored_progress_key, reason` | log of rejected older batches; evidence for the no-regression test |

Access control:
- `ingest` schema: `revoke all from anon, authenticated`; not in PostgREST `exposed_schemas`.
- `public` tables: RLS enabled, `select` policy for `anon` and `authenticated`; no insert/update/delete policies for clients.
- All views `with (security_invoker = true)`. No view may be used to "hide" a column; sensitive data lives in `ingest`.
- Realtime: `realtime.messages` RLS policy grants `select` (receive) to `anon`/`authenticated` on topics matching `game:%` and `league:%`; **no insert policy for clients**, so only the service-role publisher can send. Channels are `private: true`. iOS uses Supabase anonymous sign-in (guest session, no sign-up) so `setAuth` has a JWT.
- Test (M1): a client with the anon key attempts to broadcast a `status` message on `game:{id}`; assert rejection and that `bin/subscribe` never receives it.

League quirks: `games.coverage` drives watcher cadence and which change types NCAAWB extended-boxscore games emit (status/score/period only). Unrivaled Elam: `game_periods.type='elam'`, `elam_target_score`, clock null, `clock_running=false`. Unrivaled OOT games attach to `tournaments` and come from the Tournament Schedule feed, not the season schedule. `clock_extra` holds the two Unrivaled-only clock fields until a real fixture fixes the names.

## 3. Live event and change model

`src/model/live-event.ts` — body variants (discriminated on `type`): `tip_off, shot{made,points,shotType,teamId,playerId?,assistId?,blockId?,location?,description}, free_throw{made,attempt,of}, rebound{kind}, turnover{kind,stealId?}, foul{kind,drawnById?}, timeout{kind}, lineup_change{in[],out[]}, period_start, period_end, game_status{status}, elam_target_set{target}, awarded_point{...} (Unrivaled 1v1), review{outcome?}, other{providerEventType,description?}`. Each body carries `period{number,type,sequence}, clock, clockDecimal?, wallClock, score{home,away}, teamId?, playerId?`.

`content_hash` = sha256 of the canonical JSON of the **body only** (no seq, no ingestion timestamps, no provider `updated` field). Hash equality means "unchanged"; hash inequality alone never decides direction. Direction comes from the freshness policy in §4.

**One canonical `GameChange` schema** (Zod, in `model/game-change.ts`; the only shape Broadcast, `/changes`, `game_changes`, and the Swift mirror use):
```ts
{ v: 1, id: uuid, gameId, seq, ts: iso, type: 'event_insert'|'event_update'|'event_delete'|'status'|'period'|'stats_team'|'stats_player', providerEventId?: string, body }
```
Stored as columns + `body jsonb` in `game_changes`; the envelope is rebuilt from columns on read, so equality is tested on **decoded** `GameChange` objects (deep-equal after Zod parse), never on JSON bytes.
- `event_update`: full replacement body. `event_delete`: body `{providerEventId}`.
- `status`: `{status, score, period}` — durable changes own score, period, and status.
- **Clock is never a durable change.** During live play the worker sends a `pulse` message every 10 s (and once on close) directly to the transport, never to `game_changes`:
  `{ v:1, type:'pulse', gameId, latestSeq, status, clock, clockDecimal?, clockRunning: true|false|null, clockAsOf, observedAt }`.
  Client rules: ignore a pulse whose `observedAt` ≤ the last applied pulse; if `latestSeq` > last applied durable seq, fetch `/changes`; count down only when `clockRunning === true`, anchored to `clockAsOf`; when `null`, display the last observed clock frozen. Pulses never touch score or period.

Unknown provider types → `other`, never throw. One shared Sportradar basketball normalizer; adapters override league quirks only. `pnpm gen:swift` emits `LiveEvent.swift` + `GameChange.swift` into Wehoop at M5.

## 4. Ingestion

- **`LeagueAdapter`**: `capabilities{pushClock,pushEvents,pushStats,coverageFor}`, `schedule/summary/boxscore/pbp/teamProfile/playerProfile/standings/hierarchy/changes/seasonalStats/tournamentSchedule`, `normalizePbp()`, `openPush?()`. One `SportradarHttp` with `UrlResolver` = `ProdUrlResolver(product, access, key)` | `SimulationUrlResolver(recordingId, sessionId)`. `bin/sim.ts`: GraphQL `recordings(league:)`, `createSession`, prints per-recording feed availability.
- **Freshness policy** (`ingest/freshness.ts`). Every normalized batch carries an `Observation`: `{source: push|rest|simulation|fixture, fetchedAt (our clock), providerUpdatedAt?: max of any provider updated fields present, progressKey}`. `progressKey` is derived from basketball content, not timestamps: `[statusRank, periodSequence, -clockSecondsRemaining, eventCount]` with `statusRank` scheduled < inprogress < halftime < complete < closed; `postponed`/`cancelled` are terminal and compare above `inprogress`. Rules, applied in order:
  1. **Per event**: if both stored and incoming events have a provider `updated`, the newer wins; equal → compare hash. If either lacks it, fall to rule 2.
  2. **Per batch**: if `progressKey` < stored `games.progress_key` → the batch is **stale**: no durable changes, no observation update, one `stale_observations` row, metric `stale_batch`. This is what makes "replay restarts at 0–0" and "old REST arrives after push" harmless.
  3. If `progressKey` ≥ stored: inserts, hash-differing updates, and deletions are **corrections** and are applied. Stats-only changes on a `closed` game (official stat corrections) count as equal-progress corrections and are applied.
  4. Competing sources at equal progress (push and REST reconciliation): content compare decides; nothing special, because both are applied through the same transaction and serialized by the game row lock.
  5. Operator override: `pnpm game rebuild --game <id>` clears state and replays from a chosen source for forensics. Never automatic.
  Feeds without usable timestamps (NCAAWB extended boxscore summaries, some sim recordings) are handled entirely by rule 2.
- **`applyChanges(gameId, normalized, observation)`** (`ingest/apply-changes.ts`), one transaction, two write categories:
  1. `SELECT … FROM games WHERE id=$1 FOR UPDATE` (serializes per game).
  2. Freshness check (above). Stale → log and commit, nothing else.
  3. Load current `play_events(provider_event_id, content_hash, deleted_at, provider_updated_at)` for the game.
  4. Diff into durable changes: `event_insert`, `event_update` (hash differs and not older), `event_delete` (in `deleted_events[]`/push `operation=delete`, not yet deleted), `status`/`period`/`stats_*` via their own hashes.
  5. **Observation write (always, when not stale)**: `games.clock, clock_decimal, clock_running, clock_as_of, clock_extra, progress_key, observed_at, observed_source, provider_updated_at`. No seq increment, no change row.
  6. **Durable write (only if `n > 0`)**: `UPDATE games SET last_seq = last_seq + n RETURNING last_seq`; number changes `last_seq-n+1 … last_seq`; upsert `play_events` current state; insert `play_event_raw`; insert `game_changes` (with new `id`s); insert `broadcast_outbox` (`change_id` PK); `NOTIFY outbox`.
  `clock_running` derivation: WNBA push clock gives it directly; REST summaries give `true` when `status=inprogress` and the clock advanced between two observations, `false` at period end/timeouts when the feed says so, `null` otherwise.
  Guarantees by construction: applying the same normalized batch twice yields zero changes; an older batch never regresses state; a genuinely newer correction appends exactly one change per changed entity; `seq` is gap-free.
- **Rate/quota**: `RateLimiter` (1 s slots) wraps production calls; every call logs `provider_calls` with `product`. `QuotaGuard` reads `ingest.v_quota` per product and `ingest.product_quotas` (seeded from console limits; config override), refuses below reserve.
- **Trial mode** (`ingest/trial-mode.ts`, `MODE=trial`): no automatic discovery. Operator runs `pnpm trial plan --league ncaawb --date 2026-11-08` (1 schedule call) and `pnpm trial watch --game <id> --profile full|extended` which computes the call budget for that profile, writes a `budget_reservations` row, and refuses if `remaining - reserved < reserve`. Profiles: `full` = pbp every 30 s + boxscore every 5 min for ~2.5 h ≈ 330 calls; `extended` = summary every 60 s for 2.5 h + 1 boxscore at +120 min ≈ 150 calls; `lean-full` = pbp every 60 s ≈ 165 calls. Daily `changes(date)` is **off** in trial mode. A 1,000-call NCAAWB trial therefore covers roughly two full games plus one extended game plus discovery; this is stated in the M3 devlog honestly.
- **Production/simulation scheduler**: schedule for today+tomorrow per league at 06:00 + hourly in game windows; `changes(date)` every 30 min in season (production only). `GameWatcher` cadence by `(source, capabilities, coverage)`: sim = pbp/3 s; prod push = events+statistics (+clock WNBA) + REST pbp/5 min reconciliation.
- **Push client**: chunked fetch, newline split, Zod-parse (`heartbeat` | `{payload, metadata{operation,event_type}}`), 15 s no-bytes watchdog, jittered backoff 1–30 s, then `backfill(gameId)` = full REST pbp through `applyChanges`.
- **Worker lifecycle**: on start, open the **session-mode** connection, `pg_try_advisory_lock(hash('wehoop-worker'))`; exit if not acquired. If that connection drops, stop all watchers and exit (Fly restarts it). On start and every 30 s, drain the outbox regardless of `NOTIFY` (NOTIFY is a wake-up hint only).
- **Outbox publisher**: single publisher per process (the lock holder); per channel, publish in `seq` order: `SELECT … WHERE published_at IS NULL AND dead_at IS NULL AND next_attempt_at <= now() ORDER BY channel, seq FOR UPDATE SKIP LOCKED LIMIT 200`, excluding any channel whose lowest unpublished `seq` is not in this batch's head (stuck head blocks the channel, not the system). Publish is at-least-once: a crash after the HTTP send but before `published_at` is written re-sends the same `GameChange` with the same `id`; clients dedupe on `id`/`seq`. Retry with exponential `next_attempt_at`; after 10 attempts set `dead_at`. Recovery: `pnpm outbox requeue --channel game:<id>`; clients recover regardless via `/changes` because the durable stream is `game_changes`.
- **Pulse sender**: every 10 s per live game and once when status becomes `closed`, build `pulse` from `games` observation columns + `last_seq` and send directly through `LiveTransport` (not outbox). Loss is harmless; the next pulse supersedes.
- **Reconnect contract** (client; `bin/subscribe.ts` is the reference implementation and is tested):
  1. Subscribe to `game:{id}`; buffer incoming `GameChange` and `pulse` messages.
  2. `GET /v1/games/:id/snapshot` → `{state, seq}` from **one** `REPEATABLE READ` transaction.
  3. Apply buffered changes with `seq > snapshot.seq` in order, deduping on `id`; drop the rest.
  4. On gap (`msg.seq != last+1`) or on a `pulse` with `latestSeq > last`: page `GET /v1/games/:id/changes?after=last` until `hasMore=false`; if the response says `retainedFrom > last+1`, go to step 2.
  5. On reconnect, app foreground, or network change: go to step 4 (step 2 if the gap is large or unknown).
  6. When a change or pulse reports `status=closed`, fetch one final snapshot.
  Pulses update only clock display and trigger step 4; they never change score, period, or status.

## 5. API surface

| Need | Via | Notes |
|---|---|---|
| Schedule, teams, standings, box scores, season/tournament lines | PostgREST (Supabase Swift SDK) | views `v_schedule`, `v_boxscore`, `v_standings`, `v_player_seasons`, all `security_invoker`; anon read RLS |
| `GET /v1/games/:id/snapshot` | Hono | `{game (incl. clockRunning, clockAsOf), periods, teamStats, playerStats, events (current, non-deleted), seq, coverage, serverTime}`; single consistent tx; cache 2 s live / 1 h closed |
| `GET /v1/games/:id/changes?after=&limit=` (limit ≤ 500, default 200) | Hono | `{ changes: GameChange[], nextAfter, latestSeq, hasMore, retainedFrom }`. `changes` ordered by `seq`, decoded-equal to Broadcast messages. Empty game: `latestSeq=0, retainedFrom=1, hasMore=false`. If `after < retainedFrom-1` → still 200 with `changes=[]` and `retainedFrom` set; client re-snapshots |
| `GET /v1/players/:id` | Hono | canonical player + external ids + per-league season lines |
| `GET /health`, `GET /v1/admin/quota` | Hono | outbox lag, dead count, lock held, last tick; admin bearer |

Broadcast (private channels): `game:{uuid}` → `GameChange` messages (same schema as `/changes`) + `pulse` messages. `league:{code}:scores` → 5 s-coalesced scoreboard deltas `{gameId, score, status, period, clock, latestSeq, observedAt}` (list screens re-fetch `v_schedule` on reconnect).

## 6. Agent workflow

**`CLAUDE.md`** (~80 lines): stack + commands (`pnpm dev:worker|dev:api|sim|trial|test|test:int|check`, `supabase start|db reset`); non-negotiables (Zod at every provider boundary; writes only via `ingest/apply-changes.ts`; `game_changes` + outbox rows in the same tx as state; `game_changes` never updated/deleted by code; no `any`; sim calls never count quota; secrets via env only; no client write policies); milestone pointer; evidence rule; agent roster; devlog conventions.

| Agent | Role | Tools | In → Out |
|---|---|---|---|
| `implementer.md` | implement one milestone on branch `mN-slug`, small commits, tests alongside | Read Edit Write Bash Grep Glob | plan section → green `pnpm check` + `## Handoff`. May not touch `devlog/` or `.github/` |
| `reviewer.md` | diff review vs contract: change-stream invariants, tx boundaries, Zod coverage, quota accounting, access control, league quirks | Read Grep Glob, read-only Bash | `git diff main...HEAD` → `[blocker|should|nit] file:line – issue – fix`; blockers loop (max 2) |
| `validator.md` | evidence, not opinions | Bash Read, Write only `devlog/evidence/` | acceptance table → `evidence/MN.md`: claim + exact command + captured output. Numbers from DB queries. "tests pass" alone rejected |
| `devlog.md` | milestone post | Read, Write only `devlog/`, Buffer tools | evidence + git log → `devlog/NN-slug.md` + (if `DEVLOG_BUFFER=1`) Buffer Idea `wehoop-api MN: slug`. Quotes evidence only |

Skills: `/milestone <n>` = implementer → reviewer (loop ≤2) → validator → devlog → report. Tagging `mN` happens on the **validated merge commit** after the user merges, via `pnpm release:tag`. `/validate-replay <league> <recordingId>` = `db reset`, replay twice, print invariants, kill-mid-replay (`timeout -s KILL`) then resume, before/after counts, corrections injection.

Hosted: `ci.yml` from M0 (biome ci, tsc, vitest; `supabase start` + `test:int` job). `claude-review.yml` (`anthropics/claude-code-action@v1`, reviewer checklist, read-only tools) added in **M4**, not M0. **Buffer**: connected account is `iam.pandoraaabookings1@gmail.com`, org "My Organization", groups To Do / In Progress / Done. Confirm it is yours before `DEVLOG_BUFFER=1`; default group "To Do".

## 7. Milestones

| M | Scope | Acceptance evidence | Hrs | Devlog hook |
|---|---|---|---|---|
| **M0 Scaffold** | pnpm/TS/Biome/Vitest, Supabase CLI init, `0001_core.sql` (both schemas, grants, RLS, realtime policy), Dockerfile, fly.toml, CLAUDE.md, 4 agents, 2 skills, `ci.yml`, first fixture | `db reset` clean; `pnpm check` green locally and in CI; `anon` cannot read `ingest.*` (query evidence); `/milestone 0` ran all four local agents | 8 | "A repo where the agents do the chores" |
| **M1 One recorded WNBA game, durable** | `bin/sim`, `SimulationUrlResolver`, Zod pbp/summary/boxscore from recording, normalizer, WNBA adapter, `content-hash`, `freshness`, `applyChanges` (observation + durable writes), `GameChange` schema, `game_changes`, outbox + publisher (ordering, at-least-once, startup drain), pulse sender, `SupabaseBroadcastTransport` (private), session-lock worker, snapshot + paginated `/changes`, `bin/subscribe --record` implementing the full reconnect contract, plus the CLIs `/validate-replay` depends on: `dev:worker --until closed`, `pnpm dump-game`, `pnpm sim inject --mutate-event|--delete-event` | **Idempotence**: same normalized batch applied twice → 0 new changes. **Equivalence**: replay into two clean DBs → identical `play_events` bodies, `game_periods`, final score (diff of canonical dumps). **No regression**: after full replay, re-run the recording from its start → 0 new changes, N `stale_observations` rows, final score unchanged; inject an older REST summary after a newer one → rejected. **Correction**: mutate one event's body and bump its `updated` → exactly one `event_update` with new seq, play row updated in place; inject `operation=delete` → one `event_delete`. **Contiguity**: subscriber `seq` 1..N contiguous. **Outbox parity by join**: `game_changes ⟗ broadcast_outbox on change_id` → 0 unmatched either side, 0 `dead_at`. **Crash points**: `kill -9` (a) mid-replay, (b) with a fault injected just before commit, (c) after HTTP publish before `published_at` → after restart 0 gaps, 0 duplicate state, subscriber dedupes repeated `id`. **Missing final change**: drop the last broadcast in `MemoryTransport` → subscriber catches up from the next `pulse.latestSeq`. **Auth**: anon key *and* an anonymous-sign-in guest JWT (the real iOS session) can receive but a publish attempt from each is rejected and never observed by a second subscriber. **Equal shapes**: decoded `GameChange` from Broadcast deep-equals the one from `/changes`. Final score matches recording boxscore | 24 | terminal recording: "a WNBA game replayed, killed, and recovered" |
| **M2 Three leagues + identity** | NCAAWB + Unrivaled adapters, schedule/boxscore/standings/hierarchy/profile/seasonal-stats/tournament schemas, `identity.ts`, `player_season_stats`, `tournaments` + OOT, PostgREST views (`security_invoker`), `/v1/players/:id`, Elam, coverage | per-league fixture replay row counts; one Unrivaled profile links WNBA + NCAAW ids and `/v1/players/:id` returns all three; Elam period row + target; OOT game attached to tournament; schema test rejects mutated fixture; views verified `security_invoker` | 22 | "One player, three leagues, one id" |
| **M3 NCAAWB live (trial key, Nov)** | prod resolver, `RateLimiter`, `QuotaGuard` + `product_quotas`, trial mode CLI + reservations, coverage-aware watcher, `clock_running` derivation; live run on one `full` + one `extended` game | `provider_calls` min spacing ≥1 s; per-game call totals vs reservation; `v_quota` after vs console; live changes reach subscriber with median lag from `wall_clock`; extended game emits only status/period, stats at `stats_final_at`; devlog states real call counts | 18 | "What two live games cost on a 1,000-call trial" |
| **M4 Push, deploy, hosted review** | push client + watchdog (push sim or local chunked mock), backfill reconciliation, WNBA push-clock → observation writes, `league:*:scores` channel, dead-letter requeue CLI, `game_changes` retention job, Fly deploy both groups, `/health`, alerts, `claude-review.yml`, Buffer gate | 30 s stream drop → reconnect + backfill, counts match; Fly worker restart re-acquires lock (logs + `/health`); outbox lag p95; dummy PR receives hosted review | 22 | "Killing the ingester on purpose, in prod" |
| **M5 iOS wiring + beta** | in Wehoop: Supabase Swift SDK, anonymous auth, generated `LiveEvent.swift`/`GameChange.swift`, `BroadcastGameEventSource: GameEventSource` (buffer → snapshot → apply → gap fill), PostgREST reads, clock countdown gated on `clockRunning`, TestFlight | replay renders live in Simulator; airplane mode 20 s → resync with no duplicate rows (screen recording); 3–5 testers | 26 | video: "Phone shows the replay" |

Planning range **120–150 h** (table sums to 120; agent infrastructure, TestFlight, and unknowns absorb the rest) ≈ **6–7.5 weeks** at 20 h/week, excluding waits for live games or external access. M0+M1 = 32 h ≈ 1.6 weeks; the first replayed game should stream by the end of week 2. Request the trial key when M3 tooling is ready.

## 8. Verification

Local E2E: `supabase start` → `supabase db reset` → `pnpm sim list --league wnba` → `pnpm dev:worker --mode sim --recording <id>` → `pnpm dev:api` → `pnpm subscribe --game <uuid>` → `curl :3000/v1/games/<uuid>/snapshot`.

`test/integration/invariants.sql` (validator runs these; each has an expected result):
- dupes: `select game_id, provider_event_id, count(*) from play_events group by 1,2 having count(*)>1` → 0 rows
- gaps (within retained history): `select count(*) from game_changes c where c.seq > coalesce(g.retained_from_seq,1) and not exists (select 1 from game_changes p where p.game_id=c.game_id and p.seq=c.seq-1)` joined to `games g` → 0
- head/tail: per game, `games.last_seq = coalesce(max(game_changes.seq), 0)` (empty game → both 0); if history fully expired, `retained_from_seq = last_seq + 1` and `/changes` returns `changes=[]`
- idempotence: `game_changes` count identical before and after applying the same batch twice
- no regression: `stale_observations` count > 0 after the restart-from-0–0 run and `games.home_points/away_points` unchanged
- outbox parity by join: `select count(*) from game_changes c full outer join ingest.broadcast_outbox o on o.change_id = c.id where c.id is null or o.change_id is null` → 0; `select count(*) from ingest.broadcast_outbox where dead_at is not null` → 0; `select channel, seq, count(*) ... having count(*)>1` → 0
- shape equality: `bin/subscribe --record` writes received `GameChange`s; test deep-equals them (after Zod parse) against `/changes` for the same range
- auth: anon key and guest JWT publish attempts return 4xx; second subscriber's recorded stream contains no message with those ids
- quota: `select * from ingest.v_quota`; spacing `min(called_at - lag(called_at) over (partition by product order by called_at))` ≥ 1 s

## 9. Risks

| Risk | Mitigation |
|---|---|
| Production pricing unknown/high | Nov trial proves NCAAWB; REST polling is a complete fallback; `provider_calls` gives real volumes for a quote |
| Push sims unavailable for WNBA/NCAAWB | `sim list` reports; M4 uses a local chunked NDJSON mock with heartbeats and disconnects |
| NCAAWB partial coverage | `coverage` in `v_schedule` ("score only"); trial watches `full` games first |
| Broadcast volume/cost | `pulse`/10 s + client countdown; `league:*:scores` channel; swap transport to SSE if needed. Free tier 200 conns / 100 msg/s |
| Trial quota small | trial mode + reservations; two to three games per product trial; rest via sims |
| Elam field names uncertain | `clock_extra jsonb`; normalizer accepts both spellings |
| Worker restarts / lock loss | session-mode lock, exit on loss, idempotent `applyChanges`, startup drain, backfill |
| `game_changes` growth | retention job per closed game; `/changes` returns 410 → snapshot |
| Buffer account mismatch | `DEVLOG_BUFFER` off until confirmed |

## Execution starts with M0

On approval: create `~/Projects/wehoop-api`, `git init`, scaffold toolchain, write `0001_core.sql` (public + ingest schemas, grants, RLS, realtime policy), CLAUDE.md, four agent files, two skills, `ci.yml`, copy the leaders fixture, first commit, create public GitHub repo, run `/milestone 0`.
