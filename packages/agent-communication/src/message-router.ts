import { randomUUID } from 'node:crypto';
import {
  type AgentMessageEnvelope,
  type CommunicationMessageType,
  type TaskPriority,
  type DeliveryStatus,
  type MessageAcknowledgment,
  type DepartmentId,
  validateMessagePayload,
  AgentMessageEnvelopeSchema,
  assertNoRawCredentials,
} from '@vme/shared-types';
import type { DepartmentRegistry } from '@vme/department-hierarchy';
import type { EmergencySupervisor } from '@vme/security-governance';
import type { EpisodicMemory } from '@vme/agent-memory';
import {
  PostgresMessageStorage,
  PostgresMessageStorageError,
} from './postgres-message-storage.js';

export type MessageRouterMode = 'PRODUCTION_POSTGRES' | 'TEST_IN_MEMORY';

export interface SendMessageParams {
  messageId?: string;
  senderAgentId: string;
  recipientAgentId: string;
  type: CommunicationMessageType;
  priority?: TaskPriority;
  taskId?: string;
  payload: Record<string, unknown>;
  requiresResponse?: boolean;
  correlationId?: string;
  causationId?: string;
  expiresAt?: string;
}

export interface MessageRouterOptions {
  mode?: MessageRouterMode;
  emergencySupervisor?: EmergencySupervisor;
  episodicMemory?: EpisodicMemory;
  postgresStorage?: PostgresMessageStorage;
}

export class MessageRoutingError extends Error {
  constructor(message: string) {
    super(`MESSAGE ROUTING ERROR: ${message}`);
    this.name = 'MessageRoutingError';
  }
}

export class MessageRouter {
  public readonly mode: MessageRouterMode;
  private inboxes = new Map<string, AgentMessageEnvelope[]>(); // agentId -> messages
  private deadLetterQueue: AgentMessageEnvelope[] = [];
  private processedMessageIds = new Set<string>();
  private messageStatuses = new Map<string, DeliveryStatus>();
  private acknowledgedMessages = new Map<string, MessageAcknowledgment>();

  private readonly emergencySupervisor?: EmergencySupervisor;
  private readonly episodicMemory?: EpisodicMemory;
  public readonly postgresStorage?: PostgresMessageStorage;

  constructor(
    private readonly hierarchy: DepartmentRegistry,
    options?: MessageRouterOptions
  ) {
    this.mode = options?.mode ?? (options?.postgresStorage ? 'PRODUCTION_POSTGRES' : 'TEST_IN_MEMORY');
    if (this.mode === 'PRODUCTION_POSTGRES' && !options?.postgresStorage) {
      throw new PostgresMessageStorageError(
        'Production message router initialization failed: PostgresMessageStorage is required. In-memory fallback is disabled in production.'
      );
    }
    this.postgresStorage = options?.postgresStorage;
    this.emergencySupervisor = options?.emergencySupervisor;
    this.episodicMemory = options?.episodicMemory;
  }

