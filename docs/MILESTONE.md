# Current milestone

**M3 — NCAAWB live (trial key, Nov)** on branch `m3-ncaawb-live` (M2 merged as PR #4 and tagged `m2`; plan is rev 4.5).

Scope (from `docs/PLAN.md` §7): prod resolver, `RateLimiter`, `QuotaGuard` + `product_quotas`, trial mode CLI + reservations, coverage-aware watcher, `clock_running` derivation; live run on one `full` + one `extended` game; **assess coverage impact of held profiles** (rev 4.5 checkpoint): count open `player_merge_holds` after the live run, list the affected players, and state whether any appear in a watched game.

Acceptance (from `docs/PLAN.md` §7): `provider_calls` min spacing ≥1 s; per-game call totals vs reservation; `v_quota` after vs console; live changes reach subscriber with median lag from `wall_clock`; extended game emits only status/period, stats at `stats_final_at`; devlog states real call counts; **held-profile impact**: the open-hold count after the live run, the affected players (document id, league, candidate rows), and for each whether it appears in a watched game's `game_player_stats` (query evidence, even when the count is 0). Evidence goes to `devlog/evidence/M3.md`.

Constraints this milestone: the trial key is supplied by the owner via `.env` only (`SPORTRADAR_NCAAWB_KEY`); the coordinator and agents never request or activate a trial; no production services; every trial call is budgeted through a reservation and counted in `provider_calls`; until a key and live NCAAWB games exist (season opens early November), the code is built and verified against the simulation host and the live-run acceptance rows are recorded as NOT RUN with the exact commands to run later.

Next: **M4 — Push, deploy, hosted review.**
