import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../../../src/logger.js';
import {
  assertIntervalFits,
  DEFAULT_INTERVAL_MS,
  type DemoHost,
  demoClock,
  epochFor,
  type LoadedRecording,
  loadRecording,
  MemoryProvenanceStore,
  ProvenanceConflictError,
  parseSlotId,
  pickIndex,
  provenanceRow,
  RECORDED_ROTATION,
  type ReplaySlotRow,
  rotationFor,
  SLOT_ORIGIN_MS,
  SYNTHETIC_ROTATION,
  shiftDocument,
  shiftIso,
  slotAt,
  slotGameId,
  slotRecording,
  slotsOn,
  startDemoHost,
} from '../../../src/providers/sportradar/demo-host.js';
import { PushEventMessageSchema } from '../../../src/providers/sportradar/schemas/push.js';

/**
 * The demo host (plan rev 4.15 (1), (2)): deterministic slot identity and anchoring, timestamp
 * shift, interval-vs-span refusal, provenance before listing. DB-free (MemoryProvenanceStore).
 */
const log = createLogger({ level: 'silent', pretty: false });
const H = 3_600_000;
const MIN = 60_000;
const rotation = rotationFor({});
let wnba: LoadedRecording;
let ncaawb: LoadedRecording;
let unrivaled: LoadedRecording;

beforeAll(async () => {
  [wnba, ncaawb, unrivaled] = await Promise.all([
    loadRecording(RECORDED_ROTATION[0] as (typeof RECORDED_ROTATION)[number]),
    loadRecording(RECORDED_ROTATION[1] as (typeof RECORDED_ROTATION)[number]),
    loadRecording(SYNTHETIC_ROTATION[0] as (typeof SYNTHETIC_ROTATION)[number]),
  ]);
});

const hosts: DemoHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.close()));
});

/** A manually advanced clock (demo time), so two hosts can be asked at the same demo moment. */
function manualClock(start: number) {
  let t = start;
  return {
    clock: { now: () => t, speed: 1, epochMs: 0 },
    set: (v: number) => {
      t = v;
    },
  };
}

async function get(host: DemoHost, path: string, key = true) {
  const res = await fetch(`${host.url}${path}`, {
    headers: key ? { 'x-api-key': 'demo-mode-no-key' } : {},
  });
  return { status: res.status, text: await res.text() };
}

describe('slot identity', () => {
  it('derives replay-<rec8>-<yyyymmddHHMM> from the recording and the slot only, and parses it back', () => {
    const k = Math.round((Date.UTC(2026, 10, 6, 23, 0) - SLOT_ORIGIN_MS) / DEFAULT_INTERVAL_MS);
    const s = slotAt(k, rotation, DEFAULT_INTERVAL_MS);
    expect(new Date(s.tipOffMs).toISOString()).toBe('2026-11-06T23:00:00.000Z');
    expect(s.providerGameId).toBe(slotGameId(s.entry.rec8, s.tipOffMs));
    expect(s.providerGameId).toMatch(/^replay-(93ee7c68|d9b71fe0)-202611062300$/);
    // Ids fit URL path segments and the provider-id text columns unchanged.
    expect(encodeURIComponent(s.providerGameId)).toBe(s.providerGameId);
    expect(parseSlotId(s.providerGameId, rotation, DEFAULT_INTERVAL_MS)).toEqual(s);
    // The rotation alternates; the next slot is the other recording, 3 h later.
    const next = slotAt(k + 1, rotation, DEFAULT_INTERVAL_MS);
    expect(next.tipOffMs - s.tipOffMs).toBe(3 * H);
    expect(next.entry.rec8).not.toBe(s.entry.rec8);
    // Off the grid, or the other recording's id at this slot: unknown.
    expect(parseSlotId('replay-93ee7c68-202611062330', rotation, DEFAULT_INTERVAL_MS)).toBeNull();
    const wrong = s.entry.rec8 === '93ee7c68' ? 'd9b71fe0' : '93ee7c68';
    expect(parseSlotId(`replay-${wrong}-202611062300`, rotation, DEFAULT_INTERVAL_MS)).toBeNull();
    expect(
      parseSlotId('40bea3f6-68c0-4f3b-96fa-336dfb7a9034', rotation, DEFAULT_INTERVAL_MS),
    ).toBeNull();
  });

  it('lists the slots of today and tomorrow on the US Eastern calendar, eight a day at 3 h', () => {
    const now = Date.UTC(2026, 10, 6, 20, 0);
    const today = slotsOn(['2026-11-06'], rotation, DEFAULT_INTERVAL_MS, now);
    expect(today).toHaveLength(8);
    // 2026-11-06 is EST: the grid's 05:00Z is local midnight.
    expect(new Date(today[0]?.tipOffMs ?? 0).toISOString()).toBe('2026-11-06T05:00:00.000Z');
  });
});

