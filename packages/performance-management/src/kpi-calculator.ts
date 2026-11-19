import type { AgentKPI, DepartmentId } from '@vme/shared-types';
import type { PerformanceEventStore } from './performance-event-store.js';

export interface TaskExecutionMetric {
  agentId: string;
  agentName: string;
  departmentId: DepartmentId;
  durationMs: number;
  tokensUsed: number;
  costUsd: number;
  taskComplexity?: number; // e.g. 1.0 (routine) to 3.0 (complex architecture)
  qualityScore?: number; // 0.0 to 1.0 verified execution quality
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
    return this.calculateFromMetrics(agentId, agentName, departmentId, metrics);
  }

  async computeAgentKPIAsync(
    agentId: string,
    agentName: string,
    departmentId: DepartmentId,
    eventStore?: PerformanceEventStore,
    options?: { since?: string; until?: string }
  ): Promise<AgentKPI> {
    if (eventStore) {
      const events = await eventStore.getAgentEvents(agentId, options?.since, options?.until);
      if (events.length > 0) {
        return this.computeAgentKPIFromEvents(agentId, agentName, departmentId, events);
      }
    }
    return this.computeAgentKPI(agentId, agentName, departmentId);
  }

  computeAgentKPIFromEvents(
    agentId: string,
    agentName: string,
    departmentId: DepartmentId,
    events: Array<{
      durationMs: number;
      tokensUsed: number;
      costUsd: number;
      taskComplexity?: number;
      qualityScore?: number;
      isSuccessful: boolean;
    }>
  ): AgentKPI {
    const metrics: TaskExecutionMetric[] = events.map((e) => ({
      agentId,
      agentName,
      departmentId,
      durationMs: e.durationMs,
      tokensUsed: e.tokensUsed,
      costUsd: e.costUsd,
      taskComplexity: e.taskComplexity ?? 1.0,
      qualityScore: e.qualityScore ?? (e.isSuccessful ? 1.0 : 0.0),
      isSuccessful: e.isSuccessful,
    }));
    return this.calculateFromMetrics(agentId, agentName, departmentId, metrics);
  }

  private calculateFromMetrics(
    agentId: string,
    agentName: string,
    departmentId: DepartmentId,
    metrics: TaskExecutionMetric[]
  ): AgentKPI {
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

    // Reliability & Quality factor (0 - 60 points) weighted by task complexity and execution quality
    let totalWeightedQuality = 0;
    let totalWeight = 0;

    for (const m of metrics) {
      const complexity = m.taskComplexity ?? 1.0;
      const quality = m.qualityScore ?? (m.isSuccessful ? 1.0 : 0.0);
      totalWeightedQuality += quality * complexity;
      totalWeight += complexity;
    }

    const qualityRatio = totalWeight > 0 ? totalWeightedQuality / totalWeight : tasksCompleted / tasksAssigned;
    const reliabilityScore = qualityRatio * 60;

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

