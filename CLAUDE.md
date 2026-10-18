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
pnpm dev:worker --mode sim --league wnba --recording <id> --until closed   # replay one recording (3 s pbp polls)
pnpm dev:worker --mode sim --league wnba --replay-file <jsonl> --pace 0    # replay a recorded session from disk
pnpm dev:api                 # Hono API on :3000 (snapshot, changes, health)
pnpm sim list --league wnba  # list Sportradar simulation recordings (no API key)
pnpm sim inject --game <uuid> --mutate-event <id> | --delete-event <id>   # inject a correction / deletion
pnpm sim record --league wnba --recording <id> --out <file.jsonl>          # DB-free natural-pace recorder (replay fixture step 1)
pnpm sim compact --in <full.jsonl> --out <file.jsonl.gz> [--target-mb 4]   # deterministic down-sample (replay fixture step 2)
pnpm subscribe --game <uuid> --record <jsonl> [--auth guest]   # reference client: subscribe + reconnect contract
pnpm dump-game --game <uuid> # canonical JSON of play_events bodies, periods, score (for replay diffs)
pnpm release:tag --milestone <n> [--push]   # on main, clean tree, evidence all PASS: annotated tag m<n> at HEAD
pnpm invariants              # run test/integration/invariants.sql against local DB
pnpm trial:rehearsal <cmd>   # trial CLI with .env + .env.rehearsal (fake keys, loopback `pnpm sim serve`)
pnpm trial:live <cmd>        # trial CLI with .env + .env.trial (REAL keys): run `pnpm preflight:live` first
pnpm preflight:live | preflight:rehearsal   # what a live run would do, no secrets; exit 0 = ready, 65 = problems
pnpm worker:live | worker:rehearsal, pnpm api:live | api:rehearsal   # the same env loading for worker / API
pnpm trial:db start|status|stop|migration up --local   # persistent trial stack (supabase-trial/, ports +1000); NEVER `db reset`
```

`tsx` loads no `.env`: the plain `pnpm trial` / `dev:worker` / `dev:api` / `sim` / `invariants` scripts read only exported shell variables. The `*:live` / `*:rehearsal` scripts are `node --env-file=.env --env-file=.env.<name> --import tsx src/bin/<x>.ts`.

## Environments

| File | Contents | Database | Loaded by |
|---|---|---|---|
| `.env` | `MODE=sim`, no Sportradar key, dev stack URLs | dev/integration stack (`pnpm supabase start`, db 54322; `db reset` and `pnpm test:int` destroy it) | every script, first |
| `.env.trial` (git-ignored, chmod 600) | real trial keys, `MODE=trial`, `SPORTRADAR_BASE_URL` unset, `QUOTA_*` blank | **persistent trial stack** (`pnpm trial:db start`, db 55322, API 55321; its `ingest` schema is the quota ledger) | only `pnpm trial:live`, `worker:live`, `api:live`, `preflight:live`, second |
| `.env.rehearsal` (git-ignored; copy `.env.rehearsal.example`) | fake keys, `MODE=trial`, `SPORTRADAR_BASE_URL=http://127.0.0.1:8787` (`pnpm sim serve`) | dev stack (from `.env`) | only the `*:rehearsal` scripts, second |

Rules: the later file overrides the earlier; **exported shell variables override both files, so `unset` stale exports (`MODE`, `SPORTRADAR_*`, `DATABASE_URL`, `QUOTA_*`) before switching**. Leave `QUOTA_*` blank so an environment override cannot replace the verified database values (`pnpm trial:live quota …` writes them). `loadConfig` refuses `MODE=trial|production` on the dev stack unless `TRIAL_ALLOW_DEV_DB=1` (a rehearsal is exempt). Never `pnpm trial:db db reset`: it erases `provider_calls`, reservations, verified limits and rate slots while Sportradar keeps counting; apply new migrations with `pnpm trial:db migration up --local`. Before any live command: `pnpm preflight:live` must exit 0. Never read, print or commit `.env.trial`.

`WEHOOP_FAULT=before_commit[:seq]|after_publish[:seq]` makes the worker SIGKILL itself at a crash point (M1 evidence only; refused in production).

## Non-negotiables

1. **Zod at every provider boundary.** Nothing from Sportradar, Supabase, or env is used until parsed. Provider schemas are `.loose()` at the top level and strict on fields we persist.
2. **All writes to game state go through `src/ingest/apply-changes.ts`.** No other module writes `games`, `play_events`, `game_changes`, `game_periods`, or stats tables.
3. **Durable vs observation writes.** Score, period, status, play events, and stats are durable: they allocate `seq`, append `game_changes`, and insert `broadcast_outbox` in the same transaction. Clock and freshness metadata are observations: they update `games` observation columns and never touch `seq`.
4. **Freshness before diff.** Freshness is decided by watch generation (`games.watch_run_id`, inherited by sub-runs via `ingestion_runs.parent_run_id`) and per-entity precedence (`docs/PLAN.md` §4), never by a monotonic progress score and never by hash inequality alone. A batch from an older generation, or a new generation whose game-level phase or period, or newest event position, is behind stored state, is stale: log to `ingest.stale_observations`, write nothing else. A new generation's summary-only document with a lower score is stale only when its clock places it earlier in the period (rule 2(d)); without a clock it is held as `ambiguous_regression` until corroborated. Within a generation, corrections that lower the clock, the score, or the event count are legitimate and are applied; a newer revision with an identical body advances `provider_updated_at` without a change; events are deleted only by an explicit provider marker (whose revision is persisted and may be older and ignored), never by absence; game-level fields follow the newest `observedAt`; omitted fields never overwrite stored values; an unknown provider status keeps the stored status.
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
