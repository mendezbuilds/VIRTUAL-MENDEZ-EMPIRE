import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DepartmentRegistry } from '@vme/department-hierarchy';
import {
  KPICalculator,
  BudgetTracker,
} from './index.js';

describe('@vme/performance-management Corporate KPIs & Budget Oversight', () => {
  it('computes accurate agent KPI scores based on task success and efficiency', () => {
    const calc = new KPICalculator();
    const agentId = randomUUID();
    const agentName = 'TopPerformerBot';
    const deptId = 'opportunity_acquisition';

    // 5 successful tasks, low latency, low tokens
    for (let i = 0; i < 5; i++) {
      calc.recordMetric({
        agentId,
        agentName,
        departmentId: deptId,
        durationMs: 300,
        tokensUsed: 150,
        costUsd: 0.002,
        isSuccessful: true,
      });
    }

    const kpi = calc.computeAgentKPI(agentId, agentName, deptId);
    expect(kpi.tasksAssigned).toBe(5);
    expect(kpi.tasksCompleted).toBe(5);
    expect(kpi.tasksFailed).toBe(0);
    expect(kpi.performanceScore).toBeGreaterThanOrEqual(90);
  });

  it('correctly flags underperforming agents with high failure rates', () => {
    const calc = new KPICalculator();
    const agentId = randomUUID();
    const agentName = 'FailingBot';
    const deptId = 'technology_engineering';

    // 4 failed tasks out of 5
    calc.recordMetric({
      agentId,
      agentName,
      departmentId: deptId,
      durationMs: 1500,
      tokensUsed: 1200,
      costUsd: 0.02,
      isSuccessful: true,
    });

    for (let i = 0; i < 4; i++) {
      calc.recordMetric({
        agentId,
        agentName,
        departmentId: deptId,
        durationMs: 4000,
        tokensUsed: 3000,
        costUsd: 0.05,
        isSuccessful: false,
      });
    }

    const kpi = calc.computeAgentKPI(agentId, agentName, deptId);
    expect(kpi.tasksAssigned).toBe(5);
    expect(kpi.tasksCompleted).toBe(1);
    expect(kpi.tasksFailed).toBe(4);
    // Score should be very low (< 50)
    expect(kpi.performanceScore).toBeLessThan(50);
  });

  it('tracks department monthly budget, burn rate percentage, and spending ceiling', () => {
    const hierarchy = new DepartmentRegistry();
    const tracker = new BudgetTracker(hierarchy);

    const financeDept = hierarchy.getDepartment('financial_intelligence')!;
    expect(financeDept.budgetMonthlyUsd).toBe(50000);

    // Initial check: 0 spent
    const initialReport = tracker.getDepartmentBudgetReport('financial_intelligence');
    expect(initialReport.actualSpentUsd).toBe(0);
    expect(initialReport.burnRatePercentage).toBe(0);
    expect(initialReport.remainingBudgetUsd).toBe(50000);

    // Record server infrastructure & data feeds expenses: $12,500
    tracker.recordExpense('financial_intelligence', 12500);

    const updatedReport = tracker.getDepartmentBudgetReport('financial_intelligence');
    expect(updatedReport.actualSpentUsd).toBe(12500);
    expect(updatedReport.burnRatePercentage).toBe(25);
    expect(updatedReport.remainingBudgetUsd).toBe(37500);

    // Additional expense of $30,000 is within budget
    expect(tracker.isWithinBudget('financial_intelligence', 30000)).toBe(true);

    // Additional expense of $40,000 exceeds budget (12500 + 40000 = 52500 > 50000)
    expect(tracker.isWithinBudget('financial_intelligence', 40000)).toBe(false);
  });
});
