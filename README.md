# wehoop-api

Backend for **Wehoop**, a live stats app for women's basketball: WNBA, NCAA Women's Basketball, and Unrivaled, on Sportradar data. Built in public, one milestone at a time, with Claude Code agents doing implementation, review, and evidence-based validation. The devlog lives in [`devlog/`](devlog/).

**Status:** M0 scaffold. See [`docs/MILESTONE.md`](docs/MILESTONE.md) and the full plan in [`docs/PLAN.md`](docs/PLAN.md).

## What it does (when finished)

- Ingests schedules, box scores, play-by-play, standings, and player profiles for all three leagues through one shared model, with a canonical player identity that follows a player from college to the WNBA to Unrivaled.
- Holds live games as a **current state** table plus an **append-only, gap-free change stream** per game, so a phone can reconnect at any point and catch up exactly.
- Publishes changes to Supabase Realtime Broadcast on private, receive-only channels, and serves snapshots and change pages over a small REST API.
- Runs against Sportradar's free simulation recordings first, then a trial key, then production.

## Stack

Node 22 · TypeScript · pnpm · Vitest · Biome · Hono · Zod · pino · `postgres` · Supabase (Postgres, Realtime, anonymous auth) · Fly.io for the worker.

## Local development

```bash
pnpm install
pnpm supabase start            # Docker required; prints local keys
pnpm supabase db reset         # apply migrations
cp .env.example .env           # paste the printed anon / service_role keys
pnpm check                     # lint + types + unit tests
pnpm test:int                  # integration tests against the local stack
pnpm invariants                # change-stream and access-control invariants
```

## Working with the agents

```
/milestone <n>                 # implementer → reviewer → validator → devlog
/validate-replay <league> <id> # replay a Sportradar recording and prove the invariants
```

Agent definitions are in `.claude/agents/`, rules of engagement in `CLAUDE.md`.

## Data

Sportradar is the data provider. This repository contains no API keys and no raw provider payloads beyond small curated fixtures used for schema tests. Sportradar's APIs are B2B; the iOS app never calls them directly.

## License

MIT
