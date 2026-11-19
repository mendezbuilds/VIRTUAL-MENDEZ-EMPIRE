import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import {
  type AgentMessageEnvelope,
  type MessageAcknowledgment,
  type DeliveryStatus,
  AgentMessageEnvelopeSchema,
} from '@vme/shared-types';

export interface MessageStorageContext {
  tenantId: string;
}

export class PostgresMessageStorageError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(`POSTGRES MESSAGE STORAGE ERROR: ${message}`);
    this.name = 'PostgresMessageStorageError';
  }
}

export class PostgresMessageStorage {
  constructor(
    private readonly pool: Pool,
    private readonly context: MessageStorageContext
  ) {}

  async persistEnvelope(envelope: AgentMessageEnvelope): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO agent_communication_envelopes (
          message_id, tenant_id, sender_agent_id, sender_agent_code, sender_department_id,
          recipient_agent_id, recipient_agent_code, recipient_department_id, type, priority,
          task_id, payload, correlation_id, causation_id, delivery_status, retry_count,
          expires_at, requires_response, sent_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
        ON CONFLICT (message_id) DO UPDATE SET
          delivery_status = EXCLUDED.delivery_status,
          updated_at = clock_timestamp()`,
        [
          envelope.messageId,
          this.context.tenantId,
          envelope.senderAgentId,
          envelope.senderAgentCode,
          envelope.senderDepartmentId,
          envelope.recipientAgentId,
          envelope.recipientAgentCode,
          envelope.recipientDepartmentId,
          envelope.type,
          envelope.priority,
          envelope.taskId ?? null,
          JSON.stringify(envelope.payload),
          envelope.correlationId,
          envelope.causationId ?? null,
          envelope.deliveryStatus,
          0,
          envelope.expiresAt ?? null,
          envelope.requiresResponse,
          envelope.sentAt,
        ]
      );
    } catch (err: unknown) {
      throw new PostgresMessageStorageError(
        `Failed to persist message envelope ${envelope.messageId}: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    } finally {
      client.release();
    }
  }

  async updateDeliveryStatus(
    messageId: string,
    status: DeliveryStatus,
    nextRetryAt?: string
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `UPDATE agent_communication_envelopes
         SET delivery_status = $1,
             next_retry_at = $2,
             updated_at = clock_timestamp()
         WHERE message_id = $3 AND tenant_id = $4`,
        [status, nextRetryAt ?? null, messageId, this.context.tenantId]
      );
    } catch (err: unknown) {
      throw new PostgresMessageStorageError(
        `Failed to update delivery status for message ${messageId}: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    } finally {
      client.release();
    }
  }

  async recordAcknowledgment(ack: MessageAcknowledgment): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `INSERT INTO message_delivery_acknowledgments (
          acknowledgment_id, message_id, recipient_agent_id, status, rejection_reason, received_at
        ) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (acknowledgment_id) DO NOTHING`,
        [
          ack.acknowledgmentId,
          ack.messageId,
          ack.recipientAgentId,
          ack.status,
          ack.rejectionReason ?? null,
          ack.receivedAt,
        ]
      );

      const newDeliveryStatus: DeliveryStatus =
        ack.status === 'ACCEPTED' ? 'ACKNOWLEDGED' : 'FAILED';

      await client.query(
        `UPDATE agent_communication_envelopes
         SET delivery_status = $1,
             acknowledged_at = $2,
             updated_at = clock_timestamp()
         WHERE message_id = $3 AND tenant_id = $4`,
        [newDeliveryStatus, ack.receivedAt, ack.messageId, this.context.tenantId]
      );

      await client.query('COMMIT');
    } catch (err: unknown) {
      await client.query('ROLLBACK');
      throw new PostgresMessageStorageError(
        `Failed to record acknowledgment for message ${ack.messageId}: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    } finally {
      client.release();
    }
  }

  async routeToDeadLetter(
    message: AgentMessageEnvelope,
    failureReason: string,
    retryAttempts: number
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `INSERT INTO message_dead_letter_queue (
          id, message_id, tenant_id, sender_agent_id, recipient_agent_id, type, payload, failure_reason, retry_attempts, failed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, clock_timestamp())`,
        [
          randomUUID(),
          message.messageId,
          this.context.tenantId,
          message.senderAgentId,
          message.recipientAgentId,
          message.type,
          JSON.stringify(message.payload),
          failureReason,
          retryAttempts,
        ]
      );

      await client.query(
        `UPDATE agent_communication_envelopes
         SET delivery_status = 'FAILED',
             updated_at = clock_timestamp()
         WHERE message_id = $1 AND tenant_id = $2`,
        [message.messageId, this.context.tenantId]
      );

      await client.query('COMMIT');
    } catch (err: unknown) {
      await client.query('ROLLBACK');
      throw new PostgresMessageStorageError(
        `Failed to route message ${message.messageId} to DLQ: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    } finally {
      client.release();
    }
  }

  async getInbox(recipientAgentId: string): Promise<AgentMessageEnvelope[]> {
    const client = await this.pool.connect();
    try {
      const res = await client.query(
        `SELECT message_id as "messageId", sender_agent_id as "senderAgentId", sender_agent_code as "senderAgentCode",
                sender_department_id as "senderDepartmentId", recipient_agent_id as "recipientAgentId",
                recipient_agent_code as "recipientAgentCode", recipient_department_id as "recipientDepartmentId",
                type, priority, task_id as "taskId", payload, correlation_id as "correlationId",
                causation_id as "causationId", sent_at as "sentAt", expires_at as "expiresAt",
                delivery_status as "deliveryStatus", requires_response as "requiresResponse"
         FROM agent_communication_envelopes
         WHERE recipient_agent_id = $1 AND tenant_id = $2 AND delivery_status IN ('PENDING', 'DELIVERED')
         ORDER BY sent_at ASC`,
        [recipientAgentId, this.context.tenantId]
      );

      return res.rows.map((row) => this.mapRowToEnvelope(row));
    } catch (err: unknown) {
      throw new PostgresMessageStorageError(
        `Failed to get inbox for agent ${recipientAgentId}: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    } finally {
      client.release();
    }
  }

  async recoverPendingMessages(): Promise<AgentMessageEnvelope[]> {
    const client = await this.pool.connect();
    try {
      const res = await client.query(
        `SELECT message_id as "messageId", sender_agent_id as "senderAgentId", sender_agent_code as "senderAgentCode",
                sender_department_id as "senderDepartmentId", recipient_agent_id as "recipientAgentId",
                recipient_agent_code as "recipientAgentCode", recipient_department_id as "recipientDepartmentId",
                type, priority, task_id as "taskId", payload, correlation_id as "correlationId",
                causation_id as "causationId", sent_at as "sentAt", expires_at as "expiresAt",
                delivery_status as "deliveryStatus", requires_response as "requiresResponse"
         FROM agent_communication_envelopes
         WHERE tenant_id = $1 AND delivery_status = 'PENDING'
           AND (expires_at IS NULL OR expires_at > clock_timestamp())
           AND (next_retry_at IS NULL OR next_retry_at <= clock_timestamp())
         ORDER BY sent_at ASC`,
        [this.context.tenantId]
      );

      return res.rows.map((row) => this.mapRowToEnvelope(row));
    } catch (err: unknown) {
      throw new PostgresMessageStorageError(
        `Failed to recover pending messages: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    } finally {
      client.release();
    }
  }

  async calculateBackoffAndScheduleRetry(
    messageId: string,
    currentRetryCount: number,
    baseIntervalMs: number = 1000,
    maxRetries: number = 3
  ): Promise<{ shouldRetry: boolean; nextRetryAt?: string; retryCount: number }> {
    const client = await this.pool.connect();
    try {
      if (currentRetryCount >= maxRetries) {
        return { shouldRetry: false, retryCount: currentRetryCount };
      }

      const nextRetryCount = currentRetryCount + 1;
      const delayMs = baseIntervalMs * Math.pow(2, currentRetryCount);
      const nextRetryAt = new Date(Date.now() + delayMs).toISOString();

      await client.query(
        `UPDATE agent_communication_envelopes
         SET retry_count = $1,
             next_retry_at = $2,
             delivery_status = 'PENDING',
             updated_at = clock_timestamp()
         WHERE message_id = $3 AND tenant_id = $4`,
        [nextRetryCount, nextRetryAt, messageId, this.context.tenantId]
      );

      return { shouldRetry: true, nextRetryAt, retryCount: nextRetryCount };
    } catch (err: unknown) {
      throw new PostgresMessageStorageError(
        `Failed to schedule retry for message ${messageId}: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    } finally {
      client.release();
    }
  }

  private mapRowToEnvelope(row: any): AgentMessageEnvelope {
    return AgentMessageEnvelopeSchema.parse({
      ...row,
      causationId: row.causationId ?? undefined,
      taskId: row.taskId ?? undefined,
      payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload ?? {}),
      sentAt: row.sentAt instanceof Date ? row.sentAt.toISOString() : String(row.sentAt),
      expiresAt: row.expiresAt instanceof Date ? row.expiresAt.toISOString() : (row.expiresAt ? String(row.expiresAt) : undefined),
    });
  }
}
