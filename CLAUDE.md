# wehoop-api

Backend for Wehoop, a live stats app for women's basketball (WNBA, NCAA Women's, Unrivaled) on Sportradar data. Node 22 + TypeScript worker on Fly.io, Supabase for Postgres + Realtime Broadcast + anonymous auth. The iOS client lives in a separate repo.

Full plan with rationale: `docs/PLAN.md`. Current milestone: see `docs/MILESTONE.md`.

## Commands

```
pnpm supabase start          # local stack (Docker). Studio at http://127.0.0.1:54323
pnpm supabase db reset       # drop + apply supabase/migrations + seed
pnpm check                   # biome ci + tsc --noEmit + vitest run (unit)
pnpm test                    # unit tests
pnpm test:int                # integration tests; requires `supabase start`
pnpm dev:worker              # ingestion worker (reads MODE=sim|trial|production)
pnpm dev:api                 # Hono API on :3000
pnpm sim list --league wnba  # list Sportradar simulation recordings (no API key)
pnpm subscribe --game <uuid> # reference client: subscribe + reconnect contract
pnpm invariants              # run test/integration/invariants.sql against local DB
```

## Non-negotiables

1. **Zod at every provider boundary.** Nothing from Sportradar, Supabase, or env is used until parsed. Provider schemas are `.loose()` at the top level and strict on fields we persist.
2. **All writes to game state go through `src/ingest/apply-changes.ts`.** No other module writes `games`, `play_events`, `game_changes`, `game_periods`, or stats tables.
3. **Durable vs observation writes.** Score, period, status, play events, and stats are durable: they allocate `seq`, append `game_changes`, and insert `broadcast_outbox` in the same transaction. Clock and freshness metadata are observations: they update `games` observation columns and never touch `seq`.
4. **Freshness before diff.** Freshness is decided by watch generation (`games.watch_run_id`, inherited by sub-runs via `ingestion_runs.parent_run_id`) and per-entity precedence (`docs/PLAN.md` §4), never by a monotonic progress score and never by hash inequality alone. A batch from an older generation, or a new generation whose game-level phase or period, or newest event position, is behind stored state, is stale: log to `ingest.stale_observations`, write nothing else. Within a generation, corrections that lower the clock or the event count are legitimate and are applied; events are deleted only by an explicit provider marker, never by absence; game-level fields follow the newest `observedAt`.
5. **`game_changes` is append-only.** Code never updates or deletes rows. Retention is a separate job that moves `games.retained_from_seq`.
6. **One `GameChange` schema** (`src/model/game-change.ts`) for Broadcast, `/changes`, and storage. Equality is tested on decoded objects, never JSON bytes.
7. **No `any`.** `tsc --noEmit` and Biome must be green before any handoff.
8. **Simulation and fixture calls never count toward quota.** `provider_calls.quota_counted` is true only for `trial` and `production`.
9. **Secrets only via env.** Never in code, fixtures, or devlog. `.env.example` lists every variable.
10. **Clients can only read.** No RLS write policies for `anon`/`authenticated`, no Realtime insert policy, `ingest` schema never exposed.
11. **Lowercase snake_case in SQL**, `timestamptz` for time, `text` not `varchar`, index every FK.

## Repo map

```
src/model      LiveEvent union, GameChange schema, game-state reducer, content hash
src/providers  Sportradar HTTP, URL resolvers (prod | simulation), Zod schemas, push client
src/leagues    LeagueAdapter interface + wnba / ncaawb / unrivaled adapters
src/ingest     freshness, apply-changes, scheduler, trial-mode, game-watcher, backfill, identity
src/live       LiveTransport interface, Supabase Broadcast transport, outbox publisher, pulse
src/api        Hono routes: snapshot, changes, players, health
src/bin        worker, api, sim, subscribe CLIs
supabase/      config + SQL migrations (the only schema source of truth)
fixtures/      recorded provider payloads, committed
test/          unit (vitest) and integration (needs supabase start) + invariants.sql
devlog/        one post draft per milestone + evidence/MN.md
```

## Milestone workflow

Each milestone runs `/milestone <n>`: implementer → reviewer (≤2 blocker loops) → validator → devlog. A milestone is **done** only when `devlog/evidence/M<n>.md` contains every evidence line from the plan's acceptance table, each with the exact command that produced it and its captured output. "Tests pass" alone is never evidence. The user merges; `pnpm release:tag` tags the validated merge commit.

Agents: `.claude/agents/implementer.md`, `reviewer.md`, `validator.md`, `devlog.md`. Skills: `.claude/skills/milestone`, `.claude/skills/validate-replay`.

Agent write boundaries ("validator writes only under `devlog/evidence/`", "implementer never touches `.github/`", "reviewer is read-only") are enforced by review, not by tooling: the `tools:` frontmatter cannot scope paths. The reviewer checks `git diff --stat` for out-of-bounds files on every milestone.

## Devlog conventions

`devlog/NN-<slug>.md`: a post draft (hook, what shipped, what broke, what's next), a capture checklist (which terminal recordings / screenshots to take), and three alternative hooks. Numbers come from `devlog/evidence/` only. Buffer posting is gated by `DEVLOG_BUFFER=1`.

## Reference material (read, don't copy)

- Wehoop iOS repo: `~/Desktop/Development/Wehoop/Wehoop/Wehoop/Data/DTOs/Sportradar/SportradarResponseDTOs.swift` (Unrivaled v8 shapes; its standings DTO is wrong, don't port it).
- Courtside: `~/Desktop/Development/Courtside/CourtsideKit/Sources/CourtsideEngine/GameEvent.swift` (closed enum style the Swift mirror should match).
- Sportradar docs: https://developer.sportradar.com/basketball/reference/{wnba,ncaawb,unrivaled}-overview and `getting-started/docs/simulations`.
- The `NBA_*_Sandbox` folders in Development contain copied employer code. Never read them for reuse.
