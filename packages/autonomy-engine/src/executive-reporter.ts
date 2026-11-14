import type { StrategicObjective, OrchestratedTask } from '@vme/shared-types';
import type { DepartmentRegistry } from '@vme/department-hierarchy';
import type { DelegationManager } from '@vme/agent-communication';

export interface ExecutiveReport {
  companyName: string;
  generatedAt: string;
  activeObjectivesCount: number;
  completedTasksCount: number;
  pendingOwnerApprovalsCount: number;
  departments: Array<{
    id: string;
    name: string;
    budgetMonthlyUsd: number;
    activeAgentsCount: number;
  }>;
  pendingOwnerApprovals: Array<{
    id: string;
    actionType: string;
    departmentId: string;
    requestedAt: string;
  }>;
}

export class ExecutiveReporter {
  constructor(
    private readonly hierarchy: DepartmentRegistry,
    private readonly delegationManager: DelegationManager
  ) {}

  generateReport(
    activeObjectives: StrategicObjective[],
    completedTasks: OrchestratedTask[]
  ): ExecutiveReport {
    const departments = this.hierarchy.listDepartments().map((d) => ({
      id: d.id,
      name: d.name,
      budgetMonthlyUsd: d.budgetMonthlyUsd,
      activeAgentsCount: this.hierarchy.listAgentsByDepartment(d.id).length,
    }));

    const pendingApprovals = this.delegationManager.getPendingOwnerApprovals().map((p) => ({
      id: p.id,
      actionType: p.actionType,
      departmentId: p.departmentId,
      requestedAt: p.requestedAt,
    }));

    return {
      companyName: 'VIRTUAL MENDEZ EMPIRE',
      generatedAt: new Date().toISOString(),
      activeObjectivesCount: activeObjectives.length,
      completedTasksCount: completedTasks.length,
      pendingOwnerApprovalsCount: pendingApprovals.length,
      departments,
      pendingOwnerApprovals: pendingApprovals,
    };
  }
}
