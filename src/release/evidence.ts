/**
 * Evidence-file check for `pnpm release:tag`. A milestone is tagged only when
 * `devlog/evidence/M<n>.md` ends with a summary table in which every row
 * passed. Pure: takes the file text, returns the verdict.
 */
export interface EvidenceVerdict {
  ok: boolean;
  /** Rows of the final table that are not PASS (or the reason no table was found). */
  problems: string[];
  rows: number;
}

/**
 * The FINAL markdown table of the file (the summary). A row passes only when it
 * contains the word `PASS` and no `FAIL` / `NOT RUN` (case-insensitive, whole
 * words); a blank or `pending` verdict is a failure. The header and separator
 * rows are ignored. No table at all is a failure.
 */
export function checkEvidenceSummary(text: string): EvidenceVerdict {
  const lines = text.split(/\r?\n/);
  let table: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (/^\s*\|.*\|\s*$/.test(line)) {
      current.push(line.trim());
    } else if (current.length > 0) {
      table = current;
      current = [];
    }
  }
  if (current.length > 0) table = current;
  if (table.length === 0) return { ok: false, problems: ['no markdown table found'], rows: 0 };
  const rows = table.filter((l, i) => i > 0 && !/^\|[\s:|-]+\|$/.test(l));
  const problems = rows.filter((r) => !/\bPASS\b/i.test(r) || /\b(FAIL|NOT RUN)\b/i.test(r));
  return { ok: problems.length === 0 && rows.length > 0, problems, rows: rows.length };
}
