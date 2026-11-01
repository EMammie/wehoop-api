import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { VIEW_ROW_SCHEMAS } from '../../src/model/views.js';

/**
 * The Zod row schemas in src/model/views.ts (the source of the generated Swift
 * view rows, M5 B1) must match the views in the database: same columns, same
 * order, and a base type compatible with the column's Postgres type. The SQL
 * is the source of truth; a migration that adds, drops or retypes a view
 * column fails here until the Zod schema follows (and then `pnpm gen:swift`).
 * Nullability is not recorded on views by Postgres and is reviewed by hand.
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

type Kind = 'string' | 'int' | 'number' | 'boolean' | 'json' | 'enum';

/** Base kind of a Zod field, looking through nullable/optional. */
function zodKind(schema: z.ZodType): { kind: Kind; entries?: string[] } {
  // biome-ignore lint/suspicious/noExplicitAny: test-only introspection of Zod internals
  let d = (schema as any)._zod.def;
  while (d.type === 'nullable' || d.type === 'optional') d = d.innerType._zod.def;
  switch (d.type) {
    case 'string':
      return { kind: 'string' };
    case 'number':
      return { kind: d.format === 'safeint' ? 'int' : 'number' };
    case 'boolean':
      return { kind: 'boolean' };
    case 'record':
      return { kind: 'json' };
    case 'enum':
      return { kind: 'enum', entries: Object.values(d.entries) as string[] };
    default:
      throw new Error(`unexpected zod type ${d.type}`);
  }
}

const UDT_KIND: Record<string, Kind> = {
  uuid: 'string',
  text: 'string',
  timestamptz: 'string',
  date: 'string',
  int4: 'int',
  int8: 'int',
  numeric: 'number',
  bool: 'boolean',
  jsonb: 'json',
};

describe('view rows match the Zod contract', () => {
  for (const [view, schema] of Object.entries(VIEW_ROW_SCHEMAS)) {
    it(`${view}: same columns in the same order, compatible types`, async () => {
      const cols = await sql<{ column_name: string; udt_name: string; data_type: string }[]>`
        select column_name, udt_name, data_type from information_schema.columns
        where table_schema = 'public' and table_name = ${view} order by ordinal_position`;
      // biome-ignore lint/suspicious/noExplicitAny: test-only introspection of Zod internals
      const shape = (schema as any)._zod.def.shape as Record<string, z.ZodType>;
      expect(cols.map((c) => c.column_name)).toEqual(Object.keys(shape));
      for (const c of cols) {
        const field = shape[c.column_name];
        if (!field) throw new Error(`no zod field for ${view}.${c.column_name}`);
        const z = zodKind(field);
        if (c.data_type === 'USER-DEFINED') {
          expect(z.kind, `${view}.${c.column_name} is enum ${c.udt_name}`).toBe('enum');
          const labels = await sql<{ l: string }[]>`
            select e.enumlabel as l from pg_enum e join pg_type t on t.oid = e.enumtypid
            where t.typname = ${c.udt_name} order by e.enumsortorder`;
          expect(z.entries, `${view}.${c.column_name} (${c.udt_name})`).toEqual(
            labels.map((r) => r.l),
          );
        } else {
          expect(z.kind, `${view}.${c.column_name} (${c.udt_name})`).toBe(UDT_KIND[c.udt_name]);
        }
      }
    });
  }
});
