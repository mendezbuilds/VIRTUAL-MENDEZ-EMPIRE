import { z } from 'zod';

export const EventEnvelopeSchema = z.object({
  eventId: z.string().uuid(),
  streamId: z.string().min(1).max(128),
  sequenceNumber: z.number().int().nonnegative(),
  aggregateType: z.string().min(1).max(64),
  aggregateId: z.string().min(1).max(128),
  eventType: z.string().min(1).max(128),
  payload: z.record(z.unknown()),
  metadata: z.record(z.unknown()).default({}),
  tenantId: z.string().uuid(),
  correlationId: z.string().uuid(),
  causationId: z.string().uuid().optional(),
  occurredAt: z.string().datetime(),
});

export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

export const OutboxStatusSchema = z.enum(['PENDING', 'PUBLISHED', 'FAILED', 'DEAD_LETTER']);
export type OutboxStatus = z.infer<typeof OutboxStatusSchema>;

export const OutboxRecordSchema = z.object({
  id: z.string().uuid(),
  event: EventEnvelopeSchema,
  status: OutboxStatusSchema,
  retryCount: z.number().int().nonnegative().default(0),
  lastError: z.string().optional(),
  createdAt: z.string().datetime(),
  publishedAt: z.string().datetime().optional(),
});

export type OutboxRecord = z.infer<typeof OutboxRecordSchema>;
