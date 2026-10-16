import { describe, expect, it } from 'vitest';
import {
  applyCoverage,
  defaultCoverageFor,
  effectiveCoverage,
} from '../../../src/leagues/adapter.js';
import { ncaawbAdapter } from '../../../src/leagues/ncaawb/adapter.js';
import { PbpDocumentSchema } from '../../../src/providers/sportradar/schemas/pbp.js';
import { SummaryDocumentSchema } from '../../../src/providers/sportradar/schemas/summary.js';
import { fixture } from '../../helpers/fixtures.js';

/**
 * NCAAWB coverage (plan §2, §9): `full` games carry play-by-play;
 * `extended_boxscore` / `boxscore` games emit status, score and period only
 * while live, and their stats once final. The simulation service exposes only
 * `full` recordings, so the score-only path is exercised by setting `coverage`
 * on the recorded fixture.
 */
const withCoverage = (name: string, coverage: string, status?: string) => {
  const raw = fixture(name, 'ncaawb') as Record<string, unknown>;
  raw.coverage = coverage;
  if (status) raw.status = status;
  return raw;
};

describe('NCAAWB coverage profiles', () => {
  it('maps coverage strings to profiles; unknown or absent coverage is never full', () => {
    expect(defaultCoverageFor('full')).toEqual({ events: true, stats: 'live' });
    expect(defaultCoverageFor(null)).toEqual({ events: false, stats: 'final' });
    expect(defaultCoverageFor('unknown')).toEqual({ events: false, stats: 'final' });
    expect(defaultCoverageFor('extended_boxscore')).toEqual({ events: false, stats: 'final' });
    expect(defaultCoverageFor('boxscore')).toEqual({ events: false, stats: 'final' });
  });

  it('a document that omits coverage is gated by the stored games.coverage, never by full', () => {
    expect(effectiveCoverage('full', { storedCoverage: 'extended_boxscore' })).toBe('full');
    expect(effectiveCoverage(undefined, { storedCoverage: 'extended_boxscore' })).toBe(
      'extended_boxscore',
    );
    expect(effectiveCoverage(null, { storedCoverage: 'full' })).toBe('full');
    expect(effectiveCoverage(undefined, undefined)).toBeNull();
    const raw = fixture('sim-d9b71fe0-summary-q1.json', 'ncaawb') as Record<string, unknown>;
    delete raw.coverage;
    const doc = SummaryDocumentSchema.parse(raw);
    expect(doc.coverage).toBeUndefined();
    // stored extended_boxscore: score-only while live
    const gated = ncaawbAdapter.normalizeSummary(doc, { storedCoverage: 'extended_boxscore' });
    expect(gated.batch.playerStats).toEqual([]);
    expect(gated.batch.teamStats).toEqual([]);
    expect(gated.gameView?.coverage).toBeNull(); // omission is not change: the stored value stays
    // stored full: live stats
    expect(
      ncaawbAdapter.normalizeSummary(doc, { storedCoverage: 'full' }).batch.playerStats.length,
    ).toBeGreaterThan(10);
    // nothing known on either side: score-only
    expect(ncaawbAdapter.normalizeSummary(doc).batch.playerStats).toEqual([]);
    expect(
      ncaawbAdapter.normalizeSummary(doc, { storedCoverage: 'unknown' }).batch.playerStats,
    ).toEqual([]);
    // the document's own coverage wins over the stored one
    const full = fixture('sim-d9b71fe0-pbp-q1.json', 'ncaawb');
    expect(
      ncaawbAdapter.normalizePbp(PbpDocumentSchema.parse(full), {
        storedCoverage: 'extended_boxscore',
      }).batch.events.length,
    ).toBeGreaterThan(5);
  });

  it('full coverage: the recorded pbp yields events and a complete document', () => {
    const nd = ncaawbAdapter.normalizePbp(
      PbpDocumentSchema.parse(fixture('sim-d9b71fe0-pbp-q1.json', 'ncaawb')),
    );
    expect(nd.isComplete).toBe(true);
    expect(nd.batch.events.length).toBeGreaterThan(5);
    expect(nd.gameView?.coverage).toBe('full');
  });

  it('extended_boxscore while live: no events, no stats, not a complete document, game view intact', () => {
    const nd = ncaawbAdapter.normalizePbp(
      PbpDocumentSchema.parse(withCoverage('sim-d9b71fe0-pbp-q1.json', 'extended_boxscore')),
    );
    expect(nd.batch.events).toEqual([]);
    expect(nd.batch.deletedEvents).toEqual([]);
    expect(nd.isComplete).toBe(false);
    expect(nd.gameView).toMatchObject({ status: 'inprogress', coverage: 'extended_boxscore' });
    expect((nd.gameView?.score.home ?? 0) + (nd.gameView?.score.away ?? 0)).toBeGreaterThan(0);
    const s = ncaawbAdapter.normalizeSummary(
      SummaryDocumentSchema.parse(withCoverage('sim-d9b71fe0-summary-q1.json', 'boxscore')),
    );
    expect(s.batch.teamStats).toEqual([]);
    expect(s.batch.playerStats).toEqual([]);
    expect(s.players.length).toBeGreaterThan(0); // identity still learns the roster
  });

  it('extended_boxscore once closed: stats are emitted (stats_final_at), still no events', () => {
    // The Q1 documents with their status set to closed: the normalizer keys on status, not on content.
    const s = ncaawbAdapter.normalizeSummary(
      SummaryDocumentSchema.parse(
        withCoverage('sim-d9b71fe0-summary-q1.json', 'extended_boxscore', 'closed'),
      ),
    );
    expect(s.batch.teamStats).toHaveLength(2);
    expect(s.batch.playerStats.length).toBeGreaterThan(10);
    const p = ncaawbAdapter.normalizePbp(
      PbpDocumentSchema.parse(
        withCoverage('sim-d9b71fe0-pbp-q1.json', 'extended_boxscore', 'closed'),
      ),
    );
    expect(p.batch.events).toEqual([]);
    expect(p.gameView?.status).toBe('closed');
  });

  it('applyCoverage is the identity for full coverage', () => {
    const nd = ncaawbAdapter.normalizePbp(
      PbpDocumentSchema.parse(fixture('sim-d9b71fe0-pbp-q1.json', 'ncaawb')),
    );
    expect(applyCoverage(nd, { events: true, stats: 'live' })).toBe(nd);
  });
});
