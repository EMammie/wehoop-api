import { describe, expect, it, vi } from 'vitest';
import {
  AUTO_PURGE_KEEP_MS,
  AUTO_PURGE_PERIOD_MS,
  autoPurgeDue,
  startAutoPurge,
} from '../../../src/ingest/demo-auto-purge.js';
import type { PurgeResult } from '../../../src/ingest/demo-purge.js';
import { createLogger } from '../../../src/logger.js';

const silentLog = createLogger({ level: 'silent' });
const DAY = 86_400_000;
const NOW = new Date('2026-12-01T06:00:00Z');
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const result = (over: Partial<PurgeResult> = {}): PurgeResult => ({
  dryRun: false,
  olderThan: null,
  candidates: 0,
  purged: [],
  skipped: [],
  leftAlone: [],
  orphanSlots: 0,
  ...over,
});

describe('autoPurgeDue', () => {
  it('keeps 7 days, runs weekly: due once the oldest replay is 14 days old', () => {
    expect(AUTO_PURGE_KEEP_MS).toBe(7 * DAY);
    expect(AUTO_PURGE_PERIOD_MS).toBe(7 * DAY);
    expect(autoPurgeDue(null, NOW)).toBe(false);
    expect(autoPurgeDue(ago(7), NOW)).toBe(false);
    expect(autoPurgeDue(ago(13.99), NOW)).toBe(false);
    expect(autoPurgeDue(ago(14), NOW)).toBe(true);
    expect(autoPurgeDue(ago(30), NOW)).toBe(true);
  });
});

describe('startAutoPurge', () => {
  const start = (
    oldest: () => Promise<Date | null>,
    purge: (cutoff: Date, isStopped: () => boolean) => Promise<PurgeResult>,
    checkEveryMs = 5,
  ) =>
    startAutoPurge({
      log: silentLog,
      oldest,
      purge,
      checkEveryMs,
      firstCheckMs: 0,
      now: () => NOW,
    });

  it('purges with a 7 day cutoff when due, and not again once the oldest is young', async () => {
    let oldest = ago(15);
    const purge = vi.fn(async (_cutoff: Date, _stopped: () => boolean) => {
      oldest = ago(6);
      return result({ candidates: 3 });
    });
    const checks = vi.fn(async () => oldest);
    const job = start(checks, purge);
    await vi.waitFor(() => expect(checks.mock.calls.length).toBeGreaterThan(3));
    await job.stop();
    expect(purge).toHaveBeenCalledTimes(1);
    expect(purge.mock.calls[0]?.[0]).toEqual(ago(7));
  });

  it('does nothing while nothing is due', async () => {
    const purge = vi.fn(async () => result());
    const checks = vi.fn(async () => ago(10));
    const job = start(checks, purge);
    await vi.waitFor(() => expect(checks.mock.calls.length).toBeGreaterThan(2));
    await job.stop();
    expect(purge).not.toHaveBeenCalled();
  });

  it('a failed purge or check never escapes (the worker keeps ingesting) and is retried', async () => {
    let n = 0;
    const purge = vi.fn(async () => {
      n += 1;
      if (n === 1) throw new Error('db went away');
      return result();
    });
    let c = 0;
    const job = start(async () => {
      c += 1;
      if (c === 1) throw new Error('check failed');
      return ago(20);
    }, purge);
    await vi.waitFor(() => expect(purge.mock.calls.length).toBeGreaterThanOrEqual(2));
    await job.stop();
  });

  it('stop() tells a running purge to stop, waits for its current game, and starts no other check', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let seen: (() => boolean) | null = null;
    const checks = vi.fn(async () => ago(20));
    const job = start(checks, async (_cutoff, isStopped) => {
      seen = isStopped;
      await gate;
      return result();
    });
    await vi.waitFor(() => expect(seen).not.toBeNull());
    expect((seen as unknown as () => boolean)()).toBe(false);
    let stopped = false;
    const stopping = job.stop().then(() => {
      stopped = true;
    });
    expect((seen as unknown as () => boolean)()).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(stopped).toBe(false);
    release();
    await stopping;
    const after = checks.mock.calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(checks.mock.calls.length).toBe(after);
  });

  it('stop() before the first check runs nothing', async () => {
    const checks = vi.fn(async () => ago(20));
    const job = startAutoPurge({
      log: silentLog,
      oldest: checks,
      purge: async () => result(),
      checkEveryMs: 5,
      firstCheckMs: 10,
      now: () => NOW,
    });
    await job.stop();
    await new Promise((r) => setTimeout(r, 30));
    expect(checks).not.toHaveBeenCalled();
  });
});
