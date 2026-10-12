import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

/**
 * Runs test/integration/invariants.sql against DATABASE_URL and prints each
 * named check with its expected and actual value. Exit code 1 if any check
 * fails. The validator agent pastes this output into the evidence file.
 *
 * Each statement in the file is preceded by a comment of the form:
 *   -- check: <name> | expect: <value>
 * and must return a single row with a single column.
 */
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(2);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const file = join(here, '..', '..', 'test', 'integration', 'invariants.sql');
  const text = readFileSync(file, 'utf8');

  const blocks = text
    .split(/\n(?=-- check:)/)
    .map((b) => b.trim())
    .filter((b) => b.startsWith('-- check:'));

  const sql = postgres(url, { max: 1, prepare: false });
  let failures = 0;
  const rows: { check: string; expect: string; actual: string; ok: boolean }[] = [];

  for (const block of blocks) {
    const header = block.split('\n')[0] ?? '';
    const m = /^-- check:\s*(.+?)\s*\|\s*expect:\s*(.+)$/.exec(header);
    if (!m) continue;
    const [, name = '', expect = ''] = m;
    const statement = block.slice(header.length).trim();
    try {
      const result = await sql.unsafe(statement);
      const first = result[0] as Record<string, unknown> | undefined;
      const actual = first ? String(Object.values(first)[0]) : '<no row>';
      const ok = actual === expect.trim();
      if (!ok) failures++;
      rows.push({ check: name, expect: expect.trim(), actual, ok });
    } catch (err) {
      failures++;
      rows.push({
        check: name,
        expect: expect.trim(),
        actual: `ERROR ${(err as Error).message}`,
        ok: false,
      });
    }
  }
  await sql.end();

  const w = Math.max(...rows.map((r) => r.check.length), 5);
  console.log(`${'check'.padEnd(w)}  expect  actual  result`);
  for (const r of rows) {
    console.log(
      `${r.check.padEnd(w)}  ${r.expect.padEnd(6)}  ${r.actual.padEnd(6)}  ${r.ok ? 'PASS' : 'FAIL'}`,
    );
  }
  console.log(`\n${rows.length - failures}/${rows.length} invariants hold`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
