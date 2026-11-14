import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  IdempotencyManager,
  InMemoryIdempotencyStorage,
  IdempotencyPayloadMismatchError,
  IdempotencyConcurrentConflictError,
} from './index.js';

describe('@vme/idempotency Concurrency-Safe Idempotency Engine', () => {
  const tenantId = randomUUID();

  it('executes once and returns cached response for duplicate requests', async () => {
    const storage = new InMemoryIdempotencyStorage();
    const manager = new IdempotencyManager(storage);
    const key = 'idem-req-001';
    const payload = { amount: '500.00', currency: 'USD', recipient: 'acc-123' };

    let executionCount = 0;
    const execute = vi.fn(async () => {
      executionCount++;
      return {
        statusCode: 201,
        body: { transactionId: 'tx-999', status: 'SUCCESS' },
      };
    });

    // First call
    const res1 = await manager.runWithIdempotency({
      key,
      tenantId,
      payload,
      execute,
    });

    expect(res1.statusCode).toBe(201);
    expect(res1.body).toEqual({ transactionId: 'tx-999', status: 'SUCCESS' });
    expect(executionCount).toBe(1);

    // Second call with identical payload
    const res2 = await manager.runWithIdempotency({
      key,
      tenantId,
      payload,
      execute,
    });

    expect(res2.statusCode).toBe(201);
    expect(res2.body).toEqual({ transactionId: 'tx-999', status: 'SUCCESS' });
    // execute function should not be called again!
    expect(executionCount).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('rejects duplicate key with modified payload (IdempotencyPayloadMismatchError)', async () => {
    const storage = new InMemoryIdempotencyStorage();
    const manager = new IdempotencyManager(storage);
    const key = 'idem-req-002';

    const originalPayload = { amount: '100.00', currency: 'USD' };
    const alteredPayload = { amount: '999.00', currency: 'USD' }; // Attacker tampering

    await manager.runWithIdempotency({
      key,
      tenantId,
      payload: originalPayload,
      execute: async () => ({ statusCode: 200, body: { ok: true } }),
    });

    // Replay with altered payload must fail
    await expect(
      manager.runWithIdempotency({
        key,
        tenantId,
        payload: alteredPayload,
        execute: async () => ({ statusCode: 200, body: { ok: true } }),
      })
    ).rejects.toThrow(IdempotencyPayloadMismatchError);
  });

  it('detects concurrent in-flight requests and rejects race with IdempotencyConcurrentConflictError', async () => {
    const storage = new InMemoryIdempotencyStorage();
    const manager = new IdempotencyManager(storage);
    const key = 'idem-req-003';
    const payload = { action: 'HEAVY_CALCULATION' };

    // Simulate an in-flight operation that takes time
    let resolveFirst: () => void = () => {};
    const firstExecutionPromise = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });

    const call1 = manager.runWithIdempotency({
      key,
      tenantId,
      payload,
      execute: async () => {
        await firstExecutionPromise;
        return { statusCode: 200, body: { done: true } };
      },
    });

    // Simultaneous call2 while call1 is PROCESSING
    const call2 = manager.runWithIdempotency({
      key,
      tenantId,
      payload,
      execute: async () => ({ statusCode: 200, body: { done: true } }),
    });

    // call2 must be rejected with concurrency conflict
    await expect(call2).rejects.toThrow(IdempotencyConcurrentConflictError);

    // Unblock call1
    resolveFirst();
    const res1 = await call1;
    expect(res1.statusCode).toBe(200);
  });

  it('guarantees single execution across 50 simulated concurrent attempts', async () => {
    const storage = new InMemoryIdempotencyStorage();
    const manager = new IdempotencyManager(storage);
    const key = 'idem-req-stress';
    const payload = { operation: 'STRESS_TEST' };

    let runCount = 0;
    const results = await Promise.allSettled(
      Array.from({ length: 50 }).map(() =>
        manager.runWithIdempotency({
          key,
          tenantId,
          payload,
          execute: async () => {
            runCount++;
            return { statusCode: 200, body: { success: true } };
          },
        })
      )
    );

    // Exactly one call should have successfully acquired and executed
    expect(runCount).toBe(1);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    // All rejected ones must be IdempotencyConcurrentConflictError
    for (const r of rejected) {
      if (r.status === 'rejected') {
        expect(r.reason).toBeInstanceOf(IdempotencyConcurrentConflictError);
      }
    }
  });
});
