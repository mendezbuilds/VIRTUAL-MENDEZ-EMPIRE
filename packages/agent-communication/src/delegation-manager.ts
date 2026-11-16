import { OWNER_PRINCIPAL_ID, CANONICAL_OWNER_PRINCIPAL, type OrchestratedTask } from '@vme/shared-types';
import type { DepartmentRegistry } from '@vme/department-hierarchy';
import type { MessageRouter } from './message-router.js';

export interface OwnerAuthorizationRequest {
  id: string;
  taskId: string;
  actionType: 'LIVE_TRADING' | 'CAPITAL_TRANSFER' | 'EXTERNAL_OUTREACH' | 'BINDING_CONTRACT';
  agentId: string;
  departmentId: string;
  payload: Record<string, unknown>;
  status: 'PENDING_OWNER_REVIEW' | 'APPROVED' | 'REJECTED';
  requestedAt: string;
  decidedBy?: string;
  decisionNotes?: string;
  decidedAt?: string;
}

export class UnauthorizedOwnerDecisionError extends Error {
  constructor(message: string) {
    super(`OWNER GOVERNANCE VIOLATION: ${message}`);
    this.name = 'UnauthorizedOwnerDecisionError';
  }
}

export class DelegationManager {
  private pendingOwnerApprovals: OwnerAuthorizationRequest[] = [];

  constructor(
    private readonly hierarchy: DepartmentRegistry,
    private readonly router: MessageRouter
  ) {}

  /**
   * Delegates a task downward from supervisor to subordinate.
   */
  async delegateTask(
    supervisorId: string,
    subordinateId: string,
    task: OrchestratedTask
  ): Promise<void> {
    await this.router.dispatch({
      senderAgentId: supervisorId,
      recipientAgentId: subordinateId,
      type: 'TASK_DELEGATION',
      priority: task.priority,
      taskId: task.id,
      payload: {
        taskTitle: task.title,
        description: task.description,
        inputData: task.inputData,
      },
      requiresResponse: true,
    });
  }

  /**
   * Evaluates if a proposed operational action requires explicit Owner authorization.
   */
  interceptConsequentialAction(
    agentId: string,
    taskId: string,
    actionType: OwnerAuthorizationRequest['actionType'],
    payload: Record<string, unknown>
  ): { requiresOwnerApproval: boolean; request: OwnerAuthorizationRequest } {
    const agent = this.hierarchy.getAgentRecord(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    const request: OwnerAuthorizationRequest = {
      id: `auth-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      taskId,
      actionType,
      agentId,
      departmentId: agent.departmentId,
      payload,
      status: 'PENDING_OWNER_REVIEW',
      requestedAt: new Date().toISOString(),
    };

    this.pendingOwnerApprovals.push(request);
    return { requiresOwnerApproval: true, request };
  }

  /**
   * Resolves an Owner authorization request.
   * Strictly enforces that only the authentic Owner principal can authorize consequential actions.
   */
  authorizeAction(
    requestId: string,
    decision: 'APPROVED' | 'REJECTED',
    decidedBy: string,
    decisionNotes?: string
  ): OwnerAuthorizationRequest {
    const isOwner =
      decidedBy === OWNER_PRINCIPAL_ID || decidedBy === CANONICAL_OWNER_PRINCIPAL.principalId;

    if (!isOwner) {
      throw new UnauthorizedOwnerDecisionError(
        `Consequential actions can exclusively be authorized by the Owner principal (Stephen Mendez). Agent or caller '${decidedBy}' cannot approve or reject consequential actions.`
      );
    }

    const request = this.pendingOwnerApprovals.find((r) => r.id === requestId);
    if (!request) {
      throw new Error(`Owner authorization request with id '${requestId}' not found.`);
    }

    request.status = decision;
    request.decidedBy = decidedBy;
    request.decisionNotes = decisionNotes;
    request.decidedAt = new Date().toISOString();

    return request;
  }

  getPendingOwnerApprovals(): OwnerAuthorizationRequest[] {
    return this.pendingOwnerApprovals.filter((r) => r.status === 'PENDING_OWNER_REVIEW');
  }

  getRequestById(requestId: string): OwnerAuthorizationRequest | undefined {
    return this.pendingOwnerApprovals.find((r) => r.id === requestId);
  }

  /**
   * Escalates a task failure up to the Department Director or COO.
   */
  async escalateFailure(
    agentId: string,
    taskId: string,
    errorReason: string
  ): Promise<void> {
    const agent = this.hierarchy.getAgentRecord(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    // Find the department director to escalate to
    const director = this.hierarchy.getDepartmentDirectorRecord(agent.departmentId);
    const coo = this.hierarchy.getAgentRecord('EXEC-COO');

    const targetSupervisor =
      director && director.id !== agent.id
        ? director
        : coo ?? this.hierarchy.listAgentRecords().find((a) => a.level === 'EXECUTIVE')!;

    await this.router.dispatch({
      senderAgentId: agent.id,
      recipientAgentId: targetSupervisor.id,
      type: 'ESCALATION',
      priority: 'CRITICAL',
      taskId,
      payload: {
        reason: `Task failure: ${errorReason}`,
        severity: 'CRITICAL',
        escalationTier: director && director.id !== agent.id ? 'DIRECTOR' : 'EXECUTIVE',
        contextData: {
          failingAgent: agent.displayName,
          errorReason,
          departmentId: agent.departmentId,
        },
      },
      requiresResponse: true,
    });
  }
}
