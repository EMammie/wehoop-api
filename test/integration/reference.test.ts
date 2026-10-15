import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReferenceIngester } from '../../src/ingest/reference.js';
import {
  apply,
  counts,
  observation,
  pbpQ1,
  replayRun,
  seedGame,
  silentLog,
  staleReasons,
  testDb,
} from '../helpers/db.js';
import { fixture } from '../helpers/fixtures.js';

/**
 * Reference feeds through ReferenceIngester. Provider ids of games are suffixed
 * per run so the tests never collide with the validator's replays.
 */
const db = testDb();
const T0 = new Date('2025-01-17T23:00:00Z');

beforeAll(async () => {
  await db`select 1`;
});
afterAll(async () => {
  await db.end();
});

const suffixed = <T>(doc: unknown, ids: string[], suffix: string): T => {
  let text = JSON.stringify(doc);
  for (const id of ids) text = text.replaceAll(id, `${id}-${suffix}`);
  return JSON.parse(text) as T;
};

const ingester = (league: 'wnba' | 'ncaawb' | 'unrivaled') =>
  new ReferenceIngester({ db, log: silentLog, league, source: 'fixture', runSource: 'fixture' });

describe('ReferenceIngester', () => {
  it('season schedule: games, teams and the season are created; a closed schedule entry sets status but never score', async () => {
    const suffix = randomUUID();
    const gameIds = [
      '838316ea-ab7b-4581-a1dd-74229d1970d5',
      '3c58e5c2-6d7c-4797-9a43-9f3fffc536f7',
      '5a8f4590-601c-4ed0-88f6-df78201e0a22',
    ];
    const doc = suffixed(fixture('docs-schedule-2025-REG.json', 'unrivaled'), gameIds, suffix);
    const out = await ingester('unrivaled').process('schedule', doc, T0);
    expect(out).toMatchObject({ feed: 'schedule', games: 3, stale: 0 });
    const rows = await db<
      {
        providerGameId: string;
        status: string;
        home: number;
        away: number;
        lastSeq: string;
        season: string;
        title: string | null;
      }[]
    >`
      select g.provider_game_id as "providerGameId", g.status::text as status, g.home_points as home, g.away_points as away,
             g.last_seq::text as "lastSeq", s.type::text || s.year::text as season, g.title
      from public.games g join public.seasons s on s.id = g.season_id
      where g.league = 'unrivaled' and g.provider_game_id = any(${gameIds.map((i) => `${i}-${suffix}`)})
      order by g.scheduled_at`;
    expect(rows.map((r) => [r.status, r.home, r.away, Number(r.lastSeq), r.season])).toEqual([
      // created as closed by ensureGame (status is taken from the document on insert); the
      // generation-less batch then finds nothing to change and never writes the 80-84 score
      ['closed', 0, 0, 0, 'REG2025'],
      ['scheduled', 0, 0, 0, 'REG2025'],
      ['scheduled', 0, 0, 0, 'REG2025'],
    ]);
    // same document again: nothing new
    const again = await ingester('unrivaled').process(
      'schedule',
      doc,
      new Date(T0.getTime() + 1000),
    );
    expect(again.games).toBe(3);
    const [first] = rows;
    const [after] = await db<{ lastSeq: string }[]>`
      select last_seq::text as "lastSeq" from public.games where league = 'unrivaled' and provider_game_id = ${first?.providerGameId ?? ''}`;
    expect(after?.lastSeq).toBe('0');
  });

  it('a lagging schedule entry during a live game writes nothing game-level and is logged superseded_observation', async () => {
    const nd = pbpQ1();
    const { gameId, providerGameId } = await seedGame(db, nd);
    const run = await replayRun(db, gameId);
    await apply({ db, log: silentLog }, gameId, nd, observation(run, nd, T0));
    const before = await counts(db, gameId);
    expect(before.lastSeq).toBeGreaterThan(0);
    const doc = {
      season: { id: `season-${randomUUID()}`, year: 2026, type: 'CC' },
      games: [
        {
          id: providerGameId,
          status: 'scheduled',
          coverage: 'full',
          scheduled: nd.gameView?.scheduledAt,
          home_points: 0,
          away_points: 0,
          home: { id: nd.teams[0]?.providerTeamId, name: nd.teams[0]?.name },
          away: { id: nd.teams[1]?.providerTeamId, name: nd.teams[1]?.name },
        },
      ],
    };
    const out = await ingester('wnba').process('schedule', doc, new Date(T0.getTime() + 60_000));
    expect(out.stale).toBe(1);
    const after = await counts(db, gameId);
    expect(after).toMatchObject({
      lastSeq: before.lastSeq,
      home: before.home,
      away: before.away,
      watchRunId: before.watchRunId,
    });
    expect((await staleReasons(db, gameId)).superseded_observation).toBe(1);
    // the CC season (Commissioner's Cup) is now a real season row linked to the game
    const [g] = await db<{ type: string }[]>`
      select s.type::text as type from public.games g join public.seasons s on s.id = g.season_id where g.id = ${gameId}`;
    expect(g?.type).toBe('CC');
  });

  it('tournament list + tournament schedule: OOT games attach to their tournament and OOT season', async () => {
    const suffix = randomUUID();
    const ids = [
      '28d4af13-bfa1-4c95-9f1b-30af6fd5b7ee',
      '506e7bd0-ec4e-49aa-b55c-bddd8ed41003',
      '06dbbc3b-b5e2-444c-b70b-06465e267135',
      '04cb26c7-b1d2-4e19-8fe4-c0a30814aa5c',
    ];
    const list = suffixed(fixture('docs-tournament-list-2025-OOT.json', 'unrivaled'), ids, suffix);
    const sched = suffixed(
      fixture('docs-tournament-schedule-28d4af13.json', 'unrivaled'),
      ids,
      suffix,
    );
    const a = await ingester('unrivaled').process('tournament_list', list, T0);
    expect(a.tournaments).toBe(1);
    const b = await ingester('unrivaled').process('tournament_schedule', sched, T0);
    expect(b).toMatchObject({ tournaments: 1, games: 2, stale: 0 });
    const rows = await db<
      {
        providerGameId: string;
        status: string;
        title: string | null;
        tournament: string;
        seasonType: string;
        startsOn: string | null;
        parent: string | null;
      }[]
    >`
      select g.provider_game_id as "providerGameId", g.status::text as status, g.title, t.name as tournament, s.type::text as "seasonType",
             t.starts_on::text as "startsOn", t.provider_parent_id as parent
      from public.games g
      join public.tournaments t on t.id = g.tournament_id
      join public.seasons s on s.id = g.season_id
      where g.provider_game_id in (${`${ids[1]}-${suffix}`}, ${`${ids[2]}-${suffix}`})
      order by g.scheduled_at`;
    expect(rows).toEqual([
      {
        providerGameId: `${ids[1]}-${suffix}`,
        status: 'cancelled',
        title: 'First Round - Pod C - Game 2',
        tournament: '2025 Unrivaled 1 on 1 Tournament',
        seasonType: 'OOT',
        startsOn: '2025-02-10',
        parent: '39dbbe86-83b9-4f7a-80e1-becc451cc7f2',
      },
      {
        providerGameId: `${ids[2]}-${suffix}`,
        status: 'closed',
        title: 'First Round - Pod B - Game 1',
        tournament: '2025 Unrivaled 1 on 1 Tournament',
        seasonType: 'OOT',
        startsOn: '2025-02-10',
        parent: '39dbbe86-83b9-4f7a-80e1-becc451cc7f2',
      },
    ]);
    // idempotent
    const again = await ingester('unrivaled').process(
      'tournament_schedule',
      sched,
      new Date(T0.getTime() + 1000),
    );
    expect(again.games).toBe(2);
    const [n] = await db<{ n: number }[]>`
      select count(*)::int as n from public.tournaments where provider_tournament_id = ${`${ids[0]}-${suffix}`}`;
    expect(n?.n).toBe(1);
  });

  it('standings and hierarchy: standings rows per team with conference, hierarchy fills colors and venue; both idempotent', async () => {
    const suffix = randomUUID();
    const seasonId = `73f9bbde-1a9a-4ae3-95d7-125df431bdda`;
    const st = suffixed(fixture('docs-standings-2022-REG.json', 'wnba'), [seasonId], suffix);
    // (league, year, type) is unique, so a re-run of this suite lands on the same season row and
    // finds the rows already written: assert on state, and on the second pass writing nothing.
    const out = await ingester('wnba').process('standings', st, T0);
    expect(out.standings).toBeGreaterThanOrEqual(0);
    const rows = await db<
      {
        team: string;
        conference: string;
        wins: number;
        rank: number | null;
        streak: string | null;
      }[]
    >`
      select t.name as team, st.conference, st.wins, st.rank, st.streak
      from public.standings st join public.seasons s on s.id = st.season_id join public.teams t on t.id = st.team_id
      where s.year = 2022 and s.type = 'REG' and s.league = 'wnba' order by st.conference, st.rank`;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({ conference: expect.any(String), wins: expect.any(Number) });
    const again = await ingester('wnba').process('standings', st, new Date(T0.getTime() + 1000));
    expect(again.standings).toBe(0); // unchanged hashes: nothing rewritten
    const h = await ingester('wnba').process(
      'hierarchy',
      fixture('docs-hierarchy.json', 'wnba'),
      T0,
    );
    expect(h.teams).toBeGreaterThan(0);
    const [liberty] = await db<
      { conference: string | null; colors: unknown; venue: { name?: string } | null }[]
    >`
      select conference, colors, venue from public.teams where league = 'wnba' and provider_team_id = '08ed8274-e29f-4248-bc2e-83cc8ed18d75'`;
    expect(liberty?.conference).toBeTruthy();
    expect(Array.isArray(liberty?.colors)).toBe(true);
    expect(liberty?.venue?.name).toBeTruthy();
  });

  it('seasonal statistics and league leaders write season lines once; re-applying writes none', async () => {
    const suffix = randomUUID();
    const seasonal = suffixed(
      fixture('docs-seasonal-stats-6e0c5edc.json', 'ncaawb'),
      ['cf5dcb91-e9ec-4993-ba42-5d632306b4c8'],
      suffix,
    );
    const a = await ingester('ncaawb').process('seasonal_stats', seasonal, T0);
    expect(a).toMatchObject({ teams: 1, players: 1 });
    expect(a.seasonLines).toBeLessThanOrEqual(1); // 0 when a previous run of this suite already wrote it
    const b = await ingester('ncaawb').process('seasonal_stats', seasonal, T0);
    expect(b.seasonLines).toBe(0);
    const [line] = await db<{ n: number }[]>`
      select count(*)::int as n from public.v_player_seasons where league = 'ncaawb' and season_year = 2023 and season_type = 'REG'`;
    expect(line?.n).toBeGreaterThanOrEqual(1);
    const leaders = suffixed(
      fixture('2026-REG-league-leaders.json', 'unrivaled'),
      ['e8440860-998c-42ca-902d-461e588de916'],
      suffix,
    );
    const c = await ingester('unrivaled').process('league_leaders', leaders, T0);
    expect(c.players).toBe(45);
    expect(c.seasonLines).toBeLessThanOrEqual(45);
    const d = await ingester('unrivaled').process('league_leaders', leaders, T0);
    expect(d.seasonLines).toBe(0);
    const [lines] = await db<{ n: number }[]>`
      select count(*)::int as n from public.v_player_seasons where season_type = 'REG' and season_year = 2026 and league = 'unrivaled'`;
    expect(lines?.n).toBeGreaterThanOrEqual(45);
  });
});
