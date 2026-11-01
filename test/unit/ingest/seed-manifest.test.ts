import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRecording } from '../../../src/ingest/recording.js';
import { SEED_EPOCH, SEED_MANIFEST } from '../../../src/ingest/seed-manifest.js';

const FIXTURES = join(import.meta.dirname, '../../../fixtures');

/**
 * Fixture files `pnpm seed:dev` does not list because they are not documents to
 * load on their own: moments cut from a replay the manifest does load, push
 * stream samples (no REST document), and documents a listed replay file already
 * carries byte-identical. A new fixture must land in the manifest or here.
 */
const NOT_SEEDED_DIRECTLY: Record<string, (file: string) => boolean> = {
  wnba: (f) =>
    /^sim-93ee7c68-(pbp|summary|boxscore)-.*\.json$/.test(f) || // moments of the compact replay
    /^sim-93ee7c68-push-.*-sample\.json$/.test(f) || // push samples, not REST documents
    f === 'docs-player-profile-boston.json', // in docs-identity-replay.jsonl
  ncaawb: (f) => /^sim-d9b71fe0-(pbp|summary|boxscore)-.*\.json$/.test(f),
  unrivaled: (f) =>
    /^docs-838316ea-(pbp|summary|boxscore)-.*\.json$/.test(f) || // in docs-838316ea-replay.jsonl
    f === 'docs-player-profile-collier.json' || // in docs-838316ea-replay.jsonl
    f === '2026-REG-league-leaders.json' || // in identity-replay.jsonl.gz
    f === 'hand-player-profile-boston.json' || // in identity-replay.jsonl.gz
    f === 'docs-tournament-list-2025-OOT.json' || // in docs-oot-replay.jsonl
    f === 'docs-tournament-schedule-28d4af13.json', // in docs-oot-replay.jsonl
};

describe('seed:dev manifest', () => {
  it('names only files that exist, each once', () => {
    for (const [league, steps] of Object.entries(SEED_MANIFEST)) {
      const files = steps.map((s) => s.file);
      expect(new Set(files).size, league).toBe(files.length);
      for (const f of files)
        expect(existsSync(join(FIXTURES, league, f)), `${league}/${f}`).toBe(true);
    }
  });

  it('every committed fixture is loaded by the manifest or explained as carried by a replay', () => {
    const unaccounted: string[] = [];
    for (const [league, steps] of Object.entries(SEED_MANIFEST)) {
      const listed = new Set(steps.map((s) => s.file));
      for (const f of readdirSync(join(FIXTURES, league))) {
        if (f === 'README.md' || f.endsWith('.raw.jsonl')) continue;
        if (listed.has(f) || NOT_SEEDED_DIRECTLY[league]?.(f)) continue;
        unaccounted.push(`${league}/${f}`);
      }
    }
    expect(unaccounted).toEqual([]);
  });

  it('loads teams before schedules and schedules before standings, and WNBA before Unrivaled (Boston references)', () => {
    const order = Object.keys(SEED_MANIFEST);
    expect(order.indexOf('wnba')).toBeLessThan(order.indexOf('unrivaled'));
    for (const [league, steps] of Object.entries(SEED_MANIFEST)) {
      const at = (feed: string) =>
        steps.findIndex((s) => s.kind === 'reference' && s.feed === feed);
      expect(at('hierarchy'), league).toBe(0);
      expect(at('schedule'), league).toBeLessThan(at('standings'));
      const firstReplay = steps.findIndex((s) => s.kind === 'replay');
      const lastReference = steps.map((s) => s.kind).lastIndexOf('reference');
      expect(lastReference, `${league}: replays last`).toBeLessThan(firstReplay);
    }
  });

  it('observes reference documents before every replay document, so replayed game state wins (rule 3)', async () => {
    for (const [league, steps] of Object.entries(SEED_MANIFEST)) {
      for (const step of steps) {
        if (step.kind !== 'replay') continue;
        for await (const line of readRecording(join(FIXTURES, league, step.file))) {
          expect(new Date(line.requestedAt).getTime(), `${league}/${step.file}`).toBeGreaterThan(
            SEED_EPOCH.getTime(),
          );
          break; // lines are in order; the first is the oldest
        }
      }
    }
  });
});
