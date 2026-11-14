export interface CachedResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
}

export type IdempotencyRecordStatus = 'PROCESSING' | 'COMPLETED' | 'FAILED';

export interface IdempotencyRecord {
  key: string;
  tenantId: string;
  payloadHash: string;
  status: IdempotencyRecordStatus;
  response?: CachedResponse;
  errorMessage?: string;
  createdAt: number;
  expiresAt: number;
}

export interface IdempotencyStorage {
  reserveLock(
    key: string,
    tenantId: string,
    payloadHash: string,
    ttlMs: number
  ): Promise<{
    success: boolean;
    existing?: IdempotencyRecord;
  }>;

  complete(
    key: string,
    tenantId: string,
    response: CachedResponse
  ): Promise<void>;

  fail(
    key: string,
    tenantId: string,
    errorMessage: string
  ): Promise<void>;

  get(key: string, tenantId: string): Promise<IdempotencyRecord | null>;
}

export class InMemoryIdempotencyStorage implements IdempotencyStorage {
  private records = new Map<string, IdempotencyRecord>();
  // Synchronous lock mutex to simulate database atomic row locks
  private mutex = new Map<string, Promise<void>>();

  private getCompositeKey(tenantId: string, key: string): string {
    return `${tenantId}:${key}`;
  }

  async reserveLock(
    key: string,
    tenantId: string,
    payloadHash: string,
    ttlMs: number
  ): Promise<{ success: boolean; existing?: IdempotencyRecord }> {
    const compositeKey = this.getCompositeKey(tenantId, key);
    const now = Date.now();

    const existing = this.records.get(compositeKey);
    if (existing && existing.expiresAt > now) {
      return { success: false, existing };
    }

    // Atomically insert PROCESSING
    const record: IdempotencyRecord = {
      key,
      tenantId,
      payloadHash,
      status: 'PROCESSING',
      createdAt: now,
      expiresAt: now + ttlMs,
    };

    this.records.set(compositeKey, record);
    return { success: true };
  }

  async complete(key: string, tenantId: string, response: CachedResponse): Promise<void> {
    const compositeKey = this.getCompositeKey(tenantId, key);
    const existing = this.records.get(compositeKey);
    if (existing) {
      existing.status = 'COMPLETED';
      existing.response = response;
    }
  }

  async fail(key: string, tenantId: string, errorMessage: string): Promise<void> {
    const compositeKey = this.getCompositeKey(tenantId, key);
    const existing = this.records.get(compositeKey);
    if (existing) {
      existing.status = 'FAILED';
      existing.errorMessage = errorMessage;
    }
  }

  async get(key: string, tenantId: string): Promise<IdempotencyRecord | null> {
    const compositeKey = this.getCompositeKey(tenantId, key);
    const record = this.records.get(compositeKey);
    if (!record) return null;
    if (record.expiresAt <= Date.now()) {
      this.records.delete(compositeKey);
      return null;
    }
    return record;
  }
}

