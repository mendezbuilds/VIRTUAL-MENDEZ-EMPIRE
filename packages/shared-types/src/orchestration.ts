import { z } from 'zod';
import { DepartmentIdSchema, RoleTierSchema } from './departments.js';

export const AgentSpecSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  departmentId: DepartmentIdSchema,
  tier: RoleTierSchema,
  systemPrompt: z.string(),
  modelProvider: z.enum(['mock', 'anthropic', 'openai', 'gemini']),
  modelId: z.string(),
  allowedTools: z.array(z.string()),
  maxParallelTasks: z.number().int().min(1).max(20).default(3),
  isActive: z.boolean().default(true),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type AgentSpec = z.infer<typeof AgentSpecSchema>;

export const TaskPrioritySchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;

export const TaskStatusSchema = z.enum([
  'PENDING',
  'ASSIGNED',
  'IN_PROGRESS',
  'WAITING_FEEDBACK',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const OrchestratedTaskSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  title: z.string().min(1).max(256),
  description: z.string(),
  departmentId: DepartmentIdSchema,
  assignedAgentId: z.string().uuid().optional(),
  priority: TaskPrioritySchema.default('MEDIUM'),
  status: TaskStatusSchema.default('PENDING'),
  inputData: z.record(z.unknown()).default({}),
  outputResult: z.record(z.unknown()).optional(),
  errorMessage: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type OrchestratedTask = z.infer<typeof OrchestratedTaskSchema>;

export const LLMCompletionRequestSchema = z.object({
  messages: z.array(
    z.object({
      role: z.enum(['system', 'user', 'assistant', 'tool']),
      content: z.string(),
      name: z.string().optional(),
      toolCallId: z.string().optional(),
    })
  ),
  temperature: z.number().min(0).max(2).default(0.7),
  maxTokens: z.number().int().positive().optional(),
  tools: z.array(z.record(z.unknown())).optional(),
});

export type LLMCompletionRequest = z.infer<typeof LLMCompletionRequestSchema>;

export const LLMCompletionResponseSchema = z.object({
  content: z.string(),
  model: z.string(),
  toolCalls: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      arguments: z.string(),
    })
  ).optional(),
  usage: z.object({
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
  }),
});

export type LLMCompletionResponse = z.infer<typeof LLMCompletionResponseSchema>;
