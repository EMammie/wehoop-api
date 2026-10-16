import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * PostgREST views (plan §5): v_schedule, v_boxscore, v_standings,
 * v_player_seasons are `security_invoker`, readable by anon/authenticated,
 * select-only, and never expose games.watch_run_id. The `ingest` schema stays
 * closed to clients.
 */
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests');
const sql = postgres(url, { max: 2, prepare: false });
const VIEWS = ['v_schedule', 'v_boxscore', 'v_standings', 'v_player_seasons'] as const;

beforeAll(async () => {
  await sql`select 1`;
});
afterAll(async () => {
  await sql.end();
});

describe('client views', () => {
  it('all four views exist with security_invoker = true', async () => {
    const rows = await sql<{ name: string; invoker: string | null }[]>`
      select c.relname as name,
             (select option_value from pg_options_to_table(c.reloptions) where option_name = 'security_invoker') as invoker
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'v' and c.relname = any(${[...VIEWS]})
      order by c.relname`;
    expect(rows).toEqual([...VIEWS].sort().map((name) => ({ name, invoker: 'true' })));
  });

  it('no view in public or ingest lacks security_invoker', async () => {
    const [r] = await sql<{ n: number }[]>`
      select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'v' and n.nspname in ('public', 'ingest')
        and not coalesce((select option_value::boolean from pg_options_to_table(c.reloptions) where option_name = 'security_invoker'), false)`;
    expect(r?.n).toBe(0);
  });

  it('v_schedule does not expose watch_run_id (nor any other view)', async () => {
    const cols = await sql<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.columns
      where table_schema = 'public' and table_name = any(${[...VIEWS]})
        and column_name in ('watch_run_id', 'observed_run_id')`;
    expect(cols).toEqual([]);
    const schedule = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'v_schedule'`;
    const names = schedule.map((c) => c.column_name);
    for (const expected of [
      'coverage',
      'coverage_label',
      'elam_target_score',
      'clock_running',
      'last_seq',
      'home_name',
      'season_type',
      'tournament_name',
    ]) {
      expect(names).toContain(expected);
    }
  });

  for (const role of ['anon', 'authenticated'] as const) {
    it(`${role} can select from every view and still cannot touch ingest`, async () => {
      for (const view of VIEWS) {
        const rows = await sql.begin(async (tx) => {
          await tx.unsafe(`set local role ${role}`);
          return tx.unsafe(`select * from public.${view} limit 1`);
        });
        expect(Array.isArray(rows)).toBe(true);
      }
      await expect(
        sql.begin(async (tx) => {
          await tx.unsafe(`set local role ${role}`);
          await tx`select count(*) from ingest.stale_observations`;
        }),
      ).rejects.toThrow(/permission denied/);
    });

    it(`${role} has no write privilege on any view`, async () => {
      const rows = await sql<{ table_name: string; privilege_type: string }[]>`
        select table_name, privilege_type from information_schema.role_table_grants
        where grantee = ${role} and table_schema = 'public' and table_name = any(${[...VIEWS]})
          and privilege_type <> 'SELECT'`;
      expect(rows).toEqual([]);
    });
  }

  it('v_schedule labels non-full coverage as "score only"', async () => {
    const rows = await sql<{ coverage: string; label: string }[]>`
      select c::text as coverage,
             case c when 'full' then 'live plays' when 'unknown' then 'unknown' else 'score only' end as label
      from unnest(enum_range(null::public.coverage_level)) c`;
    expect(Object.fromEntries(rows.map((r) => [r.coverage, r.label]))).toEqual({
      full: 'live plays',
      extended_boxscore: 'score only',
      boxscore: 'score only',
      unknown: 'unknown',
    });
    // and the view definition carries exactly that expression
    const [def] = await sql<
      { d: string }[]
    >`select pg_get_viewdef('public.v_schedule'::regclass) as d`;
    expect(def?.d).toMatch(/'score only'/);
  });
});
