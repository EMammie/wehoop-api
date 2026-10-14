import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendRecordedDocument,
  type CompactKey,
  compactKeyOf,
  compactRecording,
  type RecordedDocument,
  readRecording,
  selectCompact,
  toRecordedDocument,
} from '../../../src/ingest/recording.js';
import type { Feed } from '../../../src/providers/sportradar/urls.js';

const doc = (feed: Feed, body: Record<string, unknown>, i = 0): RecordedDocument => ({
  feed,
  requestedAt: new Date(Date.UTC(2026, 9, 13, 7, 0, i)).toISOString(),
  receivedAt: new Date(Date.UTC(2026, 9, 13, 7, 0, i, 100)).toISOString(),
  status: 200,
  body: { id: 'g1', status: 'inprogress', scheduled: '2026-06-30T23:00:00+00:00', ...body },
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wehoop-recording-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('recording files', () => {
  it('reads a gzip-compressed .jsonl.gz recording in order', async () => {
    const lines = [doc('pbp', { quarter: 1 }, 0), doc('summary', { quarter: 1 }, 1)];
    const path = join(dir, 'tiny.jsonl.gz');
    writeFileSync(path, gzipSync(`${lines.map((l) => JSON.stringify(l)).join('\n')}\n`));
    const read: RecordedDocument[] = [];
    for await (const l of readRecording(path)) read.push(l);
    expect(read).toEqual(lines);
  });

  it('appends plain lines synchronously and reads them back (the --record-to format)', async () => {
    const path = join(dir, 'rec.jsonl');
    const line = toRecordedDocument('pbp', {
      data: {},
      requestedAt: new Date('2026-10-13T07:34:11.948Z'),
      receivedAt: new Date('2026-10-13T07:34:12.100Z'),
      bytes: 2,
      rawText: '{"id":"g1","status":"created","scheduled":"2026-06-30T23:00:00+00:00"}',
    });
    const bytes = appendRecordedDocument(path, line);
    expect(bytes).toBe(Buffer.byteLength(`${JSON.stringify(line)}\n`));
    expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true);
    const read: RecordedDocument[] = [];
    for await (const l of readRecording(path)) read.push(l);
    expect(read).toEqual([
      {
        feed: 'pbp',
        requestedAt: '2026-10-13T07:34:11.948Z',
        receivedAt: '2026-10-13T07:34:12.100Z',
        status: 200,
        body: { id: 'g1', status: 'created', scheduled: '2026-06-30T23:00:00+00:00' },
      },
    ]);
  });

  it('rejects a line that is not a recorded document', async () => {
    const path = join(dir, 'bad.jsonl');
    writeFileSync(path, `${JSON.stringify({ feed: 'nope', body: {} })}\n`);
    await expect(async () => {
      for await (const _ of readRecording(path)) {
        /* consume */
      }
    }).rejects.toThrow(/line 1 is not a recorded document/);
  });
});

const key = (
  feed: Feed,
  status: string,
  period: number | null,
  deletedIds: string[] | null = null,
): CompactKey => ({ feed, status, period, deletedIds });

describe('selectCompact (deterministic sampling rule)', () => {
  it('keeps first, last, every stride-th, and both sides of every status/period change', () => {
    // pbp indices:        0..4 Q1 inprogress, 5..9 Q2, 10..11 halftime, 12..14 Q3, 15 closed
    const keys: CompactKey[] = [
      ...Array.from({ length: 5 }, () => key('pbp', 'inprogress', 1)),
      ...Array.from({ length: 5 }, () => key('pbp', 'inprogress', 2)),
      key('pbp', 'halftime', 2),
      key('pbp', 'halftime', 2),
      ...Array.from({ length: 3 }, () => key('pbp', 'inprogress', 3)),
      key('pbp', 'closed', 4),
    ];
    const keep = selectCompact(keys, { everyPbp: 4, everySummary: 10 });
    const kept = keep.flatMap((k, i) => (k ? [i] : []));
    // 0 first; 4 last before Q1->Q2 and stride; 5 first after; 8 stride; 9 last before halftime;
    // 10 first after; 11 last before Q3; 12 first after and stride; 14 last before closed; 15 last.
    expect(kept).toEqual([0, 4, 5, 8, 9, 10, 11, 12, 14, 15]);
  });

  it('keeps a pbp whose deleted_events set differs from the previously kept pbp', () => {
    const keys: CompactKey[] = [
      key('pbp', 'inprogress', 1, []),
      key('pbp', 'inprogress', 1, []),
      key('pbp', 'inprogress', 1, ['e9']),
      key('pbp', 'inprogress', 1, ['e9']),
      key('pbp', 'inprogress', 1, ['e9', 'e2']),
      key('pbp', 'inprogress', 1, ['e9', 'e2']),
      key('pbp', 'inprogress', 1, ['e9', 'e2']),
    ];
    const keep = selectCompact(keys, { everyPbp: 1000, everySummary: 1000 });
    expect(keep).toEqual([true, false, true, false, true, false, true]);
  });

  it('treats feeds independently and keeps every boxscore with a changed status or period plus the final one', () => {
    const keys: CompactKey[] = [
      key('pbp', 'inprogress', 1),
      key('boxscore', 'inprogress', 1),
      key('summary', 'inprogress', 1),
      key('pbp', 'inprogress', 1),
      key('boxscore', 'inprogress', 1),
      key('summary', 'inprogress', 1),
      key('pbp', 'inprogress', 2),
      key('boxscore', 'inprogress', 2),
      key('summary', 'inprogress', 2),
      key('pbp', 'closed', 2),
      key('boxscore', 'closed', 2),
      key('summary', 'closed', 2),
      key('boxscore', 'closed', 2),
      key('summary', 'closed', 2),
    ];
    const keep = selectCompact(keys, { everyPbp: 1000, everySummary: 1000 });
    const keptBy = (feed: Feed) => keys.flatMap((k, i) => (k.feed === feed ? [keep[i]] : []));
    // boxscore: first, (1) dropped: nothing changed and not last before a change... but it IS the
    // last before the Q1->Q2 change, so kept; Q2 first after; closed first after; final.
    expect(keptBy('boxscore')).toEqual([true, true, true, true, true]);
    expect(keptBy('summary')).toEqual([true, true, true, true, true]);
    // pbp: 0 first, 1 last before Q2, 2 first after + last before closed, 3 last.
    expect(keptBy('pbp')).toEqual([true, true, true, true]);
    // Drop the middle boxscore when it is surrounded by identical state.
    const flat: CompactKey[] = [
      key('boxscore', 'inprogress', 1),
      key('boxscore', 'inprogress', 1),
      key('boxscore', 'inprogress', 1),
      key('boxscore', 'closed', 4),
    ];
    expect(selectCompact(flat, { everyPbp: 1000, everySummary: 1000 })).toEqual([
      true,
      false,
      true,
      true,
    ]);
  });

  it('is deterministic and keeps everything when strides are 1', () => {
    const keys = Array.from({ length: 7 }, () => key('summary', 'inprogress', 1));
    expect(selectCompact(keys, { everyPbp: 1, everySummary: 1 })).toEqual(new Array(7).fill(true));
    const a = selectCompact(keys, { everyPbp: 3, everySummary: 3 });
    expect(a).toEqual(selectCompact(keys, { everyPbp: 3, everySummary: 3 }));
    expect(a).toEqual([true, false, false, true, false, false, true]);
  });

  it('extracts the key from a recorded document header', () => {
    expect(
      compactKeyOf(
        doc('pbp', { status: 'halftime', quarter: 2, deleted_events: [{ id: 'b' }, { id: 'a' }] }),
      ),
    ).toEqual({ feed: 'pbp', status: 'halftime', period: 2, deletedIds: ['a', 'b'] });
    expect(compactKeyOf(doc('boxscore', {}))).toEqual({
      feed: 'boxscore',
      status: 'inprogress',
      period: null,
      deletedIds: null,
    });
  });
});

describe('compactRecording', () => {
  it('writes the selected lines byte-identical into a gzip file readable by readRecording', async () => {
    const input = join(dir, 'full.jsonl');
    const lines: RecordedDocument[] = [];
    for (let i = 0; i < 12; i++) {
      lines.push(doc('pbp', { quarter: i < 6 ? 1 : 2, n: i }, i));
      if (i % 4 === 0) lines.push(doc('summary', { quarter: i < 6 ? 1 : 2, n: i }, i));
    }
    lines.push(doc('pbp', { status: 'closed', quarter: 2, n: 12 }, 12));
    lines.push(doc('summary', { status: 'closed', quarter: 2, n: 12 }, 12));
    const text = `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
    writeFileSync(input, text);
    const out = join(dir, 'compact.jsonl.gz');
    const result = await compactRecording(input, out, { everyPbp: 5, everySummary: 2 });
    expect(result.total).toBe(lines.length);
    // pbp: 0 first, 5 stride + last before Q2, 6 first after, 10 stride, 11 last before closed, 12 last
    expect(result.perFeed.pbp).toEqual({ kept: 6, total: 13 });
    // summary (n=0,4,8,closed): 0 first, 1 last before Q2, 2 first after + stride, 3 last
    expect(result.perFeed.summary).toEqual({ kept: 4, total: 4 });
    expect(result.kept).toBe(10);
    const written = gunzipSync(readFileSync(out)).toString('utf8');
    const originalLines = text.trimEnd().split('\n');
    for (const l of written.trimEnd().split('\n')) expect(originalLines).toContain(l);
    const read: RecordedDocument[] = [];
    for await (const l of readRecording(out)) read.push(l);
    expect(read).toHaveLength(10);
    const last = read.at(-1);
    expect(last?.feed).toBe('summary');
    expect((last?.body as { status: string } | undefined)?.status).toBe('closed');
  });
});
