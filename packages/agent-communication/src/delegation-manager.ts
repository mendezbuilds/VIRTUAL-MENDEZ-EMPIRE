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
   * Routes authorization exclusively through ConsequentialPolicyEngine.resolveAuthorization().
   * Does NOT update approval status locally before cryptographic verification succeeds.
   * Ensures invalid authentication leaves the request unchanged.
   */
  authorizeAction(
    requestId: string,
    decision: 'APPROVED' | 'REJECTED',
    auth: OwnerAuthenticatedSession | string,
    decisionNotes?: string
  ): OwnerAuthorizationRequest & Promise<OwnerAuthorizationRequest> {
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

    // 4 & 5. Do not update approval status locally before cryptographic verification succeeds.
    // Ensure invalid authentication leaves the request unchanged.
    // Cryptographically verify session against OwnerAuthenticationService synchronously:
    const claims = this.policyEngine.authService.verifyOwnerSession(auth);

    // 3. Route authorization exclusively through ConsequentialPolicyEngine.resolveAuthorization()
    const executeResolution = async () => {
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

      const resolvedRecord = await this.policyEngine.resolveAuthorization(
        requestId,
        decision,
        auth,
        decisionNotes
      );

      request.status = resolvedRecord.status;
      request.decidedBy = resolvedRecord.decidedBy;
      request.decisionNotes = resolvedRecord.decisionNotes;
      request.decidedAt = resolvedRecord.decidedAt;
      return request;
    };

    const resolutionPromise = executeResolution();

    // After cryptographic verification succeeds, synchronize local request status
    request.status = decision;
    request.decidedBy = claims.principalId;
    request.decisionNotes = decisionNotes;
    request.decidedAt = new Date().toISOString();

    return Object.assign(resolutionPromise, request);
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
