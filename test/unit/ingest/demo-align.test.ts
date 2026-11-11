import { describe, expect, it } from 'vitest';
import {
  type AlignFeed,
  type AlignKey,
  candidateGroups,
  checkServed,
  selectAligned,
  type TimedView,
  type ViewKey,
} from '../../../src/ingest/demo-align.js';

/**
 * The aligned compaction rule (`pnpm sim align`, src/ingest/demo-align.ts) on hand-made keys, and
 * the served-state check the fixture test relies on. DB-free and file-free.
 */
const view = (status: string, periodSeq: number | null, home: number, away: number): ViewKey => ({
  status,
  periodSeq,
  home,
  away,
  lineScore: periodSeq === null ? '[]' : JSON.stringify([[periodSeq, home, away]]),
});

let t = 0;
const key = (feed: AlignFeed, v: ViewKey, deletedIds: string[] | null = null): AlignKey => {
  t += 1000;
  return {
    feed,
    requestedAt: new Date(t).toISOString(),
    receivedAt: new Date(t + 100).toISOString(),
    view: v,
    deletedIds: feed === 'pbp' ? (deletedIds ?? []) : null,
  };
};
/** One recorder cycle: pbp, summary, boxscore (optionally with a differing summary). */
const cycle = (
  v: ViewKey,
  opts: { summary?: ViewKey; deleted?: string[]; extraPbp?: number } = {},
) => [
  ...Array.from({ length: opts.extraPbp ?? 0 }, () => key('pbp', v, opts.deleted)),
  key('pbp', v, opts.deleted),
  key('summary', opts.summary ?? v),
  key('boxscore', v),
];

describe('candidate groups', () => {
  it('close when every feed has a document newer than the previous group, and are disjoint', () => {
    t = 0;
    const keys = [
      ...cycle(view('created', null, 0, 0)),
      ...cycle(view('inprogress', 1, 2, 0), { extraPbp: 3 }),
      null, // a reference line (schedule) between game documents is ignored
      ...cycle(view('inprogress', 1, 4, 0)),
    ];
    const groups = candidateGroups(keys);
    expect(groups).toHaveLength(3);
    // The second group's pbp is the LATEST pbp before its boxscore, not the first of the cycle.
    expect(groups[1]?.members).toEqual({ pbp: 6, summary: 7, boxscore: 8 });
    const used = groups.flatMap((g) => Object.values(g.members));
    expect(new Set(used).size).toBe(used.length);
    // Group time = latest request of its members (the boxscore here).
    expect(groups[1]?.requestedAt).toBe(keys[8]?.requestedAt);
    expect(groups[1]?.receivedAt).toBe(keys[8]?.receivedAt);
  });

  it('a group whose documents disagree on the game view is not eligible', () => {
    t = 0;
    const keys = [
      ...cycle(view('created', null, 0, 0)),
      ...cycle(view('inprogress', 1, 57, 28), { summary: view('inprogress', 1, 55, 28) }),
      ...cycle(view('inprogress', 1, 57, 28)),
    ];
    expect(candidateGroups(keys).map((g) => g.eligible)).toEqual([true, false, true]);
  });

  it('refuses request times that go backwards', () => {
    t = 10_000;
    const a = key('pbp', view('created', null, 0, 0));
    t = 0;
    const b = key('summary', view('created', null, 0, 0));
    expect(() => candidateGroups([a, b])).toThrow(/backwards/);
  });
});

