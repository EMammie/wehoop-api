# Evidence: M0 review follow-ups (branch `m0-review-followups`)

Validator run against the exact branch head. Every row below was produced by the command shown; output is captured, trimmed to the relevant lines, never edited. SQL that seeds rows was run inside a transaction that was rolled back, and the post-rollback counts are shown.

## Environment

Command:
`git rev-parse HEAD && git log --oneline main..HEAD && git status --porcelain`

Output:
```
30eb40ef53115c31c74aa4a3499e87b16623c56d
30eb40e test(integration): sub_run_has_parent check and parent_run_id restrict delete
232ab39 test(invariants): both generation FKs restrict delete
c861835 feat(schema): 0002 exactly the sub-run kinds carry a parent_run_id
5d789ee docs: freshness rev 4.2 – generation-less polls never write live state; 2c ignores explicitly deleted events
4d208ed test(integration): prove outbox UPDATE re-route, watch_run_id restrict, parent_run_id check
512632f test(invariants): watch_run FK restricts delete, outbox has exactly one FK
ffde997 feat(schema): 0002 watch generations – watch_run_id, parent_run_id, single outbox FK
e41e0ab docs: freshness rev 4.1 – watch generations, position-based gate, restrict run deletes
85abacb test(integration): prove outbox routing FK, generated channel, stale reasons, games columns
dc5e142 test(invariants): check outbox routing fields, generated channel, composite FK, no progress_key
8268a1e feat(schema): 0002 run-generation freshness columns and outbox routing constraints
95d7d2f docs: rev 4 plan – run-generation freshness policy and outbox routing constraints
```
(`git status --porcelain` printed nothing: working tree clean.)

| Item | Value |
|---|---|
| Date (UTC) | 2026-10-13T02:25:19Z |
| Commit | `30eb40ef53115c31c74aa4a3499e87b16623c56d` |
| Branch | `m0-review-followups` (12 commits ahead of `main`) |
| node | v25.9.0 |
| pnpm | 12.11.2 |
| supabase CLI | 2.120.0 |
| `pnpm supabase status` | running; `DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres` (stopped: imgproxy, pooler, both unused here) |
| Direct SQL | `docker exec supabase_db_wehoop-api psql -U postgres -d postgres -Atc "..."` (no `psql` on host) |
| Scope | M0_REVIEW.md "Required before accepting M1" items 1 (freshness design + schema support) and 2 (outbox routing enforced by constraint) |

Diff footprint of the branch (`git diff --stat main..HEAD`): `.claude/agents/reviewer.md`, `CLAUDE.md`, `docs/MILESTONE.md`, `docs/PLAN.md`, `supabase/migrations/0002_freshness_and_outbox_routing.sql` (new, 119 lines), `test/integration/invariants.sql`, `test/integration/schema.test.ts`; 7 files, +479/-109.

Note on the revision label: `docs/PLAN.md` line 1 reads `(rev 4)` and line 18 carries the Rev 4 note. The labels "rev 4.1" and "rev 4.2" exist only in the commit subjects `e41e0ab`, `5d789ee`, `c861835` (`grep -n "4\.2" docs/PLAN.md` matches nothing). The design under validation is PLAN.md §4 at HEAD, whatever the sub-label.

---

## 1. `pnpm supabase db reset` applies 0001 and 0002 cleanly

Command:
`pnpm supabase db reset`

Output:
```
Resetting local database...
Recreating database...
Initialising schema...
Seeding globals from roles.sql...
Applying migration 0001_core.sql...
Applying migration 0002_freshness_and_outbox_routing.sql...
Seeding data from supabase/seed.sql...
Restarting containers...
Finished supabase db reset on branch m0-review-followups.
{"target":"local","version":"","message":"Reset local database."}
exit: 0
```
Result: **PASS**

## 2. `pnpm check` green

Command:
`pnpm check; echo "exit: $?"` (script is `biome ci . && tsc --noEmit && vitest run`)

