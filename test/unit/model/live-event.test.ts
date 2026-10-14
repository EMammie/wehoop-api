import { describe, expect, it } from 'vitest';
import { LiveEventSchema } from '../../../src/model/live-event.js';

/**
 * Plan §3: every id inside a LiveEvent body is a provider id and is named
 * `provider…Id` / `provider…Ids`. Canonical uuids never enter a body.
 */
describe('LiveEvent body ids', () => {
  it('every body field ending in Id or Ids carries the provider prefix (all variants, nested shapes included)', () => {
    const offenders: string[] = [];
    const visit = (shape: Record<string, unknown>, path: string) => {
      for (const [key, schema] of Object.entries(shape)) {
        if (/Ids?$/.test(key) && !key.startsWith('provider')) offenders.push(`${path}${key}`);
        const inner = unwrap(schema);
        if (inner && 'shape' in inner && typeof inner.shape === 'object' && inner.shape) {
          visit(inner.shape as Record<string, unknown>, `${path}${key}.`);
        }
      }
    };
    for (const option of LiveEventSchema.options) {
      const type = option.shape.type.value;
      visit(option.shape, `${type}.`);
    }
    expect(offenders).toEqual([]);
    // and the ratified names are present where the plan puts them
    const byType = new Map(LiveEventSchema.options.map((o) => [o.shape.type.value, o.shape]));
    expect(Object.keys(byType.get('shot') ?? {})).toEqual(
      expect.arrayContaining([
        'providerTeamId',
        'providerPlayerId',
        'providerPossessionTeamId',
        'providerAssistId',
        'providerBlockId',
      ]),
    );
    expect(Object.keys(byType.get('turnover') ?? {})).toContain('providerStealId');
    expect(Object.keys(byType.get('foul') ?? {})).toContain('providerDrawnById');
    expect(Object.keys(byType.get('lineup_change') ?? {})).toContain('providerOnCourtPlayerIds');
  });
});

/** Strip optional/nullable wrappers to reach an object schema's shape, if any. */
function unwrap(schema: unknown): { shape?: unknown } | null {
  let s = schema as { def?: { innerType?: unknown; type?: string }; shape?: unknown } | null;
  for (let i = 0; i < 5 && s; i++) {
    if ('shape' in s && s.shape) return s;
    const inner = s.def?.innerType;
    if (!inner) break;
    s = inner as typeof s;
  }
  return s && 'shape' in s ? s : null;
}
