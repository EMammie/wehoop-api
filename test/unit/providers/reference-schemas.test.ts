import { describe, expect, it } from 'vitest';
import { BoxscoreDocumentSchema } from '../../../src/providers/sportradar/schemas/boxscore.js';
import { LeagueHierarchyDocumentSchema } from '../../../src/providers/sportradar/schemas/hierarchy.js';
import { PbpDocumentSchema } from '../../../src/providers/sportradar/schemas/pbp.js';
import { PlayerProfileDocumentSchema } from '../../../src/providers/sportradar/schemas/profile.js';
import { SeasonScheduleDocumentSchema } from '../../../src/providers/sportradar/schemas/schedule.js';
import {
  LeagueLeadersDocumentSchema,
  TeamSeasonalStatisticsDocumentSchema,
} from '../../../src/providers/sportradar/schemas/seasonal-stats.js';
import { StandingsDocumentSchema } from '../../../src/providers/sportradar/schemas/standings.js';
import { SummaryDocumentSchema } from '../../../src/providers/sportradar/schemas/summary.js';
import {
  TournamentListDocumentSchema,
  TournamentScheduleDocumentSchema,
} from '../../../src/providers/sportradar/schemas/tournament.js';
import { fixture } from '../../helpers/fixtures.js';

type J = Record<string, unknown>;

/** Element `i` of a JSON array, typed as an object; throws instead of asserting non-null. */
function nth(value: unknown, i: number): J {
  const el = (value as J[])[i];
  if (!el) throw new Error(`fixture has no element ${i}`);
  return el;
}

/**
 * M2 acceptance "schema test rejects mutated fixture": for every schema family,
 * the committed fixture parses, and the same fixture with one persisted field
 * mutated to the wrong type (or dropped) is rejected. Unknown top-level fields
 * survive (`.loose()`).
 */
