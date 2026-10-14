import { describe, expect, it } from 'vitest';
import { checkEvidenceSummary } from '../../../src/release/evidence.js';

const passing = `# M1 evidence

| Setting | Value |
|---|---|
| Node | 22 |

## Baseline
some text with the word FAIL in prose that is not in the summary table

## Summary

| Acceptance item | Result |
|---|---|
| Idempotence | PASS |
| Auth (receive ok; socket publish rejected) | PASS |
`;

describe('release:tag evidence check', () => {
  it('passes when the final table has only PASS rows', () => {
    expect(checkEvidenceSummary(passing)).toEqual({ ok: true, problems: [], rows: 2 });
  });
  it('fails on FAIL or NOT RUN in any row of the final table, case-insensitively', () => {
    const failing = `${passing}| Crash point (b) | FAIL |\n| Missing final change | not run |\n`;
    const v = checkEvidenceSummary(failing);
    expect(v.ok).toBe(false);
    expect(v.problems).toHaveLength(2);
    expect(v.rows).toBe(4);
  });
  it('fails without a table or with an empty table', () => {
    expect(checkEvidenceSummary('# nothing here').ok).toBe(false);
    expect(checkEvidenceSummary('| a | b |\n|---|---|\n').ok).toBe(false);
  });
  it('only the LAST table counts: an earlier failing table is history, the summary decides', () => {
    const earlierFail = passing.replace('| Node | 22 |', '| Node | FAIL |');
    expect(checkEvidenceSummary(earlierFail).ok).toBe(true);
  });
  it('words containing FAIL (e.g. "failover") do not trip the check', () => {
    expect(checkEvidenceSummary(`${passing}| failover test | PASS |\n`).ok).toBe(true);
  });
});
