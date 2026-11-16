import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { DepartmentIdSchema } from './organization.js';
import { TaskPrioritySchema, TaskStatusSchema } from './task-management.js';
import { RestrictedActionTypeSchema } from './authority.js';
import { FailureClassificationSchema, type ExecutionContext } from './execution.js';

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

// ===========================================================================
// Dedicated Message-Type-Specific Payload Schemas (14 Mandatory Categories)
// ===========================================================================

export const TaskAssignmentPayloadSchema = z.object({
  taskId: z.string().uuid(),
  title: z.string().min(1),
  instructions: z.string().min(1),
  priority: TaskPrioritySchema.default('MEDIUM'),
  deadline: z.string().datetime().optional(),
  inputData: z.record(z.unknown()).default({}),
});
export type TaskAssignmentPayload = z.infer<typeof TaskAssignmentPayloadSchema>;

export const TaskAcceptancePayloadSchema = z.object({
  taskId: z.string().uuid(),
  acceptedAt: z.string().datetime(),
  estimatedCompletionAt: z.string().datetime().optional(),
  acknowledgedPriority: TaskPrioritySchema.optional(),
});
export type TaskAcceptancePayload = z.infer<typeof TaskAcceptancePayloadSchema>;

export const TaskRejectionPayloadSchema = z.object({
  taskId: z.string().uuid(),
  reason: z.string().min(1),
  rejectionCode: z.string().optional(),
  suggestedAlternativeAgentId: z.string().uuid().optional(),
});
export type TaskRejectionPayload = z.infer<typeof TaskRejectionPayloadSchema>;

export const TaskStatusUpdatePayloadSchema = z.object({
  taskId: z.string().uuid(),
  status: TaskStatusSchema,
  progressPercentage: z.number().min(0).max(100).optional(),
  currentStep: z.string().optional(),
  notes: z.string().optional(),
});
export type TaskStatusUpdatePayload = z.infer<typeof TaskStatusUpdatePayloadSchema>;

export const TaskCompletionPayloadSchema = z.object({
  taskId: z.string().uuid(),
  status: z.enum(['SUCCESS', 'PARTIAL_SUCCESS']),
  summary: z.string().min(1),
  outputData: z.record(z.unknown()),
  tokensUsed: z.number().int().nonnegative().optional(),
  executionDurationMs: z.number().nonnegative().optional(),
});
export type TaskCompletionPayload = z.infer<typeof TaskCompletionPayloadSchema>;

export const DelegationRequestPayloadSchema = z.object({
  parentTaskId: z.string().uuid(),
  delegatedTaskId: z.string().uuid(),
  delegatorAgentId: z.string().uuid(),
  delegateeAgentId: z.string().uuid(),
  delegationDepth: z.number().int().min(1).max(5),
  scopeBoundaries: z.array(z.string()).default([]),
  contextData: z.record(z.unknown()).default({}),
});
export type DelegationRequestPayload = z.infer<typeof DelegationRequestPayloadSchema>;

export const DelegationResponsePayloadSchema = z.object({
  delegationId: z.string().uuid().optional(),
  delegatedTaskId: z.string().uuid(),
  accepted: z.boolean(),
  reason: z.string().optional(),
});
export type DelegationResponsePayload = z.infer<typeof DelegationResponsePayloadSchema>;

export const InformationRequestPayloadSchema = z.object({
  query: z.string().min(1),
  requestedInformationType: z.string().optional(),
  context: z.record(z.unknown()).default({}),
  deadline: z.string().datetime().optional(),
});
export type InformationRequestPayload = z.infer<typeof InformationRequestPayloadSchema>;

export const InformationResponsePayloadSchema = z.object({
  queryId: z.string().uuid().optional(),
  findings: z.record(z.unknown()),
  summary: z.string().min(1),
  confidenceScore: z.number().min(0).max(1).optional(),
});
export type InformationResponsePayload = z.infer<typeof InformationResponsePayloadSchema>;

export const ApprovalRequestPayloadSchema = z.object({
  requestId: z.string().uuid(),
  actionType: RestrictedActionTypeSchema,
  title: z.string().min(1),
  justification: z.string().min(1),
  payload: z.record(z.unknown()),
  riskAssessment: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  financialImpactUsd: z.number().nonnegative().optional(),
});
export type ApprovalRequestPayload = z.infer<typeof ApprovalRequestPayloadSchema>;

