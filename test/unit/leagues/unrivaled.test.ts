import { describe, expect, it } from 'vitest';
import { adapterFor } from '../../../src/leagues/registry.js';
import { unrivaledAdapter } from '../../../src/leagues/unrivaled/adapter.js';
import { LiveEventSchema } from '../../../src/model/live-event.js';
import { BoxscoreDocumentSchema } from '../../../src/providers/sportradar/schemas/boxscore.js';
import { PbpDocumentSchema } from '../../../src/providers/sportradar/schemas/pbp.js';
import { SummaryDocumentSchema } from '../../../src/providers/sportradar/schemas/summary.js';
import { fixture } from '../../helpers/fixtures.js';

/**
 * The Unrivaled game documents under fixtures/unrivaled are HAND-ASSEMBLED from
 * the Sportradar docs samples (no simulation recording exists for the product,
 * and no trial key was used): every id and number comes from a docs sample or
 * the league rule stated per file in fixtures/unrivaled/README.md. The Elam
 * target field name in particular is the plan's, not a captured one, and the
 * target 84 is derived, so that example is PARTLY SYNTHETIC.
 */
const pbp = (name: string) =>
  unrivaledAdapter.normalizePbp(PbpDocumentSchema.parse(fixture(name, 'unrivaled')));

describe('Unrivaled adapter: Elam Ending and 3-on-3 quirks', () => {
  it('registry resolves all three leagues', () => {
    expect(adapterFor('wnba').league).toBe('wnba');
    expect(adapterFor('ncaawb').league).toBe('ncaawb');
    expect(adapterFor('unrivaled').league).toBe('unrivaled');
  });

  it('during regulation the game clock is live and no target is set', () => {
    const q1 = pbp('docs-838316ea-pbp-q1.json');
    expect(q1.gameView).toMatchObject({
      status: 'inprogress',
      period: { number: 1, type: 'quarter', sequence: 1 },
      clock: '6:48',
      clockRunning: null,
      elamTargetScore: null,
    });
    expect(q1.gameView?.clockExtra).toEqual({ clockType: 'standard' });
    expect(q1.gameView?.season).toEqual({
      providerSeasonId: 'c86ab7c9-5408-44e6-af06-c22636262927',
      year: 2025,
      type: 'REG',
    });
  });

  it('in the Elam period the game clock is null, clock_running is false, the target is read and the count-up lands in clockExtra', () => {
    const el = pbp('docs-838316ea-pbp-elam.json');
    expect(el.gameView).toMatchObject({
      status: 'inprogress',
      period: { number: 4, type: 'elam', sequence: 4 },
      clock: null,
      clockDecimal: null,
      clockRunning: false,
      elamTargetScore: 84,
    });
    expect(el.gameView?.clockExtra).toEqual({ clockType: 'elam', clockDirectional: '+00:19' });
    expect(el.gameView?.periods.map((p) => [p.sequence, p.type])).toEqual([
      [1, 'quarter'],
      [4, 'elam'],
    ]);
    // the Elam event keeps the provider's count-up next to its clock
    const elamEvent = el.batch.events.find((e) => e.periodType === 'elam');
    expect(elamEvent?.body).toMatchObject({ type: 'shot', made: true, clockDirectional: '+00:19' });
    expect(LiveEventSchema.safeParse(elamEvent?.body).success).toBe(true);
  });

  it('accepts the other spelling of the target (`target_score`) and omits it when absent', () => {
    const raw = fixture('docs-838316ea-pbp-elam.json', 'unrivaled') as Record<string, unknown>;
    delete raw.elam_target_score;
    expect(
      unrivaledAdapter.normalizePbp(PbpDocumentSchema.parse(raw)).gameView?.elamTargetScore,
    ).toBeNull();
    raw.target_score = 84;
    expect(
      unrivaledAdapter.normalizePbp(PbpDocumentSchema.parse(raw)).gameView?.elamTargetScore,
    ).toBe(84);
  });

  it('closed game: final score, closed status, players collected from on_court and statistics', () => {
    const closed = pbp('docs-838316ea-pbp-closed.json');
    expect(closed.gameView).toMatchObject({
      status: 'closed',
      score: { home: 80, away: 84 },
      elamTargetScore: 84,
    });
    expect(closed.batch.events).toHaveLength(4);
    const ids = new Set(closed.players.map((p) => p.providerPlayerId));
    expect(ids.has('a00515fd-bdd9-44d1-83a5-597a99316c54')).toBe(true); // Breanna Stewart
    const stewart = closed.players.find(
      (p) => p.providerPlayerId === 'a00515fd-bdd9-44d1-83a5-597a99316c54',
    );
    expect(stewart).toMatchObject({
      fullName: 'Breanna Stewart',
      jersey: '30',
      providerTeamId: '0780b080-347b-407b-b8d6-fa109ec23908',
    });
  });

  it('summary carries player box lines with canonical-free provider ids and typed stats', () => {
    const s = unrivaledAdapter.normalizeSummary(
      SummaryDocumentSchema.parse(fixture('docs-838316ea-summary-closed.json', 'unrivaled')),
    );
    expect(s.batch.teamStats).toHaveLength(1);
    expect(s.batch.playerStats).toHaveLength(1);
    const line = s.batch.playerStats[0];
    expect(line).toMatchObject({
      providerPlayerId: 'a00515fd-bdd9-44d1-83a5-597a99316c54',
      fullName: 'Breanna Stewart',
      jersey: '30',
      starter: true,
      stats: { points: 6, rebounds: 13, fga: 10, plusMinus: -11, minutes: '13:06' },
    });
    expect(line?.stats.extra).toHaveProperty('true_shooting_pct');
    expect(s.gameView?.elamTargetScore).toBe(84);
    const b = unrivaledAdapter.normalizeBoxscore(
      BoxscoreDocumentSchema.parse(fixture('docs-838316ea-boxscore-closed.json', 'unrivaled')),
    );
    expect(b.gameView?.periods.find((p) => p.type === 'elam')).toEqual({
      number: 4,
      type: 'elam',
      sequence: 4,
      score: { home: 7, away: 17 },
    });
  });

  it('maps lineupchangeone / lineupchangethree to lineup_change and a winning basket onto the shot', () => {
    const raw = fixture('docs-838316ea-pbp-elam.json', 'unrivaled') as {
      periods: { events: Record<string, unknown>[] }[];
    };
    const elam = raw.periods[1];
    const last = elam?.events[0];
    if (!elam || !last) throw new Error('fixture has no elam event');
    const stats = last.statistics as Record<string, unknown>[];
    (stats[0] as Record<string, unknown>).winning_basket = true;
    elam.events.push({
      id: 'lu-1',
      event_type: 'lineupchangeone',
      sequence: 1763078027999,
      clock: '00:25',
      attribution: { id: '0780b080-347b-407b-b8d6-fa109ec23908', name: 'Mist' },
      on_court: {
        home: {
          id: '0780b080-347b-407b-b8d6-fa109ec23908',
          players: [{ id: 'p-b' }, { id: 'p-a' }, { id: 'p-c' }],
        },
      },
    });
    const nd = unrivaledAdapter.normalizePbp(PbpDocumentSchema.parse(raw));
    const bodies = nd.batch.events.map((e) => e.body);
    expect(bodies.find((b) => b.type === 'shot' && b.winningBasket)).toBeDefined();
    const lineup = bodies.find((b) => b.type === 'lineup_change');
    expect(lineup?.type === 'lineup_change' && lineup.providerOnCourtPlayerIds).toEqual([
      'p-a',
      'p-b',
      'p-c',
    ]);
  });
});
