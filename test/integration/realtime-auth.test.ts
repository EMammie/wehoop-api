import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/server.js';
import { loadConfig } from '../../src/config.js';
import { OutboxPublisher } from '../../src/live/outbox-publisher.js';
import { SupabaseBroadcastTransport } from '../../src/live/supabase-broadcast.js';
import { gameChannel } from '../../src/live/transport.js';
import { type GameChange, GameChangeSchema } from '../../src/model/game-change.js';
import { ChangesPageSchema } from '../../src/model/snapshot.js';
import {
  apply,
  observation,
  pbpQ1,
  replayRun,
  seedGame,
  silentLog,
  testDb,
} from '../helpers/db.js';

/**
 * Live Realtime authorization against the local Supabase stack. Needs
 * SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY (never printed).
 * Proves: anon key AND an anonymous-sign-in guest JWT can receive on the private
 * channel; a publish attempt from each is rejected over the socket and silently
 * dropped over REST; a second subscriber never observes it; and a decoded
 * GameChange received from Broadcast deep-equals the one from /changes.
 */
// Vitest sets process.env.MODE='test'; the worker and API read MODE=sim.
const config = loadConfig({ ...process.env, MODE: 'sim' });
const anonKey = config.supabase.anonKey;
const serviceKey = config.supabase.serviceRoleKey;
const enabled = Boolean(anonKey && serviceKey);

const db = testDb();
const deps = { db, log: silentLog };
const app = createApp({ db, config, log: silentLog });

interface Sub {
  client: SupabaseClient;
  channel: RealtimeChannel;
  received: Array<{ event: string; payload: unknown }>;
  jwt: string;
}

async function subscribe(topic: string, auth: 'anon' | 'guest'): Promise<Sub> {
  if (!anonKey) throw new Error('anon key missing');
  const client = createClient(config.supabase.url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  let jwt = anonKey;
  if (auth === 'guest') {
    const { data, error } = await client.auth.signInAnonymously();
    if (error || !data.session) throw new Error(`anonymous sign-in failed: ${error?.message}`);
    jwt = data.session.access_token;
  }
  await client.realtime.setAuth(jwt);
  const received: Sub['received'] = [];
  const channel = client.channel(topic, {
    config: { private: true, broadcast: { ack: true, self: true } },
  });
  channel.on('broadcast', { event: '*' }, (m) =>
    received.push({ event: m.event, payload: m.payload }),
  );
  await new Promise<void>((resolve, reject) => {
    channel.subscribe((status, err) => {
      if (status === 'SUBSCRIBED') resolve();
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT')
        reject(new Error(`${status}: ${err?.message}`));
    });
  });
  return { client, channel, received, jwt };
}

const settle = (ms = 1500) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!enabled)('Realtime: private game channel is receive-only for clients', () => {
  let gameId = '';
  let topic = '';
  let anon: Sub;
  let guest: Sub;

  beforeAll(async () => {
    await db`select 1`;
    const nd = pbpQ1();
    ({ gameId } = await seedGame(db, nd));
    topic = gameChannel(gameId);
    anon = await subscribe(topic, 'anon');
    guest = await subscribe(topic, 'guest');
    const run = await replayRun(db, gameId);
    await apply(deps, gameId, nd, observation(run, nd, new Date()));
  });
  afterAll(async () => {
    await anon?.client.removeAllChannels();
    await guest?.client.removeAllChannels();
    await db.end();
  });

  it('anon key and guest JWT publish attempts are rejected over the socket and never observed by the other subscriber', async () => {
    const forged = { v: 1, type: 'status', forged: true };
    expect(await anon.channel.send({ type: 'broadcast', event: 'change', payload: forged })).toBe(
      'error',
    );
    expect(await guest.channel.send({ type: 'broadcast', event: 'change', payload: forged })).toBe(
      'error',
    );
    const statuses: number[] = [];
    for (const jwt of [anon.jwt, guest.jwt]) {
      const res = await fetch(new URL('/realtime/v1/api/broadcast', config.supabase.url), {
        method: 'POST',
        headers: {
          apikey: anonKey ?? '',
          authorization: `Bearer ${jwt}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          messages: [{ topic, event: 'change', payload: forged, private: true }],
        }),
      });
      statuses.push(res.status);
      await res.text();
    }
    // The REST endpoint acknowledges the request (202) and then drops it under RLS: nothing is delivered.
    expect(statuses.every((s) => s < 500)).toBe(true);
    await settle();
    expect(anon.received.filter((m) => (m.payload as { forged?: boolean }).forged)).toEqual([]);
    expect(guest.received.filter((m) => (m.payload as { forged?: boolean }).forged)).toEqual([]);
  });

  it('the service-role publisher delivers to both; decoded GameChange from Broadcast deep-equals /changes', async () => {
    if (!serviceKey) throw new Error('service key missing');
    const transport = new SupabaseBroadcastTransport({
      url: config.supabase.url,
      serviceRoleKey: serviceKey,
      log: silentLog,
    });
    const publisher = new OutboxPublisher({ db, log: silentLog, transport });
    const r = await publisher.drain();
    expect(r.published).toBeGreaterThan(0);
    await settle(2500);
    const decode = (s: Sub): GameChange[] =>
      s.received
        .filter((m) => m.event === 'change')
        .map((m) => GameChangeSchema.parse(m.payload))
        .sort((a, b) => a.seq - b.seq);
    const fromAnon = decode(anon);
    const fromGuest = decode(guest);
    const res = await app.request(`/v1/games/${gameId}/changes?limit=500`);
    const page = ChangesPageSchema.parse(await res.json());
    expect(fromAnon.length).toBe(page.changes.length);
    expect(fromAnon).toEqual(page.changes);
    expect(fromGuest).toEqual(page.changes);
    expect(fromAnon.map((c) => c.seq)).toEqual(page.changes.map((_c, i) => i + 1));
  });
});
