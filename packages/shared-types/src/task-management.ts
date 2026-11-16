import { z } from 'zod';
import { DepartmentIdSchema } from './organization.js';

/**
 * Task Priority levels across the empire
 */
export const TaskPrioritySchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;

/**
 * Comprehensive Task Lifecycle Statuses
 */
export const TaskStatusSchema = z.enum([
  'PENDING',           // Created, awaiting assignment
  'ASSIGNED',          // Assigned to specific agent
  'IN_PROGRESS',       // Agent actively executing
  'WAITING_FEEDBACK',  // Blocked on intermediate feedback or clarification
  'WAITING_APPROVAL',  // Blocked on Owner or Director authorization gate
  'COMPLETED',         // Successfully completed with verified outputs
  'FAILED',            // Execution failed
  'CANCELLED',         // Explicitly cancelled by supervisor or circuit breaker
  'ESCALATED',         // Escalated to higher authority level due to failure or block
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/**
 * Canonical Task Definition
 */
export const TaskSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  title: z.string().min(1).max(256),
  description: z.string().min(1),
  departmentId: DepartmentIdSchema,
  assignedAgentId: z.string().uuid().optional(),
  assignedAgentCode: z.string().optional(),
  creatorAgentId: z.string().uuid().optional(),
  creatorAgentCode: z.string().optional(),
  priority: TaskPrioritySchema.default('MEDIUM'),
  status: TaskStatusSchema.default('PENDING'),
  parentTaskId: z.string().uuid().optional(),
  strategicInitiativeId: z.string().uuid().optional(),
  requiresOwnerApproval: z.boolean().default(false),
  deadline: z.string().datetime().optional(),
  inputData: z.record(z.unknown()).default({}),
  outputResult: z.record(z.unknown()).optional(),
  errorMessage: z.string().optional(),
  tags: z.array(z.string()).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Task = z.infer<typeof TaskSchema>;

/**
 * Task Assignment Contract
 */
export const TaskAssignmentSchema = z.object({
  assignmentId: z.string().uuid(),
  taskId: z.string().uuid(),
  assignerAgentId: z.string().uuid(),
  assigneeAgentId: z.string().uuid(),
  departmentId: DepartmentIdSchema,
  instructions: z.string().min(1),
  priority: TaskPrioritySchema,
  deadline: z.string().datetime().optional(),
  context: z.record(z.unknown()).default({}),
  assignedAt: z.string().datetime(),
});

export type TaskAssignment = z.infer<typeof TaskAssignmentSchema>;

/**
 * Hierarchical Task Delegation Contract
 */
export const TaskDelegationSchema = z.object({
  delegationId: z.string().uuid(),
  parentTaskId: z.string().uuid(),
  delegatedTaskId: z.string().uuid(),
  delegatorAgentId: z.string().uuid(),
  delegatorDepartmentId: DepartmentIdSchema,
  delegateeAgentId: z.string().uuid(),
  delegateeDepartmentId: DepartmentIdSchema,
  delegationDepth: z.number().int().min(1).max(5),
  scopeBoundaries: z.array(z.string()).default([]),
  requiresDirectorApproval: z.boolean().default(false),
  status: z.enum(['PROPOSED', 'ACCEPTED', 'REJECTED', 'REVOKED']).default('ACCEPTED'),
  rejectionReason: z.string().optional(),
  delegatedAt: z.string().datetime(),
});

export type TaskDelegation = z.infer<typeof TaskDelegationSchema>;

/**
 * Task Result Contract
 */
export const TaskResultSchema = z.object({
  resultId: z.string().uuid(),
  taskId: z.string().uuid(),
  executingAgentId: z.string().uuid(),
  status: z.enum(['SUCCESS', 'FAILURE', 'PARTIAL_SUCCESS']),
  outputData: z.record(z.unknown()),
  summary: z.string().min(1),
  tokensUsed: z.number().int().nonnegative().default(0),
  executionDurationMs: z.number().nonnegative(),
  errorDetails: z.string().optional(),
  completedAt: z.string().datetime(),
});

export type TaskResult = z.infer<typeof TaskResultSchema>;

/**
 * Task Dependency Contract
 */
export const TaskDependencySchema = z.object({
  dependencyId: z.string().uuid(),
  taskId: z.string().uuid(),
  dependsOnTaskId: z.string().uuid(),
  dependencyType: z.enum(['BLOCKING', 'INFORMATIONAL', 'SUCCESS_REQUIRED']),
  isResolved: z.boolean().default(false),
  resolvedAt: z.string().datetime().optional(),
});

export type TaskDependency = z.infer<typeof TaskDependencySchema>;

/**
 * Task Escalation Contract
 */
export const TaskEscalationSchema = z.object({
  escalationId: z.string().uuid(),
  taskId: z.string().uuid(),
  originatingAgentId: z.string().uuid(),
  targetSupervisorId: z.string().uuid(),
  departmentId: DepartmentIdSchema,
  reason: z.string().min(1),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  status: z.enum(['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'ESCALATED_TO_OWNER']).default('OPEN'),
  resolutionNotes: z.string().optional(),
  escalatedAt: z.string().datetime(),
  resolvedAt: z.string().datetime().optional(),
});

export type TaskEscalation = z.infer<typeof TaskEscalationSchema>;
