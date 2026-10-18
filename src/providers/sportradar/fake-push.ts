import { PbpDocumentSchema, type PbpEvent } from './schemas/pbp.js';
import { PushClockMessageSchema, PushEventMessageSchema } from './schemas/push.js';

/**
 * Push lines derived from a recorded pbp sequence, for `pnpm sim serve` (plan
 * §9: "M4 uses a local chunked NDJSON mock with heartbeats and disconnects").
 * Each consecutive pbp document is diffed against the previous one:
 *   - an event id seen for the first time   -> `operation: insert`
 *   - an event whose JSON changed           -> `operation: update`
 *   - a new `deleted_events[]` id           -> `operation: delete` (with the last known body)
 * and every change of the header (status, clock, score, period) becomes one
 * clock line with `clocks.running` derived (inprogress and the clock moved).
 * Every produced line is Zod-parsed with the recorded-sample schemas
 * (`fixtures/wnba/sim-93ee7c68-push-{events,clock}-sample.json`) so the mock
 * cannot drift from the shape the client accepts. Pure: no clock, no I/O.
 */
export interface TimedLine {
  offsetMs: number;
  line: unknown;
}

export interface PushTimelines {
  events: TimedLine[];
  clocks: TimedLine[];
}

/** `"10:00"` -> `"1000"`, `"00:25"` -> `"0025"`: the digit form the recorded push clock sample uses. */
export function clockToPushDigits(clock: string | undefined): string | undefined {
  if (clock === undefined) return undefined;
  const m = /^(\d{1,2}):(\d{2})(\.\d+)?$/.exec(clock);
  if (!m) return clock;
  return `${(m[1] ?? '0').padStart(2, '0')}${m[2]}${m[3] ?? ''}`;
}

type Doc = ReturnType<typeof PbpDocumentSchema.parse>;

function gameHeader(doc: Doc) {
  const team = (t: Doc['home']) => ({
    id: t.id,
    name: t.name,
    ...(t.market !== undefined ? { market: t.market } : {}),
    ...(t.alias !== undefined ? { alias: t.alias } : {}),
    points: t.points ?? 0,
    ...(t.sr_id !== undefined ? { sr_id: t.sr_id } : {}),
    ...(t.reference !== undefined ? { reference: t.reference } : {}),
  });
  return {
    id: doc.id,
    ...(doc.title !== undefined ? { title: doc.title } : {}),
    status: doc.status,
    ...(doc.coverage !== undefined ? { coverage: doc.coverage } : {}),
    ...(doc.reference !== undefined ? { reference: doc.reference } : {}),
    scheduled: doc.scheduled,
    home: team(doc.home),
    away: team(doc.away),
  };
}

function metadata(doc: Doc, operation: string, extra: Record<string, unknown> = {}) {
  return {
    match: `sd:match:${doc.id}`,
    league: 'wnba',
    locale: 'en',
    status: doc.status,
    operation,
    version: 'v7',
    ...extra,
  };
}

export function buildPushTimelines(
  pbpDocs: Array<{ offsetMs: number; body: unknown }>,
): PushTimelines {
  const events: TimedLine[] = [];
  const clocks: TimedLine[] = [];
  const known = new Map<string, { json: string; event: PbpEvent; period: unknown }>();
  const deleted = new Set<string>();
  let prevHeader: string | null = null;
  let prevClock: string | undefined;
  for (const { offsetMs, body } of pbpDocs) {
    const doc = PbpDocumentSchema.parse(body);
    const header = gameHeader(doc);
    for (const p of doc.periods) {
      const period = {
        number: p.number,
        sequence: p.sequence,
        type: p.type,
        ...(p.id ? { id: p.id } : {}),
      };
      for (const ev of p.events) {
        const json = JSON.stringify(ev);
        const prev = known.get(ev.id);
        if (prev && prev.json === json) continue;
        known.set(ev.id, { json, event: ev, period });
        const line = PushEventMessageSchema.parse({
          payload: { game: header, event: { ...ev, period } },
          metadata: metadata(doc, prev ? 'update' : 'insert', { event_type: ev.event_type }),
          locale: 'en',
        });
        events.push({ offsetMs, line });
      }
    }
    for (const d of doc.deleted_events ?? []) {
      if (deleted.has(d.id)) continue;
      deleted.add(d.id);
      const k = known.get(d.id);
      if (!k) continue; // never seen a body for it: nothing a push delete could carry
      const line = PushEventMessageSchema.parse({
        payload: {
          game: header,
          event: {
            ...k.event,
            period: k.period,
            ...(d.updated !== undefined ? { updated: d.updated } : {}),
          },
        },
        metadata: metadata(doc, 'delete', { event_type: k.event.event_type }),
        locale: 'en',
      });
      events.push({ offsetMs, line });
    }
    const current =
      doc.quarter !== undefined ? doc.periods.find((p) => p.number === doc.quarter) : undefined;
    const headerKey = JSON.stringify([
      doc.status,
      doc.clock ?? null,
      doc.home.points ?? 0,
      doc.away.points ?? 0,
      current?.sequence ?? null,
    ]);
    if (headerKey !== prevHeader) {
      const clockMoved = doc.clock !== undefined && doc.clock !== prevClock;
      // Every third clock line omits `points` (the real feed omits fields; the ingester must keep
      // the stored score rather than claim 0-0).
      const omitPoints = clocks.length % 3 === 2;
      const strip = (t: Record<string, unknown>) => {
        const { points: _p, ...rest } = t;
        return rest;
      };
      const clockHeader = omitPoints
        ? { ...header, home: strip(header.home), away: strip(header.away) }
        : header;
      const line = PushClockMessageSchema.parse({
        payload: {
          game: clockHeader,
          ...(current
            ? { period: { number: current.number, sequence: current.sequence, type: current.type } }
            : {}),
          clocks: {
            game: clockToPushDigits(doc.clock) ?? '',
            ...(doc.clock_decimal !== undefined
              ? { game_decimal: clockToPushDigits(doc.clock_decimal) }
              : {}),
            running: doc.status === 'inprogress' && clockMoved,
          },
        },
        locale: 'en',
        metadata: metadata(doc, 'update'),
      });
      clocks.push({ offsetMs, line });
      prevHeader = headerKey;
    }
    prevClock = doc.clock;
  }
  return { events, clocks };
}
