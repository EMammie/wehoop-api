import { describe, expect, it } from 'vitest';
import { canonicalJson, contentHash } from '../../../src/model/content-hash.js';

describe('content hash', () => {
  it('is independent of key order and drops undefined members', () => {
    const a = { b: 1, a: { y: [1, 2], x: 'z' }, u: undefined };
    const b = { a: { x: 'z', y: [1, 2] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(contentHash(a)).toBe(contentHash(b));
  });

  it('changes when any body value changes and keeps array order', () => {
    expect(contentHash({ x: [1, 2] })).not.toBe(contentHash({ x: [2, 1] }));
    expect(contentHash({ clock: '5:00' })).not.toBe(contentHash({ clock: '5:30' }));
  });

  it('is a 64-char sha256 hex', () => {
    expect(contentHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});
