import { z } from 'zod';
import type { LeagueAdapter } from '../leagues/adapter.js';
import { BoxscoreDocumentSchema } from '../providers/sportradar/schemas/boxscore.js';
import { PbpDocumentSchema } from '../providers/sportradar/schemas/pbp.js';
import { SummaryDocumentSchema } from '../providers/sportradar/schemas/summary.js';
import {
  GzipLineWriter,
  type ReadRecordingOptions,
  type RecordedDocument,
  RecordedDocumentSchema,
  readRecording,
  readRecordingLines,
} from './recording.js';
import type { GameView } from './types.js';

/**
 * Aligned compaction for the DEMO fixtures (`pnpm sim align`, plan rev 4.15 (6), owner decision
 * 2026-11-11 "option 1"). The M1 compaction (`selectCompact`) samples each feed on its own stride,
 * so the demo host could serve a summary minutes older than the pbp it served a moment earlier and
 * the game view flickered (57-28 -> 55-28 -> 57-28). The real provider does not do that, so the fix
 * is in the demo data: every served instant must show ONE game view across the three feeds.
 *
 * Rule (deterministic, from the full raw recording, which is sorted by request time):
 *   1. Candidate groups. Walking the raw lines in order, a group closes at the first line at which
 *      every game feed (pbp, summary, boxscore) has a document requested after the previous
 *      group closed; the group is the latest document of each feed at that line. Groups are
 *      therefore disjoint and ordered (in the recorder's cycle: one pbp + summary + boxscore
 *      every 10th poll, about every 30 s).
 *   2. Eligible groups: all three documents agree on the game-level view the watcher derives
 *      (the league adapter's normalizer: status, current period sequence, home and away points,
 *      and the per-period line score). A group straddling a score or a phase change is dropped.
 *   3. Kept groups, among the eligible ones (index i, previous kept group K): i is first or last;
 *      i is a multiple of `everyGroup`; its phase (status, period sequence) differs from K's;
 *      its pbp `deleted_events` id set differs from K's; it is the last eligible group before,
 *      or the first after, a phase change between consecutive eligible groups. So pregame, every
 *      period start and end, halftime, `complete` and `closed` are present.
 *   4. Every document of a kept group gets the group's `requestedAt` (the latest original
 *      request of its three documents) and `receivedAt` (the latest original receipt), so the
 *      host serves the three together and no served revision is later than the moment it is
 *      served. The original times are kept as `recordedRequestedAt` / `recordedReceivedAt`
 *      (RecordedDocumentSchema strips them; readers that do not know them ignore them). Bodies
 *      are written exactly as recorded, one group = three lines in the order pbp, summary,
 *      boxscore, gzip level 9.
 * The first candidate (pregame) and the last (`closed`) must be eligible, else the command fails.
 */

export const ALIGN_FEEDS = ['pbp', 'summary', 'boxscore'] as const;
export type AlignFeed = (typeof ALIGN_FEEDS)[number];
const isAlignFeed = (f: string): f is AlignFeed => (ALIGN_FEEDS as readonly string[]).includes(f);

/** The game-level view the alignment compares (what applyChanges would write durably). */
export interface ViewKey {
  status: string | null;
  periodSeq: number | null;
  home: number;
  away: number;
  /** `[sequence, home, away]` per period, sorted by sequence (JSON). */
  lineScore: string;
}

export function viewKeyOfGameView(v: GameView): ViewKey {
  const lines = [...v.periods]
    .sort((a, b) => a.sequence - b.sequence)
    .map((p) => [p.sequence, p.score.home, p.score.away]);
  return {
    status: v.status ?? v.unknownStatus,
    periodSeq: v.period?.sequence ?? null,
    home: v.score.home,
    away: v.score.away,
    lineScore: JSON.stringify(lines),
  };
}

/** The game view of one game document, through the league adapter's normalizer. */
export function gameViewOf(adapter: LeagueAdapter, feed: AlignFeed, body: unknown): GameView {
  const doc =
    feed === 'pbp'
      ? adapter.normalizePbp(PbpDocumentSchema.parse(body))
      : feed === 'summary'
        ? adapter.normalizeSummary(SummaryDocumentSchema.parse(body))
        : adapter.normalizeBoxscore(BoxscoreDocumentSchema.parse(body));
  if (!doc.gameView) throw new Error(`${feed} document without a game view`);
  return doc.gameView;
}

