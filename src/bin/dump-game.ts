import { parseArgs } from 'node:util';
import { loadConfig } from '../config.js';
import { createDb } from '../db/client.js';
import { canonicalJson } from '../model/content-hash.js';

/**
 * pnpm dump-game --game <uuid> | --provider-game-id <id> [--league wnba]
 * Canonical JSON of the game's durable state: play_events bodies (stable
 * order), game_periods, final score, team stats. No volatile ids or
 * timestamps, so two replays into clean databases produce byte-identical dumps.
 */
async function main() {
  const { values: args } = parseArgs({
    options: {
      game: { type: 'string' },
      'provider-game-id': { type: 'string' },
      league: { type: 'string', default: 'wnba' },
      'include-deleted': { type: 'boolean', default: false },
    },
    strict: true,
  });
  const config = loadConfig();
  const db = createDb(config.db.url, { max: 2 });
  const [g] = args.game
    ? await db<Row[]>`select ${columns(db)} from public.games g where g.id = ${args.game}`
    : await db<
        Row[]
      >`select ${columns(db)} from public.games g where g.league = ${args.league} and g.provider_game_id = ${args['provider-game-id'] ?? ''}`;
  if (!g) {
    console.error('game not found');
    process.exit(66);
  }
  const periods = await db<
    { number: number; type: string; sequence: number; home: number; away: number }[]
  >`
    select number, type::text as type, sequence, home_points as home, away_points as away
    from public.game_periods where game_id = ${g.id} order by sequence`;
  const events = await db<
    {
      providerEventId: string;
      body: unknown;
      deleted: boolean;
      periodSequence: number | null;
      providerSequence: string | null;
      providerNumber: number | null;
    }[]
  >`
    select provider_event_id as "providerEventId", payload as body, (deleted_at is not null) as deleted,
           period_sequence as "periodSequence", provider_sequence::text as "providerSequence", provider_number as "providerNumber"
    from public.play_events where game_id = ${g.id} ${args['include-deleted'] ? db`` : db`and deleted_at is null`}
    order by period_sequence nulls first, provider_sequence nulls first, provider_number nulls first, provider_event_id`;
  const teamStats = await db<
    { isHome: boolean; providerTeamId: string; contentHash: string | null; points: number | null }[]
  >`
    select s.is_home as "isHome", t.provider_team_id as "providerTeamId", s.content_hash as "contentHash", s.points
    from public.game_team_stats s join public.teams t on t.id = s.team_id
    where s.game_id = ${g.id} order by s.is_home desc`;
  await db.end();
  const dump = {
    game: {
      providerGameId: g.providerGameId,
      status: g.status,
      score: { home: g.homePoints, away: g.awayPoints },
      currentPeriod: g.currentPeriod,
      currentPeriodSequence: g.currentPeriodSequence,
      lastSeq: Number(g.lastSeq),
    },
    periods,
    eventCount: events.length,
    events: events.map((e) => ({
      providerEventId: e.providerEventId,
      deleted: e.deleted,
      body: e.body,
    })),
    teamStats,
  };
  console.log(JSON.stringify(JSON.parse(canonicalJson(dump)), null, 1));
}

interface Row {
  id: string;
  providerGameId: string;
  status: string;
  homePoints: number;
  awayPoints: number;
  currentPeriod: number | null;
  currentPeriodSequence: number | null;
  lastSeq: string;
}

function columns(db: ReturnType<typeof createDb>) {
  return db`g.id, g.provider_game_id as "providerGameId", g.status::text as status, g.home_points as "homePoints",
            g.away_points as "awayPoints", g.current_period as "currentPeriod",
            g.current_period_sequence as "currentPeriodSequence", g.last_seq::text as "lastSeq"`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