  async dispatch(params: SendMessageParams): Promise<AgentMessageEnvelope> {
    // 1. Emergency Halt Invariant
    if (this.emergencySupervisor) {
      this.emergencySupervisor.assertOperational();
    }

    // 2. Strict Credential Defense
    const credCheck = assertNoRawCredentials(params.payload, 'communication_payload');
    if (!credCheck.valid) {
      throw new MessageRoutingError(`Credential defense violation: ${credCheck.errors.join('; ')}`);
    }

    // 3. Typed Payload Schema Validation
    const payloadValidation = validateMessagePayload(params.type, params.payload);
    if (!payloadValidation.valid) {
      throw new MessageRoutingError(`Payload validation failed: ${payloadValidation.error}`);
    }

    // 4. Sender and Recipient Verification (Native AgentRecord)
    const sender = this.hierarchy.getAgentRecord(params.senderAgentId);
    const recipient = this.hierarchy.getAgentRecord(params.recipientAgentId);

    if (!sender) {
      throw new MessageRoutingError(`Sender agent not found: ${params.senderAgentId}`);
    }
    if (!recipient) {
      throw new MessageRoutingError(`Recipient agent not found: ${params.recipientAgentId}`);
    }

    // 5. Hierarchical Routing & Communication Boundaries
    this.validateHierarchyPolicy(sender, recipient, params.type);

    // 6. Idempotency Check
    const messageId = params.messageId ?? randomUUID();
    if (this.processedMessageIds.has(messageId)) {
      const existing = (this.inboxes.get(recipient.id) ?? []).find((m) => m.messageId === messageId);
      if (existing) return existing;
    }
    this.processedMessageIds.add(messageId);

    // 7. Envelope Construction
    const envelope: AgentMessageEnvelope = {
      messageId,
      senderAgentId: sender.id,
      senderAgentCode: sender.agentCode,
      senderDepartmentId: sender.departmentId,
      recipientAgentId: recipient.id,
      recipientAgentCode: recipient.agentCode,
      recipientDepartmentId: recipient.departmentId,
      type: params.type,
      priority: params.priority ?? 'MEDIUM',
      taskId: params.taskId,
      payload: params.payload,
      correlationId: params.correlationId ?? randomUUID(),
      causationId: params.causationId,
      sentAt: new Date().toISOString(),
      expiresAt: params.expiresAt,
      deliveryStatus: 'PENDING',
      requiresResponse: params.requiresResponse ?? false,
    };

    if (envelope.expiresAt && new Date(envelope.expiresAt).getTime() < Date.now()) {
      envelope.deliveryStatus = 'EXPIRED';
      const parsedExpired = AgentMessageEnvelopeSchema.parse(envelope);
      this.deadLetterQueue.push(parsedExpired);
      this.messageStatuses.set(envelope.messageId, 'EXPIRED');
      if (this.postgresStorage) {
        await this.postgresStorage.persistEnvelope(parsedExpired);
        await this.postgresStorage.routeToDeadLetter(parsedExpired, 'Message expired prior to delivery', 0);
      }
      return parsedExpired;
    }

    envelope.deliveryStatus = 'DELIVERED';
    const parsedEnvelope = AgentMessageEnvelopeSchema.parse(envelope);

    let recipientInbox = this.inboxes.get(recipient.id);
    if (!recipientInbox) {
      recipientInbox = [];
      this.inboxes.set(recipient.id, recipientInbox);
    }
    recipientInbox.push(parsedEnvelope);
    this.messageStatuses.set(envelope.messageId, 'DELIVERED');

    if (this.postgresStorage) {
      await this.postgresStorage.persistEnvelope(parsedEnvelope);
    }

    // 9. Episodic Memory Integration (Audit Trail)
    if (this.episodicMemory) {
      try {
        await this.episodicMemory.recordExecution({
          id: randomUUID(),
          agentId: sender.id,
          agentCode: sender.agentCode,
          departmentId: sender.departmentId,
          taskId: params.taskId ?? randomUUID(),
          actionType: `DISPATCH_${params.type}`,
          inputSummary: `Sent ${params.type} to ${recipient.agentCode}`,
          decisionRationale: `Routing through organizational hierarchy (${sender.departmentId} -> ${recipient.departmentId})`,
          outcome: `Delivered message ${envelope.messageId}`,
          status: 'SUCCESS',
          scope: 'DEPARTMENT_SCOPED',
          importanceScore: params.priority === 'CRITICAL' ? 8 : 5,
          metadata: {
            messageId: envelope.messageId,
            correlationId: envelope.correlationId,
          },
          recordedAt: new Date().toISOString(),
        });
      } catch {
        // Logging failure should not break messaging flow
      }
    }

    return parsedEnvelope;
  }

