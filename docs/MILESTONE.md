# Current milestone

**M0 — Scaffold** (branch: `main` bootstrap, then `m1-first-replay` next)

Scope: toolchain, Supabase local stack, `0001_core.sql`, CLAUDE.md, four agents, two skills, CI, first fixture.

Acceptance (from `docs/PLAN.md` §7):
- `pnpm supabase db reset` applies cleanly.
- `pnpm check` green locally and in CI.
- `anon` cannot read `ingest.*` (query evidence).
- `/milestone 0` ran all four local agents.

Next: **M1 — One recorded WNBA game, durable.**
