import { createHash } from 'node:crypto';
import type { LedgerPosting, JournalEntry } from '@vme/shared-types';

export const GENESIS_HASH = '0'.repeat(64);

export function computePayloadHash(
  postings: Array<Omit<LedgerPosting, 'id' | 'journalEntryId'>>,
  description: string,
  referenceType: string,
  referenceId: string
): string {
  // Canonical string representation for deterministic hashing
  const canonicalPostings = [...postings].sort((a, b) => {
    if (a.accountId !== b.accountId) return a.accountId.localeCompare(b.accountId);
    if (a.direction !== b.direction) return a.direction.localeCompare(b.direction);
    return a.amount.localeCompare(b.amount);
  });

  const payloadString = JSON.stringify({
    description,
    referenceType,
    referenceId,
    postings: canonicalPostings.map((p) => ({
      accountId: p.accountId,
      direction: p.direction,
      amount: p.amount,
      currency: p.currency,
    })),
  });

  return createHash('sha256').update(payloadString).digest('hex');
}

export function computeEntryHash(
  previousHash: string,
  payloadHash: string,
  entryNumber: number,
  txId: string,
  committedAt: string
): string {
  const hashInput = `${previousHash}|${payloadHash}|${entryNumber}|${txId}|${committedAt}`;
  return createHash('sha256').update(hashInput).digest('hex');
}

export function verifyJournalIntegrity(entries: JournalEntry[]): {
  isValid: boolean;
  brokenAtIndex?: number;
  reason?: string;
} {
  let currentExpectedPreviousHash = GENESIS_HASH;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;

    // 1. Verify previous hash chaining
    if (entry.previousHash !== currentExpectedPreviousHash) {
      return {
        isValid: false,
        brokenAtIndex: i,
        reason: `Previous hash mismatch at index ${i}. Expected ${currentExpectedPreviousHash}, got ${entry.previousHash}`,
      };
    }

    // 2. Verify payload hash
    const recomputedPayloadHash = computePayloadHash(
      entry.postings,
      entry.description,
      entry.referenceType,
      entry.referenceId
    );
    if (recomputedPayloadHash !== entry.payloadHash) {
      return {
        isValid: false,
        brokenAtIndex: i,
        reason: `Payload hash mismatch at entry #${entry.entryNumber}. Recomputed ${recomputedPayloadHash}, recorded ${entry.payloadHash}`,
      };
    }

    // 3. Verify entry hash
    const recomputedEntryHash = computeEntryHash(
      entry.previousHash,
      entry.payloadHash,
      entry.entryNumber,
      entry.txId,
      entry.committedAt
    );
    if (recomputedEntryHash !== entry.entryHash) {
      return {
        isValid: false,
        brokenAtIndex: i,
        reason: `Entry hash mismatch at entry #${entry.entryNumber}. Recomputed ${recomputedEntryHash}, recorded ${entry.entryHash}`,
      };
    }

    currentExpectedPreviousHash = entry.entryHash;
  }

  return { isValid: true };
}