export const sameView = (a: ViewKey, b: ViewKey) =>
  a.status === b.status &&
  a.periodSeq === b.periodSeq &&
  a.home === b.home &&
  a.away === b.away &&
  a.lineScore === b.lineScore;

const samePhase = (a: ViewKey, b: ViewKey) => a.status === b.status && a.periodSeq === b.periodSeq;

const DeletedSchema = z
  .object({ deleted_events: z.array(z.object({ id: z.string() }).loose()).optional() })
  .loose();

/** What the alignment rule knows about one raw line. */
export interface AlignKey {
  feed: AlignFeed;
  requestedAt: string;
  receivedAt: string;
  view: ViewKey;
  /** (pbp) sorted `deleted_events` ids; null for other feeds or without the list. */
  deletedIds: string[] | null;
}

export function alignKeyOf(adapter: LeagueAdapter, line: RecordedDocument): AlignKey | null {
  if (!isAlignFeed(line.feed)) return null;
  const deleted =
    line.feed === 'pbp' ? DeletedSchema.parse(line.body ?? {}).deleted_events : undefined;
  return {
    feed: line.feed,
    requestedAt: line.requestedAt,
    receivedAt: line.receivedAt,
    view: viewKeyOfGameView(gameViewOf(adapter, line.feed, line.body)),
    deletedIds: deleted ? deleted.map((d) => d.id).sort() : null,
  };
}

export interface AlignedGroup {
  /** Raw line position of each member. */
  members: Record<AlignFeed, number>;
  requestedAt: string;
  receivedAt: string;
  view: ViewKey;
  deletedIds: string[] | null;
}

export interface CandidateGroup extends AlignedGroup {
  /** All three members agree on the view (rule 2). `view` is the pbp's. */
  eligible: boolean;
}

const maxIso = (xs: string[]) => xs.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));

/** Rule 1 + 2: candidate groups in order. `keys[pos]` is null for non-game lines. */
export function candidateGroups(keys: readonly (AlignKey | null)[]): CandidateGroup[] {
  const out: CandidateGroup[] = [];
  const latest = new Map<AlignFeed, number>();
  let cut = -1;
  let prevAt = Number.NEGATIVE_INFINITY;
  keys.forEach((k, pos) => {
    if (!k) return;
    const at = Date.parse(k.requestedAt);
    if (at < prevAt) throw new Error(`line ${pos + 1}: requestedAt goes backwards`);
    prevAt = at;
    latest.set(k.feed, pos);
    const members = ALIGN_FEEDS.map((f) => latest.get(f));
    if (members.some((m) => m === undefined || m <= cut)) return;
    const [p, s, b] = members as [number, number, number];
    const ks = [keys[p], keys[s], keys[b]] as [AlignKey, AlignKey, AlignKey];
    out.push({
      members: { pbp: p, summary: s, boxscore: b },
      requestedAt: maxIso(ks.map((x) => x.requestedAt)),
      receivedAt: maxIso(ks.map((x) => x.receivedAt)),
      view: ks[0].view,
      deletedIds: ks[0].deletedIds,
      eligible: sameView(ks[0].view, ks[1].view) && sameView(ks[0].view, ks[2].view),
    });
    cut = pos;
  });
  return out;
}

const sameIds = (a: string[] | null, b: string[] | null) =>
  a === b || (a !== null && b !== null && a.length === b.length && a.every((x, i) => x === b[i]));

export interface AlignOptions {
  /** Keep every Nth eligible group (rule 3). */
  everyGroup: number;
}

