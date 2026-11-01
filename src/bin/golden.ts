import { execSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { z } from 'zod';
import { createApp } from '../api/server.js';
import { isDevStackUrl, loadConfig } from '../config.js';
import { CONTRACTS } from '../contracts/registry.js';
import { createDb } from '../db/client.js';
import type { LeagueCode } from '../leagues/codes.js';
import { buildPulse } from '../live/pulse.js';
import { DbScoreboardSource } from '../live/scoreboard.js';
import { createLogger } from '../logger.js';
import { ScoreboardSchema } from '../model/scoreboard.js';

/**
 * pnpm golden --out <dir>
 *   Capture the golden JSON the app's TestSupport decodes (Wehoop M5 S1): for
 *   every seeded game its snapshot, every /changes page (limit 500) plus the
 *   empty tail page, its pulse and its v_boxscore rows; per league the
 *   v_schedule, v_standings, v_player_seasons and v_leaders rows and a
 *   league:{code}:scores message; the leagues rows; and /v1/players/:id for the
 *   three profiled players (Boston across three leagues). API bodies come from
 *   the Hono app in-process (the bytes the API serves); view rows come from the
 *   local PostgREST with the anon key (the bytes the app receives). Every body
 *   is parsed with its registry schema before it is written, so a golden can
 *   never disagree with the backend's own contract. manifest.json lists each
 *   file with its contract type; the app decodes every entry.
 *
 *   Needs the dev stack seeded (`pnpm seed:dev`); ids differ per `db reset`, so
 *   goldens are frozen files recaptured as a whole, never diffed by hand.
 * Exit codes: 0 ok; 64 usage; 65 wrong database; 66 a seeded row is missing.
 */

interface GoldenGame {
  league: LeagueCode;
  providerGameId: string;
  /** File stem; the app's TestSupport names its cases after these. */
  stem: string;
  note: string;
}

export const GOLDEN_GAMES: GoldenGame[] = [
  {
    league: 'wnba',
    providerGameId: '40bea3f6-68c0-4f3b-96fa-336dfb7a9034',
    stem: 'sim-93ee7c68',
    note: 'Las Vegas Aces at New York Liberty, 2026 Commissioner’s Cup final; full coverage, every change type, five deleted events',
  },
  {
    league: 'ncaawb',
    providerGameId: '2e36b340-9277-4b99-af20-b7ff7e86640e',
    stem: 'sim-d9b71fe0',
    note: 'Northwestern at Michigan State, 2025 REG; full coverage',
  },
  {
    league: 'ncaawb',
    providerGameId: 'e5e5e5e5-9277-4b99-af20-b7ff7e86640e',
    stem: 'sim-d9b71fe0-extended',
    note: 'the same recording relabelled extended_boxscore: status and period changes only, stats at stats_final_at',
  },
  {
    league: 'unrivaled',
    providerGameId: '838316ea-ab7b-4581-a1dd-74229d1970d5',
    stem: 'docs-838316ea',
    note: 'Lunar Owls at Mist, hand-assembled from docs samples; Elam period, target 84 (partly synthetic, fixtures/unrivaled/README.md)',
  },
];

export const GOLDEN_PLAYERS: { league: LeagueCode; providerPlayerId: string; stem: string }[] = [
  { league: 'unrivaled', providerPlayerId: '54b8a881-27f7-4735-b499-0c3adf0286b0', stem: 'boston' }, // WNBA + NCAAW + Unrivaled ids
  { league: 'ncaawb', providerPlayerId: '29d82b92-40a0-4116-bf6d-f807901fbb7e', stem: 'stuelke' },
  {
    league: 'unrivaled',
    providerPlayerId: 'fd8d4b11-3d70-450a-b65c-016bec29cc9d',
    stem: 'collier',
  },
];

const LEAGUES: LeagueCode[] = ['wnba', 'ncaawb', 'unrivaled'];
const PAGE = 500;

export interface GoldenEntry {
  file: string;
  /** Registry contract name (src/contracts/registry.ts) the body decodes as. */
  type: string;
  /** True when the file is a JSON array of `type`. */
  array: boolean;
  league: LeagueCode | null;
  /** The game stem for per-game files. */
  game: string | null;
  /** Where the bytes came from: an API path or a PostgREST path. */
  source: string;
}

export interface GoldenManifest {
  generator: 'pnpm golden';
  backendCommit: string;
  capturedAt: string;
  games: GoldenGame[];
  entries: GoldenEntry[];
}

function schemaOf(type: string): z.ZodType {
  const entry = CONTRACTS.find((c) => c.name === type);
  if (!entry) throw new Error(`no contract named ${type}`);
  return entry.schema;
}

async function main() {
  const { values: args } = parseArgs({
    options: { out: { type: 'string' } },
    strict: true,
  });
  if (!args.out) {
    console.error('usage: pnpm golden --out <dir>');
    process.exit(64);
  }
  const out = resolve(args.out);
  const config = loadConfig(process.env);
  if (config.mode !== 'sim' || !isDevStackUrl(config.db.url)) {
    console.error(
      `golden captures from the seeded DEV stack only (MODE=sim, DATABASE_URL at 127.0.0.1:54322); got MODE=${config.mode}`,
    );
    process.exit(65);
  }
  if (!config.supabase.anonKey) {
    console.error(
      'SUPABASE_ANON_KEY is required (the view rows are read through PostgREST as the app does)',
    );
    process.exit(64);
  }
  const anonKey = config.supabase.anonKey;
  const log = createLogger({ level: 'error' });
  const db = createDb(config.db.url);
  const app = createApp({ db, config, log });
  const entries: GoldenEntry[] = [];
  let written = 0;

  const write = async (
    entry: Omit<GoldenEntry, 'file'> & { file: string },
    text: string,
  ): Promise<void> => {
    const schema = schemaOf(entry.type);
    const parsed: unknown = JSON.parse(text);
    if (entry.array) {
      if (!Array.isArray(parsed)) throw new Error(`${entry.file}: expected an array`);
      for (const row of parsed) schema.parse(row);
    } else {
      schema.parse(parsed);
    }
    const path = join(out, entry.file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text.endsWith('\n') ? text : `${text}\n`);
    entries.push(entry);
    written++;
    const count = entry.array ? ` (${(parsed as unknown[]).length} rows)` : '';
    console.log(`golden: ${entry.file}${count}`);
  };

  const api = async (path: string): Promise<string> => {
    const res = await app.request(path);
    if (res.status !== 200) throw new Error(`${path} → ${res.status} (run pnpm seed:dev first?)`);
    return res.text();
  };
  const rest = async (path: string): Promise<string> => {
    const res = await fetch(`${config.supabase.url}/rest/v1/${path}`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
    });
    if (res.status !== 200) throw new Error(`PostgREST ${path} → ${res.status}`);
    return res.text();
  };

  try {
    // Tables and per-league views.
    await write(
      {
        file: 'leagues.json',
        type: 'LeagueRow',
        array: true,
        league: null,
        game: null,
        source: 'leagues?order=code.asc',
      },
      await rest('leagues?order=code.asc'),
    );
    for (const league of LEAGUES) {
      const views: [string, string, string][] = [
        [
          'schedule.json',
          'ScheduleRow',
          `v_schedule?league=eq.${league}&order=scheduled_at.asc,provider_game_id.asc`,
        ],
        [
          'standings.json',
          'StandingsRow',
          `v_standings?league=eq.${league}&order=season_id.asc,rank.asc.nullslast,team_id.asc`,
        ],
        [
          'player-seasons.json',
          'PlayerSeasonRow',
          `v_player_seasons?league=eq.${league}&order=season_id.asc,player_id.asc,team_id.asc`,
        ],
        [
          'leaders.json',
          'LeadersRow',
          `v_leaders?league=eq.${league}&order=rank.asc,category.asc,player_id.asc&limit=50`,
        ],
      ];
      for (const [file, type, path] of views) {
        await write(
          { file: `${league}/${file}`, type, array: true, league, game: null, source: path },
          await rest(path),
        );
      }
      // league:{code}:scores as the worker builds it (every game of the league, oldest change first).
      const changed = (await new DbScoreboardSource(db).changedSince(null)).filter(
        (g) => g.league === league,
      );
      if (changed.length > 0) {
        const message = ScoreboardSchema.parse({
          v: 1,
          type: 'scores',
          league,
          deltas: changed.map(({ league: _l, changedAt: _c, ...delta }) => delta),
          sentAt: changed[changed.length - 1]?.changedAt.toISOString(),
        });
        await write(
          {
            file: `${league}/scoreboard.json`,
            type: 'Scoreboard',
            array: false,
            league,
            game: null,
            source: `league:${league}:scores (DbScoreboardSource.changedSince(null))`,
          },
          JSON.stringify(message),
        );
      }
    }

    // Per game: snapshot, every /changes page, the empty tail page, pulse, v_boxscore rows.
    for (const g of GOLDEN_GAMES) {
      const [row] = await db<{ id: string; lastSeq: string }[]>`
        select id, last_seq::text as "lastSeq" from public.games
        where league = ${g.league} and provider_game_id = ${g.providerGameId}`;
      if (!row || Number(row.lastSeq) === 0) {
        console.error(
          `golden: ${g.league} ${g.providerGameId} is not seeded with history; run pnpm seed:dev (exit 66)`,
        );
        process.exit(66);
      }
      const base = { league: g.league, game: g.stem };
      let path = `/v1/games/${row.id}/snapshot`;
      await write(
        {
          ...base,
          file: `${g.league}/${g.stem}/snapshot.json`,
          type: 'Snapshot',
          array: false,
          source: path,
        },
        await api(path),
      );
      let after = 0;
      let page = 1;
      for (;;) {
        path = `/v1/games/${row.id}/changes?after=${after}&limit=${PAGE}`;
        const text = await api(path);
        const body = JSON.parse(text) as { hasMore: boolean; nextAfter: number; latestSeq: number };
        await write(
          {
            ...base,
            file: `${g.league}/${g.stem}/changes-p${page}.json`,
            type: 'ChangesPage',
            array: false,
            source: path,
          },
          text,
        );
        if (!body.hasMore) {
          path = `/v1/games/${row.id}/changes?after=${body.latestSeq}&limit=${PAGE}`;
          await write(
            {
              ...base,
              file: `${g.league}/${g.stem}/changes-tail.json`,
              type: 'ChangesPage',
              array: false,
              source: path,
            },
            await api(path),
          );
          break;
        }
        after = body.nextAfter;
        page++;
      }
      const pulse = await buildPulse(db, row.id);
      if (!pulse) throw new Error(`no pulse for ${g.stem}`);
      await write(
        {
          ...base,
          file: `${g.league}/${g.stem}/pulse.json`,
          type: 'Pulse',
          array: false,
          source: `buildPulse(${row.id})`,
        },
        JSON.stringify(pulse),
      );
      path = `v_boxscore?game_id=eq.${row.id}&order=team_id.asc,provider_player_id.asc`;
      await write(
        {
          ...base,
          file: `${g.league}/${g.stem}/boxscore.json`,
          type: 'BoxscoreRow',
          array: true,
          source: path,
        },
        await rest(path),
      );
    }

    // Players.
    for (const p of GOLDEN_PLAYERS) {
      const path = `/v1/players/${p.league}:${p.providerPlayerId}`;
      await write(
        {
          file: `players/${p.stem}.json`,
          type: 'PlayerResponse',
          array: false,
          league: p.league,
          game: null,
          source: path,
        },
        await api(path),
      );
    }

    const manifest: GoldenManifest = {
      generator: 'pnpm golden',
      backendCommit: execSync('git rev-parse HEAD', {
        cwd: dirname(new URL(import.meta.url).pathname),
      })
        .toString()
        .trim(),
      capturedAt: new Date().toISOString(),
      games: GOLDEN_GAMES,
      entries,
    };
    await writeFile(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(
      join(out, 'README.md'),
      [
        '# Golden fixtures',
        '',
        `Captured by wehoop-api \`pnpm golden\` from a dev stack seeded with \`pnpm seed:dev\` (backend ${manifest.backendCommit.slice(0, 7)}, ${manifest.capturedAt}).`,
        'API bodies are the bytes the Hono API serves; view rows are the bytes the local PostgREST returns to the anon role.',
        'Every file was parsed with its contract schema before it was written. `manifest.json` lists each file with its contract type.',
        'Ids differ per `db reset`: recapture the whole set (`scripts/sync-goldens.sh` in the app), never edit a file by hand.',
        '',
        ...GOLDEN_GAMES.map((g) => `- \`${g.league}/${g.stem}\`: ${g.note}`),
        '',
      ].join('\n'),
    );
    console.log(`golden: ${written} files + manifest.json written to ${out}`);
  } finally {
    await db.end({ timeout: 2 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