Output (ANSI colour codes stripped from the Biome line only):
```
$ biome ci . && tsc --noEmit && vitest run
Checked 18 files in 28ms. No fixes applied.

 RUN  v5.0.3 /Users/emammie/Projects/wehoop-api

 Test Files  1 passed (1)
      Tests  7 passed (7)
   Start at  22:30:30
   Duration  158ms (import 63%, transform 25%, tests 8%, worker 4%)

pnpm check exit: 0
```
`tsc --noEmit` prints nothing on success; the `&&` chain reaching `vitest run` proves it exited 0. Biome: 18 files, no fixes. Vitest unit: 7/7.
Result: **PASS**

## 3. `pnpm test:int` green

Command:
`DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres pnpm test:int; echo "exit: $?"`

Output:
```
$ VITEST_INTEGRATION=1 vitest run

 RUN  v5.0.3 /Users/emammie/Projects/wehoop-api

 Test Files  1 passed (1)
      Tests  24 passed (24)
   Start at  22:30:31
   Duration  205ms (tests 73%, import 13%, transform 12%, worker 1%)

pnpm test:int exit: 0
```

Command:
`grep -n "it(" test/integration/schema.test.ts`

Output:
```
23:  it('seeds the three leagues', async () => {
30:  it('seeds a quota row per product', async () => {
41:    it(`${role} can read public.leagues`, async () => {
49:    it(`${role} cannot insert into public.games`, async () => {
58:    it(`${role} cannot read ingest.provider_calls`, async () => {
67:    it(`${role} cannot read ingest.v_quota`, async () => {
77:  it('realtime.messages has a receive policy for game/league topics and no client insert policy', async () => {
119:  it('rejects a second outbox row for the same change (PK is the change id)', async () => {
133:  it('game_changes rejects updates and deletes above retained_from_seq, allows deletes below', async () => {
167:  it('refuses a quota-counted provider call without a product', async () => {
173:  it("rejects an outbox row whose game_id is not the referenced change's game", async () => {
189:  it("rejects an outbox row whose seq is not the referenced change's seq", async () => {
204:  it('refuses an explicitly supplied outbox channel (channel is generated)', async () => {
226:  it('derives channel = game:{game_id} for a correctly routed outbox row', async () => {
236:  it('stale_observations accepts the three freshness reasons and rejects any other', async () => {
261:  it('games carries watch-generation observation columns, no progress_key, no observed_run_id', async () => {
273:  it('rejects re-routing an existing outbox row to another game (UPDATE path)', async () => {
312:  it('games.watch_run_id must reference a real run, and that run cannot be deleted', async () => {
341:  it('ingestion_runs.parent_run_id: sub-runs need a parent, roots cannot have one, no self-parent, restrict delete', async () => {
391:  it('rejects retained_from_seq beyond last_seq + 1', async () => {
```
Count reconciliation: 20 `it(` sites; lines 41/49/58/67 sit inside `for (const role of ['anon', 'authenticated'] as const)` (line 40), so 4 sites x 2 roles = 8 tests + 16 others = 24, matching the vitest count. M0 had 16 integration tests (M0_REVIEW.md); the 8 new ones are lines 173-391 minus the pre-existing retained_from_seq test.
Result: **PASS**

## 4. `pnpm invariants` all hold

Command:
`DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres pnpm invariants; echo "exit: $?"`

