# Current milestone

**M0 — Scaffold** (merged, tagged `m0`) → **pre-M1 fixes** on branch `m0-review-followups` (migration `0002`: run-generation freshness columns, outbox routing constraints), then `m1-first-replay`

Scope: toolchain, Supabase local stack, `0001_core.sql`, CLAUDE.md, four agents, two skills, CI, first fixture.

Acceptance (from `docs/PLAN.md` §7):
- `pnpm supabase db reset` applies cleanly.
- `pnpm check` green locally and in CI.
- `anon` cannot read `ingest.*` (query evidence).
- `/milestone 0` ran all four local agents.

Next: **M1 — One recorded WNBA game, durable.**