describe('timestamps', () => {
  it('shiftIso keeps the offset notation and fraction digits', () => {
    expect(shiftIso('2026-06-30T23:16:34+00:00', 3 * H)).toBe('2026-07-01T02:16:34+00:00');
    expect(shiftIso('2026-10-14T14:05:21.179Z', MIN)).toBe('2026-10-14T14:06:21.179Z');
    expect(shiftIso('2026-06-30T19:00:00-04:00', H)).toBe('2026-06-30T20:00:00-04:00');
    expect(shiftIso('not a time', H)).toBe('not a time');
    expect(shiftIso('2026-06-30', H)).toBe('2026-06-30');
  });

  it('a served document is shifted by slot - recorded tip-off, keeps revision order, and carries the slot id', () => {
    const k = Math.round((Date.UTC(2026, 10, 6, 23, 0) - SLOT_ORIGIN_MS) / DEFAULT_INTERVAL_MS);
    const slot = slotAt(k, [wnba.entry], DEFAULT_INTERVAL_MS);
    const lines = slotRecording(wnba, slot);
    const closed = lines.filter((l) => l.feed === 'pbp').at(-1)?.body as {
      id: string;
      scheduled: string;
      periods: Array<{ events: Array<{ updated: string; wall_clock: string }> }>;
    };
    expect(closed.id).toBe(slot.providerGameId);
    expect(closed.scheduled).toBe('2026-11-06T23:00:00+00:00');
    const original = wnba.docs.pbp.at(-1)?.body as typeof closed;
    const shift = slot.tipOffMs - wnba.recordedTipOffMs;
    const shifted = closed.periods.flatMap((p) => p.events.map((e) => Date.parse(e.updated)));
    const before = original.periods.flatMap((p) => p.events.map((e) => Date.parse(e.updated)));
    expect(shifted).toEqual(before.map((t) => t + shift));
    // Order of every pair is kept (one constant shift), and no served document carries a
    // revision later than the moment it is served.
    for (const l of lines) {
      const body = l.body as { periods?: Array<{ events: Array<{ updated?: string }> }> };
      for (const p of body.periods ?? [])
        for (const e of p.events)
          if (e.updated)
            expect(Date.parse(e.updated)).toBeLessThanOrEqual(Date.parse(l.requestedAt));
    }
    // The recorded game id is gone from every served body.
    expect(JSON.stringify(lines).includes(wnba.recordedGameId)).toBe(false);
    expect(shiftDocument({ a: [wnba.recordedGameId] }, 0, wnba.recordedGameId, 'x')).toEqual({
      a: ['x'],
    });
  });
});

describe('interval vs span', () => {
  it('measures the recordings as the plan states (first document to closed)', () => {
    expect(Math.round(wnba.spanMs / MIN)).toBe(140); // 2 h 20 min
    expect(Math.round(ncaawb.spanMs / MIN)).toBe(127); // 2 h 07 min
    expect(Math.round(unrivaled.spanMs / MIN)).toBe(75);
  });

  it('refuses an interval at or below the longest span (or the rotation footprint); 3 h fits', () => {
    expect(() => assertIntervalFits([wnba, ncaawb], DEFAULT_INTERVAL_MS)).not.toThrow();
    expect(() => assertIntervalFits([wnba, ncaawb], wnba.spanMs)).toThrow(/too short/);
    expect(() => assertIntervalFits([wnba, ncaawb], 2 * H)).toThrow(
      /longest recording in the rotation spans 140 min/,
    );
    // Above the span but inside the served windows (the WNBA replay starts 16 min after tip-off).
    expect(() => assertIntervalFits([wnba, ncaawb], 145 * MIN)).toThrow(/would overlap/);
  });

  it('the host refuses to start with such an interval', async () => {
    await expect(
      startDemoHost({ rotation, intervalMs: 2 * H, provenance: new MemoryProvenanceStore(), log }),
    ).rejects.toThrow(/too short/);
  });
});