Output:
```
$ tsx src/bin/invariants.ts
check                                       expect  actual  result
play_events_no_duplicate_provider_ids       0       0       PASS
game_changes_no_gaps_in_retained_history    0       0       PASS
games_last_seq_matches_max_change           0       0       PASS
outbox_matches_changes_exactly              0       0       PASS
outbox_no_dead_letters                      0       0       PASS
outbox_no_duplicate_game_seq                0       0       PASS
outbox_channel_is_generated                 1       1       PASS
outbox_has_composite_routing_fk             1       1       PASS
games_has_no_progress_key                   0       0       PASS
generation_fks_restrict_delete              2       2       PASS
outbox_has_single_fk                        1       1       PASS
anon_cannot_select_ingest_tables            0       0       PASS
anon_has_no_write_grants_on_public          0       0       PASS
public_tables_all_have_rls                  0       0       PASS
retained_head_exists                        0       0       PASS
anon_has_no_maintain_privilege_on_public    0       0       PASS
anon_has_no_usage_on_ingest_schema          0       0       PASS
public_schema_has_no_client_write_policies  0       0       PASS
realtime_has_no_client_insert_policy        0       0       PASS
game_changes_has_append_only_trigger        1       1       PASS
views_use_security_invoker                  0       0       PASS

21/21 invariants hold
pnpm invariants exit: 0
```
21/21 (M0 had 16/16; the 5 new checks are `outbox_channel_is_generated`, `outbox_has_composite_routing_fk`, `games_has_no_progress_key`, `generation_fks_restrict_delete`, `outbox_has_single_fk`; `outbox_matches_changes_exactly` was extended to compare `game_id`, `seq`, and `channel`).
Result: **PASS**

## 5. Outbox routing is unforgeable (direct SQL, rolled back)

Script (`\set VERBOSITY verbose` so SQLSTATE codes print; each failing statement is wrapped in a savepoint so the transaction continues):

Command:
`docker exec -i supabase_db_wehoop-api psql -U postgres -d postgres < row5_outbox_routing.sql`

Seed and ids:
```
begin;
insert into public.games (league, provider_game_id, scheduled_at) values ('wnba', 'validator-route-a', now()) returning id as a_game \gset
insert into public.games (league, provider_game_id, scheduled_at) values ('wnba', 'validator-route-b', now()) returning id as b_game \gset
insert into public.game_changes (game_id, seq, change_type, body) values (:'a_game', 1, 'status', '{}'::jsonb) returning id as a_change \gset
insert into public.game_changes (game_id, seq, change_type, body) values (:'b_game', 1, 'status', '{}'::jsonb) returning id as b_change \gset
update public.games set last_seq = 1 where id in (:'a_game', :'b_game');
UPDATE 2
                a_game                |               a_change               |                b_game                |               b_change
--------------------------------------+--------------------------------------+--------------------------------------+--------------------------------------
 3e7d99e8-4ee5-4f65-937b-0bbdd103ff3f | 9e453ea0-7596-4397-b0bb-2099741c1720 | 80370edc-73f7-4bc7-8892-0f94b6a07d28 | 256e9f36-c71e-4d69-ac0c-eb66fd85968e
```

(a) change of game A with game B's `game_id`:
```
insert into ingest.broadcast_outbox (change_id, game_id, seq) values (:'a_change', :'b_game', 1);
ERROR:  23503: insert or update on table "broadcast_outbox" violates foreign key constraint "broadcast_outbox_routes_its_change"
DETAIL:  Key (change_id, game_id, seq)=(9e453ea0-7596-4397-b0bb-2099741c1720, 80370edc-73f7-4bc7-8892-0f94b6a07d28, 1) is not present in table "game_changes".
CONSTRAINT NAME:  broadcast_outbox_routes_its_change
```
Expected 23503 `broadcast_outbox_routes_its_change`: matches.

(b) change of game A with the wrong `seq`:
```
insert into ingest.broadcast_outbox (change_id, game_id, seq) values (:'a_change', :'a_game', 2);
ERROR:  23503: insert or update on table "broadcast_outbox" violates foreign key constraint "broadcast_outbox_routes_its_change"
DETAIL:  Key (change_id, game_id, seq)=(9e453ea0-7596-4397-b0bb-2099741c1720, 3e7d99e8-4ee5-4f65-937b-0bbdd103ff3f, 2) is not present in table "game_changes".
CONSTRAINT NAME:  broadcast_outbox_routes_its_change
```
Expected 23503 `broadcast_outbox_routes_its_change`: matches.

(c) `channel` supplied explicitly, even with the correct value:
```
insert into ingest.broadcast_outbox (change_id, channel, game_id, seq) values (:'a_change', 'game:' || :'a_game', :'a_game', 1);
ERROR:  428C9: cannot insert a non-DEFAULT value into column "channel"
DETAIL:  Column "channel" is a generated column.
```
Expected 428C9: matches.

