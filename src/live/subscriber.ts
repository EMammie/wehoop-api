import { type GameChange, GameChangeSchema } from '../model/game-change.js';
import { applyChange, type GameState, stateFromSnapshot } from '../model/game-state.js';
import { type Pulse, PulseSchema } from '../model/pulse.js';
import type { ChangesPage, Snapshot } from '../model/snapshot.js';

/** What the reference client needs from the API (fetch in bin/subscribe, in-process in tests). */
export interface ChangesApi {
  snapshot(gameId: string): Promise<Snapshot>;
  changes(gameId: string, after: number, limit?: number): Promise<ChangesPage>;
}

export type IncomingMessage = { event: string; payload: unknown };

export interface SubscriberEvents {
  onChange?: (change: GameChange, via: 'broadcast' | 'catch-up' | 'buffer') => void;
  onPulse?: (pulse: Pulse) => void;
  onCatchUp?: (info: { from: number; to: number; pages: number; resnapshot: boolean }) => void;
  onSnapshot?: (snapshot: Snapshot, reason: 'start' | 'retention' | 'closed' | 'reconnect') => void;
  onDuplicate?: (change: GameChange) => void;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

/**
 * Reference implementation of the reconnect contract (plan §4), transport
 * agnostic. bin/subscribe feeds it Supabase Broadcast messages; tests feed it
 * a MemoryTransport.
 *   1. buffer everything until the snapshot is loaded
 *   2. snapshot -> {state, seq}
 *   3. apply buffered changes with seq > snapshot.seq in order, dedupe on id
 *   4. gap or pulse.latestSeq > last -> page /changes until hasMore=false;
 *      retainedFrom > last+1 -> re-snapshot
 *   5. reconnect/foreground -> step 4
 *   6. status closed -> one final snapshot
 */
export class GameSubscriber {
  readonly applied: GameChange[] = [];
  readonly seenIds = new Set<string>();
  lastSeq = 0;
  state: GameState | null = null;
  lastPulse: Pulse | null = null;
  finalSnapshot: Snapshot | null = null;
  duplicates = 0;
  catchUps = 0;
  private buffer: IncomingMessage[] = [];
  private started = false;
  private closedHandled = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly gameId: string,
    private readonly api: ChangesApi,
    private readonly events: SubscriberEvents = {},
  ) {}

  /** Step 1: feed every transport message here, before or after start(). */
  handleMessage(msg: IncomingMessage): void {
    if (!this.started) {
      this.buffer.push(msg);
      return;
    }
    this.enqueue(() => this.process(msg, 'broadcast'));
  }

  /** Steps 2–3. */
  async start(): Promise<void> {
    const snap = await this.api.snapshot(this.gameId);
    this.loadSnapshot(snap, 'start');
    this.started = true;
    const buffered = this.buffer;
    this.buffer = [];
    const changes: GameChange[] = [];
    const pulses: Pulse[] = [];
    for (const m of buffered) {
      if (m.event === 'change') {
        const c = GameChangeSchema.safeParse(m.payload);
        if (c.success) changes.push(c.data);
      } else if (m.event === 'pulse') {
        const p = PulseSchema.safeParse(m.payload);
        if (p.success) pulses.push(p.data);
      }
    }
    changes.sort((a, b) => a.seq - b.seq);
    await this.enqueue(async () => {
      for (const c of changes) await this.applyIncoming(c, 'buffer');
      for (const p of pulses) await this.applyPulse(p);
    });
  }

  /** Step 5: after a reconnect, app foreground, or network change. */
  reconnect(): Promise<void> {
    return this.enqueue(() => this.catchUp('reconnect'));
  }

