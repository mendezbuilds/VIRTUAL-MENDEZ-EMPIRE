import { OWNER_PRINCIPAL_ID, CANONICAL_OWNER_PRINCIPAL, type OrchestratedTask } from '@vme/shared-types';
import type { DepartmentRegistry } from '@vme/department-hierarchy';
import type { MessageRouter } from './message-router.js';
import {
  ConsequentialPolicyEngine,
  type ConsequentialActionType,
  computeParameterHash,
  ConsequentialPolicyViolationError,
  UnauthorizedOwnerDecisionError,
} from './consequential-policy-engine.js';

export interface OwnerAuthorizationRequest {
  id: string;
  taskId: string;
  actionType: ConsequentialActionType;
  agentId: string;
  departmentId: string;
  payload: Record<string, unknown>;
  parameterHash?: string;
  validUntil?: string;
  status: 'PENDING_OWNER_REVIEW' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'EXECUTED';
  requestedAt: string;
  decidedBy?: string;
  decisionNotes?: string;
  decidedAt?: string;
}

export { UnauthorizedOwnerDecisionError };

export class DelegationManager {
  private pendingOwnerApprovals: OwnerAuthorizationRequest[] = [];
  public readonly policyEngine?: ConsequentialPolicyEngine;

  constructor(
    private readonly hierarchy: DepartmentRegistry,
    private readonly router: MessageRouter,
    policyEngine?: ConsequentialPolicyEngine
  ) {
    this.policyEngine = policyEngine;
  }

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

    const parameterHash = computeParameterHash(payload);
    const validUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const request: OwnerAuthorizationRequest = {
      id: `auth-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      taskId,
      actionType,
      agentId,
      departmentId: agent.departmentId,
      payload,
      parameterHash,
      validUntil,
      status: 'PENDING_OWNER_REVIEW',
      requestedAt: new Date().toISOString(),
    };

    this.pendingOwnerApprovals.push(request);

    if (this.policyEngine) {
      this.policyEngine
        .quarantineAction({
          taskId,
          actionType,
          agentId,
          departmentId: agent.departmentId,
          payload,
        })
        .catch(() => {});
    }

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

    if (this.policyEngine) {
      this.policyEngine
        .resolveAuthorization(requestId, decision, decidedBy, decisionNotes)
        .catch(() => {});
    }

    return request;
  }

  /**
   * Step 6 of Consequential Action Lifecycle: Revalidates that an authorized request
   * has not expired and that the parameters to execute cryptographically match the authorized hash.
   */
  revalidateConsequentialAction(
    requestId: string,
    payloadToExecute: Record<string, unknown>
  ): OwnerAuthorizationRequest {
    const request = this.pendingOwnerApprovals.find((r) => r.id === requestId);
    if (!request) {
      throw new ConsequentialPolicyViolationError(
        `Owner authorization request '${requestId}' not found for revalidation.`
      );
    }

    if (request.status !== 'APPROVED') {
      throw new ConsequentialPolicyViolationError(
        `Cannot execute consequential action ${requestId}: status is '${request.status}'. Owner approval is required.`
      );
    }

    if (request.validUntil && new Date(request.validUntil).getTime() < Date.now()) {
      request.status = 'EXPIRED';
      throw new ConsequentialPolicyViolationError(
        `Cannot execute consequential action ${requestId}: authorization has expired.`
      );
    }

    if (request.parameterHash) {
      const currentHash = computeParameterHash(payloadToExecute);
      if (currentHash !== request.parameterHash) {
        throw new ConsequentialPolicyViolationError(
          `Cryptographic parameter hash mismatch! Authorized hash '${request.parameterHash}' does not match execution payload hash '${currentHash}'. Parameter tampering detected.`
        );
      }
    }

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