Seed the one legitimate outbox row (game A's own change), then (e) the generated channel:
```
insert into ingest.broadcast_outbox (change_id, game_id, seq) values (:'a_change', :'a_game', 1);
INSERT 0 1
select change_id = :'a_change' as is_a_change, channel, channel = 'game:' || game_id::text as channel_matches from ingest.broadcast_outbox where change_id = :'a_change';
 is_a_change |                  channel                  | channel_matches
-------------+-------------------------------------------+-----------------
 t           | game:3e7d99e8-4ee5-4f65-937b-0bbdd103ff3f | t
```
(e) `channel = 'game:' || game_id`: true.

(d1) update the existing row's `game_id` to game B while `(B, 1)` is free, so only the FK can object:
```
update ingest.broadcast_outbox set game_id = :'b_game' where change_id = :'a_change';
ERROR:  23503: insert or update on table "broadcast_outbox" violates foreign key constraint "broadcast_outbox_routes_its_change"
DETAIL:  Key (change_id, game_id, seq)=(9e453ea0-7596-4397-b0bb-2099741c1720, 80370edc-73f7-4bc7-8892-0f94b6a07d28, 1) is not present in table "game_changes".
CONSTRAINT NAME:  broadcast_outbox_routes_its_change
```
(d2) same update after game B's own outbox row occupies `(B, 1)`:
```
insert into ingest.broadcast_outbox (change_id, game_id, seq) values (:'b_change', :'b_game', 1);
INSERT 0 1
update ingest.broadcast_outbox set game_id = :'b_game' where change_id = :'a_change';
ERROR:  23505: duplicate key value violates unique constraint "broadcast_outbox_game_id_seq_key"
DETAIL:  Key (game_id, seq)=(80370edc-73f7-4bc7-8892-0f94b6a07d28, 1) already exists.
CONSTRAINT NAME:  broadcast_outbox_game_id_seq_key
```
Which and why: **23503** when the target `(game_id, seq)` slot is free (the composite FK is the only objector); **23505** when the slot is taken, because the unique index `broadcast_outbox_game_id_seq_key` is checked during the heap/index insert, before the RI trigger runs at end of statement. Both paths refuse the re-route; neither lets an outbox row point at another game.

Rollback and leak check:
```
select count(*) as outbox_rows_inside_txn from ingest.broadcast_outbox;   -> 2
rollback;
ROLLBACK
select count(*) as outbox_rows_after_rollback from ingest.broadcast_outbox; -> 0
psql exit: 0
```
Result: **PASS** (a 23503, b 23503, c 428C9, d 23503/23505 as explained, e true)

## 6. Routing catalog facts

Command:
`docker exec supabase_db_wehoop-api psql -U postgres -d postgres -Atc "select conname, contype, pg_get_constraintdef(oid) from pg_constraint where conrelid='ingest.broadcast_outbox'::regclass and contype='f' order by 1;"` and the same with `select count(*)`

Output:
```
broadcast_outbox_routes_its_change|f|FOREIGN KEY (change_id, game_id, seq) REFERENCES game_changes(id, game_id, seq) ON DELETE CASCADE
1
```
All constraints on the table, for completeness:
```
broadcast_outbox_routes_its_change|f|FOREIGN KEY (change_id, game_id, seq) REFERENCES game_changes(id, game_id, seq) ON DELETE CASCADE
broadcast_outbox_pkey|p|PRIMARY KEY (change_id)
broadcast_outbox_game_id_seq_key|u|UNIQUE (game_id, seq)
```

Command:
`... -Atc "select column_name, is_generated, generation_expression, is_nullable from information_schema.columns where table_schema='ingest' and table_name='broadcast_outbox' and column_name='channel';"`

Output:
```
channel|ALWAYS|('game:'::text || (game_id)::text)|NO
```

Command:
`... -Atc "select conname, contype, conrelid::regclass, pg_get_constraintdef(oid) from pg_constraint where conname='game_changes_id_game_id_seq_key';"`

Output:
```
game_changes_id_game_id_seq_key|u|game_changes|UNIQUE (id, game_id, seq)
```
Exactly one FK on `broadcast_outbox` and it is `broadcast_outbox_routes_its_change`; `channel` is `is_generated='ALWAYS'`, not null; the composite FK target `game_changes_id_game_id_seq_key` exists.
Result: **PASS**

## 7. Freshness schema support

Command:
`... -Atc "select column_name, data_type from information_schema.columns where table_schema='public' and table_name='games' and column_name in ('watch_run_id','current_period_sequence','progress_key') order by 1;"`
then `... count(*) ... column_name='progress_key'` and `... where conname='games_watch_run_id_fkey'`

Output:
```
current_period_sequence|integer
watch_run_id|bigint
0
games_watch_run_id_fkey|r|FOREIGN KEY (watch_run_id) REFERENCES ingest.ingestion_runs(id) ON DELETE RESTRICT
```
(`confdeltype = r` is RESTRICT. `progress_key` count 0: column is gone.)

Command:
`... -Atc "select column_name, data_type, is_nullable from information_schema.columns where table_schema='ingest' and table_name='ingestion_runs' and column_name='parent_run_id';"` and
`... -Atc "select conname, contype, confdeltype, pg_get_constraintdef(oid) from pg_constraint where conrelid='ingest.ingestion_runs'::regclass and conname in ('ingestion_runs_parent_run_id_fkey','ingestion_runs_not_own_parent','ingestion_runs_sub_run_has_parent') order by 1;"`

Output:
```
parent_run_id|bigint|YES
ingestion_runs_not_own_parent|c| |CHECK ((parent_run_id IS DISTINCT FROM id))
ingestion_runs_parent_run_id_fkey|f|r|FOREIGN KEY (parent_run_id) REFERENCES ingest.ingestion_runs(id) ON DELETE RESTRICT
ingestion_runs_sub_run_has_parent|c| |CHECK (((kind = ANY (ARRAY['push_stream'::text, 'backfill'::text])) = (parent_run_id IS NOT NULL)))
```

Command:
`... -Atc "select column_name, data_type from information_schema.columns where table_schema='ingest' and table_name='stale_observations' order by ordinal_position;"`,
`... -Atc "select conname, pg_get_constraintdef(oid) from pg_constraint where conname='stale_observations_reason_check';"`,
`... -Atc "select conname, confdeltype, pg_get_constraintdef(oid) from pg_constraint where conrelid='ingest.stale_observations'::regclass and contype='f' order by 1;"`

Output:
```
id|bigint
game_id|uuid
source|USER-DEFINED
observed_at|timestamp with time zone
observation|jsonb
stored|jsonb
reason|text
created_at|timestamp with time zone
run_id|bigint
stale_observations_reason_check|CHECK ((reason = ANY (ARRAY['older_run'::text, 'run_regresses_state'::text, 'superseded_observation'::text])))
stale_observations_game_id_fkey|c|FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
stale_observations_run_id_fkey|n|FOREIGN KEY (run_id) REFERENCES ingest.ingestion_runs(id) ON DELETE SET NULL
```
`observation`, `stored`, `observed_at`, `run_id` present; the reason check lists exactly `older_run`, `run_regresses_state`, `superseded_observation`. The `run_id` FK is `set null` (`confdeltype = n`), which matches the migration's stated intent that `stale_observations` is a log, not a generation marker; the two generation FKs (`games_watch_run_id_fkey`, `ingestion_runs_parent_run_id_fkey`) are the ones that restrict.
Result: **PASS**

## 8. Restrict semantics proven in SQL (rolled back)

Command:
`docker exec -i supabase_db_wehoop-api psql -U postgres -d postgres < row8_restrict.sql` (`\set VERBOSITY verbose`; savepoints around each expected failure)

(i) a `replay` run referenced by `games.watch_run_id` cannot be deleted:
```
insert into public.games (league, provider_game_id, scheduled_at) values ('wnba', 'validator-restrict', now()) returning id as g \gset
insert into ingest.ingestion_runs (kind, league, game_id, source) values ('replay', 'wnba', :'g', 'simulation') returning id as replay_run \gset
update public.games set watch_run_id = :replay_run where id = :'g' returning id, watch_run_id;
                  id                  | watch_run_id
--------------------------------------+--------------
 357c5d25-3f20-4821-a0c3-2da3b16bccaa |            6
delete from ingest.ingestion_runs where id = :replay_run;
ERROR:  23503: update or delete on table "ingestion_runs" violates foreign key constraint "games_watch_run_id_fkey" on table "games"
DETAIL:  Key (id)=(6) is still referenced from table "games".
CONSTRAINT NAME:  games_watch_run_id_fkey
```
(ii) a root `watch_game` run with a `push_stream` child cannot be deleted:
```
insert into ingest.ingestion_runs (kind, league, source) values ('watch_game', 'wnba', 'simulation') returning id as root_run \gset
insert into ingest.ingestion_runs (kind, league, source, parent_run_id) values ('push_stream', 'wnba', 'simulation', :root_run) returning id, kind, parent_run_id;
 id |    kind     | parent_run_id
----+-------------+---------------
  8 | push_stream |             7
delete from ingest.ingestion_runs where id = :root_run;
ERROR:  23503: update or delete on table "ingestion_runs" violates foreign key constraint "ingestion_runs_parent_run_id_fkey" on table "ingestion_runs"
DETAIL:  Key (id)=(7) is still referenced from table "ingestion_runs".
CONSTRAINT NAME:  ingestion_runs_parent_run_id_fkey
```
(iii) a `backfill` run without a parent is rejected:
```
insert into ingest.ingestion_runs (kind, league, source) values ('backfill', 'wnba', 'simulation');
ERROR:  23514: new row for relation "ingestion_runs" violates check constraint "ingestion_runs_sub_run_has_parent"
DETAIL:  Failing row contains (9, backfill, wnba, null, simulation, 2026-10-13 02:29:51.910332+00, null, running, 0, 0, 0, 0, null, null, null).
CONSTRAINT NAME:  ingestion_runs_sub_run_has_parent
```
Rollback and leak check:
```
select count(*) as runs_inside_txn from ingest.ingestion_runs;    -> 3
rollback;
ROLLBACK
select count(*) as runs_after_rollback from ingest.ingestion_runs; -> 0
psql exit: 0
```
Result: **PASS** (i 23503 `games_watch_run_id_fkey`, ii 23503 `ingestion_runs_parent_run_id_fkey`, iii 23514 `ingestion_runs_sub_run_has_parent`)

## 9. Access control unchanged

Command (the two invariant queries, run directly):
`... -Atc "select count(*) from information_schema.role_table_grants where grantee in ('anon','authenticated') and table_schema='ingest';"`
`... -Atc "select count(*) from information_schema.role_table_grants where grantee in ('anon','authenticated') and table_schema='public' and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE');"`
`... -Atc "select privilege_type, count(*) from information_schema.role_table_grants where grantee in ('anon','authenticated') and table_schema='public' group by 1 order by 1;"`

Output:
```
0
0
SELECT|32
```
(Zero grants of any kind on `ingest.*`; on `public.*` the only privilege held by `anon`/`authenticated` is SELECT, 32 grants across the two roles.)

Command:
`... -Atc "select count(*) from pg_policies where schemaname='realtime' and tablename='messages' and cmd in ('INSERT','ALL') and (roles::text[] && array['anon','authenticated','public']);"`
`... -Atc "select policyname, cmd, roles from pg_policies where schemaname='realtime' and tablename='messages' order by 1;"`

Output:
```
0
clients receive game and league broadcasts|SELECT|{anon,authenticated}
```
The only `realtime.messages` policy is the SELECT (receive) policy; no client INSERT/ALL policy. Also covered by invariants `anon_cannot_select_ingest_tables`, `anon_has_no_write_grants_on_public`, `anon_has_no_usage_on_ingest_schema`, `public_schema_has_no_client_write_policies`, `realtime_has_no_client_insert_policy` in row 4 (all PASS).
Result: **PASS**

## 10. No test data leaked

Command (run after rows 2-9, including the second `pnpm check` / `pnpm test:int` / `pnpm invariants` pass):
`... -Atc "select 'public.games', count(*) from public.games union all select 'public.game_changes', count(*) from public.game_changes union all select 'ingest.broadcast_outbox', count(*) from ingest.broadcast_outbox union all select 'ingest.stale_observations', count(*) from ingest.stale_observations union all select 'ingest.ingestion_runs', count(*) from ingest.ingestion_runs;"`

Output:
```
public.games|0
public.game_changes|0
ingest.broadcast_outbox|0
ingest.stale_observations|0
ingest.ingestion_runs|0
```
Command:
`... -Atc "select count(*) from public.games where provider_game_id like 'validator-%' or provider_game_id like 'test-%';"`

Output:
```
0
```
Result: **PASS**

## 11. Documentation consistency

Command:
`grep -n "progress_key" docs/PLAN.md CLAUDE.md .claude/agents/*.md; echo "exit: $?"`

Output:
```
exit: 1
```
Zero matches in the plan, CLAUDE.md, and all agent definitions: there are no historical mentions left to list (stricter than the acceptance wording, which allowed rev-note mentions). The Rev 4 note at `docs/PLAN.md:18` describes the change as replacing "the monotonic basketball-progress key" without the identifier. Repo-wide, the identifier survives only where it must (`grep -rn "progress_key" . --exclude-dir=node_modules --exclude-dir=.git`): `supabase/migrations/0001_core.sql:266,539,540` (the original columns), `0002_freshness_and_outbox_routing.sql:4,12,53,69,70` (the drop/rename and its rationale), `test/integration/invariants.sql:63,68` (the `games_has_no_progress_key` check), `test/integration/schema.test.ts:252,261,265` (negative assertions).

Command:
`grep -c "watch_run_id" docs/PLAN.md CLAUDE.md supabase/migrations/0002_freshness_and_outbox_routing.sql`

Output:
```
CLAUDE.md:1
supabase/migrations/0002_freshness_and_outbox_routing.sql:5
docs/PLAN.md:10
```
All >= 1.

Command:
`diff -q docs/PLAN.md ~/.claude/plans/logical-gliding-flask.md; echo "exit: $?"`

Output:
```
exit: 0
```
(`diff -q` prints nothing and exits 0: the files are identical.)
Result: **PASS**

## 12. Scope note: §4 freshness acceptance cases are M1 scope (not a pass/fail row)

Command:
``grep "Acceptance cases for `freshness.ts`" docs/PLAN.md | sed 's/.*M1 replay evidence): //' | tr ';' '\n' | sed '/^\s*$/d' | nl`` (sentence is at `docs/PLAN.md:149`)

Output:
```
 1  halftime → period 3 `inprogress` accepted
 2  clock correction 5:00 → 5:30 inside one period accepted and observed
 3  explicit deletion lowering the event count accepted as exactly one `event_delete`
 4  absence of events without a marker never deletes
 5  delayed REST (`observedAt` earlier than the stored push observation) → `superseded_observation`, no game-level write
 6  replay restart from 0–0 as a new generation → `run_regresses_state`
 7  in-flight batch from an older generation → `older_run`
 8  worker restart mid-game as a new generation → accepted
 9  a push sub-run and a backfill sub-run of the same generation interleave without either being marked stale
10  a generation-less schedule poll during a live game never advances `watch_run_id` and never overwrites a newer clock
11  a complete document missing one old event (not the newest) is not stale
12  a generation-less poll with a lagging score during a live game writes nothing game-level and logs `superseded_observation`
13  a new generation's first document that explicitly deletes the stored newest event is accepted and yields one `event_delete`.
count: 13
```
**13 acceptance cases** for `freshness.ts`. They are unit tests on code that does not exist yet (`src/ingest/freshness.ts` is M1), so M1's validator should expect 13 named cases, re-proven in the M1 replay evidence per the sentence itself. The four cases the M0 review demanded by name (halftime to second half, clock correction, deletion reducing play count, delayed REST racing newer push at equal progress) are items 1, 2, 3, and 5.

---

## Review history (as relayed by the caller; on-disk corroboration noted)

- Reviewer pass 1 on the rev 4 design + 0002: verdict APPROVED-WITH-SHOULDS. The shoulds and nits are enumerated in the body of commit `e41e0ab` ("docs: freshness rev 4.1"): concurrent run kinds per game (`parent_run_id` / `watch_run_id`), rule 2c compares newest event position instead of set containment, runs referenced by games are never pruned, `observed_source` is the enum; nits on gate placement, generation advance on acceptance, 2b using the batch's game view, post->pre when `last_seq=0`, dropping the redundant outbox `change_id` FK, snapshot omitting `watch_run_id`. Schema and tests for that pass landed in `ffde997`, `512632f`, `4d208ed`.
- Reviewer pass 2: verdict APPROVED-WITH-SHOULDS, shoulds resolved in `5d789ee` (rev 4.2 wording: generation-less polls never write live state; 2c ignores explicitly deleted events), `c861835` (`ingestion_runs_sub_run_has_parent`), `232ab39`, `30eb40e`.
- Remaining nits: the caller states they are listed in the PR. At validation time `gh pr list --state all` for this repo shows only PR #1 (`m0-review-fixes`, the M0 PR); no PR exists yet for `m0-review-followups`, so the nit list could not be read here. The verdict vocabulary `BLOCKED | APPROVED-WITH-SHOULDS | APPROVED` is defined at `.claude/agents/reviewer.md:36`; the only on-disk verdict record is M0's own (`devlog/evidence/M0.md:237`). The two pass verdicts above are therefore caller-reported, not independently validated.

## Summary

| # | Item | Result |
|---|---|---|
| 1 | `pnpm supabase db reset` applies 0001 and 0002 | PASS |
| 2 | `pnpm check` (Biome 18 files, tsc, vitest 7/7) | PASS |
| 3 | `pnpm test:int` 24/24 (20 `it(` sites, 4 of them x 2 roles) | PASS |
| 4 | `pnpm invariants` 21/21 | PASS |
| 5 | Outbox routing unforgeable in SQL (23503, 23503, 428C9, 23503/23505, channel derived) | PASS |
| 6 | Routing catalog: one FK `broadcast_outbox_routes_its_change`, `channel` ALWAYS generated, `game_changes_id_game_id_seq_key` | PASS |
| 7 | Freshness schema: `watch_run_id` restrict FK, `current_period_sequence`, no `progress_key`, `parent_run_id` restrict + 2 checks, `stale_observations` columns + 3-reason check | PASS |
| 8 | Restrict semantics in SQL (23503, 23503, 23514) | PASS |
| 9 | Access control unchanged (0 ingest grants, 0 public write grants, no client insert policy on realtime.messages) | PASS |
| 10 | No leaked test data (five tables at 0) | PASS |
| 11 | Docs consistent (no `progress_key`; `watch_run_id` in all three files; plan copies identical) | PASS |
| 12 | Scope note: 13 freshness acceptance cases deferred to M1 | n/a (recorded) |

**Overall verdict: PASS** — rows 1-11 all PASS at `30eb40ef53115c31c74aa4a3499e87b16623c56d`. M0 review findings 1 and 2 are answered at the schema level; the behavioural half of finding 1 (13 `freshness.ts` cases) and finding 3 (live Realtime authorization) remain M1 scope.

File: `/Users/emammie/Projects/wehoop-api/devlog/evidence/M0-followups.md`

## Addendum (coordinator, after validation)

Commit `2bfccad` was added after this validation run. It changes only `docs/PLAN.md` line 1 and the rev note (label `(rev 4)` → `(rev 4.2)`), which resolves the "revision label" note above. No SQL, test, or source file changed; the validated results for rows 1–11 apply unchanged. Devlog and evidence commits follow it.
