import type { DepartmentId, DepartmentBudgetReport } from '@vme/shared-types';
import type { DepartmentRegistry } from '@vme/department-hierarchy';
import type { KPICalculator } from './kpi-calculator.js';
import type { BudgetTracker } from './budget-tracker.js';

export interface DepartmentHealthReport {
  departmentId: DepartmentId;
  departmentName: string;
  totalAgents: number;
  activeAgents: number;
  budgetReport: DepartmentBudgetReport;
  totalTasksAssigned: number;
  totalTasksCompleted: number;
  totalTasksFailed: number;
  overallSuccessRatePct: number;
  averagePerformanceScore: number;
  topPerformers: string[];
  underperformingAgents: string[];
  identifiedBottlenecks: string[];
}

export class DepartmentAnalyticsEngine {
  constructor(
    private readonly hierarchy: DepartmentRegistry,
    private readonly kpiCalculator: KPICalculator,
    private readonly budgetTracker: BudgetTracker
  ) {}

  generateDepartmentHealth(departmentId: DepartmentId): DepartmentHealthReport {
    const dept = this.hierarchy.getDepartment(departmentId);
    if (!dept) {
      throw new Error(`Department '${departmentId}' not found in corporate hierarchy.`);
    }

    const agents = this.hierarchy.listAgentRecordsByDepartment(departmentId);
    const budgetReport = this.budgetTracker.getDepartmentBudgetReport(departmentId);

    let totalTasksAssigned = 0;
    let totalTasksCompleted = 0;
    let totalTasksFailed = 0;
    let totalScoreSum = 0;

    const topPerformers: string[] = [];
    const underperformingAgents: string[] = [];
    const bottlenecks: string[] = [];

    for (const agent of agents) {
      const kpi = this.kpiCalculator.computeAgentKPI(agent.id, agent.displayName, departmentId);
      totalTasksAssigned += kpi.tasksAssigned;
      totalTasksCompleted += kpi.tasksCompleted;
      totalTasksFailed += kpi.tasksFailed;
      totalScoreSum += kpi.performanceScore;

      if (kpi.performanceScore >= 85) {
        topPerformers.push(agent.agentCode);
      } else if (kpi.performanceScore < 60 && kpi.tasksAssigned > 0) {
        underperformingAgents.push(agent.agentCode);
      }

      if (kpi.averageCycleTimeMs > 3000 && kpi.tasksAssigned > 0) {
        bottlenecks.push(`High latency bottleneck on agent ${agent.agentCode} (${kpi.averageCycleTimeMs}ms avg)`);
      }
    }

    const overallSuccessRatePct =
      totalTasksAssigned > 0
        ? Number(((totalTasksCompleted / totalTasksAssigned) * 100).toFixed(1))
        : 100;

    const averagePerformanceScore =
      agents.length > 0 ? Math.round(totalScoreSum / agents.length) : 100;

    // Check budget bottleneck
    if (budgetReport.burnRatePercentage >= 90) {
      bottlenecks.push(`Budget burn rate critical: ${budgetReport.burnRatePercentage}% of monthly ceiling consumed.`);
    }

    return {
      departmentId,
      departmentName: dept.name,
      totalAgents: agents.length,
      activeAgents: agents.filter((a) => a.operationalStatus === 'ACTIVE').length,
      budgetReport,
      totalTasksAssigned,
      totalTasksCompleted,
      totalTasksFailed,
      overallSuccessRatePct,
      averagePerformanceScore,
      topPerformers,
      underperformingAgents,
      identifiedBottlenecks: bottlenecks,
    };
  }
}