describe('reference and game schemas against committed fixtures', () => {
  const cases: Array<{
    name: string;
    schema: { safeParse: (v: unknown) => { success: boolean } };
    fixture: () => J;
    mutate: (doc: J) => void;
    drop: (doc: J) => void;
    keep?: (doc: J) => unknown;
  }> = [
    {
      name: 'Unrivaled pbp (Elam period, docs sample + away)',
      schema: PbpDocumentSchema,
      fixture: () => fixture('docs-838316ea-pbp-closed.json', 'unrivaled') as J,
      mutate: (d) => {
        nth(d.periods, 1).sequence = 'four';
      },
      drop: (d) => {
        delete (d.home as J).id;
      },
      keep: (d) => d.lead_changes,
    },
    {
      name: 'NCAAWB pbp (docs-free: recorded simulation)',
      schema: PbpDocumentSchema,
      fixture: () => fixture('sim-d9b71fe0-pbp-q1.json', 'ncaawb') as J,
      mutate: (d) => {
        nth(nth(d.periods, 0).events, 0).id = 42;
      },
      drop: (d) => {
        delete d.scheduled;
      },
      keep: (d) => d.conference_game,
    },
    {
      name: 'Unrivaled summary (player statistics, period stats)',
      schema: SummaryDocumentSchema,
      fixture: () => fixture('docs-838316ea-summary-closed.json', 'unrivaled') as J,
      mutate: (d) => {
        (nth((d.home as J).players, 0).statistics as J).points = '6';
      },
      drop: (d) => {
        delete (d.away as J).name;
      },
    },
    {
      name: 'Unrivaled boxscore (elam scoring)',
      schema: BoxscoreDocumentSchema,
      fixture: () => fixture('docs-838316ea-boxscore-closed.json', 'unrivaled') as J,
      mutate: (d) => {
        nth((d.home as J).scoring, 1).points = 'seven';
      },
      drop: (d) => {
        delete d.status;
      },
    },
    {
      name: 'Unrivaled player profile (references[], seasons[])',
      schema: PlayerProfileDocumentSchema,
      fixture: () => fixture('docs-player-profile-collier.json', 'unrivaled') as J,
      mutate: (d) => {
        nth(d.references, 1).source_id = 123;
      },
      drop: (d) => {
        delete d.full_name;
      },
      keep: (d) => d.high_school,
    },
    {
      name: 'WNBA player profile (external + sport_profile + NCAAW references)',
      schema: PlayerProfileDocumentSchema,
      fixture: () => fixture('docs-player-profile-boston.json', 'wnba') as J,
      mutate: (d) => {
        d.birthdate = '12/11/2001';
      },
      drop: (d) => {
        delete d.id;
      },
      keep: (d) => d.draft,
    },
    {
      name: 'Unrivaled tournament schedule (OOT, bracketed rounds)',
      schema: TournamentScheduleDocumentSchema,
      fixture: () => fixture('docs-tournament-schedule-28d4af13.json', 'unrivaled') as J,
      mutate: (d) => {
        const r = nth(d.rounds, 0);
        nth(nth(r.bracketed, 0).games, 0).scheduled = 'tomorrow';
      },
      drop: (d) => {
        delete (d.season as J).type;
      },
    },
    {
      name: 'Unrivaled tournament list',
      schema: TournamentListDocumentSchema,
      fixture: () => fixture('docs-tournament-list-2025-OOT.json', 'unrivaled') as J,
      mutate: (d) => {
        nth(d.tournaments, 0).start_date = 20250210;
      },
      drop: (d) => {
        delete nth(d.tournaments, 0).name;
      },
    },
    {
      name: 'NCAAWB schedule (coverage boxscore)',
      schema: SeasonScheduleDocumentSchema,
      fixture: () => fixture('docs-schedule-2022-REG.json', 'ncaawb') as J,
      mutate: (d) => {
        nth(d.games, 0).home_points = '88';
      },
      drop: (d) => {
        delete (nth(d.games, 0).home as J).id;
      },
      keep: (d) => nth(d.games, 0).conference_game,
    },
    {
      name: 'WNBA standings',
      schema: StandingsDocumentSchema,
      fixture: () => fixture('docs-standings-2022-REG.json', 'wnba') as J,
      mutate: (d) => {
        nth(nth(d.conferences, 0).teams, 0).wins = '26';
      },
      drop: (d) => {
        delete nth(nth(d.conferences, 0).teams, 0).losses;
      },
    },
    {
      name: 'NCAAWB hierarchy (divisions > conferences)',
      schema: LeagueHierarchyDocumentSchema,
      fixture: () => fixture('docs-hierarchy.json', 'ncaawb') as J,
      mutate: (d) => {
        const conf = nth(nth(d.divisions, 0).conferences, 0);
        nth(conf.teams, 0).id = null;
      },
      drop: (d) => {
        delete d.league;
      },
    },
    {
      name: 'Unrivaled seasonal statistics',
      schema: TeamSeasonalStatisticsDocumentSchema,
      fixture: () => fixture('docs-seasonal-stats-67c22115.json', 'unrivaled') as J,
      mutate: (d) => {
        (nth(d.players, 0).total as J).games_played = 1.5;
      },
      drop: (d) => {
        delete (d.season as J).year;
      },
    },
    {
      name: 'Unrivaled league leaders (captured)',
      schema: LeagueLeadersDocumentSchema,
      fixture: () => fixture('2026-REG-league-leaders.json', 'unrivaled') as J,
      mutate: (d) => {
        (nth(nth(d.categories, 0).ranks, 0).player as J).id = 7;
      },
      drop: (d) => {
        delete nth(nth(d.categories, 0).ranks, 0).rank;
      },
    },
  ];

  for (const c of cases) {
    it(`${c.name}: parses the committed fixture, rejects a mutated and a dropped persisted field`, () => {
      const ok = c.fixture();
      expect(c.schema.safeParse(ok).success).toBe(true);
      if (c.keep) expect(c.keep(ok)).toBeDefined(); // undeclared fields survive .loose()
      const mutated = c.fixture();
      c.mutate(mutated);
      expect(c.schema.safeParse(mutated).success).toBe(false);
      const dropped = c.fixture();
      c.drop(dropped);
      expect(c.schema.safeParse(dropped).success).toBe(false);
    });
  }
});