/** Rule 3 over the candidates; throws when the first or last candidate is not eligible. */
export function selectAligned(
  candidates: readonly CandidateGroup[],
  opts: AlignOptions,
): AlignedGroup[] {
  if (candidates.length === 0) throw new Error('no candidate group (a game feed is missing)');
  if (!candidates[0]?.eligible)
    throw new Error('the first group (pregame) does not agree across feeds');
  if (!candidates.at(-1)?.eligible)
    throw new Error('the last group (closed) does not agree across feeds');
  const eligible = candidates.filter((c) => c.eligible);
  const stride = Math.max(1, opts.everyGroup);
  const kept: AlignedGroup[] = [];
  let last: AlignedGroup | null = null;
  eligible.forEach((g, i) => {
    const prev = eligible[i - 1];
    const next = eligible[i + 1];
    const keep =
      i === 0 ||
      i === eligible.length - 1 ||
      i % stride === 0 ||
      (last !== null && !samePhase(last.view, g.view)) ||
      (last !== null && !sameIds(last.deletedIds, g.deletedIds)) ||
      (next !== undefined && !samePhase(g.view, next.view)) ||
      (prev !== undefined && !samePhase(prev.view, g.view));
    if (keep) {
      const { eligible: _e, ...group } = g;
      kept.push(group);
      last = group;
    }
  });
  return kept;
}

/** A line of an aligned file: a RecordedDocument plus the original request and receipt times. */
export const AlignedDocumentSchema = RecordedDocumentSchema.extend({
  recordedRequestedAt: z.iso.datetime(),
  recordedReceivedAt: z.iso.datetime(),
});
export type AlignedDocument = z.infer<typeof AlignedDocumentSchema>;

export interface AlignResult {
  perFeed: Record<string, number>;
  total: number;
  candidates: number;
  eligible: number;
  kept: number;
  /** Same-period score decreases in the raw pbp sequence: the provider's own corrections. */
  rawPbpDrops: ServedDrop[];
  /** The same over every raw document in request order (a summary behind the pbp before it). */
  rawRequestOrderDrops: ServedDrop[];
}

/**
 * Two streaming passes over the raw recording (it does not fit in memory: 1.8 GB for WNBA): the
 * first derives an AlignKey per line, the second writes the kept groups' documents.
 */
export async function alignRecording(
  inPath: string,
  outPath: string,
  adapter: LeagueAdapter,
  opts: AlignOptions & ReadRecordingOptions,
): Promise<AlignResult> {
  const keys: (AlignKey | null)[] = [];
  const perFeed: Record<string, number> = {};
  for await (const line of readRecording(inPath, opts)) {
    perFeed[line.feed] = (perFeed[line.feed] ?? 0) + 1;
    keys.push(alignKeyOf(adapter, line));
  }
  const candidates = candidateGroups(keys);
  const kept = selectAligned(candidates, opts);
  const game = keys.filter((k): k is AlignKey => k !== null);
  const asView = (k: AlignKey) => timedViewOf(Date.parse(k.requestedAt), k.view);
  // Request order: every document is its own instant (a fresh provider answer at its request).
  const requestOrder = game.map((k, i) => ({ ...asView(k), at: i }));
  const groupOf = new Map<number, AlignedGroup>();
  for (const g of kept) for (const f of ALIGN_FEEDS) groupOf.set(g.members[f], g);
  const writer = new GzipLineWriter(outPath);
  const pending = new Map<AlignedGroup, Partial<Record<AlignFeed, RecordedDocument>>>();
  let pos = 0;
  for await (const raw of readRecordingLines(inPath)) {
    if (pos >= keys.length) break; // a truncated last line was excluded by readRecording
    const g = groupOf.get(pos);
    pos++;
    if (!g) continue;
    const line = RecordedDocumentSchema.parse(JSON.parse(raw));
    const got = pending.get(g) ?? {};
    if (isAlignFeed(line.feed)) got[line.feed] = line;
    pending.set(g, got);
    if (!ALIGN_FEEDS.every((f) => got[f])) continue;
    pending.delete(g);
    for (const f of ALIGN_FEEDS) {
      const d = got[f] as RecordedDocument;
      const out: AlignedDocument = {
        feed: d.feed,
        requestedAt: g.requestedAt,
        receivedAt: g.receivedAt,
        status: d.status,
        recordedRequestedAt: d.requestedAt,
        recordedReceivedAt: d.receivedAt,
        body: d.body,
      };
      await writer.write(JSON.stringify(out));
    }
  }
  await writer.close();
  if (pending.size > 0) throw new Error('internal: an aligned group was not written whole');
  return {
    perFeed,
    total: keys.length,
    candidates: candidates.length,
    eligible: candidates.filter((c) => c.eligible).length,
    kept: kept.length,
    rawPbpDrops: checkServed({ pbp: game.filter((k) => k.feed === 'pbp').map(asView) }).drops,
    rawRequestOrderDrops: checkServed({ raw: requestOrder }).drops,
  };
}

