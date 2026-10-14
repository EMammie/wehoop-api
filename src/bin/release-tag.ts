import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { checkEvidenceSummary } from '../release/evidence.js';

/**
 * pnpm release:tag --milestone <n> [--push]
 *
 * Tags the VALIDATED MERGE COMMIT of milestone n as `m<n>` (annotated tag at
 * HEAD). Run on `main` after the user merges the milestone PR. Checks, in order:
 *   1. current branch is `main`                                  (exit 66)
 *   2. working tree is clean (`git status --porcelain` empty)    (exit 66)
 *   3. devlog/evidence/M<n>.md exists and its final summary table
 *      contains no FAIL / NOT RUN row                             (exit 65)
 *   4. tag m<n> does not already exist                           (exit 67)
 * Then creates the tag; pushes it only with --push. Usage errors exit 64, git
 * failures exit 1. Never force-moves a tag.
 */
function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function main() {
  const { values: args } = parseArgs({
    options: { milestone: { type: 'string' }, push: { type: 'boolean', default: false } },
    strict: true,
  });
  const n = Number(args.milestone);
  if (!args.milestone || !Number.isInteger(n) || n < 0) {
    console.error('usage: pnpm release:tag --milestone <n> [--push]');
    process.exit(64);
  }
  const tag = `m${n}`;
  const evidencePath = `devlog/evidence/M${n}.md`;

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== 'main') {
    console.error(`release:tag: on branch ${branch}; tags are created on main only`);
    process.exit(66);
  }
  const dirty = git(['status', '--porcelain']);
  if (dirty) {
    console.error(`release:tag: working tree is not clean:\n${dirty}`);
    process.exit(66);
  }
  if (!existsSync(evidencePath)) {
    console.error(`release:tag: ${evidencePath} does not exist; validate the milestone first`);
    process.exit(65);
  }
  const verdict = checkEvidenceSummary(readFileSync(evidencePath, 'utf8'));
  if (!verdict.ok) {
    console.error(`release:tag: ${evidencePath} summary table is not all PASS:`);
    for (const p of verdict.problems) console.error(`  ${p}`);
    process.exit(65);
  }
  if (git(['tag', '--list', tag])) {
    console.error(`release:tag: tag ${tag} already exists (${git(['rev-parse', tag])})`);
    process.exit(67);
  }
  const head = git(['rev-parse', 'HEAD']);
  git([
    'tag',
    '-a',
    tag,
    '-m',
    `Milestone ${n}: validated merge commit ${head}\n\nEvidence: ${evidencePath} (${verdict.rows} acceptance rows, all PASS)`,
  ]);
  console.log(`tagged ${tag} at ${head} (${verdict.rows} evidence rows)`);
  if (args.push) {
    git(['push', 'origin', tag]);
    console.log(`pushed ${tag} to origin`);
  } else {
    console.log(`not pushed; run: git push origin ${tag}  (or re-run with --push)`);
  }
}

try {
  main();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
