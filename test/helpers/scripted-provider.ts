/**
 * A scripted stand-in for api.sportradar.com as a `fetchImpl` (dev stack tests only, nothing
 * listens on the network): the test sets the document each game feed returns right now, and the
 * push streams answer 200 with a heartbeat line every `heartbeatMs` until the client aborts. Used
 * where a test needs a provider state machine (complete -> closed, live -> postponed) that a
 * time-scaled recording (fake-provider.ts) cannot pin to a watch generation. Like the fake
 * provider, it rejects a request without an `x-api-key` header (401) and counts accepted requests
 * that arrive closer than 1 s (`tooClose`), which a missing rate limiter would produce.
 */
export type GameFeedName = 'pbp' | 'summary' | 'boxscore';

export interface ScriptedRequest {
  feed: GameFeedName | 'push_events' | 'push_clock' | 'other';
  at: number;
}

export interface ScriptedProvider {
  fetchImpl: typeof fetch;
  /** What each game feed returns now (null: 404). */
  docs: Record<GameFeedName, unknown>;
  requests: ScriptedRequest[];
  /** Accepted requests closer than 1 s to the previous one. */
  tooClose: number;
  /** Push streams currently open. */
  openStreams: number;
  /** Called before a game feed is answered (after `docs` is read, so it may switch the phase). */
  onServe: ((feed: GameFeedName, doc: unknown) => void) | null;
  /** Fault injection: a Response returned here is answered instead of the document (a 429, a 503). */
  fault: ((feed: GameFeedName) => Response | undefined) | null;
  /** Awaited before a push stream is answered; `n` counts that feed's connections (1 = first). */
  onStream: ((feed: 'push_events' | 'push_clock', n: number) => Promise<void> | void) | null;
  /** Cut every open stream of one feed (the client sees the body error and reconnects). */
  dropStreams(feed: 'push_events' | 'push_clock'): number;
}

const enc = new TextEncoder();

export function scriptedProvider(opts: { heartbeatMs?: number } = {}): ScriptedProvider {
  const heartbeatMs = opts.heartbeatMs ?? 200;
  let lastAt: number | null = null;
  const open = new Map<(err: unknown | null) => void, 'push_events' | 'push_clock'>();
  const connections = { push_events: 0, push_clock: 0 };
  const p: ScriptedProvider = {
    onStream: null,
    fault: null,
    dropStreams(feed) {
      let n = 0;
      for (const [end, f] of [...open]) {
        if (f !== feed) continue;
        end(new Error('scripted provider: stream dropped'));
        n++;
      }
      return n;
    },
    docs: { pbp: null, summary: null, boxscore: null },
    requests: [],
    tooClose: 0,
    openStreams: 0,
    onServe: null,
    fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      const headers = new Headers(init?.headers);
      if (!headers.get('x-api-key'))
        return new Response('{"message":"Unauthorized"}', { status: 401 });
      const now = Date.now();
      if (lastAt !== null && now - lastAt < 1000) p.tooClose++;
      lastAt = now;
      const stream = /\/stream\/[a-z]{2}\/(events|clock)\/subscribe$/.exec(url.pathname);
      if (stream) {
        const feed = stream[1] === 'events' ? 'push_events' : 'push_clock';
        p.requests.push({ feed, at: now });
        connections[feed]++;
        await p.onStream?.(feed, connections[feed]);
        const signal = init?.signal ?? null;
        let timer: ReturnType<typeof setInterval> | undefined;
        /** Stop heartbeats and forget the stream; error the body unless the client cancelled it. */
        let finish: (err: unknown | null) => void = () => undefined;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            p.openStreams++;
            finish = (err) => {
              if (timer === undefined) return;
              clearInterval(timer);
              timer = undefined;
              open.delete(finish);
              p.openStreams--;
              if (err === null) return;
              try {
                controller.error(err);
              } catch {
                // already closed
              }
            };
            timer = setInterval(() => {
              try {
                controller.enqueue(
                  enc.encode(`${JSON.stringify({ heartbeat: { interval: heartbeatMs } })}\n`),
                );
              } catch {
                finish(new Error('stream closed'));
              }
            }, heartbeatMs);
            open.set(finish, feed);
            if (signal?.aborted) finish(signal.reason);
            else signal?.addEventListener('abort', () => finish(signal.reason), { once: true });
          },
          cancel() {
            finish(null);
          },
        });
        return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
      }
      const game = /\/games\/[^/]+\/(pbp|summary|boxscore)\.json$/.exec(url.pathname);
      if (!game) {
        p.requests.push({ feed: 'other', at: now });
        return new Response('{"message":"not found"}', { status: 404 });
      }
      const feed = game[1] as GameFeedName;
      p.requests.push({ feed, at: now });
      const doc = p.docs[feed];
      p.onServe?.(feed, doc);
      const override = p.fault?.(feed);
      if (override) return override;
      if (doc === null) return new Response(`{"message":"no ${feed}"}`, { status: 404 });
      return new Response(JSON.stringify(doc), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
  };
  return p;
}

/** A deep copy of a provider document with every occurrence of one id replaced (a unique test game). */
export function relabelDoc<T>(doc: T, fromId: string, toId: string): T {
  return JSON.parse(JSON.stringify(doc).replaceAll(fromId, toId)) as T;
}
