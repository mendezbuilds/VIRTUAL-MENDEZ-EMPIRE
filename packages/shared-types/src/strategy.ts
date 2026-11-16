import { z } from 'zod';
import { DepartmentIdSchema } from './departments.js';
import { TaskPrioritySchema } from './orchestration.js';

export const StrategicInitiativeSchema = z.object({
  id: z.string().uuid(),
  departmentId: DepartmentIdSchema,
  title: z.string(),
  description: z.string(),
  targetCompletionDate: z.string().datetime().optional(),
  tasks: z.array(
    z.object({
      id: z.string().uuid(),
      title: z.string(),
      description: z.string(),
      priority: TaskPrioritySchema.default('MEDIUM'),
      requiresOwnerApproval: z.boolean().default(false),
      inputData: z.record(z.unknown()).default({}),
    })
  ),
});

export type StrategicInitiative = z.infer<typeof StrategicInitiativeSchema>;

export const StrategicObjectiveSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).max(256),
  description: z.string(),
  status: z.enum(['DRAFT', 'ACTIVE', 'ACHIEVED', 'PAUSED', 'ABANDONED']).default('ACTIVE'),
  initiatives: z.array(StrategicInitiativeSchema),
  targetQuarter: z.string().optional(), // e.g. "Q4-2026"
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type StrategicObjective = z.infer<typeof StrategicObjectiveSchema>;

export const AgentKPISchema = z.object({
  agentId: z.string().uuid(),
  agentName: z.string(),
  departmentId: DepartmentIdSchema,
  tasksAssigned: z.number().int().nonnegative(),
  tasksCompleted: z.number().int().nonnegative(),
  tasksFailed: z.number().int().nonnegative(),
  tokensUsed: z.number().int().nonnegative(),
  totalCostUsd: z.number().nonnegative(),
  averageCycleTimeMs: z.number().nonnegative(),
  performanceScore: z.number().min(0).max(100),
});

export type AgentKPI = z.infer<typeof AgentKPISchema>;

export const DepartmentBudgetReportSchema = z.object({
  departmentId: DepartmentIdSchema,
  monthlyBudgetUsd: z.number().nonnegative(),
  actualSpentUsd: z.number().nonnegative(),
  remainingBudgetUsd: z.number(),
  burnRatePercentage: z.number().min(0),
  activeAgentCount: z.number().int().nonnegative(),
});

export type DepartmentBudgetReport = z.infer<typeof DepartmentBudgetReportSchema>;

