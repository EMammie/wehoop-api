import { appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createClient } from '@supabase/supabase-js';
import { loadConfig } from '../config.js';
import { type ChangesApi, GameSubscriber } from '../live/subscriber.js';
import { gameChannel } from '../live/transport.js';
import { canonicalJson } from '../model/content-hash.js';
import { canonicalState, stateFromSnapshot } from '../model/game-state.js';
import { ChangesPageSchema, SnapshotSchema } from '../model/snapshot.js';

/**
 * pnpm subscribe --game <uuid> [--record <path.jsonl>] [--auth anon|guest] [--until closed] [--settle-ms 20000]
 * Reference client: subscribes to the private channel game:{id} with the anon
 * key (or an anonymous-sign-in guest JWT, the real iOS session), then runs
 * the reconnect contract (src/live/subscriber.ts) against the Hono API.
 * Logs `catch-up` whenever it pages /changes. `--record` appends every
 * applied GameChange as JSONL with how it arrived (broadcast | catch-up | buffer)
 * and `receivedAt` (our clock), which `pnpm trial lag --record` turns into the
 * median subscriber lag from `wall_clock` and from the change's own `ts`.
 */
async function main() {
  const { values: args } = parseArgs({
    options: {
      game: { type: 'string' },
      record: { type: 'string' },
      auth: { type: 'string', default: 'anon' },
      until: { type: 'string', default: 'closed' },
      'settle-ms': { type: 'string', default: '20000' },
      api: { type: 'string' },
    },
    strict: true,
  });
  if (!args.game) throw new Error('--game <uuid> is required');
  const gameId = args.game;
  const config = loadConfig();
  if (!config.supabase.anonKey) throw new Error('SUPABASE_ANON_KEY is required to subscribe');
  const apiBase = args.api ?? config.api.baseUrl;
  const log = (msg: string, data: Record<string, unknown> = {}) =>
    console.log(`${new Date().toISOString()} ${msg} ${JSON.stringify(data)}`);

  const api: ChangesApi = {
    async snapshot(id) {
      const res = await fetch(`${apiBase}/v1/games/${id}/snapshot`);
      if (!res.ok) throw new Error(`snapshot HTTP ${res.status}`);
      return SnapshotSchema.parse(await res.json());
    },
    async changes(id, after, limit = 200) {
      const res = await fetch(`${apiBase}/v1/games/${id}/changes?after=${after}&limit=${limit}`);
      if (!res.ok) throw new Error(`changes HTTP ${res.status}`);
      return ChangesPageSchema.parse(await res.json());
    },
  };

  const client = createClient(config.supabase.url, config.supabase.anonKey, {
    auth: { persistSession: false, autoRefreshToken: true },
  });
  if (args.auth === 'guest') {
    const { data, error } = await client.auth.signInAnonymously();
    if (error || !data.session) throw new Error(`anonymous sign-in failed: ${error?.message}`);
    await client.realtime.setAuth(data.session.access_token);
    log('signed in as guest', {
      userId: data.user?.id,
      tokenBytes: data.session.access_token.length,
    });
  } else {
    await client.realtime.setAuth(config.supabase.anonKey);
  }

  let done: (() => void) | null = null;
  const finished = new Promise<void>((r) => {
    done = r;
  });
  const subscriber = new GameSubscriber(gameId, api, {
    log,
    onChange: (c, via) => {
      if (args.record) {
        appendFileSync(
          args.record,
          `${JSON.stringify({ via, receivedAt: new Date().toISOString(), change: c })}\n`,
        );
      }
    },
    onSnapshot: (snap, reason) => {
      if (reason === 'closed') {
        log('closed', { seq: snap.seq, score: snap.game.score });
        // The watcher fetches the closing summary + boxscore AFTER the pbp that reported `closed`
        // (their stats changes follow the status change; live run 2026-10-19 stopped at 1305 of
        // 1306). Keep listening for --settle-ms, then catch up from /changes and re-snapshot.
        if (args.until === 'closed') {
          const settleMs = Number(args['settle-ms'] ?? 20_000);
          log('settling after closed', { settleMs });
          setTimeout(() => {
            void (async () => {
              await subscriber.reconnect();
              subscriber.finalSnapshot = await api.snapshot(gameId);
              log('final catch-up', {
                lastSeq: subscriber.lastSeq,
                snapshotSeq: subscriber.finalSnapshot.seq,
              });
              done?.();
            })().catch((e) => {
              log('final catch-up failed', { err: String(e) });
              done?.();
            });
          }, settleMs);
        }
      }
    },
  });

  let subscribedOnce = false;
  const channel = client.channel(gameChannel(gameId), { config: { private: true } });
  channel.on('broadcast', { event: '*' }, (msg) => {
    subscriber.handleMessage({ event: msg.event, payload: msg.payload });
  });
  channel.subscribe((status, err) => {
    log('channel', { status, err: err?.message });
    if (status === 'SUBSCRIBED') {
      if (!subscribedOnce) {
        subscribedOnce = true;
        void subscriber.start().catch((e) => log('start failed', { err: String(e) }));
      } else {
        void subscriber.reconnect();
      }
    }
  });

  const summary = () => {
    const seqs = subscriber.applied.map((c) => c.seq);
    const contiguous = seqs.every((s, i) => i === 0 || s === (seqs[i - 1] ?? 0) + 1);
    const derived = subscriber.state ? canonicalState(subscriber.state) : null;
    const fromSnapshot = subscriber.finalSnapshot
      ? canonicalState(stateFromSnapshot(subscriber.finalSnapshot))
      : null;
    return {
      applied: seqs.length,
      firstSeq: seqs[0] ?? null,
      lastSeq: subscriber.lastSeq,
      contiguous,
      duplicates: subscriber.duplicates,
      catchUps: subscriber.catchUps,
      derivedStateEqualsFinalSnapshot:
        derived !== null && fromSnapshot !== null ? derived === fromSnapshot : null,
    };
  };
  /** Equal shapes: every change received via Broadcast must decode-equal the same seq from /changes. */
  const equalsApi = async (): Promise<boolean | null> => {
    const first = subscriber.applied[0]?.seq;
    if (first === undefined) return null;
    const fromApi = [];
    let after = first - 1;
    for (;;) {
      const page = await api.changes(gameId, after, 500);
      fromApi.push(...page.changes);
      if (!page.hasMore) break;
      after = page.nextAfter;
    }
    const mine = subscriber.applied.filter((c) => c.seq >= first && c.seq <= subscriber.lastSeq);
    return (
      canonicalJson(mine) === canonicalJson(fromApi.filter((c) => c.seq <= subscriber.lastSeq))
    );
  };
  const stop = async (code: number) => {
    log('summary', { ...summary(), receivedEqualsApi: await equalsApi().catch(() => null) });
    await client.removeAllChannels();
    process.exit(code);
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void stop(0));
  await finished;
  await subscriber.idle();
  await stop(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