  /**
   * Enforces corporate hierarchy rules for delegations, escalations, and cross-department comms.
   */
  private validateHierarchyPolicy(
    sender: { id: string; level: string; departmentId: DepartmentId },
    recipient: { id: string; level: string; departmentId: DepartmentId },
    type: CommunicationMessageType
  ): void {
    // A. Downward Delegation Check
    if (type === 'TASK_DELEGATION' || type === 'TASK_ASSIGNMENT' || type === 'DELEGATION_REQUEST') {
      const delegationCheck = this.hierarchy.validateDelegation(sender.id, recipient.id);
      if (!delegationCheck.allowed) {
        throw new MessageRoutingError(`Corporate delegation rejected: ${delegationCheck.reason}`);
      }
      return;
    }

    // B. Upward Escalation Check
    if (type === 'ESCALATION' || type === 'FAILURE_REPORT') {
      if (sender.level === 'EXECUTIVE' && recipient.level === 'SPECIALIST') {
        throw new MessageRoutingError(`Escalations cannot flow downward from Executive to Specialist.`);
      }
      return;
    }

    // C. Cross-Department Lateral Communication Boundaries
    if (sender.departmentId !== recipient.departmentId) {
      const isSenderExecutive = sender.level === 'EXECUTIVE';
      const isRecipientExecutive = recipient.level === 'EXECUTIVE';
      const isSenderDirector = sender.level === 'DIRECTOR';
      const isRecipientDirector = recipient.level === 'DIRECTOR';
      const isSecurityGovernance = sender.departmentId === 'security_governance';

      if (
        !isSenderExecutive &&
        !isRecipientExecutive &&
        !isSecurityGovernance &&
        !(isSenderDirector && isRecipientDirector)
      ) {
        throw new MessageRoutingError(
          `Cross-department communication from '${sender.departmentId}' to '${recipient.departmentId}' is restricted. Direct lateral communication between non-director specialists in different departments requires Director gating or Executive coordination.`
        );
      }
    }
  }

  acknowledgeMessage(
    messageId: string,
    recipientAgentId: string,
    status: 'ACCEPTED' | 'REJECTED' | 'QUEUED',
    rejectionReason?: string
  ): MessageAcknowledgment {
    const ack: MessageAcknowledgment = {
      acknowledgmentId: randomUUID(),
      messageId,
      recipientAgentId,
      receivedAt: new Date().toISOString(),
      status,
      rejectionReason,
    };

    this.acknowledgedMessages.set(messageId, ack);

    if (status === 'ACCEPTED') {
      this.messageStatuses.set(messageId, 'ACKNOWLEDGED');
    } else if (status === 'REJECTED') {
      this.messageStatuses.set(messageId, 'FAILED');
      const inbox = this.inboxes.get(recipientAgentId);
      if (inbox) {
        const idx = inbox.findIndex((m) => m.messageId === messageId);
        if (idx !== -1) {
          const [msg] = inbox.splice(idx, 1);
          if (msg) {
            msg.deliveryStatus = 'FAILED';
            this.deadLetterQueue.push(msg);
          }
        }
      }
    }

    if (this.postgresStorage) {
      this.postgresStorage.recordAcknowledgment(ack).catch(() => {});
      if (status === 'REJECTED') {
        const existingEnvelope =
          this.deadLetterQueue.find((m) => m.messageId === messageId) ??
          Array.from(this.inboxes.values()).flat().find((m) => m.messageId === messageId);

        if (existingEnvelope) {
          this.postgresStorage
            .routeToDeadLetter(existingEnvelope, rejectionReason ?? 'Message rejected by recipient', 0)
            .catch(() => {});
        } else {
          this.postgresStorage.getEnvelopeById(messageId).then((env) => {
            if (env) {
              this.postgresStorage?.routeToDeadLetter(env, rejectionReason ?? 'Message rejected by recipient', 0).catch(() => {});
            }
          }).catch(() => {});
        }
      }
    }

    return ack;
  }

  async acknowledgeMessageAsync(
    messageId: string,
    recipientAgentId: string,
    status: 'ACCEPTED' | 'REJECTED' | 'QUEUED',
    rejectionReason?: string
  ): Promise<MessageAcknowledgment> {
    const ack = this.acknowledgeMessage(messageId, recipientAgentId, status, rejectionReason);
    if (this.postgresStorage) {
      await this.postgresStorage.recordAcknowledgment(ack);
    }
    return ack;
  }

