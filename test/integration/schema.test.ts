import postgres from 'postgres';
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

describe('change stream constraints', () => {
  it('rejects a second outbox row for the same change (PK is the change id)', async () => {
    await sql
      .begin(async (tx) => {
        const [game] = await tx<{ id: string }[]>`
        insert into public.games (league, provider_game_id, scheduled_at)
        values ('wnba', 'test-outbox-pk', now()) returning id
      `;
        if (!game) throw new Error('insert failed');
        const [change] = await tx<{ id: string }[]>`
        insert into public.game_changes (game_id, seq, change_type, body)
        values (${game.id}, 1, 'status', '{}'::jsonb) returning id
      `;
        if (!change) throw new Error('insert failed');
        await tx`update public.games set last_seq = 1 where id = ${game.id}`;
        await tx`insert into ingest.broadcast_outbox (change_id, channel, game_id, seq)
               values (${change.id}, ${`game:${game.id}`}, ${game.id}, 1)`;
        await expect(
          tx`insert into ingest.broadcast_outbox (change_id, channel, game_id, seq)
           values (${change.id}, ${`game:${game.id}`}, ${game.id}, 1)`,
        ).rejects.toThrow(/duplicate key/);
        // roll back by throwing
        throw new Error('__rollback__');
      })
      .catch((e: Error) => {
        if (e.message !== '__rollback__') throw e;
      });
  });

  it('game_changes rejects updates and deletes above retained_from_seq, allows deletes below', async () => {
    await sql
      .begin(async (tx) => {
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
        throw new Error('__rollback__');
      })
      .catch((e: Error) => {
        if (e.message !== '__rollback__') throw e;
      });
  });

  it('refuses a quota-counted provider call without a product', async () => {
    await expect(
      sql`insert into ingest.provider_calls (source, feed, url, quota_counted) values ('trial', 'pbp', 'https://x', true)`,
    ).rejects.toThrow(/check constraint/);
  });

  it('refuses outbox rows for non-game channels', async () => {
    await sql
      .begin(async (tx) => {
        const [game] = await tx<{ id: string }[]>`
          insert into public.games (league, provider_game_id, scheduled_at)
          values ('wnba', 'test-outbox-channel', now()) returning id`;
        if (!game) throw new Error('insert failed');
        const [change] = await tx<{ id: string }[]>`
          insert into public.game_changes (game_id, seq, change_type, body)
          values (${game.id}, 1, 'status', '{}'::jsonb) returning id`;
        if (!change) throw new Error('insert failed');
        await tx`update public.games set last_seq = 1 where id = ${game.id}`;
        await expect(
          tx`insert into ingest.broadcast_outbox (change_id, channel, game_id, seq)
             values (${change.id}, 'league:wnba:scores', ${game.id}, 1)`,
        ).rejects.toThrow(/check constraint/);
        throw new Error('__rollback__');
      })
      .catch((e: Error) => {
        if (e.message !== '__rollback__') throw e;
      });
  });

  it('rejects retained_from_seq beyond last_seq + 1', async () => {
    await expect(
      sql`insert into public.games (league, provider_game_id, scheduled_at, last_seq, retained_from_seq)
          values ('wnba', 'test-retained', now(), 0, 5)`,
    ).rejects.toThrow(/check constraint/);
  });
});
