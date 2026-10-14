# Current milestone

**M1 corrective pass** on branch `m1-first-replay` (PR #3, unmerged). Rev 4.3 of `docs/PLAN.md` ratifies the three M1 contract questions and names five correctness holes; this pass implements them, adds a committed reproducible replay fixture, implements `pnpm release:tag`, and re-runs the affected M1 evidence before a fresh review.

M1 proper (validated 14/14 at `fe529cf`, APPROVED-WITH-SHOULDS) is described below for context.

Scope (from `docs/PLAN.md` §7): `bin/sim`, `SimulationUrlResolver`, Zod pbp/summary/boxscore from recording, normalizer, WNBA adapter, `content-hash`, `freshness`, `applyChanges` (observation + durable writes), `GameChange` schema, `game_changes`, outbox + publisher (ordering, at-least-once, startup drain), pulse sender, `SupabaseBroadcastTransport` (private), session-lock worker, snapshot + paginated `/changes`, `bin/subscribe --record` implementing the full reconnect contract, plus the CLIs `/validate-replay` depends on: `dev:worker --until closed`, `pnpm dump-game`, `pnpm sim inject --mutate-event|--delete-event`.

Acceptance: see the M1 row of `docs/PLAN.md` §7 (idempotence, equivalence, no regression, freshness cases vs §4, correction, contiguity, outbox parity by join, crash points, missing final change, auth, equal shapes, final score matches boxscore). Evidence goes to `devlog/evidence/M1.md`.

Next: **M2 — Three leagues + identity.**
