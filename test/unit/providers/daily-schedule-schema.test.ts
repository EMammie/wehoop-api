import { describe, expect, it } from 'vitest';
import { DailyScheduleDocumentSchema } from '../../../src/providers/sportradar/schemas/schedule.js';
import { fixture } from '../../helpers/fixtures.js';

describe('DailyScheduleDocumentSchema (/games/{yyyy}/{mm}/{dd}/schedule.json)', () => {
  it('parses the assembled docs sample: date, league, one game with coverage, no season header', () => {
    const doc = DailyScheduleDocumentSchema.parse(
      fixture('docs-daily-schedule-2022-11-07.json', 'ncaawb'),
    );
    expect(doc.date).toBe('2022-11-07');
    expect(doc.league?.alias).toBe('NCAAW');
    expect(doc.season).toBeUndefined();
    expect(doc.games).toHaveLength(1);
    expect(doc.games[0]).toMatchObject({ coverage: 'boxscore', status: 'closed' });
    expect(doc.games[0]?.home.market).toBeUndefined(); // name + alias only, as the live feed
  });

  it('rejects a malformed date or a missing games entry id; unknown top-level keys pass (.loose)', () => {
    const raw = fixture('docs-daily-schedule-2022-11-07.json', 'ncaawb') as Record<string, unknown>;
    expect(DailyScheduleDocumentSchema.safeParse({ ...raw, date: '2022-11-7' }).success).toBe(
      false,
    );
    expect(DailyScheduleDocumentSchema.safeParse({ ...raw, extra: 1 }).success).toBe(true);
    const games = raw.games as Array<Record<string, unknown>>;
    const home = { ...(games[0]?.home as Record<string, unknown>) };
    delete home.id;
    expect(
      DailyScheduleDocumentSchema.safeParse({ ...raw, games: [{ ...games[0], home }] }).success,
    ).toBe(false);
  });
});
