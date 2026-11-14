import type { OrchestratedTask } from '@vme/shared-types';
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
  ): { requiresOwnerApproval: boolean; request?: OwnerAuthorizationRequest } {
    const agent = this.hierarchy.getAgent(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    // All consequential actions MUST be intercepted and gated
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

  getPendingOwnerApprovals(): OwnerAuthorizationRequest[] {
    return this.pendingOwnerApprovals.filter((r) => r.status === 'PENDING_OWNER_REVIEW');
  }

  /**
   * Escalates a task failure up to the Department Director or COO.
   */
  async escalateFailure(
    agentId: string,
    taskId: string,
    errorReason: string
  ): Promise<void> {
    const agent = this.hierarchy.getAgent(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    // Find the department director to escalate to
    const director = this.hierarchy.getDepartmentDirector(agent.departmentId);
    const targetSupervisor =
      director && director.id !== agent.id
        ? director
        : this.hierarchy.getAllAgents().find((a) => a.name === 'ChiefOperatingOfficer')!;

    await this.router.dispatch({
      senderAgentId: agent.id,
      recipientAgentId: targetSupervisor.id,
      type: 'ESCALATION',
      priority: 'CRITICAL',
      taskId,
      payload: {
        failingAgent: agent.name,
        errorReason,
        departmentId: agent.departmentId,
      },
      requiresResponse: true,
    });
  }
}
