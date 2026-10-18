import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type FakeProvider,
  startFakeProvider,
} from '../../../src/providers/sportradar/fake-provider.js';
import {
  DailyScheduleDocumentSchema,
  SeasonScheduleDocumentSchema,
} from '../../../src/providers/sportradar/schemas/schedule.js';
import { SummaryDocumentSchema } from '../../../src/providers/sportradar/schemas/summary.js';

const FIXTURE = new URL(
  '../../../fixtures/ncaawb/sim-d9b71fe0-replay.compact.jsonl.gz',
  import.meta.url,
).pathname;

let server: FakeProvider;
let t = 0;
beforeAll(async () => {
  server = await startFakeProvider({
    replayFile: FIXTURE,
    speed: 1,
    minSpacingMs: 1000,
    now: () => t,
  });
});
afterAll(async () => {
  await server.close();
});

describe('fake provider (rehearsal stand-in for api.sportradar.com)', () => {
  it('serves the recording over the production URL shape, 401 without a key', async () => {
    const path = `${server.url}/ncaawb/trial/v8/en/games/${server.providerGameId}/summary.json`;
    expect((await fetch(path)).status).toBe(401);
    t += 1000;
    const res = await fetch(path, { headers: { 'x-api-key': 'rehearsal-not-a-key' } });
    expect(res.status).toBe(200);
    const doc = SummaryDocumentSchema.parse(await res.json());
    expect(doc.id).toBe(server.providerGameId);
    expect(doc.status).toBe('created'); // t=0 of the recording: pregame
  });

  it('429 when two accepted requests arrive within the spacing; the schedule is synthesized from the first summary', async () => {
    const h = { headers: { 'x-api-key': 'rehearsal-not-a-key' } };
    t += 500;
    const tooSoon = await fetch(`${server.url}/ncaawb/trial/v8/en/games/x/pbp.json`, h);
    expect(tooSoon.status).toBe(429);
    t += 1000;
    const sched = await fetch(`${server.url}/ncaawb/trial/v8/en/games/2025/REG/schedule.json`, h);
    expect(sched.status).toBe(200);
    const doc = SeasonScheduleDocumentSchema.parse(await sched.json());
    expect(doc.games).toHaveLength(1);
    expect(doc.games[0]).toMatchObject({ id: server.providerGameId, coverage: 'full' });
    expect(doc.season.year).toBe(2025);
    expect(server.stats.rejected401).toBe(1);
    expect(server.stats.rejected429).toBe(1);
  });

  it('daily schedule route: the recording game on its own day, nothing on another day', async () => {
    const h = { headers: { 'x-api-key': 'rehearsal-not-a-key' } };
    t += 1000;
    const day = await fetch(`${server.url}/ncaawb/trial/v8/en/games/2026/02/18/schedule.json`, h);
    expect(day.status).toBe(200);
    const doc = DailyScheduleDocumentSchema.parse(await day.json());
    expect(doc.date).toBe('2026-02-18');
    expect(doc.games.map((g) => g.id)).toEqual([server.providerGameId]);
    t += 1000;
    const other = await fetch(`${server.url}/ncaawb/trial/v8/en/games/2026/02/19/schedule.json`, h);
    expect(DailyScheduleDocumentSchema.parse(await other.json()).games).toEqual([]);
    expect(server.stats.byFeed.daily_schedule).toBe(2);
  });

  it('time-scaled: later elapsed time returns later documents, never earlier ones', async () => {
    const h = { headers: { 'x-api-key': 'rehearsal-not-a-key' } };
    t += 3 * 3600 * 1000; // three hours in: the game is over
    const res = await fetch(`${server.url}/ncaawb/trial/v8/en/games/x/summary.json`, h);
    const doc = SummaryDocumentSchema.parse(await res.json());
    expect(doc.status).toBe('closed');
    expect(server.documents).toBeGreaterThan(100);
  });
});
