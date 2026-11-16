import { randomUUID } from 'node:crypto';
import type { AgentMessageEnvelope, AgentMessageType, DepartmentId, TaskPriority } from '@vme/shared-types';
import type { DepartmentRegistry } from '@vme/department-hierarchy';

export interface SendMessageParams {
  senderAgentId: string;
  recipientAgentId: string;
  type: AgentMessageType;
  priority?: TaskPriority;
  taskId?: string;
  payload: Record<string, unknown>;
  requiresResponse?: boolean;
  correlationId?: string;
}

export class MessageRouter {
  private inboxes = new Map<string, AgentMessageEnvelope[]>(); // agentId -> messages

  constructor(private readonly hierarchy: DepartmentRegistry) {}

  async dispatch(params: SendMessageParams): Promise<AgentMessageEnvelope> {
    const sender = this.hierarchy.getAgent(params.senderAgentId);
    const recipient = this.hierarchy.getAgent(params.recipientAgentId);

    if (!sender) {
      throw new Error(`Sender agent not found: ${params.senderAgentId}`);
    }
    if (!recipient) {
      throw new Error(`Recipient agent not found: ${params.recipientAgentId}`);
    }

    // Enforce corporate hierarchy rules for delegations
    if (params.type === 'TASK_DELEGATION') {
      const validation = this.hierarchy.validateDelegation(sender.id, recipient.id);
      if (!validation.allowed) {
        throw new Error(`Corporate delegation rejected: ${validation.reason}`);
      }
    }

    const envelope: AgentMessageEnvelope = {
      messageId: randomUUID(),
      senderAgentId: sender.id,
      recipientAgentId: recipient.id,
      senderDepartmentId: sender.departmentId,
      recipientDepartmentId: recipient.departmentId,
      type: params.type,
      priority: params.priority ?? 'MEDIUM',
      taskId: params.taskId,
      payload: params.payload,
      requiresResponse: params.requiresResponse ?? false,
      correlationId: params.correlationId ?? randomUUID(),
      sentAt: new Date().toISOString(),
    };

    let recipientInbox = this.inboxes.get(recipient.id);
    if (!recipientInbox) {
      recipientInbox = [];
      this.inboxes.set(recipient.id, recipientInbox);
    }
    recipientInbox.push(envelope);

    return envelope;
  }

  getInbox(agentId: string): AgentMessageEnvelope[] {
    return this.inboxes.get(agentId) ?? [];
  }

  clearInbox(agentId: string): void {
    this.inboxes.delete(agentId);
  }
}