export const ApprovalResponsePayloadSchema = z.object({
  requestId: z.string().uuid(),
  approved: z.boolean(),
  decidedBy: z.string().min(1),
  decisionNotes: z.string().optional(),
  approvedAt: z.string().datetime(),
});
export type ApprovalResponsePayload = z.infer<typeof ApprovalResponsePayloadSchema>;

export const FailureReportPayloadSchema = z.object({
  taskId: z.string().uuid(),
  failureClassification: FailureClassificationSchema,
  errorMessage: z.string().min(1),
  retryCount: z.number().int().nonnegative().default(0),
  errorDetails: z.record(z.unknown()).default({}),
});
export type FailureReportPayload = z.infer<typeof FailureReportPayloadSchema>;

export const EscalationPayloadSchema = z.object({
  escalationId: z.string().uuid().optional(),
  taskId: z.string().uuid().optional(),
  reason: z.string().min(1),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  escalationTier: z.enum(['SUPERVISOR', 'DIRECTOR', 'EXECUTIVE', 'OWNER']),
  contextData: z.record(z.unknown()).default({}),
});
export type EscalationPayload = z.infer<typeof EscalationPayloadSchema>;

export const ExecutiveReportPayloadSchema = z.object({
  reportPeriod: z.string().min(1),
  executiveSummary: z.string().min(1),
  kpis: z.record(z.unknown()).default({}),
  departmentHighlights: z.record(z.unknown()).default({}),
  escalationsRaised: z.number().int().nonnegative().default(0),
});
export type ExecutiveReportPayload = z.infer<typeof ExecutiveReportPayloadSchema>;

// Backward-compatible legacy payload schemas
export const TaskDelegationPayloadSchema = DelegationRequestPayloadSchema.or(z.record(z.unknown()));
export const ReviewRequestPayloadSchema = z.record(z.unknown());
export const ReviewApprovalPayloadSchema = z.record(z.unknown());
export const ReviewRejectionPayloadSchema = z.record(z.unknown());
export const InfoRequestPayloadSchema = InformationRequestPayloadSchema.or(z.record(z.unknown()));
export const InfoResponsePayloadSchema = InformationResponsePayloadSchema.or(z.record(z.unknown()));

/**
 * Registry map of message types to their respective payload schemas
 */
export const MESSAGE_PAYLOAD_SCHEMAS: Record<CommunicationMessageType, z.ZodTypeAny> = {
  TASK_ASSIGNMENT: TaskAssignmentPayloadSchema,
  TASK_ACCEPTANCE: TaskAcceptancePayloadSchema,
  TASK_REJECTION: TaskRejectionPayloadSchema,
  TASK_STATUS_UPDATE: TaskStatusUpdatePayloadSchema,
  TASK_COMPLETION: TaskCompletionPayloadSchema,
  DELEGATION_REQUEST: DelegationRequestPayloadSchema,
  DELEGATION_RESPONSE: DelegationResponsePayloadSchema,
  INFORMATION_REQUEST: InformationRequestPayloadSchema,
  INFORMATION_RESPONSE: InformationResponsePayloadSchema,
  APPROVAL_REQUEST: ApprovalRequestPayloadSchema,
  APPROVAL_RESPONSE: ApprovalResponsePayloadSchema,
  FAILURE_REPORT: FailureReportPayloadSchema,
  ESCALATION: EscalationPayloadSchema,
  EXECUTIVE_REPORT: ExecutiveReportPayloadSchema,
  // Legacy aliases:
  TASK_DELEGATION: TaskDelegationPayloadSchema,
  REVIEW_REQUEST: ReviewRequestPayloadSchema,
  REVIEW_APPROVAL: ReviewApprovalPayloadSchema,
  REVIEW_REJECTION: ReviewRejectionPayloadSchema,
  INFO_REQUEST: InfoRequestPayloadSchema,
  INFO_RESPONSE: InfoResponsePayloadSchema,
};

/**
 * Validates a message payload against its specific message-type schema
 */
export function validateMessagePayload(
  type: CommunicationMessageType,
  payload: unknown
): { valid: boolean; error?: string; data?: unknown } {
  const schema = MESSAGE_PAYLOAD_SCHEMAS[type];
  if (!schema) {
    return { valid: false, error: `Unknown message type: ${type}` };
  }
  const result = schema.safeParse(payload);
  if (!result.success) {
    return {
      valid: false,
      error: `Invalid payload for message type '${type}': ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`,
    };
  }
  return { valid: true, data: result.data };
}

