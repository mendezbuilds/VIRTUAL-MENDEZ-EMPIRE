import { createHash } from 'node:crypto';

export function hashPayload(payload: unknown): string {
  if (payload === undefined || payload === null) {
    return createHash('sha256').update('').digest('hex');
  }

  // Canonicalize keys to ensure deterministic hashing regardless of object key ordering
  const canonicalString = JSON.stringify(payload, Object.keys(payload as object).sort());
  return createHash('sha256').update(canonicalString).digest('hex');
}
