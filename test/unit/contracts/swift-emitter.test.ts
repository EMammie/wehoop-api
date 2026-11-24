import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CONTRACTS } from '../../../src/contracts/registry.js';
import {
  camelCase,
  compareWithDirectory,
  emitSwift,
  pascalCase,
} from '../../../src/contracts/swift-emitter.js';

const GENERATED = join(import.meta.dirname, '../../../generated/swift');

/** Every closed string enum the registry reaches, by walking the Zod defs. */
function countStringEnums(): number {
  const seen = new Set<z.ZodType>();
  let n = 0;
  const walk = (s: z.ZodType) => {
    if (seen.has(s)) return;
    seen.add(s);
    // biome-ignore lint/suspicious/noExplicitAny: test-only introspection of Zod internals
    const d = (s as any)._zod.def;
    switch (d.type) {
      case 'enum':
        n += 1;
        break;
      case 'object':
        for (const v of Object.values(d.shape)) walk(v as z.ZodType);
        break;
      case 'union':
        for (const o of d.options) walk(o);
        break;
      case 'nullable':
      case 'optional':
        walk(d.innerType);
        break;
      case 'array':
        walk(d.element);
        break;
      case 'record':
        walk(d.valueType);
        break;
      default:
        break;
    }
  };
  for (const e of CONTRACTS) walk(e.schema);
  return n;
}

