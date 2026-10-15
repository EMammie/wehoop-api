import { describe, expect, it } from 'vitest';
import { applyCoverage, defaultCoverageFor } from '../../../src/leagues/adapter.js';
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
  it('maps coverage strings to profiles', () => {
    expect(defaultCoverageFor('full')).toEqual({ events: true, stats: 'live' });
    expect(defaultCoverageFor(null)).toEqual({ events: true, stats: 'live' });
    expect(defaultCoverageFor('extended_boxscore')).toEqual({ events: false, stats: 'final' });
    expect(defaultCoverageFor('boxscore')).toEqual({ events: false, stats: 'final' });
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
