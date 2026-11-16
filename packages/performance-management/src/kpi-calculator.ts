import type { AgentKPI, DepartmentId } from '@vme/shared-types';

export interface TaskExecutionMetric {
  agentId: string;
  agentName: string;
  departmentId: DepartmentId;
  durationMs: number;
  tokensUsed: number;
  costUsd: number;
  isSuccessful: boolean;
}

export class KPICalculator {
  private agentMetrics = new Map<string, TaskExecutionMetric[]>();

  recordMetric(metric: TaskExecutionMetric): void {
    let list = this.agentMetrics.get(metric.agentId);
    if (!list) {
      list = [];
      this.agentMetrics.set(metric.agentId, list);
    }
    list.push(metric);
  }

  computeAgentKPI(agentId: string, agentName: string, departmentId: DepartmentId): AgentKPI {
    const metrics = this.agentMetrics.get(agentId) ?? [];
    const tasksAssigned = metrics.length;
    if (tasksAssigned === 0) {
      return {
        agentId,
        agentName,
        departmentId,
        tasksAssigned: 0,
        tasksCompleted: 0,
        tasksFailed: 0,
        tokensUsed: 0,
        totalCostUsd: 0,
        averageCycleTimeMs: 0,
        performanceScore: 100, // baseline default
      };
    }

    const tasksCompleted = metrics.filter((m) => m.isSuccessful).length;
    const tasksFailed = tasksAssigned - tasksCompleted;
    const tokensUsed = metrics.reduce((sum, m) => sum + m.tokensUsed, 0);
    const totalCostUsd = metrics.reduce((sum, m) => sum + m.costUsd, 0);
    const totalDuration = metrics.reduce((sum, m) => sum + m.durationMs, 0);
    const averageCycleTimeMs = totalDuration / tasksAssigned;

    // Reliability factor: 0 - 60 points
    const reliabilityScore = (tasksCompleted / tasksAssigned) * 60;

    // Latency factor: 0 - 20 points (e.g. <= 2000ms is full 20 points)
    const latencyScore = Math.max(0, Math.min(20, 20 - (averageCycleTimeMs - 500) / 100));

    // Efficiency factor: 0 - 20 points (low token consumption relative to tasks)
    const avgTokens = tokensUsed / tasksAssigned;
    const efficiencyScore = Math.max(0, Math.min(20, 20 - avgTokens / 500));

    const performanceScore = Math.round(reliabilityScore + latencyScore + efficiencyScore);

    return {
      agentId,
      agentName,
      departmentId,
      tasksAssigned,
      tasksCompleted,
      tasksFailed,
      tokensUsed,
      totalCostUsd: Number(totalCostUsd.toFixed(4)),
      averageCycleTimeMs: Math.round(averageCycleTimeMs),
      performanceScore: Math.min(100, Math.max(0, performanceScore)),
    };
  }
}