  async recoverPendingMessages(): Promise<AgentMessageEnvelope[]> {
    if (!this.postgresStorage) {
      return [];
    }
    const recovered = await this.postgresStorage.recoverPendingMessages();
    for (const msg of recovered) {
      let inbox = this.inboxes.get(msg.recipientAgentId);
      if (!inbox) {
        inbox = [];
        this.inboxes.set(msg.recipientAgentId, inbox);
      }
      if (!inbox.some((m) => m.messageId === msg.messageId)) {
        inbox.push(msg);
      }
      this.messageStatuses.set(msg.messageId, msg.deliveryStatus ?? 'PENDING');
    }
    return recovered;
  }

  async retryDeadLetterWithBackoff(
    messageId: string,
    baseIntervalMs: number = 1000,
    maxRetries: number = 3
  ): Promise<{ retried: boolean; nextRetryAt?: string; envelope?: AgentMessageEnvelope }> {
    if (this.postgresStorage) {
      const schedule = await this.postgresStorage.calculateBackoffAndScheduleRetry(
        messageId,
        0,
        baseIntervalMs,
        maxRetries
      );
      if (schedule.shouldRetry) {
        const msg = await this.retryDeadLetter(messageId);
        return { retried: true, nextRetryAt: schedule.nextRetryAt, envelope: msg };
      }
      return { retried: false };
    }

    const msg = await this.retryDeadLetter(messageId);
    return { retried: !!msg, envelope: msg };
  }

  getInbox(agentId: string): AgentMessageEnvelope[] {
    return this.inboxes.get(agentId) ?? [];
  }

  async getInboxAsync(agentId: string): Promise<AgentMessageEnvelope[]> {
    if (this.postgresStorage) {
      const messages = await this.postgresStorage.getInbox(agentId);
      this.inboxes.set(agentId, messages);
      for (const m of messages) {
        if (m.deliveryStatus) {
          this.messageStatuses.set(m.messageId, m.deliveryStatus);
        }
      }
      return messages;
    }
    return this.getInbox(agentId);
  }

  getMessageStatus(messageId: string): DeliveryStatus | undefined {
    return this.messageStatuses.get(messageId);
  }

  async getMessageStatusAsync(messageId: string): Promise<DeliveryStatus | undefined> {
    const cached = this.getMessageStatus(messageId);
    if (cached) return cached;
    if (this.postgresStorage) {
      const env = await this.postgresStorage.getEnvelopeById(messageId);
      if (env) {
        if (env.deliveryStatus) {
          this.messageStatuses.set(messageId, env.deliveryStatus);
        }
        return env.deliveryStatus;
      }
    }
    return undefined;
  }

  getAcknowledgment(messageId: string): MessageAcknowledgment | undefined {
    return this.acknowledgedMessages.get(messageId);
  }

  async getAcknowledgmentAsync(messageId: string): Promise<MessageAcknowledgment | undefined> {
    const cached = this.getAcknowledgment(messageId);
    if (cached) return cached;
    if (this.postgresStorage) {
      const ack = await this.postgresStorage.getAcknowledgment(messageId);
      if (ack) {
        this.acknowledgedMessages.set(messageId, ack);
        return ack;
      }
    }
    return undefined;
  }

  getDeadLetterQueue(): AgentMessageEnvelope[] {
    return [...this.deadLetterQueue];
  }

  async getDeadLetterQueueAsync(): Promise<any[]> {
    if (this.postgresStorage) {
      return await this.postgresStorage.getDeadLetters();
    }
    return this.getDeadLetterQueue();
  }

  retryDeadLetter(messageId: string): Promise<AgentMessageEnvelope | undefined> {
    const idx = this.deadLetterQueue.findIndex((m) => m.messageId === messageId);
    if (idx === -1) return Promise.resolve(undefined);

    const [msg] = this.deadLetterQueue.splice(idx, 1);
    if (!msg) return Promise.resolve(undefined);

    return this.dispatch({
      messageId: msg.messageId,
      senderAgentId: msg.senderAgentId,
      recipientAgentId: msg.recipientAgentId,
      type: msg.type,
      priority: msg.priority,
      taskId: msg.taskId,
      payload: msg.payload,
      requiresResponse: msg.requiresResponse,
      correlationId: msg.correlationId,
      causationId: msg.causationId,
    });
  }

  clearInbox(agentId: string): void {
    this.inboxes.delete(agentId);
  }
}
