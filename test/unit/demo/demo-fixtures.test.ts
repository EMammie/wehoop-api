import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  AlignedDocumentSchema,
  type AlignFeed,
  checkServed,
  gameViewOf,
  type TimedView,
  timedViewOf,
  viewKeyOfGameView,
} from '../../../src/ingest/demo-align.js';
import { readRecordingLines } from '../../../src/ingest/recording.js';
import { FIXTURES } from '../../../src/ingest/seed-manifest.js';
import type { LeagueCode } from '../../../src/leagues/codes.js';
import { adapterFor } from '../../../src/leagues/registry.js';
import { mapStatus } from '../../../src/leagues/sportradar-basketball/normalize.js';
import {
  type LoadedRecording,
  loadRecording,
  RECORDED_ROTATION,
  type RotationEntry,
} from '../../../src/providers/sportradar/demo-host.js';
import { buildPushTimelines } from '../../../src/providers/sportradar/fake-push.js';
import { PushClockMessageSchema } from '../../../src/providers/sportradar/schemas/push.js';

/**
 * The demo rotation's aligned fixtures (`pnpm sim align`, fixtures/{wnba,ncaawb}/README.md
 * "Demo fixture"): what the demo host serves, merged across feeds in served order (REST pbp,
 * summary, boxscore, and for WNBA the push clock timeline the host derives from the pbp), never
 * shows two game views at one moment and never lowers the score within a period.
 *
 * Same-period score decreases in the RAW recordings' pbp sequence (genuine provider corrections,
 * from `pnpm sim align`'s output on the git-ignored raw files; README "Demo fixture"). A decrease
 * served by the demo is allowed only if it is one of these.
 */
const RAW_PBP_CORRECTIONS: Record<
  'wnba' | 'ncaawb',
  Array<{
    recordedRequestedAt: string;
    periodSeq: number;
    from: { home: number; away: number };
    to: { home: number; away: number };
    what: string;
  }>
> = {
  wnba: [],
  ncaawb: [
    {
      recordedRequestedAt: '2026-10-15T01:16:55.907Z', // raw line 2,278
      periodSeq: 4,
      from: { home: 99, away: 66 },
      to: { home: 98, away: 66 },
      what: "Q4 3:15: Jalyn Brown's free throw 2 of 2, made, revised to a miss (1 of 1)",
    },
  ],
};

const EXPECTED: Record<
  'wnba' | 'ncaawb',
  { sha256: string; groups: number; final: { home: number; away: number } }
> = {
  wnba: {
    sha256: 'a02cf5adc80a9de904732f346e665c53c11fe648b460331f758c01f6d264f72d',
    groups: 100,
    final: { home: 93, away: 85 },
  },
  ncaawb: {
    sha256: 'edc6548afe518bb1d3562465f795adee38a89018fac17aaff6a579da045e2bd9',
    groups: 94,
    final: { home: 104, away: 68 },
  },
};

const FEEDS: readonly AlignFeed[] = ['pbp', 'summary', 'boxscore'];
const pathOf = (fixture: string) => new URL(`../${fixture}`, FIXTURES).pathname;

/** The served sources of a loaded recording, as TimedViews on the slot's offset timeline. */
function servedSources(rec: LoadedRecording, league: LeagueCode): Record<string, TimedView[]> {
  const adapter = adapterFor(league);
  const sources: Record<string, TimedView[]> = {};
  for (const feed of FEEDS) {
    sources[feed] = rec.docs[feed].map((d) =>
      timedViewOf(d.offsetMs, viewKeyOfGameView(gameViewOf(adapter, feed, d.body))),
    );
  }
  if (adapter.capabilities.pushClock) {
    // The clock timeline exactly as the host streams it; a line without `period` keeps the
    // previous one and a line without points claims no score (push-ingest keeps the stored one).
    let period: number | null = null;
    sources.push_clock = buildPushTimelines(rec.docs.pbp).clocks.map((c) => {
      const m = PushClockMessageSchema.parse(c.line);
      if (m.payload.period) period = m.payload.period.sequence;
      const g = m.payload.game;
      return {
        at: c.offsetMs,
        status: mapStatus(g.status) ?? g.status,
        periodSeq: period,
        home: g.home.points ?? null,
        away: g.away.points ?? null,
      };
    });
  }
  return sources;
}

