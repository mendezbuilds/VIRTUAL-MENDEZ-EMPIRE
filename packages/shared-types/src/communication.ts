import { z } from 'zod';
import { DepartmentIdSchema } from './departments.js';
import { TaskPrioritySchema } from './orchestration.js';

export const AgentMessageTypeSchema = z.enum([
  'TASK_DELEGATION',
  'TASK_STATUS_UPDATE',
  'REVIEW_REQUEST',
  'REVIEW_APPROVAL',
  'REVIEW_REJECTION',
  'ESCALATION',
  'INFO_REQUEST',
  'INFO_RESPONSE',
]);

export type AgentMessageType = z.infer<typeof AgentMessageTypeSchema>;

export const AgentMessageEnvelopeSchema = z.object({
  messageId: z.string().uuid(),
  senderAgentId: z.string().uuid(),
  recipientAgentId: z.string().uuid(),
  senderDepartmentId: DepartmentIdSchema,
  recipientDepartmentId: DepartmentIdSchema,
  type: AgentMessageTypeSchema,
  priority: TaskPrioritySchema.default('MEDIUM'),
  taskId: z.string().uuid().optional(),
  payload: z.record(z.unknown()),
  requiresResponse: z.boolean().default(false),
  correlationId: z.string().uuid(),
  sentAt: z.string().datetime(),
});

export type AgentMessageEnvelope = z.infer<typeof AgentMessageEnvelopeSchema>;
