import { randomUUID } from 'node:crypto';
import {
  OWNER_PRINCIPAL_ID,
  CANONICAL_OWNER_PRINCIPAL,
  type OrchestratedTask,
  type DepartmentId,
} from '@vme/shared-types';
import type { DepartmentRegistry } from '@vme/department-hierarchy';
import type { MessageRouter } from './message-router.js';
import {
  ConsequentialPolicyEngine,
  type ConsequentialActionType,
  type ConsequentialAuthorizationRecord,
  computeParameterHash,
  ConsequentialPolicyViolationError,
  UnauthorizedOwnerDecisionError,
  type OwnerAuthenticatedSession,
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
  private confirmedPolicyApprovals = new Map<string, ConsequentialAuthorizationRecord>();
  public readonly policyEngine: ConsequentialPolicyEngine;

  constructor(
    private readonly hierarchy: DepartmentRegistry,
    private readonly router: MessageRouter,
    policyEngineOrOptions?: ConsequentialPolicyEngine | { policyEngine?: ConsequentialPolicyEngine }
  ) {
    if (policyEngineOrOptions && 'quarantineAction' in policyEngineOrOptions) {
      this.policyEngine = policyEngineOrOptions as ConsequentialPolicyEngine;
    } else if (policyEngineOrOptions && typeof policyEngineOrOptions === 'object' && 'policyEngine' in policyEngineOrOptions) {
      this.policyEngine = (policyEngineOrOptions as { policyEngine?: ConsequentialPolicyEngine }).policyEngine ?? new ConsequentialPolicyEngine();
    } else {
      this.policyEngine = new ConsequentialPolicyEngine();
    }
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
    const id = `auth-${Date.now()}-${randomUUID().slice(0, 8)}`;

    const request: OwnerAuthorizationRequest = {
      id,
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
          id,
          taskId,
          actionType,
          agentId,
          departmentId: agent.departmentId as DepartmentId,
          payload,
        })
        .catch(() => {});
    }

    return { requiresOwnerApproval: true, request };
  }

  /**
   * Resolves an Owner authorization request.
   * Strictly enforces that only the authentic Owner principal can authorize consequential actions.
   * Requires a valid OwnerAuthenticatedSession or signed token.
   * Awaits ConsequentialPolicyEngine.resolveAuthorization() BEFORE changing any local request fields.
   * Only synchronizes local status and decision details after the policy engine successfully returns an approved/rejected record.
   * If policy resolution fails for any reason, leaves the local request completely unchanged.
   */
  async authorizeAction(
    requestId: string,
    decision: 'APPROVED' | 'REJECTED',
    auth: OwnerAuthenticatedSession | string,
    decisionNotes?: string
  ): Promise<OwnerAuthorizationRequest> {
    const request = this.pendingOwnerApprovals.find((r) => r.id === requestId);
    if (!request) {
      throw new Error(`Owner authorization request with id '${requestId}' not found.`);
    }

    if (!this.policyEngine) {
      throw new UnauthorizedOwnerDecisionError(
        'Owner authorization failed: ConsequentialPolicyEngine is not configured on DelegationManager. System failed closed.'
      );
    }

    // 1. Remove identity-string authorization from authorizeAction()
    // 2. Require a valid OwnerAuthenticatedSession or signed token
    if (typeof auth === 'string' && !auth.includes('.')) {
      throw new UnauthorizedOwnerDecisionError(
        `Owner authorization strictly requires a valid cryptographically signed Owner session. Identity-only authentication '${auth}' is prohibited.`
      );
    }

    // Ensure the record is registered in policyEngine before resolving
    let record = await this.policyEngine.getRequestById(requestId);
    if (!record) {
      await this.policyEngine.quarantineAction({
        id: request.id,
        taskId: request.taskId,
        actionType: request.actionType,
        agentId: request.agentId,
        departmentId: request.departmentId as DepartmentId,
        payload: request.payload,
      });
    }

    // 2. Await ConsequentialPolicyEngine.resolveAuthorization() BEFORE changing any local request fields.
    // If resolveAuthorization fails for ANY reason (cryptographic signature failure, expired session,
    // revoked session, unregistered session, validity window expiration, etc.), it will throw here,
    // and local request fields remain completely unchanged ('PENDING_OWNER_REVIEW').
    const resolvedRecord = await this.policyEngine.resolveAuthorization(
      requestId,
      decision,
      auth,
      decisionNotes
    );

    // 3. Only synchronize local status and decision details after policy engine successfully returns
    request.status = resolvedRecord.status;
    request.decidedBy = resolvedRecord.decidedBy;
    request.decisionNotes = resolvedRecord.decisionNotes;
    request.decidedAt = resolvedRecord.decidedAt;

    this.confirmedPolicyApprovals.set(requestId, resolvedRecord);

    return request;
  }

  /**
   * Step 6 of Consequential Action Lifecycle: Revalidates that an authorized request
   * has not expired, that the parameters to execute cryptographically match the authorized hash,
   * and that the policy engine has confirmed approval (eliminating local status tampering bypass).
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

    // 5. Ensure revalidateConsequentialAction() cannot authorize execution based solely on local status
    // when the policy engine has not confirmed approval.
    if (!this.policyEngine) {
      throw new ConsequentialPolicyViolationError(
        `Cannot execute consequential action ${requestId}: ConsequentialPolicyEngine is not configured.`
      );
    }

    const policyRecord =
      this.confirmedPolicyApprovals.get(requestId) ?? this.policyEngine.getRequestRecord(requestId);
    if (!policyRecord || policyRecord.status !== 'APPROVED') {
      throw new ConsequentialPolicyViolationError(
        `Cannot execute consequential action ${requestId}: policy engine has not confirmed approval (current engine status: '${policyRecord?.status ?? 'UNREGISTERED'}'). Local status alone cannot authorize execution.`
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

    if (policyRecord.validUntil && new Date(policyRecord.validUntil).getTime() < Date.now()) {
      request.status = 'EXPIRED';
      policyRecord.status = 'EXPIRED';
      throw new ConsequentialPolicyViolationError(
        `Cannot execute consequential action ${requestId}: policy engine authorization has expired.`
      );
    }

    const currentHash = computeParameterHash(payloadToExecute);
    if (request.parameterHash && currentHash !== request.parameterHash) {
      throw new ConsequentialPolicyViolationError(
        `Cryptographic parameter hash mismatch! Authorized hash '${request.parameterHash}' does not match execution payload hash '${currentHash}'. Parameter tampering detected.`
      );
    }

    if (policyRecord.parameterHash && currentHash !== policyRecord.parameterHash) {
      throw new ConsequentialPolicyViolationError(
        `Cryptographic parameter hash mismatch! Policy engine authorized hash '${policyRecord.parameterHash}' does not match execution payload hash '${currentHash}'. Parameter tampering detected.`
      );
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