describe.each(RECORDED_ROTATION.map((e) => [e.league, e] as [LeagueCode, RotationEntry]))(
  'demo fixture %s',
  (league, entry) => {
    const lg = league as 'wnba' | 'ncaawb';
    const expected = EXPECTED[lg];
    let rec: LoadedRecording;
    beforeAll(async () => {
      rec = await loadRecording(entry);
    });

    it('is the aligned re-sample documented in the README (path, sha256, labelled recorded)', () => {
      expect(entry.fixture).toMatch(/\.demo\.jsonl\.gz$/);
      expect(entry.provenance).toBe('recorded');
      const sha = createHash('sha256')
        .update(readFileSync(pathOf(entry.fixture)))
        .digest('hex');
      expect(sha).toBe(expected.sha256);
      expect(rec.sha256).toBe(expected.sha256);
    });

    it('is whole groups: pbp, summary, boxscore sharing one request time, the originals kept, one game view', async () => {
      const lines = [];
      for await (const raw of readRecordingLines(pathOf(entry.fixture))) {
        lines.push(AlignedDocumentSchema.parse(JSON.parse(raw)));
      }
      expect(lines).toHaveLength(expected.groups * 3);
      const adapter = adapterFor(league);
      let prevAt = Number.NEGATIVE_INFINITY;
      for (let g = 0; g < expected.groups; g++) {
        const group = lines.slice(g * 3, g * 3 + 3);
        expect(group.map((l) => l.feed)).toEqual(FEEDS);
        const at = group[0]?.requestedAt ?? '';
        expect(Date.parse(at)).toBeGreaterThan(prevAt);
        prevAt = Date.parse(at);
        const recordedTimes = group.map((l) => Date.parse(l.recordedRequestedAt));
        expect(Date.parse(at)).toBe(Math.max(...recordedTimes));
        const views = new Set<string>();
        for (const l of group) {
          expect(l.requestedAt).toBe(at);
          expect(l.receivedAt).toBe(group[0]?.receivedAt);
          expect(Date.parse(l.recordedReceivedAt)).toBeLessThanOrEqual(Date.parse(l.receivedAt));
          views.add(
            JSON.stringify(viewKeyOfGameView(gameViewOf(adapter, l.feed as AlignFeed, l.body))),
          );
        }
        expect(views.size).toBe(1);
      }
      const first = viewKeyOfGameView(gameViewOf(adapter, 'pbp', lines[0]?.body));
      expect(first).toMatchObject({ status: 'created', home: 0, away: 0 });
      const last = viewKeyOfGameView(gameViewOf(adapter, 'boxscore', lines.at(-1)?.body));
      expect(last).toMatchObject({ status: 'closed', ...expected.final });
      // Every phase of the recording is served, `complete` before `closed`.
      const phases = lines
        .filter((l) => l.feed === 'pbp')
        .map((l) => gameViewOf(adapter, 'pbp', l.body).status)
        .filter((s, i, a) => s !== a[i - 1]);
      expect(phases).toContain('halftime');
      expect(phases.slice(-2)).toEqual(['complete', 'closed']);
    });

    it('serves every feed from the same group at every moment (the host picks by offset)', () => {
      const offsets = FEEDS.map((f) => rec.docs[f].map((d) => d.offsetMs));
      expect(offsets[1]).toEqual(offsets[0]);
      expect(offsets[2]).toEqual(offsets[0]);
    });

    it('merged in served order across feeds (and push clock) never disagrees and never lowers a score in a period', () => {
      const r = checkServed(servedSources(rec, league));
      expect(r.instants).toBe(expected.groups);
      expect(r.disagreements).toEqual([]);
      expect(r.phaseRegressions).toEqual([]);
      // No decrease is served at all: not even the enumerated raw corrections, whose
      // pre-correction score no group samples (asserted in the next test).
      expect(r.drops).toEqual([]);
    });

    it('serves no pre-correction score of an enumerated raw correction (each falls between two groups)', () => {
      const adapter = adapterFor(league);
      const pbpViews = rec.docs.pbp.map((d) =>
        viewKeyOfGameView(gameViewOf(adapter, 'pbp', d.body)),
      );
      for (const c of RAW_PBP_CORRECTIONS[lg]) {
        const served = pbpViews.filter(
          (v) => v.periodSeq === c.periodSeq && v.home === c.from.home && v.away === c.from.away,
        );
        expect(served, c.what).toEqual([]);
        // ... while the corrected score is served (the game moves on through it).
        expect(
          pbpViews.some(
            (v) => v.periodSeq === c.periodSeq && v.home === c.to.home && v.away === c.to.away,
          ),
          c.what,
        ).toBe(true);
      }
    });

    it('starts with the same first documents as the compact file, whose second documents come after the re-point bound', async () => {
      // demo-host.ts EnsureOptions: a never-played slot may be re-pointed from the compact file
      // to this one before tip-off + startOffsetMs, because until then only first documents are
      // served and they are the same raw lines in both files.
      const compact = await loadRecording({
        ...entry,
        fixture: entry.fixture.replace('.demo.', '.compact.'),
      });
      for (const feed of FEEDS) {
        expect(rec.docs[feed][0]?.body, feed).toEqual(compact.docs[feed][0]?.body);
        expect(compact.docs[feed][1]?.offsetMs ?? 0, feed).toBeGreaterThan(rec.startOffsetMs);
        expect(rec.docs[feed][1]?.offsetMs ?? 0, feed).toBeGreaterThan(rec.startOffsetMs);
      }
      expect(rec.startOffsetMs).toBeGreaterThan(0); // every slot's bound is after its tip-off
    });

    it('the independently sampled compact fixture it replaces DOES flicker (the check is not vacuous)', async () => {
      const compact = await loadRecording({
        ...entry,
        fixture: entry.fixture.replace('.demo.', '.compact.'),
      });
      const r = checkServed(servedSources(compact, league));
      expect(r.disagreements.length).toBeGreaterThan(0);
      expect(r.drops.length).toBeGreaterThan(0);
    });
  },
);