describe('selectAligned', () => {
  it('keeps first, last, the stride, every phase boundary (both sides) and deletion changes', () => {
    t = 0;
    const q1 = (h: number) => view('inprogress', 1, h, 0);
    const keys = [
      ...cycle(view('created', null, 0, 0)), // 0 first
      ...cycle(q1(1)), // 1 first after a phase change
      ...cycle(q1(2)), // 2
      ...cycle(q1(3)), // 3 stride (every 3)
      ...cycle(q1(4), { deleted: ['e1'] }), // 4 deletion set changed
      ...cycle(q1(5), { deleted: ['e1'] }), // 5 last before a phase change
      ...cycle(view('halftime', 1, 5, 0), { deleted: ['e1'] }), // 6 phase change (stride too)
      ...cycle(view('inprogress', 2, 5, 0), { deleted: ['e1'] }), // 7
      ...cycle(view('inprogress', 2, 7, 0), { deleted: ['e1'] }), // 8 dropped
      ...cycle(view('inprogress', 2, 9, 0), { deleted: ['e1'] }), // 9 stride
      ...cycle(view('inprogress', 2, 9, 0), { deleted: ['e1'] }), // 10 last before closed
      ...cycle(view('closed', 2, 9, 0), { deleted: ['e1'] }), // 11 last
    ];
    const kept = selectAligned(candidateGroups(keys), { everyGroup: 3 });
    expect(kept.map((g) => `${g.view.status}:${g.view.home}`)).toEqual([
      'created:0',
      'inprogress:1',
      'inprogress:3',
      'inprogress:4',
      'inprogress:5',
      'halftime:5',
      'inprogress:5',
      'inprogress:9',
      'inprogress:9',
      'closed:9',
    ]);
  });

  it('counts the stride over eligible groups only and never keeps a disagreeing one', () => {
    t = 0;
    const keys = [
      ...cycle(view('created', null, 0, 0)),
      ...cycle(view('inprogress', 1, 2, 0), { summary: view('inprogress', 1, 0, 0) }),
      ...cycle(view('inprogress', 1, 2, 0)),
      ...cycle(view('inprogress', 1, 4, 0)),
      ...cycle(view('closed', 1, 4, 0)),
    ];
    const kept = selectAligned(candidateGroups(keys), { everyGroup: 100 });
    expect(kept.map((g) => g.members.summary)).toEqual([1, 7, 10, 13]);
  });

  it('refuses a recording whose pregame or closed group disagrees', () => {
    t = 0;
    const badStart = [
      ...cycle(view('created', null, 0, 0), { summary: view('inprogress', 1, 0, 0) }),
      ...cycle(view('closed', 1, 4, 0)),
    ];
    expect(() => selectAligned(candidateGroups(badStart), { everyGroup: 1 })).toThrow(/first/);
    const badEnd = [
      ...cycle(view('created', null, 0, 0)),
      ...cycle(view('closed', 1, 4, 0), { summary: view('complete', 1, 4, 0) }),
    ];
    expect(() => selectAligned(candidateGroups(badEnd), { everyGroup: 1 })).toThrow(/last/);
  });
});

describe('checkServed', () => {
  const tv = (
    at: number,
    home: number | null,
    periodSeq = 1,
    status = 'inprogress',
  ): TimedView => ({
    at,
    status,
    periodSeq,
    home,
    away: home === null ? null : 0,
  });

  it('finds the flicker of independently sampled feeds (a stale summary served after a newer pbp)', () => {
    const r = checkServed({
      pbp: [tv(0, 55), tv(10, 57), tv(30, 59)],
      summary: [tv(0, 55), tv(20, 57)],
    });
    // At 10 the summary still serves 55 while the pbp serves 57.
    expect(r.disagreements.map((d) => d.at)).toEqual([10, 30]);
    expect(r.drops).toHaveLength(2);
    expect(r.drops[0]).toMatchObject({
      at: 10,
      source: 'summary',
      from: { home: 57 },
      to: { home: 55 },
    });
  });

  it('accepts aligned feeds, a new period, and push lines that carry no points', () => {
    const r = checkServed({
      pbp: [tv(0, 55), tv(10, 57), tv(20, 0, 2)],
      summary: [tv(0, 55), tv(10, 57), tv(20, 0, 2)],
      push_clock: [tv(0, 55), tv(10, null), tv(20, 0, 2)],
    });
    expect(r).toEqual({ instants: 3, disagreements: [], drops: [] });
  });

  it('counts a genuine correction once', () => {
    const r = checkServed({ pbp: [tv(0, 98), tv(1, 99), tv(2, 98), tv(3, 98), tv(4, 100)] });
    expect(r.drops).toEqual([
      {
        at: 2,
        source: 'pbp',
        periodSeq: 1,
        from: { home: 99, away: 0 },
        to: { home: 98, away: 0 },
      },
    ]);
  });
});
