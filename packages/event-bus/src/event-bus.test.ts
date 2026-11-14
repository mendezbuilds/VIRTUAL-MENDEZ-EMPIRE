import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  OutboxManager,
  InMemoryOutboxStorage,
  StreamBus,
  type EventEnvelope,
} from './index.js';

describe('@vme/event-bus Reliable Event Sequencing & Replay Engine', () => {
  const tenantId = randomUUID();
  const streamId = 'dept:financial_intelligence:events';

  it('stages outbox events with strictly increasing monotonic sequence numbers', async () => {
    const storage = new InMemoryOutboxStorage();
    const manager = new OutboxManager(storage);

    const ev1 = await manager.stageEvent({
      streamId,
      aggregateType: 'JournalEntry',
      aggregateId: 'je-1',
      eventType: 'JOURNAL_POSTED',
      payload: { amount: '1000' },
      tenantId,
    });

    const ev2 = await manager.stageEvent({
      streamId,
      aggregateType: 'JournalEntry',
      aggregateId: 'je-2',
      eventType: 'JOURNAL_POSTED',
      payload: { amount: '2000' },
      tenantId,
    });

    const ev3 = await manager.stageEvent({
      streamId,
      aggregateType: 'JournalEntry',
      aggregateId: 'je-3',
      eventType: 'JOURNAL_POSTED',
      payload: { amount: '3000' },
      tenantId,
    });

    expect(ev1.sequenceNumber).toBe(1);
    expect(ev2.sequenceNumber).toBe(2);
    expect(ev3.sequenceNumber).toBe(3);

    const pending = await storage.getPendingEvents();
    expect(pending).toHaveLength(3);
    expect(pending[0]?.event.sequenceNumber).toBe(1);
  });

  it('guarantees disconnect-replay: replays missed events upon subscriber reconnection', async () => {
    const bus = new StreamBus();
    const receivedEvents: EventEnvelope[] = [];

    const handler = vi.fn(async (event: EventEnvelope) => {
      receivedEvents.push(event);
    });

    // 1. Initial subscription
    await bus.subscribe({
      streamId,
      groupId: 'audit-service',
      consumerId: 'worker-1',
      handler,
    });

    // 2. Publish event 1 & 2 while connected
    await bus.publish({
      eventId: randomUUID(),
      streamId,
      sequenceNumber: 1,
      aggregateType: 'Order',
      aggregateId: 'ord-1',
      eventType: 'ORDER_CREATED',
      payload: { symbol: 'EUR/USD' },
      metadata: {},
      tenantId,
      correlationId: randomUUID(),
      occurredAt: new Date().toISOString(),
    });

    await bus.publish({
      eventId: randomUUID(),
      streamId,
      sequenceNumber: 2,
      aggregateType: 'Order',
      aggregateId: 'ord-2',
      eventType: 'ORDER_CREATED',
      payload: { symbol: 'GBP/USD' },
      metadata: {},
      tenantId,
      correlationId: randomUUID(),
      occurredAt: new Date().toISOString(),
    });

    expect(receivedEvents).toHaveLength(2);
    expect(bus.getConsumerOffset('audit-service', streamId)).toBe(2);

    // 3. Worker crashes / disconnects
    bus.unsubscribe('worker-1');

    // 4. Events 3, 4, 5 are published while consumer is offline
    await bus.publish({
      eventId: randomUUID(),
      streamId,
      sequenceNumber: 3,
      aggregateType: 'Order',
      aggregateId: 'ord-3',
      eventType: 'ORDER_CREATED',
      payload: { symbol: 'BTC/USD' },
      metadata: {},
      tenantId,
      correlationId: randomUUID(),
      occurredAt: new Date().toISOString(),
    });

    await bus.publish({
      eventId: randomUUID(),
      streamId,
      sequenceNumber: 4,
      aggregateType: 'Order',
      aggregateId: 'ord-4',
      eventType: 'ORDER_CREATED',
      payload: { symbol: 'ETH/USD' },
      metadata: {},
      tenantId,
      correlationId: randomUUID(),
      occurredAt: new Date().toISOString(),
    });

    await bus.publish({
      eventId: randomUUID(),
      streamId,
      sequenceNumber: 5,
      aggregateType: 'Order',
      aggregateId: 'ord-5',
      eventType: 'ORDER_CREATED',
      payload: { symbol: 'SOL/USD' },
      metadata: {},
      tenantId,
      correlationId: randomUUID(),
      occurredAt: new Date().toISOString(),
    });

    // Worker was offline, so receivedEvents is still 2
    expect(receivedEvents).toHaveLength(2);

    // 5. Worker restarts / reconnects under the same consumer group
    const { replayedCount } = await bus.subscribe({
      streamId,
      groupId: 'audit-service',
      consumerId: 'worker-2-recovered',
      handler,
    });

    // 6. Verify all 3 missed events were accurately replayed in sequence
    expect(replayedCount).toBe(3);
    expect(receivedEvents).toHaveLength(5);
    expect(receivedEvents.map((e) => e.sequenceNumber)).toEqual([1, 2, 3, 4, 5]);
    expect(bus.getConsumerOffset('audit-service', streamId)).toBe(5);
  });
});

