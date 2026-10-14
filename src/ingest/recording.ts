import { appendFileSync, createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { z } from 'zod';
import type { FetchedDocument } from '../providers/sportradar/http.js';
import { FEEDS, type Feed } from '../providers/sportradar/urls.js';

/**
 * Recorded provider documents: one JSON object per line (`.jsonl`, optionally
 * gzip-compressed as `.jsonl.gz`). The worker's `--record-to`, `pnpm sim record`
 * and `pnpm sim compact` all write this shape; `--replay-file` reads it.
 */
export const RecordedDocumentSchema = z.object({
  feed: z.enum(FEEDS),
  /** Request start time; replay uses it as `observedAt` (fixture semantics). */
  requestedAt: z.iso.datetime(),
  receivedAt: z.iso.datetime(),
  /** HTTP status of the provider response (always 200: failed requests are not recorded). */
  status: z.int(),
  /** The provider document exactly as returned (unknown fields kept). */
  body: z.unknown(),
});
export type RecordedDocument = z.infer<typeof RecordedDocumentSchema>;

/** Build a recording line from a fetched document, keeping the body byte-faithful to the response. */
export function toRecordedDocument(feed: Feed, doc: FetchedDocument<unknown>): RecordedDocument {
  return {
    feed,
    requestedAt: doc.requestedAt.toISOString(),
    receivedAt: doc.receivedAt.toISOString(),
    status: 200,
    body: JSON.parse(doc.rawText),
  };
}

/**
 * Append one line synchronously, so a recorder killed at any moment leaves a
 * valid prefix. Returns the number of bytes written.
 */
export function appendRecordedDocument(path: string, line: RecordedDocument): number {
  const text = `${JSON.stringify(line)}\n`;
  appendFileSync(path, text);
  return Buffer.byteLength(text);
}

function openRecording(path: string): Readable {
  const file = createReadStream(path);
  return path.endsWith('.gz') ? file.pipe(createGunzip()) : file;
}

/** Raw non-empty lines of a `.jsonl` / `.jsonl.gz` recording, in order. */
export async function* readRecordingLines(path: string): AsyncGenerator<string> {
  const rl = createInterface({ input: openRecording(path), crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of rl) {
    if (!line.trim()) continue;
    yield line;
  }
}

/** Parsed documents of a recording, in order. Every line is validated before use. */
export async function* readRecording(path: string): AsyncGenerator<RecordedDocument> {
  let n = 0;
  for await (const line of readRecordingLines(path)) {
    n++;
    const parsed = RecordedDocumentSchema.safeParse(JSON.parse(line));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(
        `${path}: line ${n} is not a recorded document (${issue?.path.join('.')}: ${issue?.message})`,
      );
    }
    yield parsed.data;
  }
}

/** Gzip line writer for compact recordings. Writes are awaited so back-pressure is honoured. */
export class GzipLineWriter {
  private readonly gzip = createGzip({ level: 9 });
  private readonly done: Promise<void>;
  constructor(path: string) {
    const out = createWriteStream(path);
    this.gzip.pipe(out);
    this.done = finished(out);
  }
  async write(line: string): Promise<void> {
    if (!this.gzip.write(`${line}\n`)) {
      await new Promise<void>((resolve) => this.gzip.once('drain', resolve));
    }
  }
  async close(): Promise<void> {
    this.gzip.end();
    await this.done;
  }
}

// ---------------------------------------------------------------------------
// Compaction (pnpm sim compact)
// ---------------------------------------------------------------------------

/** The game-level fields the sampling rule reads from any game document. */
const CompactHeaderSchema = z
  .object({
    status: z.string().optional(),
    quarter: z.int().optional(),
    deleted_events: z.array(z.object({ id: z.string() }).loose()).optional(),
  })
  .loose();

/** What the sampling rule knows about one document: feed, phase, period, deletion set. */
export interface CompactKey {
  feed: Feed;
  status: string | null;
  period: number | null;
  /** Sorted provider ids of `deleted_events`; null when the document carries no list. */
  deletedIds: string[] | null;
}

export function compactKeyOf(line: RecordedDocument): CompactKey {
  const h = CompactHeaderSchema.parse(line.body ?? {});
  return {
    feed: line.feed,
    status: h.status ?? null,
    period: h.quarter ?? null,
    deletedIds: h.deleted_events ? h.deleted_events.map((d) => d.id).sort() : null,
  };
}

export interface CompactOptions {
  /** Keep every Nth pbp document (by index within the feed). */
  everyPbp: number;
  /** Keep every Nth summary and every Nth boxscore document. */
  everySummary: number;
}

const sameIds = (a: string[] | null, b: string[] | null) =>
  a === b || (a !== null && b !== null && a.length === b.length && a.every((x, i) => x === b[i]));

/** A status or period change between two consecutive documents of one feed. */
const boundary = (a: CompactKey, b: CompactKey) => a.status !== b.status || a.period !== b.period;

/**
 * Deterministic down-sampling rule. Documents are indexed per feed (i = 0..n-1).
 * A document is KEPT when ANY of:
 *   1. it is the first or the last of its feed;
 *   2. its `status` or `quarter` differs from the previously KEPT document of the same feed;
 *   3. (pbp) its `deleted_events` id set differs from the previously KEPT pbp;
 *   4. i is a multiple of the feed's stride (`everyPbp` for pbp, `everySummary` for
 *      summary and boxscore);
 *   5. it is the last document before, or the first after, a status or period change
 *      between consecutive documents of its feed (so every period boundary, halftime
 *      and `closed` is present with the document that preceded it).
 * Rules 1, 2 and 5 together keep every boxscore whose status or period changed plus
 * the final one. Returns one boolean per input position.
 */
export function selectCompact(keys: readonly CompactKey[], opts: CompactOptions): boolean[] {
  const keep = new Array<boolean>(keys.length).fill(false);
  const byFeed = new Map<Feed, number[]>();
  keys.forEach((k, pos) => {
    const list = byFeed.get(k.feed) ?? [];
    list.push(pos);
    byFeed.set(k.feed, list);
  });
  for (const [feed, positions] of byFeed) {
    const stride = Math.max(1, feed === 'pbp' ? opts.everyPbp : opts.everySummary);
    const n = positions.length;
    let lastKept: CompactKey | null = null;
    for (let i = 0; i < n; i++) {
      const pos = positions[i];
      if (pos === undefined) continue;
      const k = keys[pos];
      if (k === undefined) continue;
      const prev = i > 0 ? keys[positions[i - 1] ?? -1] : undefined;
      const next = i + 1 < n ? keys[positions[i + 1] ?? -1] : undefined;
      const isKept =
        i === 0 ||
        i === n - 1 ||
        i % stride === 0 ||
        (lastKept !== null && boundary(lastKept, k)) ||
        (feed === 'pbp' && lastKept !== null && !sameIds(k.deletedIds, lastKept.deletedIds)) ||
        (next !== undefined && boundary(k, next)) ||
        (prev !== undefined && boundary(prev, k));
      if (isKept) {
        keep[pos] = true;
        lastKept = k;
      }
    }
  }
  return keep;
}

export interface CompactResult {
  perFeed: Record<string, { kept: number; total: number }>;
  kept: number;
  total: number;
}

/**
 * Two streaming passes over `inPath`: the first extracts a CompactKey per line,
 * the second writes the selected lines, byte-identical, gzip-compressed to `outPath`.
 */
export async function compactRecording(
  inPath: string,
  outPath: string,
  opts: CompactOptions,
): Promise<CompactResult> {
  const keys: CompactKey[] = [];
  for await (const line of readRecording(inPath)) keys.push(compactKeyOf(line));
  const keep = selectCompact(keys, opts);
  const perFeed: Record<string, { kept: number; total: number }> = {};
  keys.forEach((k, i) => {
    const f = perFeed[k.feed] ?? { kept: 0, total: 0 };
    f.total++;
    if (keep[i]) f.kept++;
    perFeed[k.feed] = f;
  });
  const writer = new GzipLineWriter(outPath);
  let i = 0;
  for await (const line of readRecordingLines(inPath)) {
    if (keep[i]) await writer.write(line);
    i++;
  }
  await writer.close();
  const kept = keep.filter(Boolean).length;
  return { perFeed, kept, total: keys.length };
}
