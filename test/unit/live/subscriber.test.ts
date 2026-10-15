import { describe, expect, it } from 'vitest';
import { type ChangesApi, GameSubscriber } from '../../../src/live/subscriber.js';
import { gameChannel, MemoryTransport } from '../../../src/live/transport.js';
import { type GameChange, GameChangeSchema } from '../../../src/model/game-change.js';
import {
  applyChange,
  canonicalState,
  type GameState,
  stateFromSnapshot,
} from '../../../src/model/game-state.js';
import type { Pulse } from '../../../src/model/pulse.js';
import type { Snapshot } from '../../../src/model/snapshot.js';

const gameId = '22222222-2222-4222-8222-222222222222';

/** An in-memory server: the durable stream plus snapshot derived by folding it. */
class FakeServer implements ChangesApi {
  readonly stream: GameChange[] = [];
  retainedFrom = 1;
  snapshots = 0;
  changesCalls = 0;
  constructor(readonly transport: MemoryTransport) {}

  append(partial: Record<string, unknown>): GameChange {
    const seq = this.stream.length + 1;
    const c = GameChangeSchema.parse({
      v: 1,
      id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
      gameId,
      seq,
      ts: new Date(1_750_000_000_000 + seq * 1000).toISOString(),
      ...partial,
    });
    this.stream.push(c);
    return c;
  }
  async publish(c: GameChange) {
    await this.transport.publish(gameChannel(gameId), [{ event: 'change', payload: c }]);
  }
  async pulse(over: Partial<Pulse> = {}) {
    const p: Pulse = {
      v: 1,
      type: 'pulse',
      gameId,
      latestSeq: this.stream.length,
      status: 'inprogress',
      clock: '1:00',
      clockRunning: true,
      clockAsOf: new Date().toISOString(),
      observedAt: new Date().toISOString(),
      ...over,
    };
    await this.transport.publish(gameChannel(gameId), [{ event: 'pulse', payload: p }]);
  }
  state(): GameState {
    const s: GameState = {
      status: 'scheduled',
      score: { home: 0, away: 0 },
      period: null,
      periods: [],
      events: new Map(),
      teamStats: new Map(),
      playerStats: new Map(),
    };
    for (const c of this.stream) applyChange(s, c);
    return s;
  }
  async snapshot(): Promise<Snapshot> {
    this.snapshots++;
    const s = this.state();
    return {
      game: {
        id: gameId,
        league: 'wnba',
        providerGameId: 'p',
        status: s.status,
        scheduledAt: '2026-06-30T23:00:00.000Z',
        coverage: 'full',
        homeTeamId: null,
        awayTeamId: null,
        score: s.score,
        period: s.period,
        clock: null,
        clockDecimal: null,
        clockRunning: null,
        clockAsOf: null,
        observedAt: null,
        elamTargetScore: null,
      },
      periods: s.periods,
      teamStats: [],
      playerStats: [],
      events: [...s.events.entries()].map(([providerEventId, body]) => ({ providerEventId, body })),
      seq: this.stream.length,
      retainedFrom: this.retainedFrom,
      coverage: 'full',
      serverTime: new Date().toISOString(),
    };
  }
  async changes(_id: string, after: number, limit = 2) {
    this.changesCalls++;
    if (after < this.retainedFrom - 1) {
      return {
        changes: [],
        nextAfter: after,
        latestSeq: this.stream.length,
        hasMore: false,
        retainedFrom: this.retainedFrom,
      };
    }
    const rows = this.stream.filter((c) => c.seq > after);
    const page = rows.slice(0, limit);
    return {
      changes: page,
      nextAfter: page[page.length - 1]?.seq ?? after,
      latestSeq: this.stream.length,
      hasMore: rows.length > limit,
      retainedFrom: this.retainedFrom,
    };
  }
}

const event = (n: number): Record<string, unknown> => ({
  type: 'event_insert',
  providerEventId: `e${n}`,
  body: {
    type: 'other',
    providerEventType: 'x',
    period: { number: 1, type: 'quarter', sequence: 1 },
    clock: '9:00',
    wallClock: null,
    score: { home: n, away: 0 },
  },
});
const status = (s: 'inprogress' | 'closed') => ({
  type: 'status' as const,
  body: { status: s, score: { home: 1, away: 0 }, period: null },
});

function wire(server: FakeServer, sub: GameSubscriber) {
  server.transport.subscribe(gameChannel(gameId), (m) =>
    sub.handleMessage({ event: m.event, payload: m.payload }),
  );
}

