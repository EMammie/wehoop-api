import { describe, expect, it } from 'vitest';
import { type ChangedGame, ScoreboardSender } from '../../../src/live/scoreboard.js';
import { MemoryTransport } from '../../../src/live/transport.js';
import { createLogger } from '../../../src/logger.js';
import { leagueScoresChannel, ScoreboardSchema } from '../../../src/model/scoreboard.js';

const log = createLogger({ level: 'silent', pretty: false });
const G1 = '11111111-1111-4111-8111-111111111111';
const G2 = '22222222-2222-4222-8222-222222222222';
const G3 = '33333333-3333-4333-8333-333333333333';

const game = (
  gameId: string,
  league: 'wnba' | 'ncaawb',
  changedAt: Date,
  home: number,
): ChangedGame => ({
  gameId,
  league,
  score: { home, away: 40 },
  status: 'inprogress',
  period: { number: 2, type: 'quarter', sequence: 2 },
  clock: '5:00',
  latestSeq: home,
  observedAt: changedAt.toISOString(),
  changedAt,
});

describe('ScoreboardSender (league:{code}:scores)', () => {
  it('publishes one message per league with the games changed since the last tick, straight to the transport, and advances the watermark', async () => {
    const transport = new MemoryTransport();
    const T0 = new Date('2026-06-30T23:40:00Z');
    const asked: Array<Date | null> = [];
    const rows: ChangedGame[] = [
      game(G1, 'wnba', new Date(T0.getTime() + 1000), 10),
      game(G2, 'wnba', new Date(T0.getTime() + 2000), 20),
      game(G3, 'ncaawb', new Date(T0.getTime() + 1500), 30),
    ];
    const sender = new ScoreboardSender({
      transport,
      log,
      now: () => T0,
      source: {
        changedSince: async (since) => {
          asked.push(since);
          return rows.filter((r) => since === null || r.changedAt > since);
        },
      },
    });
    // Before start() the sender is disabled: a worker that never enabled it publishes nothing.
    expect(await sender.tick()).toBe(0);
    expect(asked).toHaveLength(0);
    sender.start();
    sender.stop(); // stop() ends the interval but keeps the sender enabled for a final flush
    expect(await sender.tick()).toBe(3);
    expect(asked[0]?.toISOString()).toBe(T0.toISOString()); // never history before the sender existed
    expect(transport.published).toHaveLength(2);
    const wnba = transport.published.find((p) => p.channel === leagueScoresChannel('wnba'));
    const ncaawb = transport.published.find((p) => p.channel === leagueScoresChannel('ncaawb'));
    expect(wnba?.message.event).toBe('scores');
    const parsed = ScoreboardSchema.parse(wnba?.message.payload);
    expect(parsed.league).toBe('wnba');
    expect(parsed.deltas.map((d) => d.gameId)).toEqual([G1, G2]);
    expect(parsed.deltas[0]).toEqual({
      gameId: G1,
      score: { home: 10, away: 40 },
      status: 'inprogress',
      period: { number: 2, type: 'quarter', sequence: 2 },
      clock: '5:00',
      latestSeq: 10,
      observedAt: new Date(T0.getTime() + 1000).toISOString(),
    });
    expect(ScoreboardSchema.parse(ncaawb?.message.payload).deltas.map((d) => d.gameId)).toEqual([
      G3,
    ]);
    // nothing new: nothing sent; the watermark is the newest change seen
    expect(await sender.tick()).toBe(0);
    expect(asked[1]?.toISOString()).toBe(new Date(T0.getTime() + 2000).toISOString());
    expect(transport.published).toHaveLength(2);
    // one more change coalesces into the next tick only
    rows.push(game(G1, 'wnba', new Date(T0.getTime() + 3000), 12));
    expect(await sender.tick()).toBe(1);
    expect(sender.sent).toBe(3);
    expect(sender.deltas).toBe(4);
  });

  it('a failed publish is logged and does not block the next tick', async () => {
    const transport = new MemoryTransport();
    transport.failIf = () => true;
    const T0 = new Date('2026-06-30T23:40:00Z');
    const sender = new ScoreboardSender({
      transport,
      log,
      now: () => T0,
      source: { changedSince: async () => [game(G1, 'wnba', new Date(T0.getTime() + 1), 1)] },
    });
    sender.start();
    sender.stop();
    expect(await sender.tick()).toBe(0);
    expect(sender.failed).toBe(1);
    transport.failIf = null;
    expect(await sender.tick()).toBe(1);
  });

  it('start/stop drive ticks on the interval', async () => {
    const transport = new MemoryTransport();
    let n = 0;
    const sender = new ScoreboardSender({
      transport,
      log,
      intervalMs: 10,
      source: {
        changedSince: async () => [game(G1, 'wnba', new Date(Date.now() + 1000 * ++n), n)],
      },
    });
    sender.start();
    await new Promise((r) => setTimeout(r, 60));
    sender.stop();
    expect(sender.sent).toBeGreaterThanOrEqual(2);
    const before = sender.sent;
    await new Promise((r) => setTimeout(r, 30));
    expect(sender.sent).toBe(before);
  });
});
