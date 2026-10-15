import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureGame } from '../../src/ingest/apply-changes.js';
import { ensurePlayers, ensureTeams } from '../../src/ingest/identity.js';
import { ncaawbAdapter } from '../../src/leagues/ncaawb/adapter.js';
import { PbpDocumentSchema } from '../../src/providers/sportradar/schemas/pbp.js';
import { SummaryDocumentSchema } from '../../src/providers/sportradar/schemas/summary.js';
import { apply, counts, observation, replayRun, silentLog, testDb } from '../helpers/db.js';
import { fixture } from '../helpers/fixtures.js';

/**
 * NCAAWB coverage-driven behaviour (plan §2 league quirks, §9): an
 * `extended_boxscore` game emits status/score/period only while live, no event
 * changes ever, and its stats once the game is final. The recorded simulation
 * is `full`, so coverage is set on the recorded documents here.
 */
const db = testDb();
const deps = { db, log: silentLog };
const T0 = new Date('2026-02-18T23:40:00Z');
const later = (s: number) => new Date(T0.getTime() + s * 1000);

beforeAll(async () => {
  await db`select 1`;
});
afterAll(async () => {
  await db.end();
});

const doc = (name: string, coverage: string, status?: string) => {
  const raw = fixture(name, 'ncaawb') as Record<string, unknown>;
  raw.coverage = coverage;
  if (status) raw.status = status;
  return raw;
};

describe('NCAAWB extended_boxscore game through applyChanges', () => {
  it('emits only status and period changes while live, then stats (team + player) once closed; never an event change', async () => {
    const pbp = ncaawbAdapter.normalizePbp(
      PbpDocumentSchema.parse(doc('sim-d9b71fe0-pbp-q1.json', 'extended_boxscore')),
    );
    const providerGameId = `test-${randomUUID()}`;
    const teamIds = await ensureTeams(db, 'ncaawb', pbp.teams);
    const home = pbp.teams.find((t) => t.isHome);
    const away = pbp.teams.find((t) => !t.isHome);
    const { id: gameId } = await ensureGame(db, {
      league: 'ncaawb',
      providerGameId,
      scheduledAt: pbp.gameView?.scheduledAt ?? null,
      status: 'scheduled',
      coverage: 'extended_boxscore',
      homeTeamId: home ? (teamIds.get(home.providerTeamId) ?? null) : null,
      awayTeamId: away ? (teamIds.get(away.providerTeamId) ?? null) : null,
      venue: null,
      broadcasts: null,
    });
    const run = await replayRun(db, gameId);
    const r1 = await apply(deps, gameId, pbp, observation(run, pbp, T0));
    expect(r1.outcome === 'applied' && r1.changes.map((c) => c.type).sort()).toEqual([
      'period',
      'status',
    ]);
    const summaryLive = ncaawbAdapter.normalizeSummary(
      SummaryDocumentSchema.parse(doc('sim-d9b71fe0-summary-q1.json', 'extended_boxscore')),
    );
    await ensurePlayers(db, 'ncaawb', summaryLive.players);
    const r2 = await apply(deps, gameId, summaryLive, observation(run, summaryLive, later(5)));
    expect(r2.outcome === 'applied' && r2.changes).toEqual([]); // same status/score/period, no stats while live
    const [g] = await db<{ coverage: string; events: number }[]>`
      select coverage::text as coverage, (select count(*)::int from public.play_events where game_id = ${gameId}) as events
      from public.games where id = ${gameId}`;
    expect(g).toEqual({ coverage: 'extended_boxscore', events: 0 });
    const summaryClosed = ncaawbAdapter.normalizeSummary(
      SummaryDocumentSchema.parse(
        doc('sim-d9b71fe0-summary-q1.json', 'extended_boxscore', 'closed'),
      ),
    );
    const r3 = await apply(deps, gameId, summaryClosed, observation(run, summaryClosed, later(10)));
    if (r3.outcome !== 'applied') throw new Error('expected applied');
    const types = r3.changes.map((c) => c.type);
    expect(types).toContain('status');
    expect(types.filter((t) => t === 'stats_team')).toHaveLength(2);
    expect(types.filter((t) => t === 'stats_player').length).toBeGreaterThan(10);
    expect(types.some((t) => t.startsWith('event_'))).toBe(false);
    const c = await counts(db, gameId);
    expect(c.events).toBe(0);
    const [final] = await db<{ statsFinalAt: Date | null; players: number }[]>`
      select stats_final_at as "statsFinalAt", (select count(*)::int from public.game_player_stats where game_id = ${gameId}) as players
      from public.games where id = ${gameId}`;
    expect(final?.statsFinalAt).toBeInstanceOf(Date);
    expect(final?.players).toBe(types.filter((t) => t === 'stats_player').length);
    // v_boxscore shows the lines with jersey and team facts
    const box = await db<{ fullName: string; jersey: string | null; isHome: boolean }[]>`
      select full_name as "fullName", jersey, is_home as "isHome" from public.v_boxscore where game_id = ${gameId} order by is_home desc, full_name limit 3`;
    expect(box.length).toBe(3);
    expect(box[0]?.jersey).toBeTruthy();
  });
});
