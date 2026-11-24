import { appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createClient } from '@supabase/supabase-js';
import { loadConfig } from '../config.js';
import { type ChangesApi, GameSubscriber } from '../live/subscriber.js';
import { gameChannel } from '../live/transport.js';
import { canonicalJson } from '../model/content-hash.js';
import { canonicalState, stateFromSnapshot } from '../model/game-state.js';
import { leagueScoresChannel, ScoreboardSchema } from '../model/scoreboard.js';
import { ChangesPageSchema, SnapshotSchema } from '../model/snapshot.js';

/**
 * pnpm subscribe --game <uuid> [--record <path.jsonl>] [--auth anon|guest] [--until closed] [--settle-ms 20000]
 * pnpm subscribe --league wnba [--record <path.jsonl>] [--auth anon|guest]
 *   (M4) receive the league:{code}:scores scoreboard deltas (plan §5) and print each tick;
 *   --record appends every decoded message as JSONL; stop with SIGINT.
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
      league: { type: 'string' },
    },
    strict: true,
  });
  if (!args.game && !args.league) throw new Error('--game <uuid> or --league <code> is required');
  if (args.game && args.league) throw new Error('--game and --league are exclusive');
  const settleMs = Number(args['settle-ms']);
  if (!Number.isInteger(settleMs) || settleMs < 0) {
    throw new Error('--settle-ms must be an integer >= 0');
  }
  const gameId = args.game ?? '';
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

  if (args.league) {
    // Scoreboard channel: print every tick; no snapshot or catch-up (list screens re-fetch v_schedule).
    const channelName = leagueScoresChannel(args.league);
    let ticks = 0;
    let deltas = 0;
    const ch = client.channel(channelName, { config: { private: true } });
    ch.on('broadcast', { event: 'scores' }, (msg) => {
      const parsed = ScoreboardSchema.safeParse(msg.payload);
      if (!parsed.success) {
        log('undecodable scores message', { issues: parsed.error.issues.length });
        return;
      }
      ticks++;
      deltas += parsed.data.deltas.length;
      const receivedAt = new Date().toISOString();
      if (args.record)
        appendFileSync(args.record, `${JSON.stringify({ receivedAt, scores: parsed.data })}\n`);
      for (const d of parsed.data.deltas) {
        log('scores', {
          gameId: d.gameId,
          status: d.status,
          score: `${d.score.away}-${d.score.home}`,
          period: d.period?.number ?? null,
          clock: d.clock,
          latestSeq: d.latestSeq,
        });
      }
    });
    ch.subscribe((status, err) =>
      log('channel', { channel: channelName, status, err: err?.message }),
    );
    const stopLeague = async () => {
      log('summary', { ticks, deltas });
      await client.removeAllChannels();
      process.exit(0);
    };
    for (const signal of ['SIGINT', 'SIGTERM'] as const)
      process.on(signal, () => void stopLeague());
    await new Promise(() => undefined);
    return;
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
          log('settling after closed', { settleMs });
          setTimeout(() => {
            void (async () => {
              // The snapshot is read outside the subscriber's queue: if it is ahead of what was
              // applied (a change committed meanwhile), catch up again and re-read, so the
              // derived-state comparison in summary() compares equal seqs.
              await subscriber.reconnect();
              let snap = await api.snapshot(gameId);
              for (let i = 0; i < 3 && snap.seq > subscriber.lastSeq; i++) {
                await subscriber.reconnect();
                snap = await api.snapshot(gameId);
              }
              subscriber.finalSnapshot = snap;
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
      snapshotSeq: subscriber.finalSnapshot?.seq ?? null,
      // null = not comparable (the final snapshot and the applied stream end at different seqs).
      derivedStateEqualsFinalSnapshot:
        derived !== null &&
        fromSnapshot !== null &&
        subscriber.finalSnapshot?.seq === subscriber.lastSeq
          ? derived === fromSnapshot
          : null,
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
