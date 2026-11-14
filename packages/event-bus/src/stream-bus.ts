import type { EventEnvelope } from '@vme/shared-types';
import type { OutboxStorage } from './outbox.js';

export type EventHandler = (event: EventEnvelope) => Promise<void>;

export interface StreamSubscription {
  streamId: string;
  groupId: string;
  consumerId: string;
  handler: EventHandler;
}

export class StreamBus {
  private eventsByStream = new Map<string, EventEnvelope[]>();
  private consumerOffsets = new Map<string, number>(); // groupId:streamId -> lastSequenceNumber
  private activeSubscriptions: StreamSubscription[] = [];

  constructor(private readonly outboxStorage?: OutboxStorage) {}

  /**
   * Publishes an event to the persistent stream and dispatches to active consumer groups.
   */
  async publish(event: EventEnvelope): Promise<void> {
    const stream = this.eventsByStream.get(event.streamId) ?? [];
    stream.push(event);
    this.eventsByStream.set(event.streamId, stream);

    // Dispatch to matching active subscriptions
    for (const sub of this.activeSubscriptions) {
      if (sub.streamId === event.streamId || sub.streamId === '*') {
        const offsetKey = `${sub.groupId}:${event.streamId}`;
        const lastOffset = this.consumerOffsets.get(offsetKey) ?? 0;

        // In-order delivery
        if (event.sequenceNumber === lastOffset + 1) {
          await sub.handler(event);
          this.consumerOffsets.set(offsetKey, event.sequenceNumber);
        }
      }
    }
  }

  /**
   * Subscribes a consumer group to a stream. Replays any unacknowledged / missed events.
   */
  async subscribe(sub: StreamSubscription): Promise<{ replayedCount: number }> {
    this.activeSubscriptions.push(sub);
    const offsetKey = `${sub.groupId}:${sub.streamId}`;
    const lastOffset = this.consumerOffsets.get(offsetKey) ?? 0;

    // Check for missed messages in stream
    const streamEvents = this.eventsByStream.get(sub.streamId) ?? [];
    const missedEvents = streamEvents.filter((e) => e.sequenceNumber > lastOffset);

    // Replay in strict sequence order
    missedEvents.sort((a, b) => a.sequenceNumber - b.sequenceNumber);
    for (const ev of missedEvents) {
      await sub.handler(ev);
      this.consumerOffsets.set(offsetKey, ev.sequenceNumber);
    }

    return { replayedCount: missedEvents.length };
  }

  /**
   * Simulates a consumer disconnecting/crashing.
   */
  unsubscribe(consumerId: string): void {
    this.activeSubscriptions = this.activeSubscriptions.filter(
      (s) => s.consumerId !== consumerId
    );
  }

  getStreamEvents(streamId: string): EventEnvelope[] {
    return this.eventsByStream.get(streamId) ?? [];
  }

  getConsumerOffset(groupId: string, streamId: string): number {
    return this.consumerOffsets.get(`${groupId}:${streamId}`) ?? 0;
  }
}
