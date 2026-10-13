import postgres, { type TransactionSql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Access-control and schema invariants against the local Supabase stack.
 * Requires `pnpm supabase start` and DATABASE_URL. The local `postgres` role is not a
 * superuser but has BYPASSRLS and membership in anon/authenticated, so `set local role`
 * lets us act as a client.
 */
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests');

const sql = postgres(url, { max: 2, prepare: false });

beforeAll(async () => {
  await sql`select 1`;
});
afterAll(async () => {
  await sql.end();
});

describe('schema: reference data', () => {
  it('seeds the three leagues', async () => {
    const rows = await sql<
      { code: string }[]
    >`select code::text as code from public.leagues order by code::text`;
    expect(rows.map((r) => r.code)).toEqual(['ncaawb', 'unrivaled', 'wnba']);
  });

  it('seeds a quota row per product', async () => {
    const rows = await sql<
      { product: string; remaining: number }[]
    >`select product, remaining from ingest.v_quota order by product`;
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(Number(r.remaining)).toBe(1000);
  });
});

describe('access control: anon and authenticated are read-only on public, blind to ingest', () => {
  for (const role of ['anon', 'authenticated'] as const) {
    it(`${role} can read public.leagues`, async () => {
      const rows = await sql.begin(async (tx) => {
        await tx.unsafe(`set local role ${role}`);
        return tx<{ code: string }[]>`select code from public.leagues`;
      });
      expect(rows.length).toBe(3);
    });

    it(`${role} cannot insert into public.games`, async () => {
      await expect(
        sql.begin(async (tx) => {
          await tx.unsafe(`set local role ${role}`);
          await tx`insert into public.games (league, provider_game_id, scheduled_at) values ('wnba', 'x', now())`;
        }),
      ).rejects.toThrow(/permission denied|row-level security/);
    });

    it(`${role} cannot read ingest.provider_calls`, async () => {
      await expect(
        sql.begin(async (tx) => {
          await tx.unsafe(`set local role ${role}`);
          await tx`select count(*) from ingest.provider_calls`;
        }),
      ).rejects.toThrow(/permission denied/);
    });

    it(`${role} cannot read ingest.v_quota`, async () => {
      await expect(
        sql.begin(async (tx) => {
          await tx.unsafe(`set local role ${role}`);
          await tx`select * from ingest.v_quota`;
        }),
      ).rejects.toThrow(/permission denied/);
    });
  }

  it('realtime.messages has a receive policy for game/league topics and no client insert policy', async () => {
    const policies = await sql<{ cmd: string; roles: string[] }[]>`
      select cmd, roles::text[] as roles from pg_policies
      where schemaname = 'realtime' and tablename = 'messages'
    `;
    const clientPolicies = policies.filter((p) =>
      p.roles.some((r) => r === 'anon' || r === 'authenticated'),
    );
    expect(clientPolicies.some((p) => p.cmd === 'SELECT')).toBe(true);
    expect(clientPolicies.some((p) => p.cmd === 'INSERT' || p.cmd === 'ALL')).toBe(false);
  });
});

type Tx = TransactionSql;

/** Inserts a game with one durable change (seq 1) inside `tx`. Rolled back by the caller. */
async function seedGameWithChange(tx: Tx, providerGameId: string) {
  const [game] = await tx<{ id: string }[]>`
    insert into public.games (league, provider_game_id, scheduled_at)
    values ('wnba', ${providerGameId}, now()) returning id`;
  if (!game) throw new Error('game insert failed');
  const [change] = await tx<{ id: string }[]>`
    insert into public.game_changes (game_id, seq, change_type, body)
    values (${game.id}, 1, 'status', '{}'::jsonb) returning id`;
  if (!change) throw new Error('change insert failed');
  await tx`update public.games set last_seq = 1 where id = ${game.id}`;
  return { gameId: game.id, changeId: change.id };
}

/** Runs `fn` in a transaction that is always rolled back, so fixtures never leak. */
async function rolledBack(fn: (tx: Tx) => Promise<void>) {
  await sql
    .begin(async (tx) => {
      await fn(tx);
      throw new Error('__rollback__');
    })
    .catch((e: Error) => {
      if (e.message !== '__rollback__') throw e;
    });
}

describe('change stream constraints', () => {
  it('rejects a second outbox row for the same change (PK is the change id)', async () => {
    await rolledBack(async (tx) => {
      const { gameId, changeId } = await seedGameWithChange(tx, 'test-outbox-pk');
      await tx`insert into ingest.broadcast_outbox (change_id, game_id, seq)
               values (${changeId}, ${gameId}, 1)`;
      await expect(
        tx.savepoint(
          (sp) => sp`insert into ingest.broadcast_outbox (change_id, game_id, seq)
                     values (${changeId}, ${gameId}, 1)`,
        ),
      ).rejects.toMatchObject({ code: '23505', message: expect.stringMatching(/duplicate key/) });
    });
  });

  it('game_changes rejects updates and deletes above retained_from_seq, allows deletes below', async () => {
    await rolledBack(async (tx) => {
      const [game] = await tx<{ id: string }[]>`
        insert into public.games (league, provider_game_id, scheduled_at)
        values ('wnba', 'test-append-only', now()) returning id
      `;
      if (!game) throw new Error('insert failed');
      for (const seq of [1, 2, 3]) {
        await tx`insert into public.game_changes (game_id, seq, change_type, body)
                 values (${game.id}, ${seq}, 'status', '{}'::jsonb)`;
      }
      await tx`update public.games set last_seq = 3 where id = ${game.id}`;
      // Each expected failure runs in its own savepoint so the outer tx stays usable.
      await expect(
        tx.savepoint(
          (sp) =>
            sp`update public.game_changes set body = '{"x":1}'::jsonb where game_id = ${game.id} and seq = 1`,
        ),
      ).rejects.toThrow(/append-only/);
      await expect(
        tx.savepoint(
          (sp) => sp`delete from public.game_changes where game_id = ${game.id} and seq = 1`,
        ),
      ).rejects.toThrow(/cannot be deleted/);
      // retention job moves the floor, then the old row may go
      await tx`update public.games set retained_from_seq = 2 where id = ${game.id}`;
      await tx`delete from public.game_changes where game_id = ${game.id} and seq = 1`;
      const [left] = await tx<
        { n: number }[]
      >`select count(*)::int as n from public.game_changes where game_id = ${game.id}`;
      expect(left?.n).toBe(2);
    });
  });

  it('refuses a quota-counted provider call without a product', async () => {
    await expect(
      sql`insert into ingest.provider_calls (source, feed, url, quota_counted) values ('trial', 'pbp', 'https://x', true)`,
    ).rejects.toThrow(/check constraint/);
  });

  it("rejects an outbox row whose game_id is not the referenced change's game", async () => {
    await rolledBack(async (tx) => {
      const a = await seedGameWithChange(tx, 'test-outbox-route-a');
      const b = await seedGameWithChange(tx, 'test-outbox-route-b');
      await expect(
        tx.savepoint(
          (sp) => sp`insert into ingest.broadcast_outbox (change_id, game_id, seq)
                     values (${a.changeId}, ${b.gameId}, 1)`,
        ),
      ).rejects.toMatchObject({
        code: '23503',
        message: expect.stringMatching(/broadcast_outbox_routes_its_change/),
      });
    });
  });

  it("rejects an outbox row whose seq is not the referenced change's seq", async () => {
    await rolledBack(async (tx) => {
      const { gameId, changeId } = await seedGameWithChange(tx, 'test-outbox-route-seq');
      await expect(
        tx.savepoint(
          (sp) => sp`insert into ingest.broadcast_outbox (change_id, game_id, seq)
                     values (${changeId}, ${gameId}, 2)`,
        ),
      ).rejects.toMatchObject({
        code: '23503',
        message: expect.stringMatching(/broadcast_outbox_routes_its_change/),
      });
    });
  });

  it('refuses an explicitly supplied outbox channel (channel is generated)', async () => {
    await rolledBack(async (tx) => {
      const { gameId, changeId } = await seedGameWithChange(tx, 'test-outbox-channel');
      // Even the "correct" value is refused: the column can only be derived.
      await expect(
        tx.savepoint(
          (sp) => sp`insert into ingest.broadcast_outbox (change_id, channel, game_id, seq)
                     values (${changeId}, ${`game:${gameId}`}, ${gameId}, 1)`,
        ),
      ).rejects.toMatchObject({
        code: '428C9',
        message: expect.stringMatching(/cannot insert a non-DEFAULT value into column "channel"/),
      });
      await expect(
        tx.savepoint(
          (sp) => sp`insert into ingest.broadcast_outbox (change_id, channel, game_id, seq)
                     values (${changeId}, 'league:wnba:scores', ${gameId}, 1)`,
        ),
      ).rejects.toMatchObject({ code: '428C9' });
    });
  });

  it('derives channel = game:{game_id} for a correctly routed outbox row', async () => {
    await rolledBack(async (tx) => {
      const { gameId, changeId } = await seedGameWithChange(tx, 'test-outbox-derived');
      const [row] = await tx<{ channel: string }[]>`
        insert into ingest.broadcast_outbox (change_id, game_id, seq)
        values (${changeId}, ${gameId}, 1) returning channel`;
      expect(row?.channel).toBe(`game:${gameId}`);
    });
  });

  it('stale_observations accepts the three freshness reasons and rejects any other', async () => {
    await rolledBack(async (tx) => {
      const { gameId } = await seedGameWithChange(tx, 'test-stale-reasons');
      for (const reason of ['older_run', 'run_regresses_state', 'superseded_observation']) {
        await tx`insert into ingest.stale_observations (game_id, source, observed_at, observation, reason)
                 values (${gameId}, 'simulation', now(), '{}'::jsonb, ${reason})`;
      }
      const [n] = await tx<
        { n: number }[]
      >`select count(*)::int as n from ingest.stale_observations where game_id = ${gameId}`;
      expect(n?.n).toBe(3);
      await expect(
        tx.savepoint(
          (
            sp,
          ) => sp`insert into ingest.stale_observations (game_id, source, observed_at, observation, reason)
                     values (${gameId}, 'simulation', now(), '{}'::jsonb, 'progress_key_lower')`,
        ),
      ).rejects.toMatchObject({
        code: '23514',
        message: expect.stringMatching(/stale_observations_reason_check/),
      });
    });
  });

  it('games carries run-generation observation columns and no progress_key', async () => {
    const cols = await sql<{ column_name: string; data_type: string }[]>`
      select column_name, data_type from information_schema.columns
      where table_schema = 'public' and table_name = 'games'
        and column_name in ('progress_key', 'observed_run_id', 'current_period_sequence')
      order by column_name`;
    expect(cols).toEqual([
      { column_name: 'current_period_sequence', data_type: 'integer' },
      { column_name: 'observed_run_id', data_type: 'bigint' },
    ]);
  });

  it('rejects retained_from_seq beyond last_seq + 1', async () => {
    await expect(
      sql`insert into public.games (league, provider_game_id, scheduled_at, last_seq, retained_from_seq)
          values ('wnba', 'test-retained', now(), 0, 5)`,
    ).rejects.toThrow(/check constraint/);
  });
});
