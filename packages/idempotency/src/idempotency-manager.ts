import { hashPayload } from './hasher.js';
import {
  IdempotencyPayloadMismatchError,
  IdempotencyConcurrentConflictError,
} from './errors.js';
import type {
  IdempotencyStorage,
  CachedResponse,
} from './storage.js';

export interface ExecuteIdempotentParams<T> {
  key: string;
  tenantId: string;
  payload: unknown;
  ttlMs?: number;
  execute: () => Promise<{
    statusCode: number;
    headers?: Record<string, string>;
    body: T;
  }>;
}

export class IdempotencyManager {
  constructor(private readonly storage: IdempotencyStorage) {}

  async runWithIdempotency<T>(params: ExecuteIdempotentParams<T>): Promise<CachedResponse> {
    const { key, tenantId, payload, ttlMs = 120_000, execute } = params;
    const computedHash = hashPayload(payload);

    // Phase 1: Two-phase reservation
    const reservation = await this.storage.reserveLock(key, tenantId, computedHash, ttlMs);

    if (!reservation.success && reservation.existing) {
      const existing = reservation.existing;

      // Check 1: Payload verification against tampering/mismatch
      if (existing.payloadHash !== computedHash) {
        throw new IdempotencyPayloadMismatchError(key, existing.payloadHash, computedHash);
      }

      // Check 2: Concurrency collision
      if (existing.status === 'PROCESSING') {
        throw new IdempotencyConcurrentConflictError(key);
      }

      // Check 3: Cached successful response
      if (existing.status === 'COMPLETED' && existing.response) {
        return existing.response;
      }

      // If previously failed, allow retry by updating lock
      if (existing.status === 'FAILED') {
        // Retry reservation
        await this.storage.reserveLock(key, tenantId, computedHash, ttlMs);
      }
    }

    // Phase 2: Execution
    try {
      const result = await execute();
      const response: CachedResponse = {
        statusCode: result.statusCode,
        headers: result.headers ?? {},
        body: result.body,
      };

      await this.storage.complete(key, tenantId, response);
      return response;
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await this.storage.fail(key, tenantId, errorMsg);
      throw err;
    }
  }
}

