import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { CONTRACTS } from '../contracts/registry.js';
import { compareWithDirectory, emitSwift } from '../contracts/swift-emitter.js';

/**
 * pnpm gen:swift [--out <dir>] [--check]
 *   Emit the Contracts Swift files (plan §3, M5 B1) from the Zod schemas in
 *   src/contracts/registry.ts. Default --out is generated/swift (committed here;
 *   the app syncs it into WehoopKit/Sources/Contracts/Generated).
 *   --check writes nothing and exits 1 when <dir> differs from what the schemas
 *   emit (missing, stale or changed files), listing each one. CI runs it.
 * Exit codes: 0 ok / in sync; 1 drift; 64 usage.
 */
async function main() {
  const { values: args } = parseArgs({
    options: {
      out: { type: 'string', default: 'generated/swift' },
      check: { type: 'boolean', default: false },
    },
    strict: true,
  });
  const dir = resolve(args.out);
  const emitted = emitSwift(CONTRACTS);

  if (args.check) {
    const existing = new Map<string, string>();
    try {
      for (const name of await readdir(dir)) {
        if (name.endsWith('.swift')) existing.set(name, await readFile(join(dir, name), 'utf8'));
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const r = compareWithDirectory(emitted, existing);
    const problems = [
      ...r.missing.map((f) => `missing  ${f}`),
      ...r.stale.map((f) => `stale    ${f} (not emitted any more)`),
      ...r.changed.map((f) => `changed  ${f}`),
    ];
    if (problems.length) {
      console.error(`gen:swift --check: ${dir} is out of date\n  ${problems.join('\n  ')}`);
      console.error('run `pnpm gen:swift --out <dir>` and commit the result');
      process.exit(1);
    }
    console.log(`gen:swift --check: ${emitted.size} files in sync (${dir})`);
    return;
  }

  await mkdir(dir, { recursive: true });
  for (const [name, source] of emitted) await writeFile(join(dir, name), source);
  console.log(`gen:swift: wrote ${emitted.size} files to ${dir}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
