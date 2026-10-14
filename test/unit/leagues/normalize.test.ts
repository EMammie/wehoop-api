import { describe, expect, it } from 'vitest';
import {
  clockToSeconds,
  lineScoreFromScoring,
  mapPeriodType,
  mapStatus,
  normalizeEvent,
} from '../../../src/leagues/sportradar-basketball/normalize.js';
import { wnbaAdapter } from '../../../src/leagues/wnba/adapter.js';
import { contentHash } from '../../../src/model/content-hash.js';
import { LiveEventSchema } from '../../../src/model/live-event.js';
import { BoxscoreDocumentSchema } from '../../../src/providers/sportradar/schemas/boxscore.js';
import {
  PbpDocumentSchema,
  PbpEventSchema,
} from '../../../src/providers/sportradar/schemas/pbp.js';
import { SummaryDocumentSchema } from '../../../src/providers/sportradar/schemas/summary.js';
import { fixture } from '../../helpers/fixtures.js';

const R = 'sim-93ee7c68';

describe('Sportradar basketball normalizer', () => {
  const pbp = PbpDocumentSchema.parse(fixture(`${R}-pbp-q1.json`));
  const nd = wnbaAdapter.normalizePbp(pbp);

  it('turns every provider event into a valid LiveEvent, unknown types into other', () => {
    expect(nd.isComplete).toBe(true);
    expect(nd.batch.events.length).toBe(pbp.periods.reduce((n, p) => n + p.events.length, 0));
    for (const e of nd.batch.events) expect(LiveEventSchema.safeParse(e.body).success).toBe(true);
    const types = new Set(nd.batch.events.map((e) => e.body.type));
    expect(types).toContain('shot');
    expect(types).toContain('rebound');
    expect(types).toContain('lineup_change');
    expect(types).toContain('tip_off');
    expect(types).toContain('period_start');
    const other = nd.batch.events.find((e) => e.body.type === 'other');
    expect(other?.body.type === 'other' && other.body.providerEventType).toBe('stoppage');
  });

  it('fills shot details from statistics[] and carries provider ids', () => {
    const made = nd.batch.events.find((e) => e.providerEventType === 'twopointmade');
    expect(made?.body).toMatchObject({ type: 'shot', made: true, points: 2, shotType: 'layup' });
    expect(made?.body.providerPlayerId).toMatch(/^[0-9a-f-]{36}$/);
    expect(made?.body.providerTeamId).toBe(made?.teamProviderId);
    const lineup = nd.batch.events.find((e) => e.body.type === 'lineup_change');
    expect(
      lineup?.body.type === 'lineup_change' && lineup.body.providerOnCourtPlayerIds.length,
    ).toBe(5);
    expect(made?.providerUpdatedAt).toMatch(/^2026-/);
    expect(made?.periodSequence).toBe(1);
  });

  it('builds the gameView from the header and the line score from periods[].scoring', () => {
    expect(nd.gameView).toMatchObject({
      status: 'inprogress',
      period: { number: 1, type: 'quarter', sequence: 1 },
    });
    expect(nd.gameView?.periods[0]?.score.home).toBe(pbp.periods[0]?.scoring?.home.points);
    expect(nd.gameView?.clockRunning).toBeNull();
    expect(nd.teams.map((t) => t.isHome)).toEqual([true, false]);
    expect(nd.providerGameId).toBe(pbp.id);
  });

  it('is deterministic: the same document hashes to the same bodies', () => {
    const again = wnbaAdapter.normalizePbp(PbpDocumentSchema.parse(fixture(`${R}-pbp-q1.json`)));
    expect(again.batch.events.map((e) => contentHash(e.body))).toEqual(
      nd.batch.events.map((e) => contentHash(e.body)),
    );
  });

  it('reads an explicit deleted_events[] marker and never infers deletion from absence', () => {
    const withMarker = PbpDocumentSchema.parse({
      ...(fixture(`${R}-pbp-q1.json`) as object),
      deleted_events: [{ id: 'gone' }, { id: 'gone-rev', updated: '2026-06-30T23:40:00+00:00' }],
    });
    expect(wnbaAdapter.normalizePbp(withMarker).batch.deletedEvents).toEqual([
      { providerEventId: 'gone', updatedAt: null },
      { providerEventId: 'gone-rev', updatedAt: '2026-06-30T23:40:00+00:00' },
    ]);
    expect(nd.batch.deletedEvents).toEqual([]);
  });

  it('normalizes summary into gameView + team stats (no events) and boxscore into a line score', () => {
    const s = wnbaAdapter.normalizeSummary(
      SummaryDocumentSchema.parse(fixture(`${R}-summary-q1.json`)),
    );
    expect(s.isComplete).toBe(false);
    expect(s.batch.events).toEqual([]);
    expect(s.batch.teamStats).toHaveLength(2);
    expect(s.batch.teamStats[0]?.stats.fga).toBeTypeOf('number');
    const b = wnbaAdapter.normalizeBoxscore(
      BoxscoreDocumentSchema.parse(fixture(`${R}-boxscore-q1.json`)),
    );
    expect(b.gameView?.periods[0]).toMatchObject({ number: 1, sequence: 1, type: 'quarter' });
  });

  it('maps statuses and period types, parses clocks', () => {
    expect(mapStatus('inprogress')).toBe('inprogress');
    expect(mapStatus('time-tbd')).toBe('time_tbd');
    expect(mapStatus('weird')).toBeNull(); // never invented: reported as unknownStatus instead
    const weird = wnbaAdapter.normalizePbp(
      PbpDocumentSchema.parse({ ...(fixture(`${R}-pbp-q1.json`) as object), status: 'weird' }),
    );
    expect(weird.gameView).toMatchObject({ status: null, unknownStatus: 'weird' });
    expect(mapPeriodType('REG')).toBe('quarter');
    expect(mapPeriodType('overtime')).toBe('overtime');
    expect(mapPeriodType('OT')).toBe('overtime');
    expect(clockToSeconds('5:30')).toBe(330);
    expect(clockToSeconds('0:04.7')).toBeCloseTo(4.7);
    expect(clockToSeconds(null)).toBeNull();
    expect(clockToSeconds('')).toBeNull();
  });

  it('zips home/away scoring into one line score', () => {
    const line = lineScoreFromScoring(
      [{ type: 'quarter', number: 1, sequence: 1, points: 20 }],
      [
        { type: 'quarter', number: 1, sequence: 1, points: 18 },
        { type: 'quarter', number: 2, sequence: 2, points: 3 },
      ],
    );
    expect(line).toEqual([
      { number: 1, type: 'quarter', sequence: 1, score: { home: 20, away: 18 } },
      { number: 2, type: 'quarter', sequence: 2, score: { home: 0, away: 3 } },
    ]);
  });

  it('maps free throws, turnovers, fouls and timeouts', () => {
    const period = { number: 1, type: 'quarter' as const, sequence: 1 };
    const ft = normalizeEvent(
      PbpEventSchema.parse({
        id: 'a',
        event_type: 'freethrowmade',
        description: 'X makes free throw 2 of 2',
        statistics: [{ type: 'freethrow', made: true, player: { id: 'p1' } }],
      }),
      period,
    );
    expect(ft.body).toMatchObject({
      type: 'free_throw',
      made: true,
      attempt: 2,
      of: 2,
      providerPlayerId: 'p1',
    });
    const to = normalizeEvent(
      PbpEventSchema.parse({
        id: 'b',
        event_type: 'turnover',
        turnover_type: 'badpass',
        statistics: [
          { type: 'turnover', player: { id: 'p2' } },
          { type: 'steal', player: { id: 'p3' } },
        ],
      }),
      period,
    );
    expect(to.body).toMatchObject({
      type: 'turnover',
      kind: 'badpass',
      providerPlayerId: 'p2',
      providerStealId: 'p3',
    });
    const foul = normalizeEvent(
      PbpEventSchema.parse({
        id: 'c',
        event_type: 'shootingfoul',
        statistics: [
          { type: 'personalfoul', foul_type: 'shooting', player: { id: 'p4' } },
          { type: 'fouldrawn', player: { id: 'p5' } },
        ],
      }),
      period,
    );
    expect(foul.body).toMatchObject({
      type: 'foul',
      kind: 'shooting',
      providerPlayerId: 'p4',
      providerDrawnById: 'p5',
    });
    expect(
      normalizeEvent(PbpEventSchema.parse({ id: 'd', event_type: 'tvtimeout' }), period).body,
    ).toMatchObject({ type: 'timeout', kind: 'tv' });
    expect(
      normalizeEvent(PbpEventSchema.parse({ id: 'e', event_type: 'somethingnew' }), period).body,
    ).toMatchObject({ type: 'other', providerEventType: 'somethingnew' });
  });
});
