import { describe, expect, it } from 'vitest';
import { deriveClockRunning } from '../../../src/ingest/clock.js';
import { createFaultInjector, parseFault } from '../../../src/ingest/fault.js';

describe('clock_running derivation (REST/sim)', () => {
  const prev = { status: 'inprogress' as const, clock: '5:00', clockRunning: null };
  it('true when the clock advanced during inprogress', () => {
    expect(
      deriveClockRunning(prev, { status: 'inprogress', clock: '4:50', clockRunning: null }, 'shot'),
    ).toBe(true);
  });
  it('false when the newest event stops the clock, at halftime and after the game', () => {
    expect(
      deriveClockRunning(
        prev,
        { status: 'inprogress', clock: '4:50', clockRunning: null },
        'timeout',
      ),
    ).toBe(false);
    expect(
      deriveClockRunning(
        prev,
        { status: 'inprogress', clock: '0:00', clockRunning: null },
        'period_end',
      ),
    ).toBe(false);
    expect(
      deriveClockRunning(prev, { status: 'halftime', clock: '0:00', clockRunning: null }, null),
    ).toBe(false);
    expect(
      deriveClockRunning(prev, { status: 'closed', clock: '0:00', clockRunning: null }, null),
    ).toBe(false);
  });
  it('keeps the previous value when the clock is unchanged, null when it jumps up or is unknown', () => {
    expect(
      deriveClockRunning(
        { ...prev, clockRunning: true },
        { status: 'inprogress', clock: '5:00', clockRunning: null },
        'rebound',
      ),
    ).toBe(true);
    expect(
      deriveClockRunning(
        prev,
        { status: 'inprogress', clock: '5:30', clockRunning: null },
        'review',
      ),
    ).toBeNull();
    expect(
      deriveClockRunning(prev, { status: 'scheduled', clock: null, clockRunning: null }, null),
    ).toBeNull();
  });
  it('push clocks carry running directly', () => {
    expect(
      deriveClockRunning(
        prev,
        { status: 'inprogress', clock: '5:00', clockRunning: false },
        'shot',
      ),
    ).toBe(false);
  });
});

describe('fault injection spec', () => {
  it('parses kind and optional seq, rejects unknown kinds', () => {
    expect(parseFault(undefined)).toBeNull();
    expect(parseFault('before_commit')).toEqual({ kind: 'before_commit', atSeq: 1 });
    expect(parseFault('after_publish:120')).toEqual({ kind: 'after_publish', atSeq: 120 });
    expect(() => parseFault('explode')).toThrow();
  });
  it('fires only for its kind once seq reaches the threshold', () => {
    const kills: Array<[number, string]> = [];
    const f = createFaultInjector(
      { kind: 'before_commit', atSeq: 10 },
      (pid, sig) => kills.push([pid, sig]),
      () => undefined,
    );
    f.maybeFire('after_publish', 50);
    f.maybeFire('before_commit', 9);
    expect(kills).toEqual([]);
    f.maybeFire('before_commit', 10);
    expect(kills).toEqual([[process.pid, 'SIGKILL']]);
    createFaultInjector(null, (pid, sig) => kills.push([pid, sig])).maybeFire('before_commit', 999);
    expect(kills).toHaveLength(1);
  });
});