describe('the host', () => {
  const tip = Date.UTC(2026, 10, 6, 23, 0);
  const k = Math.round((tip - SLOT_ORIGIN_MS) / DEFAULT_INTERVAL_MS);
  const wnbaRotation = rotationFor({ leagues: ['wnba'] });
  const slot = slotAt(k, wnbaRotation, DEFAULT_INTERVAL_MS);
  const base = '/wnba/production/v8/en';

  it('two instances started at different moments serve the same documents at the same demo time (anchored on the slot, not on process start)', async () => {
    const a = manualClock(tip - 20 * MIN);
    const b = manualClock(tip + 50 * MIN);
    const ha = await startDemoHost({
      rotation: wnbaRotation,
      clock: a.clock,
      provenance: new MemoryProvenanceStore(),
      minSpacingMs: 0,
      log,
    });
    hosts.push(ha);
    const hb = await startDemoHost({
      rotation: wnbaRotation,
      clock: b.clock,
      provenance: new MemoryProvenanceStore(),
      minSpacingMs: 0,
      log,
    });
    hosts.push(hb);
    for (const at of [tip - 5 * MIN, tip + 17 * MIN, tip + 75 * MIN, tip + 4 * H]) {
      a.set(at);
      b.set(at);
      for (const feed of ['pbp', 'summary', 'boxscore']) {
        const ra = await get(ha, `${base}/games/${slot.providerGameId}/${feed}.json`);
        const rb = await get(hb, `${base}/games/${slot.providerGameId}/${feed}.json`);
        expect(ra.status).toBe(200);
        expect(ra.text).toBe(rb.text);
      }
    }
    // Before the first served document: the first (pregame) one; at the end: closed.
    a.set(tip - 30 * MIN);
    const pre = JSON.parse((await get(ha, `${base}/games/${slot.providerGameId}/pbp.json`)).text);
    expect(pre.status).toBe('created');
    expect(pre.id).toBe(slot.providerGameId);
    a.set(tip + 3 * H);
    const end = JSON.parse((await get(ha, `${base}/games/${slot.providerGameId}/pbp.json`)).text);
    expect(end.status).toBe('closed');
    // The served pbp at a moment is the recording's document picked by its served offset.
    a.set(tip + 75 * MIN);
    const mid = JSON.parse((await get(ha, `${base}/games/${slot.providerGameId}/pbp.json`)).text);
    const i = pickIndex(wnba.docs.pbp, 75 * MIN);
    expect(mid).toEqual(
      shiftDocument(
        wnba.docs.pbp[i]?.body,
        tip - wnba.recordedTipOffMs,
        wnba.recordedGameId,
        slot.providerGameId,
      ),
    );
  });

  it('writes provenance before a slot is listed; each league lists only its own slots; refuses no key and unknown slots', async () => {
    const c = manualClock(tip - 60 * MIN);
    const store = new MemoryProvenanceStore();
    const host = await startDemoHost({
      rotation: rotationFor({ includeSynthetic: true }),
      clock: c.clock,
      provenance: store,
      minSpacingMs: 0,
      log,
    });
    hosts.push(host);
    expect(store.rows.size).toBe(0);
    const day = await get(host, `${base}/games/2026/11/06/schedule.json`);
    expect(day.status).toBe(200);
    const doc = JSON.parse(day.text) as {
      date: string;
      games: Array<{ id: string; scheduled: string }>;
    };
    expect(doc.date).toBe('2026-11-06');
    expect(doc.games.length).toBeGreaterThan(0);
    for (const g of doc.games) {
      expect(g.id).toMatch(/^replay-93ee7c68-/); // WNBA only
      const row = store.rows.get(g.id);
      expect(row).toMatchObject({
        league: 'wnba',
        provenance: 'recorded',
        recordedGameId: wnba.recordedGameId,
      });
      expect(row?.slotTipOff.toISOString()).toBe(new Date(g.scheduled).toISOString());
      expect(row?.shiftMs).toBe(
        row ? row.slotTipOff.getTime() - row.recordedTipOff.getTime() : NaN,
      );
    }
    const unr = JSON.parse(
      (await get(host, '/unrivaled/production/v8/en/games/2026/11/06/schedule.json')).text,
    );
    for (const g of unr.games as Array<{ id: string }>) {
      expect(g.id).toMatch(/^replay-838316ea-/);
      expect(store.rows.get(g.id)?.provenance).toBe('synthetic');
    }
    // Neither yesterday nor the day after tomorrow exists on this host.
    expect(
      JSON.parse((await get(host, `${base}/games/2026/11/04/schedule.json`)).text).games,
    ).toEqual([]);
    expect((await get(host, `${base}/games/2026/11/06/schedule.json`, false)).status).toBe(401);
    expect(
      (await get(host, `${base}/games/40bea3f6-68c0-4f3b-96fa-336dfb7a9034/pbp.json`)).status,
    ).toBe(404);
    // A slot of another league asked under this league's path is unknown here.
    const n = (unr.games as Array<{ id: string }>)[0]?.id ?? '';
    expect((await get(host, `${base}/games/${n}/pbp.json`)).status).toBe(404);
  });

  it('lists a slot only until its closed document is served (a late first start never creates a finished slot)', async () => {
    const c = manualClock(tip + 2 * H);
    const host = await startDemoHost({
      rotation: wnbaRotation,
      clock: c.clock,
      provenance: new MemoryProvenanceStore(),
      minSpacingMs: 0,
      log,
    });
    hosts.push(host);
    const ids = async () =>
      (
        JSON.parse((await get(host, `${base}/games/2026/11/06/schedule.json`)).text) as {
          games: Array<{ id: string }>;
        }
      ).games.map((g) => g.id);
    expect(await ids()).toContain(slot.providerGameId); // in progress at +2 h
    c.set(tip + wnba.endOffsetMs - 1);
    expect(await ids()).toContain(slot.providerGameId);
    c.set(tip + wnba.endOffsetMs);
    expect(await ids()).not.toContain(slot.providerGameId); // closed: no longer listed
    // ... but its documents are still served (a resuming watch finishes it).
    const pbp = await get(host, `${base}/games/${slot.providerGameId}/pbp.json`);
    expect(JSON.parse(pbp.text).status).toBe('closed');
  });

  it('a provenance conflict is collected per slot (409 for that slot), never thrown; a deleted row is written again', async () => {
    const c = manualClock(tip - 60 * MIN);
    const store = new MemoryProvenanceStore();
    let ensures = 0;
    const counting = {
      ensure: (row: Parameters<MemoryProvenanceStore['ensure']>[0]) => {
        ensures++;
        return store.ensure(row);
      },
    };
    // A row already there for this slot naming another recorded game (not a fixture-only
    // difference, which a never-played slot re-points: the next test).
    await store.ensure({
      league: 'wnba',
      providerGameId: slot.providerGameId,
      recordingId: wnba.entry.recordingId,
      fixturePath: wnba.entry.fixture,
      fixtureSha256: '0'.repeat(64),
      provenance: 'recorded',
      recordedGameId: 'another-recorded-game',
      recordedTipOff: new Date(wnba.recordedTipOffMs),
      slotTipOff: new Date(tip),
      shiftMs: tip - wnba.recordedTipOffMs,
    });
    const host = await startDemoHost({
      rotation: wnbaRotation,
      clock: c.clock,
      provenance: counting,
      minSpacingMs: 0,
      log,
    });
    hosts.push(host);
    const listed = host.slotsNow();
    const out = await host.ensureListed();
    expect(out.conflicts.map((x) => x.providerGameId)).toEqual([slot.providerGameId]);
    expect(out.written).toBe(listed.length - 1);
    expect((await get(host, `${base}/games/${slot.providerGameId}/pbp.json`)).status).toBe(409);
    // The league's schedule still answers, without the conflicting slot.
    const day = await get(host, `${base}/games/2026/11/06/schedule.json`);
    expect(day.status).toBe(200);
    expect(JSON.parse(day.text).games.map((g: { id: string }) => g.id)).not.toContain(
      slot.providerGameId,
    );
    // Another slot: every request re-checks; a row deleted meanwhile is written again.
    const other = listed.find((x) => x.providerGameId !== slot.providerGameId);
    if (!other) throw new Error('no other slot listed');
    store.rows.delete(other.providerGameId);
    const before = ensures;
    expect((await get(host, `${base}/games/${other.providerGameId}/summary.json`)).status).toBe(
      200,
    );
    expect(ensures).toBe(before + 1);
    expect(store.rows.get(other.providerGameId)?.provenance).toBe('recorded');
  });

  describe('re-pointing a never-played slot to a new fixture', () => {
    const OLD_SHA = 'a'.repeat(64);
    const rowFor = (over: Partial<ReplaySlotRow> = {}): ReplaySlotRow => ({
      ...provenanceRow(wnba, slot),
      ...over,
    });
    // wnba is loaded in beforeAll, so the bound is computed when a test runs.
    const bound = () => new Date(tip + wnba.startOffsetMs);
    const preBound = () => ({ now: new Date(bound().getTime() - 1), repointUntil: bound() });
    const atBound = () => ({ now: bound(), repointUntil: bound() });

    it('a row differing only in fixture path + sha is re-pointed before the first document is due', async () => {
      const store = new MemoryProvenanceStore();
      await store.ensure(
        rowFor({ fixturePath: 'fixtures/wnba/old.jsonl.gz', fixtureSha256: OLD_SHA }),
      );
      expect(await store.ensure(rowFor(), preBound())).toBe('repointed');
      expect(store.rows.get(slot.providerGameId)?.fixtureSha256).toBe(wnba.sha256);
      expect(await store.ensure(rowFor(), preBound())).toBe('written'); // now identical
    });

    it('is refused from the bound on, for a started game, without options, and when anything else differs', async () => {
      const old = rowFor({ fixtureSha256: OLD_SHA });
      const fresh = () => {
        const st = new MemoryProvenanceStore();
        st.rows.set(slot.providerGameId, old);
        return st;
      };
      await expect(fresh().ensure(rowFor(), atBound())).rejects.toThrow(ProvenanceConflictError);
      await expect(fresh().ensure(rowFor())).rejects.toThrow(ProvenanceConflictError);
      const started = fresh();
      started.played.add(slot.providerGameId);
      await expect(started.ensure(rowFor(), preBound())).rejects.toThrow(ProvenanceConflictError);
      for (const other of [
        { recordingId: 'another-recording' },
        { recordedGameId: 'another-game' },
        { provenance: 'synthetic' as const },
        { shiftMs: rowFor().shiftMs + 60_000 },
        { recordedTipOff: new Date(wnba.recordedTipOffMs + 60_000) },
      ]) {
        const st = new MemoryProvenanceStore();
        st.rows.set(slot.providerGameId, { ...old, ...other });
        await expect(st.ensure(rowFor(), preBound()), JSON.stringify(other)).rejects.toThrow(
          ProvenanceConflictError,
        );
      }
    });

    it('the host re-points on the first request before play (warn log, counter) and serves the slot', async () => {
      const store = new MemoryProvenanceStore();
      store.rows.set(slot.providerGameId, rowFor({ fixtureSha256: OLD_SHA }));
      const warnings: string[] = [];
      const c = manualClock(tip - 5 * MIN);
      const host = await startDemoHost({
        rotation: wnbaRotation,
        clock: c.clock,
        provenance: store,
        minSpacingMs: 0,
        log: {
          ...log,
          warn: (_o: unknown, msg?: string) => {
            if (msg) warnings.push(msg);
          },
        } as unknown as typeof log,
      });
      hosts.push(host);
      expect((await get(host, `${base}/games/${slot.providerGameId}/pbp.json`)).status).toBe(200);
      expect(host.stats.repointed).toBe(1);
      expect(warnings).toContain('replay slot re-pointed to a new fixture before play');
      // After the bound a sha-only difference is a conflict again (409).
      store.rows.set(slot.providerGameId, rowFor({ fixtureSha256: OLD_SHA }));
      c.set(tip + wnba.startOffsetMs);
      expect((await get(host, `${base}/games/${slot.providerGameId}/pbp.json`)).status).toBe(409);
    });
  });

  it("streams a slot's push lines after the moment of connection, shifted and renamed", async () => {
    const speed = 600;
    const wallNow = Date.now();
    // Demo clock 2 demo minutes into the replay's first events (WNBA plays begin about +16 min).
    const clock = demoClock(speed, epochFor(tip + 17 * MIN, wallNow, speed));
    const host = await startDemoHost({
      rotation: wnbaRotation,
      clock,
      provenance: new MemoryProvenanceStore(),
      minSpacingMs: 0,
      heartbeatMs: 200,
      log,
    });
    hosts.push(host);
    const ctl = new AbortController();
    const res = await fetch(
      `${host.url}/wnba/production/stream/en/events/subscribe?match=sd:match:${slot.providerGameId}`,
      { headers: { 'x-api-key': 'k' }, signal: ctl.signal },
    );
    expect(res.status).toBe(200);
    const lines: unknown[] = [];
    const decoder = new TextDecoder();
    let buf = '';
    const reader = res.body?.getReader();
    const deadline = Date.now() + 5000;
    while (reader && lines.length < 5 && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        const json = JSON.parse(buf.slice(0, nl));
        if (!('heartbeat' in json)) lines.push(json);
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
      }
    }
    ctl.abort();
    expect(lines.length).toBeGreaterThanOrEqual(5);
    for (const l of lines) {
      const m = PushEventMessageSchema.parse(l);
      expect(m.metadata.match).toBe(`sd:match:${slot.providerGameId}`);
      expect(m.payload.game.id).toBe(slot.providerGameId);
      expect(Date.parse(String(m.payload.event.updated))).toBeGreaterThan(tip);
    }
    const noMatch = await get(host, '/wnba/production/stream/en/events/subscribe');
    expect(noMatch.status).toBe(404);
  });
});