describe('gen:swift emitter', () => {
  const files = emitSwift(CONTRACTS);
  const all = [...files.values()].join('\n');

  it('emits every registered contract as a named public type, once', () => {
    for (const e of CONTRACTS) {
      const decl = new RegExp(`^public (struct|enum) ${e.name}: `, 'mg');
      expect(all.match(decl)?.length, e.name).toBe(1);
    }
  });

  it('every closed string union gets a `case unknown(String)` (plan rev 4.11 (5))', () => {
    const enums = countStringEnums();
    expect(enums).toBeGreaterThanOrEqual(8); // the six codes + rebound kind + timeout kind
    // One `case unknown(String)` per string enum, plus one per discriminated union (LiveEvent, GameChange).
    const unknownCases = all.match(/^\s*case unknown\(String\)$/gm)?.length ?? 0;
    expect(unknownCases).toBe(enums + 2);
    for (const code of [
      'LeagueCode',
      'SeasonType',
      'CoverageLevel',
      'PeriodType',
      'GameStatus',
      'ChangeType',
    ]) {
      const body = all.slice(all.indexOf(`public enum ${code}: `));
      expect(body.slice(0, body.indexOf('\n}\n'))).toContain('case unknown(String)');
    }
  });

  it('an entry literally named `unknown` folds into the fallback case instead of a duplicate case', () => {
    const rebound = all.slice(all.indexOf('public struct Rebound: '));
    const kind = rebound.slice(
      rebound.indexOf('public enum Kind: '),
      rebound.indexOf('public static let known'),
    );
    expect(kind.match(/case unknown/g)?.length).toBe(1);
    expect(rebound).toContain(
      'public static let known: [Kind] = [.offensive, .defensive, .teamOffensive, .teamDefensive]',
    );
  });

  it('discriminated unions hoist the shared fields so an unknown change still carries seq', () => {
    const gc = all.slice(all.indexOf('public struct GameChange: '));
    for (const f of [
      'v: Int',
      'id: String',
      'gameId: String',
      'seq: Int',
      'ts: String',
      'type: Kind',
    ]) {
      expect(gc).toContain(`public let ${f}`);
    }
    expect(gc).toContain('default: type = .unknown(raw)');
    const le = all.slice(all.indexOf('public struct LiveEvent: '));
    for (const f of [
      'period: PeriodRef',
      'clock: String?',
      'score: Score',
      'providerPlayerId: String?',
    ]) {
      expect(le).toContain(`public let ${f}`);
    }
    // Payload-less variants are plain cases; a variant whose name collides with a root gets a suffix.
    expect(le).toContain('case tipOff\n');
    expect(le).toContain('case gameStatus(GameStatusPayload)');
    expect(le).toContain('public struct GameStatusPayload: ');
  });

  it('references registered schemas by name instead of inlining them', () => {
    expect(all).toContain('public let period: PeriodRef?'); // StatusBody
    expect(all).toContain('public let teamStats: [StatsTeamBody]'); // Snapshot
    expect(all).toContain('public let changes: [GameChange]'); // ChangesPage
    expect(all).toContain('public let league: LeagueCode'); // view rows, PlayerResponse
    expect(all.match(/^public struct PeriodRef: /gm)?.length).toBe(1);
  });

  it('maps snake_case view columns through CodingKeys and the primitives as documented', () => {
    const views = files.get('Views.swift') ?? '';
    expect(views).toContain('case providerGameId = "provider_game_id"');
    expect(views).toContain('public let winPct: Double?'); // numeric
    expect(views).toContain('public let lastSeq: Int'); // int8
    expect(views).toContain('public let venue: [String: JSONValue]?'); // jsonb
    expect(views).toContain('public let scheduledAt: String'); // timestamptz
    expect(views).toContain('public let clockRunning: Bool?');
    expect(views).toContain('public let coverage: CoverageLevel');
    expect(views).toContain('public let seasonType: SeasonType?');
  });

  it('is deterministic', () => {
    const again = emitSwift(CONTRACTS);
    expect([...again.entries()]).toEqual([...files.entries()]);
  });

  it('every file carries the DO NOT EDIT header and JSONValue is emitted', () => {
    for (const [name, src] of files) {
      expect(src.startsWith('// Generated by wehoop-api `pnpm gen:swift`'), name).toBe(true);
      expect(src, name).toContain('DO NOT EDIT');
    }
    expect(files.get('JSONValue.swift')).toContain(
      'public enum JSONValue: Codable, Hashable, Sendable',
    );
  });

  it('the committed generated/swift is what the schemas emit (run `pnpm gen:swift` after a schema change)', () => {
    const existing = new Map<string, string>();
    for (const f of readdirSync(GENERATED)) {
      if (f.endsWith('.swift')) existing.set(f, readFileSync(join(GENERATED, f), 'utf8'));
    }
    expect(compareWithDirectory(files, existing)).toEqual({ missing: [], stale: [], changed: [] });
  });

  it('compareWithDirectory reports missing, stale and changed files', () => {
    const existing = new Map(files);
    existing.delete('Pulse.swift');
    existing.set('Old.swift', '// gone');
    existing.set('Codes.swift', `${existing.get('Codes.swift')}\n// drift`);
    expect(compareWithDirectory(files, existing)).toEqual({
      missing: ['Pulse.swift'],
      stale: ['Old.swift'],
      changed: ['Codes.swift'],
    });
  });

  it('rejects shapes the contract does not use, so a new Zod feature is a deliberate generator change', () => {
    const union = z.union([z.string(), z.int()]);
    expect(() =>
      emitSwift([{ name: 'Bad', schema: z.object({ x: union }), file: 'X', doc: '' }]),
    ).toThrow(/nested unions/);
    expect(() => emitSwift([{ name: 'Bad', schema: union, file: 'X', doc: '' }])).toThrow(
      /discriminated/,
    );
    expect(() =>
      emitSwift([{ name: 'Bad', schema: z.object({ x: z.date() }), file: 'X', doc: '' }]),
    ).toThrow(/unsupported schema type date/);
    const twice = z.object({ a: z.string() });
    expect(() =>
      emitSwift([
        { name: 'A', schema: twice, file: 'X', doc: '' },
        { name: 'B', schema: twice, file: 'X', doc: '' },
      ]),
    ).toThrow(/registered twice/);
  });

  it('escapes Swift keywords and converts names', () => {
    expect(camelCase('if_necessary')).toBe('ifNecessary');
    expect(camelCase('PRE')).toBe('pre');
    expect(camelCase('clock_as_of')).toBe('clockAsOf');
    expect(pascalCase('event_insert')).toBe('EventInsert');
    const src = emitSwift([
      {
        name: 'Kw',
        schema: z.object({ default: z.string(), in: z.int(), kind: z.enum(['default', 'ok']) }),
        file: 'X',
        doc: '',
      },
    ]).get('X.swift');
    expect(src).toContain('public let `default`: String');
    expect(src).toContain('public let `in`: Int');
    expect(src).toContain('case `default`\n');
    expect(src).toContain('case "default": self = .`default`');
  });
});
