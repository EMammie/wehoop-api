import { describe, expect, it } from 'vitest';
import { BoxscoreDocumentSchema } from '../../../src/providers/sportradar/schemas/boxscore.js';
import { PbpDocumentSchema } from '../../../src/providers/sportradar/schemas/pbp.js';
import {
  PushClockMessageSchema,
  PushEventMessageSchema,
  PushHeartbeatSchema,
  PushLineSchema,
} from '../../../src/providers/sportradar/schemas/push.js';
import { RecordingsResponseSchema } from '../../../src/providers/sportradar/schemas/simulation.js';
import { SummaryDocumentSchema } from '../../../src/providers/sportradar/schemas/summary.js';
import { fixture } from '../../helpers/fixtures.js';

const R = 'sim-93ee7c68';

describe('Sportradar WNBA v8 schemas (recorded simulation fixtures)', () => {
  it('parses pbp at created and in Q1, keeping unknown top-level fields (.loose())', () => {
    const created = PbpDocumentSchema.parse(fixture(`${R}-pbp-created.json`));
    expect(created.status).toBe('created');
    expect(created.periods).toEqual([]);
    const q1 = PbpDocumentSchema.parse(fixture(`${R}-pbp-q1.json`));
    expect(q1.status).toBe('inprogress');
    expect(q1.periods[0]?.events.length).toBeGreaterThan(10);
    expect((q1 as Record<string, unknown>).entry_mode).toBe('WEBSOCKET'); // not declared, kept
  });

  it('rejects a pbp whose persisted fields are mutated to the wrong type', () => {
    const doc = fixture(`${R}-pbp-q1.json`) as { periods: { events: { sequence: unknown }[] }[] };
    const first = doc.periods[0]?.events[0];
    if (!first) throw new Error('fixture has no events');
    first.sequence = 'not-a-number';
    expect(PbpDocumentSchema.safeParse(doc).success).toBe(false);
  });

  it('parses summary (game feed) with team statistics and players', () => {
    const s = SummaryDocumentSchema.parse(fixture(`${R}-summary-q1.json`));
    expect(s.home.statistics?.field_goals_att).toBeTypeOf('number');
    expect(s.home.players?.length).toBeGreaterThan(5);
    expect(s.venue?.name).toBe('Barclays Center');
  });

  it('parses boxscore with per-period scoring', () => {
    const b = BoxscoreDocumentSchema.parse(fixture(`${R}-boxscore-q1.json`));
    expect(b.home.scoring?.[0]).toMatchObject({ type: 'quarter', number: 1, sequence: 1 });
  });

  it('parses push event, clock and heartbeat lines', () => {
    const lines = fixture(`${R}-push-events-sample.json`) as unknown[];
    expect(PushHeartbeatSchema.safeParse(lines[0]).success).toBe(true);
    for (const l of lines.slice(1)) {
      const m = PushEventMessageSchema.parse(l);
      expect(m.metadata.operation).toBe('update');
      expect(m.payload.event.period?.sequence).toBe(1);
    }
    for (const l of fixture(`${R}-push-clock-sample.json`) as unknown[]) {
      const m = PushClockMessageSchema.parse(l);
      expect(typeof m.payload.clocks.running).toBe('boolean');
      expect(PushLineSchema.safeParse(l).success).toBe(true);
    }
  });

  it('parses the playback GraphQL recordings response shape', () => {
    const r = RecordingsResponseSchema.parse({
      data: {
        recordings: [
          { id: 'x', title: 't', apis: [{ name: 'pbp', apiType: 'rest' }] },
          { id: 'y', apis: [] },
        ],
      },
    });
    expect(r.data.recordings[0]?.apis[0]?.name).toBe('pbp');
  });
});
