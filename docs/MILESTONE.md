# Current milestone

**M2 — Three leagues + identity** on branch `m2-three-leagues` (M1 merged as PR #3 and tagged `m1`; plan is rev 4.5).

Scope (from `docs/PLAN.md` §7): NCAAWB + Unrivaled adapters, schedule/boxscore/standings/hierarchy/profile/seasonal-stats/tournament schemas, `identity.ts`, `player_season_stats`, `tournaments` + OOT, PostgREST views (`security_invoker`), `/v1/players/:id`, Elam, coverage.

Acceptance (from `docs/PLAN.md` §7): per-league fixture replay row counts; one Unrivaled profile links WNBA + NCAAW ids and `/v1/players/:id` returns all three; Elam period row + target; OOT game attached to tournament; schema test rejects mutated fixture; views verified `security_invoker`. Evidence goes to `devlog/evidence/M2.md`.

Constraints this milestone: no production Sportradar calls and no trial key; NCAAWB comes from the simulation service, Unrivaled from committed fixtures with stated provenance.

Next: **M3 — NCAAWB live (trial key, Nov).**