  /** Wait for every queued message to be processed (tests). */
  idle(): Promise<void> {
    return this.queue;
  }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch((err) => this.events.log?.('subscriber error', { err: String(err) }));
    return next;
  }

  private loadSnapshot(snap: Snapshot, reason: 'start' | 'retention' | 'closed' | 'reconnect') {
    this.state = stateFromSnapshot(snap);
    this.lastSeq = snap.seq;
    this.events.onSnapshot?.(snap, reason);
    this.events.log?.('snapshot', { seq: snap.seq, reason, status: snap.game.status });
  }

  private async process(msg: IncomingMessage, via: 'broadcast'): Promise<void> {
    if (msg.event === 'change') {
      const c = GameChangeSchema.safeParse(msg.payload);
      if (!c.success) {
        this.events.log?.('dropping undecodable change', { issues: c.error.issues.length });
        return;
      }
      await this.applyIncoming(c.data, via);
    } else if (msg.event === 'pulse') {
      const p = PulseSchema.safeParse(msg.payload);
      if (p.success) await this.applyPulse(p.data);
    }
  }

  private apply(c: GameChange, via: 'broadcast' | 'catch-up' | 'buffer'): void {
    if (this.state) applyChange(this.state, c);
    this.applied.push(c);
    this.seenIds.add(c.id);
    this.lastSeq = c.seq;
    this.events.onChange?.(c, via);
  }

  private async applyIncoming(c: GameChange, via: 'broadcast' | 'buffer'): Promise<void> {
    if (c.gameId !== this.gameId) return;
    if (this.seenIds.has(c.id) || c.seq <= this.lastSeq) {
      this.duplicates++;
      this.events.onDuplicate?.(c);
      return;
    }
    if (c.seq === this.lastSeq + 1) {
      this.apply(c, via);
      if (c.type === 'status' && c.body.status === 'closed') await this.onClosed();
      return;
    }
    // Gap: fetch what we missed, then this message is either already applied (same id) or next.
    this.events.log?.('gap', { expected: this.lastSeq + 1, got: c.seq });
    await this.catchUp('gap');
    if (!this.seenIds.has(c.id) && c.seq === this.lastSeq + 1) this.apply(c, via);
  }

  private async applyPulse(p: Pulse): Promise<void> {
    if (p.gameId !== this.gameId) return;
    if (this.lastPulse && Date.parse(p.observedAt) <= Date.parse(this.lastPulse.observedAt)) return;
    this.lastPulse = p;
    this.events.onPulse?.(p);
    if (p.latestSeq > this.lastSeq) await this.catchUp('pulse');
    if (p.status === 'closed') await this.onClosed();
  }

  /** Step 4. */
  private async catchUp(trigger: 'gap' | 'pulse' | 'reconnect'): Promise<void> {
    const from = this.lastSeq;
    let pages = 0;
    let resnapshot = false;
    for (;;) {
      const page = await this.api.changes(this.gameId, this.lastSeq);
      pages++;
      if (page.retainedFrom > this.lastSeq + 1) {
        const snap = await this.api.snapshot(this.gameId);
        this.loadSnapshot(snap, 'retention');
        resnapshot = true;
        continue;
      }
      for (const c of page.changes) {
        if (this.seenIds.has(c.id) || c.seq <= this.lastSeq) continue;
        if (c.seq !== this.lastSeq + 1)
          throw new Error(`/changes returned seq ${c.seq}, expected ${this.lastSeq + 1}`);
        this.apply(c, 'catch-up');
      }
      if (!page.hasMore) break;
    }
    this.catchUps++;
    this.events.onCatchUp?.({ from, to: this.lastSeq, pages, resnapshot });
    this.events.log?.('catch-up', { trigger, from, to: this.lastSeq, pages, resnapshot });
    if (this.state?.status === 'closed') await this.onClosed();
  }

  /** Step 6. */
  private async onClosed(): Promise<void> {
    if (this.closedHandled) return;
    this.closedHandled = true;
    const snap = await this.api.snapshot(this.gameId);
    this.finalSnapshot = snap;
    this.events.onSnapshot?.(snap, 'closed');
    this.events.log?.('final snapshot', { seq: snap.seq });
  }
}
