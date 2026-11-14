import { randomUUID } from 'node:crypto';
import type { EventEnvelope, OutboxRecord } from '@vme/shared-types';

export interface OutboxStorage {
  getNextSequence(streamId: string): Promise<number>;
  saveEvent(record: OutboxRecord): Promise<void>;
  getPendingEvents(limit?: number): Promise<OutboxRecord[]>;
  markPublished(id: string): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
}

export class InMemoryOutboxStorage implements OutboxStorage {
  private sequences = new Map<string, number>();
  private records: OutboxRecord[] = [];

  async getNextSequence(streamId: string): Promise<number> {
    const current = this.sequences.get(streamId) ?? 0;
    const next = current + 1;
    this.sequences.set(streamId, next);
    return next;
  }

  async saveEvent(record: OutboxRecord): Promise<void> {
    this.records.push(JSON.parse(JSON.stringify(record)));
  }

  async getPendingEvents(limit = 100): Promise<OutboxRecord[]> {
    return this.records
      .filter((r) => r.status === 'PENDING')
      .slice(0, limit)
      .map((r) => JSON.parse(JSON.stringify(r)));
  }

  async markPublished(id: string): Promise<void> {
    const rec = this.records.find((r) => r.id === id);
    if (rec) {
      rec.status = 'PUBLISHED';
      rec.publishedAt = new Date().toISOString();
    }
  }

  async markFailed(id: string, error: string): Promise<void> {
    const rec = this.records.find((r) => r.id === id);
    if (rec) {
      rec.retryCount += 1;
      rec.lastError = error;
      if (rec.retryCount >= 5) {
        rec.status = 'DEAD_LETTER';
      } else {
        rec.status = 'FAILED';
      }
    }
  }
}

export interface PublishOutboxEventParams {
  streamId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  tenantId: string;
  correlationId?: string;
  causationId?: string;
  metadata?: Record<string, unknown>;
}

export class OutboxManager {
  constructor(private readonly storage: OutboxStorage) {}

  async stageEvent(params: PublishOutboxEventParams): Promise<EventEnvelope> {
    const sequenceNumber = await this.storage.getNextSequence(params.streamId);
    const eventId = randomUUID();
    const correlationId = params.correlationId ?? randomUUID();
    const occurredAt = new Date().toISOString();

    const event: EventEnvelope = {
      eventId,
      streamId: params.streamId,
      sequenceNumber,
      aggregateType: params.aggregateType,
      aggregateId: params.aggregateId,
      eventType: params.eventType,
      payload: params.payload,
      metadata: params.metadata ?? {},
      tenantId: params.tenantId,
      correlationId,
      causationId: params.causationId,
      occurredAt,
    };

    const outboxRecord: OutboxRecord = {
      id: randomUUID(),
      event,
      status: 'PENDING',
      retryCount: 0,
      createdAt: occurredAt,
    };

    await this.storage.saveEvent(outboxRecord);
    return event;
  }
}
