import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SportradarHttp } from '../../src/providers/sportradar/http.js';
import {
  ProdUrlResolver,
  redactUrl,
  SimulationUrlResolver,
} from '../../src/providers/sportradar/urls.js';
import { silentLog, testDb } from '../helpers/db.js';

const db = testDb();
beforeAll(async () => {
  await db`select 1`;
});
afterAll(async () => {
  await db.end();
});

const fakeFetch = (status = 200, body: unknown = { ok: true }): typeof fetch =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

describe('provider_calls accounting (CLAUDE.md non-negotiable 8)', () => {
  it('simulation calls are logged with quota_counted=false; trial calls with quota_counted=true and product', async () => {
    const sim = new SportradarHttp({
      db,
      log: silentLog,
      league: 'wnba',
      runId: null,
      fetchImpl: fakeFetch(),
      resolver: new SimulationUrlResolver({
        playbackUrl: 'https://playback.sportradar.com',
        league: 'wnba',
        recordingId: 'rec-1',
        sessionId: 'sess-1',
      }),
    });
    const doc = await sim.getJson('pbp', z.object({ ok: z.boolean() }));
    expect(doc.data.ok).toBe(true);
    expect(doc.requestedAt.getTime()).toBeLessThanOrEqual(doc.receivedAt.getTime());
    const trial = new SportradarHttp({
      db,
      log: silentLog,
      league: 'wnba',
      runId: null,
      fetchImpl: fakeFetch(),
      resolver: new ProdUrlResolver({
        league: 'wnba',
        accessLevel: 'trial',
        apiKey: 'not-a-real-key',
      }),
    });
    await trial.getJson('summary', z.object({ ok: z.boolean() }), { gameId: 'g1' });
    const rows = await db<
      {
        source: string;
        feed: string;
        quotaCounted: boolean;
        product: string | null;
        url: string;
        status: number;
      }[]
    >`
      select source::text as source, feed, quota_counted as "quotaCounted", product, url, status
      from ingest.provider_calls where url like '%rec-1%' or url like '%/games/g1/%' order by id desc limit 2`;
    const bySource = Object.fromEntries(rows.map((r) => [r.source, r]));
    expect(bySource.simulation).toMatchObject({ feed: 'pbp', quotaCounted: false, status: 200 });
    expect(bySource.trial).toMatchObject({
      feed: 'summary',
      quotaCounted: true,
      product: 'wnba',
      status: 200,
    });
    expect(bySource.trial?.url).not.toContain('not-a-real-key');
  });

  it('a failed call is logged with its status and the schema rejects a malformed body', async () => {
    const http = new SportradarHttp({
      db,
      log: silentLog,
      league: 'wnba',
      runId: null,
      fetchImpl: fakeFetch(503, { error: 'down' }),
      resolver: new SimulationUrlResolver({
        playbackUrl: 'https://playback.sportradar.com',
        league: 'wnba',
        recordingId: 'rec-503',
        sessionId: 's',
      }),
    });
    await expect(http.getJson('pbp', z.object({ ok: z.boolean() }))).rejects.toThrow(/HTTP 503/);
    const [row] = await db<
      { status: number }[]
    >`select status from ingest.provider_calls where url like '%rec-503%' order by id desc limit 1`;
    expect(row?.status).toBe(503);
    const bad = new SportradarHttp({
      db,
      log: silentLog,
      league: 'wnba',
      runId: null,
      fetchImpl: fakeFetch(200, { ok: 'yes' }),
      resolver: new SimulationUrlResolver({
        playbackUrl: 'https://playback.sportradar.com',
        league: 'wnba',
        recordingId: 'rec-bad',
        sessionId: 's',
      }),
    });
    await expect(bad.getJson('pbp', z.object({ ok: z.boolean() }))).rejects.toThrow(
      /schema mismatch/,
    );
  });

  it('redactUrl strips credential-looking query parameters', () => {
    expect(redactUrl('https://api.sportradar.com/wnba/trial/v8/en/x.json?api_key=abc&foo=1')).toBe(
      'https://api.sportradar.com/wnba/trial/v8/en/x.json?api_key=redacted&foo=1',
    );
  });
});