describe('reconnect contract (GameSubscriber + MemoryTransport)', () => {
  it('steps 1-3: buffers before the snapshot, applies only seq > snapshot.seq in order, dedupes on id', async () => {
    const server = new FakeServer(new MemoryTransport());
    const logs: string[] = [];
    const sub = new GameSubscriber(gameId, server, { log: (m) => logs.push(m) });
    wire(server, sub);
    server.append(event(1));
    server.append(event(2));
    await server.publish(server.stream[1] as GameChange); // arrives before start, out of order
    await server.publish(server.stream[0] as GameChange);
    await server.publish(server.stream[1] as GameChange); // duplicate id
    await sub.start(); // snapshot at seq 2: buffered 1,2 are <= snapshot.seq and dropped
    expect(sub.lastSeq).toBe(2);
    expect(sub.applied).toEqual([]);
    for (let n = 3; n <= 6; n++) await server.publish(server.append(event(n)));
    await server.publish(server.stream[4] as GameChange); // re-sent (at-least-once)
    await sub.idle();
    expect(sub.applied.map((c) => c.seq)).toEqual([3, 4, 5, 6]);
    expect(sub.duplicates).toBe(1);
    expect(sub.catchUps).toBe(0);
    expect(canonicalState(sub.state as GameState)).toBe(canonicalState(server.state()));
  });

  it('step 4 (gap): a dropped middle message is recovered from /changes before later ones apply', async () => {
    const server = new FakeServer(new MemoryTransport());
    const sub = new GameSubscriber(gameId, server);
    wire(server, sub);
    await sub.start();
    server.transport.dropIf = (_c, m) => m.event === 'change' && m.payload.seq === 2;
    for (let n = 1; n <= 4; n++) await server.publish(server.append(event(n)));
    await sub.idle();
    expect(sub.applied.map((c) => c.seq)).toEqual([1, 2, 3, 4]);
    expect(sub.applied.map((c) => c.seq)).toSatisfy((s: number[]) =>
      s.every((v, i) => i === 0 || v === (s[i - 1] ?? 0) + 1),
    );
    expect(sub.catchUps).toBe(1);
    expect(server.changesCalls).toBeGreaterThan(0);
  });

  it('missing final change: the last broadcast is dropped and the next pulse.latestSeq triggers catch-up', async () => {
    const server = new FakeServer(new MemoryTransport());
    const catchUps: Array<{ from: number; to: number }> = [];
    const logs: string[] = [];
    const sub = new GameSubscriber(gameId, server, {
      onCatchUp: (i) => catchUps.push({ from: i.from, to: i.to }),
      log: (m) => logs.push(m),
    });
    wire(server, sub);
    await sub.start();
    for (let n = 1; n <= 3; n++) await server.publish(server.append(event(n)));
    server.transport.dropIf = () => true; // lose the final change
    await server.publish(server.append(event(4)));
    await sub.idle();
    expect(sub.lastSeq).toBe(3);
    server.transport.dropIf = null;
    await server.pulse(); // latestSeq = 4 > 3
    await sub.idle();
    expect(sub.lastSeq).toBe(4);
    expect(catchUps).toEqual([{ from: 3, to: 4 }]);
    expect(logs).toContain('catch-up');
    // an older pulse is ignored
    await server.pulse({ observedAt: new Date(Date.now() - 60_000).toISOString(), latestSeq: 99 });
    await sub.idle();
    expect(sub.catchUps).toBe(1);
  });

  it('step 4 (retention): retainedFrom beyond last+1 forces a new snapshot, then paging continues', async () => {
    const server = new FakeServer(new MemoryTransport());
    const reasons: string[] = [];
    const sub = new GameSubscriber(gameId, server, { onSnapshot: (_s, r) => reasons.push(r) });
    wire(server, sub);
    await sub.start();
    for (let n = 1; n <= 5; n++) server.append(event(n));
    server.retainedFrom = 4; // history below 4 expired while we were away
    await sub.reconnect();
    expect(reasons).toEqual(['start', 'retention']);
    expect(sub.lastSeq).toBe(5);
    expect(canonicalState(sub.state as GameState)).toBe(canonicalState(server.state()));
  });

  it('step 5: reconnect pages /changes with the small page size until hasMore=false', async () => {
    const server = new FakeServer(new MemoryTransport());
    const pages: number[] = [];
    const sub = new GameSubscriber(gameId, server, { onCatchUp: (i) => pages.push(i.pages) });
    wire(server, sub);
    await sub.start();
    for (let n = 1; n <= 7; n++) server.append(event(n)); // never broadcast: we were offline
    await sub.reconnect();
    expect(sub.lastSeq).toBe(7);
    expect(pages).toEqual([4]); // page size 2 -> 4 pages
    expect(sub.applied.map((c) => c.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('step 6: a closed status fetches one final snapshot whose state equals the folded changes', async () => {
    const server = new FakeServer(new MemoryTransport());
    const sub = new GameSubscriber(gameId, server);
    wire(server, sub);
    await sub.start();
    await server.publish(server.append(status('inprogress')));
    await server.publish(server.append(event(1)));
    await server.publish(server.append(status('closed')));
    await sub.idle();
    expect(sub.finalSnapshot?.seq).toBe(3);
    expect(sub.finalSnapshot?.game.status).toBe('closed');
    expect(server.snapshots).toBe(2);
    expect(canonicalState(sub.state as GameState)).toBe(
      canonicalState(stateFromSnapshot(sub.finalSnapshot as Snapshot)),
    );
    await server.pulse({ status: 'closed' }); // a later closed pulse does not fetch again
    await sub.idle();
    expect(server.snapshots).toBe(2);
  });
});
