import { createHash } from 'node:crypto';

/**
 * Canonical JSON: object keys sorted recursively, `undefined` members dropped,
 * arrays kept in order. Two structurally equal values always serialize to the
 * same bytes, so sha256 of this string is a stable content hash.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortValue);
  const out: Record<string, unknown> = {};
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v === undefined) continue;
    out[key] = sortValue(v);
  }
  return out;
}

/** sha256 hex of the canonical JSON of `value`. Hash the *body only*, never an envelope. */
export function contentHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
