import type { DepartmentId, DepartmentBudgetReport } from '@vme/shared-types';
import type { DepartmentRegistry } from '@vme/department-hierarchy';

export class BudgetTracker {
  private actualExpensesByDept = new Map<DepartmentId, number>();

  constructor(private readonly hierarchy: DepartmentRegistry) {}

  recordExpense(departmentId: DepartmentId, amountUsd: number): void {
    const current = this.actualExpensesByDept.get(departmentId) ?? 0;
    this.actualExpensesByDept.set(departmentId, current + amountUsd);
  }

  getDepartmentBudgetReport(departmentId: DepartmentId): DepartmentBudgetReport {
    const dept = this.hierarchy.getDepartment(departmentId);
    if (!dept) throw new Error(`Department ${departmentId} not found`);

    const monthlyBudgetUsd = dept.budgetMonthlyUsd;
    const actualSpentUsd = Number((this.actualExpensesByDept.get(departmentId) ?? 0).toFixed(2));
    const remainingBudgetUsd = Number((monthlyBudgetUsd - actualSpentUsd).toFixed(2));
    const burnRatePercentage =
      monthlyBudgetUsd > 0 ? Number(((actualSpentUsd / monthlyBudgetUsd) * 100).toFixed(2)) : 0;
    const activeAgentCount = this.hierarchy.listAgentsByDepartment(departmentId).length;

    return {
      departmentId,
      monthlyBudgetUsd,
      actualSpentUsd,
      remainingBudgetUsd,
      burnRatePercentage,
      activeAgentCount,
    };
  }

  isWithinBudget(departmentId: DepartmentId, additionalExpenseUsd: number): boolean {
    const dept = this.hierarchy.getDepartment(departmentId);
    if (!dept) return false;
    const currentSpent = this.actualExpensesByDept.get(departmentId) ?? 0;
    return currentSpent + additionalExpenseUsd <= dept.budgetMonthlyUsd;
  }
}