/* ------------------------------------------------------------------ */
/* Served-state check (the unit test and `pnpm sim align` use it)      */
/* ------------------------------------------------------------------ */

/** One served (REST) or streamed (push) game view at a moment; null points = not carried. */
export interface TimedView {
  /** Serving moment (ms, any common origin). */
  at: number;
  status: string | null;
  periodSeq: number | null;
  home: number | null;
  away: number | null;
}

export interface ServedDrop {
  at: number;
  source: string;
  periodSeq: number | null;
  from: { home: number; away: number };
  to: { home: number; away: number };
}

export interface ServedCheck {
  instants: number;
  /** Moments at which two sources serve different game views (status, period, score). */
  disagreements: Array<{ at: number; views: Record<string, string> }>;
  /** Same-period score decreases against the highest score served so far in that period. */
  drops: ServedDrop[];
}

export const timedViewOf = (at: number, k: ViewKey): TimedView => ({
  at,
  status: k.status,
  periodSeq: k.periodSeq,
  home: k.home,
  away: k.away,
});

/**
 * What a client of these sources can see, independent of polling order. A REST source serves,
 * at every moment, its latest document at or before it (the demo host's `pickIndex`); a push
 * source's latest line is the state it last delivered, and a line without points makes no score
 * claim (push-ingest keeps the stored score, whichever source wrote it). At every instant at which any
 * source changes: (1) every pair of sources must agree, else a poller could read them in an
 * order that lowers the score; (2) no source may serve a lower score in the same period than
 * the highest served before (a drop is recorded once: the running high resets to the lower view,
 * so a genuine provider correction counts once and a flicker counts every time it comes back).
 */
export function checkServed(sources: Record<string, readonly TimedView[]>): ServedCheck {
  const names = Object.keys(sources);
  const lists = names.map((n) =>
    [...(sources[n] ?? [])].map((v, i) => ({ v, i })).sort((a, b) => a.v.at - b.v.at || a.i - b.i),
  );
  const instants = [...new Set(lists.flatMap((l) => l.map((x) => x.v.at)))].sort((a, b) => a - b);
  const state: Array<TimedView | null> = names.map(() => null);
  const disagreements: ServedCheck['disagreements'] = [];
  const drops: ServedDrop[] = [];
  let period: number | null | undefined;
  let high = { home: -1, away: -1 };
  const next = names.map(() => 0);
  for (const at of instants) {
    names.forEach((_, s) => {
      const list = lists[s] ?? [];
      let i = next[s] ?? 0;
      for (let x = list[i]; x !== undefined && x.v.at <= at; x = list[++i]) state[s] = x.v;
      next[s] = i;
    });
    const present = names
      .map((name, s) => ({ name, v: state[s] }))
      .filter((x): x is { name: string; v: TimedView } => x.v !== null);
    const label = (v: TimedView) => `${v.status} p${v.periodSeq} ${v.home}-${v.away}`;
    const phases = new Set(present.map((x) => `${x.v.status} p${x.v.periodSeq}`));
    const scores = new Set(
      present.filter((x) => x.v.home !== null).map((x) => `${x.v.home}-${x.v.away}`),
    );
    if (phases.size > 1 || scores.size > 1) {
      disagreements.push({
        at,
        views: Object.fromEntries(present.map((x) => [x.name, label(x.v)])),
      });
    }
    for (const { name, v } of present) {
      if (v.periodSeq !== period) {
        period = v.periodSeq;
        high = { home: v.home ?? -1, away: v.away ?? -1 };
        continue;
      }
      if (v.home === null || v.away === null) continue;
      if (v.home < high.home || v.away < high.away) {
        drops.push({
          at,
          source: name,
          periodSeq: v.periodSeq,
          from: high,
          to: { home: v.home, away: v.away },
        });
        high = { home: v.home, away: v.away };
      } else {
        high = { home: Math.max(high.home, v.home), away: Math.max(high.away, v.away) };
      }
    }
  }
  return { instants: instants.length, disagreements, drops };
}