// ===========================================================================
// Standardized Communication Envelope
// ===========================================================================

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
  verifiedSenderSignature: z.string().optional(), // Cryptographic signature from trusted ExecutionContext
});

export type CommunicationEnvelope = z.infer<typeof CommunicationEnvelopeSchema>;

/**
 * Alias for backward compatibility with early Phase 2 implementations
 */
export const AgentMessageEnvelopeSchema = CommunicationEnvelopeSchema.extend({
  recipientAgentId: z.string().uuid(),
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
 * Creates a verified CommunicationEnvelope derived directly from a trusted backend ExecutionContext.
 * Guarantees that senderAgentId and senderDepartmentId cannot be forged by untrusted caller input.
 */
export function createVerifiedCommunicationEnvelope(
  context: ExecutionContext,
  params: {
    recipientDepartmentId: z.infer<typeof DepartmentIdSchema>;
    recipientAgentId?: string;
    recipientAgentCode?: string;
    type: CommunicationMessageType;
    priority?: z.infer<typeof TaskPrioritySchema>;
    taskId?: string;
    payload: Record<string, unknown>;
    correlationId?: string;
    causationId?: string;
    expiresAt?: string;
    requiresResponse?: boolean;
  }
): CommunicationEnvelope {
  // Validate payload against type-specific schema
  const payloadCheck = validateMessagePayload(params.type, params.payload);
  if (!payloadCheck.valid) {
    throw new Error(`Envelope creation failed: ${payloadCheck.error}`);
  }

  return {
    messageId: randomUUID(),
    // Sender identity derived strictly from trusted ExecutionContext
    senderAgentId: context.agentId,
    senderAgentCode: context.agentCode,
    senderDepartmentId: context.departmentId,
    recipientAgentId: params.recipientAgentId,
    recipientAgentCode: params.recipientAgentCode,
    recipientDepartmentId: params.recipientDepartmentId,
    type: params.type,
    priority: params.priority ?? 'MEDIUM',
    taskId: params.taskId,
    payload: params.payload,
    correlationId: params.correlationId ?? randomUUID(),
    causationId: params.causationId,
    sentAt: new Date().toISOString(),
    expiresAt: params.expiresAt,
    deliveryStatus: 'PENDING',
    requiresResponse: params.requiresResponse ?? false,
    verifiedSenderSignature: context.callerSignature ?? `sig-${context.agentId}-${context.traceId}`,
  };
}

/**
 * Message Validation Helper
 * Validates envelope integrity, verifies that sender identity matches the trusted ExecutionContext,
 * and validates the message payload against its type-specific schema.
 */
export function validateCommunicationEnvelope(
  envelope: unknown,
  trustedCaller?: ExecutionContext | string
): { valid: boolean; error?: string; envelope?: CommunicationEnvelope } {
  const result = CommunicationEnvelopeSchema.safeParse(envelope);
  if (!result.success) {
    return {
      valid: false,
      error: `Malformed envelope: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`,
    };
  }

  const env = result.data;

  // Anti-spoofing check against trusted ExecutionContext or verified agent ID
  if (trustedCaller) {
    const trustedId = typeof trustedCaller === 'string' ? trustedCaller : trustedCaller.agentId;
    if (env.senderAgentId !== trustedId) {
      return {
        valid: false,
        error: `Sender identity spoofing rejected: declared sender '${env.senderAgentId}', but verified trusted caller is '${trustedId}'`,
      };
    }

    if (typeof trustedCaller !== 'string') {
      if (env.senderDepartmentId !== trustedCaller.departmentId) {
        return {
          valid: false,
          error: `Sender department spoofing rejected: declared '${env.senderDepartmentId}', but caller is in '${trustedCaller.departmentId}'`,
        };
      }
    }
  }

  // Must have at least recipientAgentId or recipientDepartmentId
  if (!env.recipientAgentId && !env.recipientDepartmentId) {
    return {
      valid: false,
      error: 'Envelope must designate either a recipient agent ID or a recipient department destination',
    };
  }

  // Validate payload against message-type-specific schema
  const payloadValidation = validateMessagePayload(env.type, env.payload);
  if (!payloadValidation.valid) {
    return {
      valid: false,
      error: payloadValidation.error,
    };
  }

  return {
    valid: true,
    envelope: env,
  };
}
