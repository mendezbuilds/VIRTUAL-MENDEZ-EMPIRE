import { z } from 'zod';
import { DepartmentIdSchema } from './organization.js';
import { TaskPrioritySchema } from './task-management.js';

/**
 * Standardized Communication Message Categories for Virtual MENDEZ EMPIRE.
 * Includes all 14 mandatory categories plus backward-compatible legacy aliases.
 */
export const CommunicationMessageTypeSchema = z.enum([
  // 14 Canonical Categories:
  'TASK_ASSIGNMENT',
  'TASK_ACCEPTANCE',
  'TASK_REJECTION',
  'TASK_STATUS_UPDATE',
  'TASK_COMPLETION',
  'DELEGATION_REQUEST',
  'DELEGATION_RESPONSE',
  'INFORMATION_REQUEST',
  'INFORMATION_RESPONSE',
  'APPROVAL_REQUEST',
  'APPROVAL_RESPONSE',
  'FAILURE_REPORT',
  'ESCALATION',
  'EXECUTIVE_REPORT',

  // Backward-compatibility aliases for Phase 1 / early Phase 2 tests:
  'TASK_DELEGATION',
  'REVIEW_REQUEST',
  'REVIEW_APPROVAL',
  'REVIEW_REJECTION',
  'INFO_REQUEST',
  'INFO_RESPONSE',
]);

export type CommunicationMessageType = z.infer<typeof CommunicationMessageTypeSchema>;

/**
 * Alias for backward compatibility
 */
export const AgentMessageTypeSchema = CommunicationMessageTypeSchema;
export type AgentMessageType = CommunicationMessageType;

/**
 * Delivery status of an agent communication envelope
 */
export const DeliveryStatusSchema = z.enum([
  'PENDING',
  'DELIVERED',
  'ACKNOWLEDGED',
  'FAILED',
  'EXPIRED',
]);

export type DeliveryStatus = z.infer<typeof DeliveryStatusSchema>;

/**
 * Standardized Agent Communication Envelope
 */
export const CommunicationEnvelopeSchema = z.object({
  messageId: z.string().uuid(),
  senderAgentId: z.string().uuid(),
  senderAgentCode: z.string().optional(),
  senderDepartmentId: DepartmentIdSchema,
  recipientAgentId: z.string().uuid().optional(), // Optional if destination is an entire department
  recipientAgentCode: z.string().optional(),
  recipientDepartmentId: DepartmentIdSchema,
  type: CommunicationMessageTypeSchema,
  priority: TaskPrioritySchema.default('MEDIUM'),
  taskId: z.string().uuid().optional(),
  payload: z.record(z.unknown()),
  correlationId: z.string().uuid(),
  causationId: z.string().uuid().optional(),
  sentAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
  deliveryStatus: DeliveryStatusSchema.optional(),
  requiresResponse: z.boolean().default(false),
  verifiedSenderSignature: z.string().optional(), // For preventing sender impersonation
});

export type CommunicationEnvelope = z.infer<typeof CommunicationEnvelopeSchema>;

/**
 * Alias for backward compatibility with early Phase 2 implementations
 */
export const AgentMessageEnvelopeSchema = CommunicationEnvelopeSchema.extend({
  recipientAgentId: z.string().uuid(), // keep non-optional for AgentMessageEnvelope if needed or accept string
});

export type AgentMessageEnvelope = z.infer<typeof AgentMessageEnvelopeSchema>;

/**
 * Message Acknowledgment Contract
 */
export const MessageAcknowledgmentSchema = z.object({
  acknowledgmentId: z.string().uuid(),
  messageId: z.string().uuid(),
  recipientAgentId: z.string().uuid(),
  receivedAt: z.string().datetime(),
  status: z.enum(['ACCEPTED', 'REJECTED', 'QUEUED']),
  rejectionReason: z.string().optional(),
});

export type MessageAcknowledgment = z.infer<typeof MessageAcknowledgmentSchema>;

/**
 * Message Validation Helper
 * Validates envelope integrity and guarantees sender agent matches verified caller context
 */
export function validateCommunicationEnvelope(
  envelope: unknown,
  trustedCallerAgentId?: string
): { valid: boolean; error?: string; envelope?: CommunicationEnvelope } {
  const result = CommunicationEnvelopeSchema.safeParse(envelope);
  if (!result.success) {
    return {
      valid: false,
      error: `Malformed envelope: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`,
    };
  }

  // Anti-spoofing check: If trusted caller context is provided, senderAgentId must strictly match
  if (trustedCallerAgentId && result.data.senderAgentId !== trustedCallerAgentId) {
    return {
      valid: false,
      error: `Sender identity spoofing rejected: declared '${result.data.senderAgentId}', but verified caller is '${trustedCallerAgentId}'`,
    };
  }

  // Must have at least recipientAgentId or recipientDepartmentId
  if (!result.data.recipientAgentId && !result.data.recipientDepartmentId) {
    return {
      valid: false,
      error: 'Envelope must designate either a recipient agent ID or a recipient department destination',
    };
  }

  return {
    valid: true,
    envelope: result.data,
  };
}
