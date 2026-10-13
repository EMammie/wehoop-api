import { describe, expect, it } from 'vitest';
import { SimulationClient } from '../../../src/providers/sportradar/simulation.js';
import { ProdUrlResolver, SimulationUrlResolver } from '../../../src/providers/sportradar/urls.js';

const fakeFetch = (
  handler: (body: { query: string; variables: Record<string, unknown> }) => unknown,
): typeof fetch =>
  (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    return new Response(JSON.stringify(handler(body)), { status: 200 });
  }) as typeof fetch;

describe('SimulationClient (playback.sportradar.com GraphQL)', () => {
  it('lists recordings, fetches one, creates a session, builds push URLs; no key anywhere', async () => {
    const calls: string[] = [];
    const client = new SimulationClient({
      playbackUrl: 'https://playback.sportradar.com',
      fetchImpl: fakeFetch(({ query, variables }) => {
        calls.push(query.split('{')[0]?.trim() ?? '');
        if (query.includes('recordings('))
          return {
            data: {
              recordings: [
                {
                  id: 'r1',
                  title: 'A at B',
                  apis: [
                    { name: 'pbp', apiType: 'rest' },
                    { name: 'events', apiType: 'push' },
                  ],
                },
              ],
            },
          };
        if (query.includes('recording('))
          return { data: { recording: { id: String(variables.id), apis: [] } } };
        if (query.includes('createSession')) return { data: { createSession: 'sess-123_-1' } };
        return {};
      }),
    });
    const list = await client.listRecordings('wnba');
    expect(list[0]?.apis.map((a) => a.apiType)).toEqual(['rest', 'push']);
    expect((await client.getRecording('r1'))?.id).toBe('r1');
    expect(await client.createSession('r1')).toBe('sess-123_-1');
    expect(client.pushUrl('events', 'r1')).toBe(
      'https://playback.sportradar.com/subscribe/events?recording_id=r1',
    );
    expect(calls.join(' ')).not.toMatch(/api_key/);
  });

  it('rejects a malformed session response', async () => {
    const client = new SimulationClient({
      playbackUrl: 'https://playback.sportradar.com',
      fetchImpl: fakeFetch(() => ({ data: { createSession: '' } })),
    });
    await expect(client.createSession('r1')).rejects.toThrow();
  });
});

describe('UrlResolvers', () => {
  it('simulation URLs map our summary feed to the replayer game feed and carry the session', () => {
    const r = new SimulationUrlResolver({
      playbackUrl: 'https://playback.sportradar.com',
      league: 'wnba',
      recordingId: 'rec',
      sessionId: 's1',
    });
    expect(r.source).toBe('simulation');
    expect(r.resolve('summary', {}).url).toBe(
      'https://playback.sportradar.com/replay/wnba/rec?feed=game&contentType=json&sessionId=s1',
    );
    expect(r.resolve('pbp', {}).url).toContain('feed=pbp');
    expect(r.resolve('pbp', {}).headers).toEqual({});
  });
  it('production URLs keep the key in a header, never in the URL', () => {
    const r = new ProdUrlResolver({ league: 'ncaawb', accessLevel: 'trial', apiKey: 'K' });
    const u = r.resolve('boxscore', { gameId: 'g' });
    expect(u.url).toBe('https://api.sportradar.com/ncaawb/trial/v8/en/games/g/boxscore.json');
    expect(u.url).not.toContain('K');
    expect(u.headers['x-api-key']).toBe('K');
    expect(() => r.resolve('pbp', {})).toThrow(/gameId/);
  });
});
