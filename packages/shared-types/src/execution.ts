import { z } from 'zod';
import { DepartmentIdSchema } from './organization.js';

/**
 * Trusted Execution Context for runtime agent invocations
 */
export const ExecutionContextSchema = z.object({
  contextId: z.string().uuid(),
  agentId: z.string().uuid(),
  agentCode: z.string(),
  departmentId: DepartmentIdSchema,
  tenantId: z.string().uuid(),
  callerVerified: z.boolean().default(false),
  callerSignature: z.string().optional(),
  environment: z.enum(['SANDBOX', 'PRODUCTION', 'TEST']).default('PRODUCTION'),
  traceId: z.string().uuid(),
  spanId: z.string().optional(),
  initiatedAt: z.string().datetime(),
  timeoutMs: z.number().int().positive().default(60000),
});

export type ExecutionContext = z.infer<typeof ExecutionContextSchema>;

/**
 * Standardized Failure Classification
 */
export const FailureClassificationSchema = z.enum([
  'TRANSIENT_NETWORK',           // Network drop, retryable
  'LLM_RATE_LIMIT',              // Upstream LLM rate limit, exponential backoff
  'TOOL_EXECUTION_ERROR',        // Deterministic tool error
  'PERMISSION_DENIED',           // Unauthorized action attempt
  'VALIDATION_ERROR',            // Malformed data / schema mismatch
  'CIRCUIT_BREAKER_HALTED',      // Emergency halt active
  'CONSEQUENTIAL_ACTION_BLOCKED',// Action quarantined pending Owner gate
  'TIMEOUT',                     // Execution deadline exceeded
  'UNKNOWN',                     // Unclassified failure
]);

export type FailureClassification = z.infer<typeof FailureClassificationSchema>;

/**
 * Retry Policy Configuration
 */
export const RetryPolicySchema = z.object({
  maxRetries: z.number().int().min(0).max(10).default(3),
  backoffStrategy: z.enum(['FIXED', 'EXPONENTIAL']).default('EXPONENTIAL'),
  initialDelayMs: z.number().int().positive().default(1000),
  maxDelayMs: z.number().int().positive().default(30000),
  retryableFailures: z.array(FailureClassificationSchema).default([
    'TRANSIENT_NETWORK',
    'LLM_RATE_LIMIT',
  ]),
});

export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

/**
 * Execution Result Contract
 */
export const ExecutionResultSchema = z.object({
  executionId: z.string().uuid(),
  taskId: z.string().uuid(),
  agentId: z.string().uuid(),
  agentCode: z.string().optional(),
  status: z.enum(['SUCCESS', 'FAILURE', 'INTERRUPTED']),
  durationMs: z.number().nonnegative(),
  tokensUsed: z.number().int().nonnegative().default(0),
  outputData: z.record(z.unknown()).optional(),
  failureClassification: FailureClassificationSchema.optional(),
  errorMessage: z.string().optional(),
  executedAt: z.string().datetime(),
});

export type ExecutionResult = z.infer<typeof ExecutionResultSchema>;

/**
 * Escalation Event Contract
 */
export const EscalationEventSchema = z.object({
  eventId: z.string().uuid(),
  sourceExecutionId: z.string().uuid().optional(),
  taskId: z.string().uuid().optional(),
  originatingAgentId: z.string().uuid(),
  originatingAgentCode: z.string().optional(),
  targetRecipientId: z.string().uuid(),
  escalationTier: z.enum(['SUPERVISOR', 'DIRECTOR', 'EXECUTIVE', 'OWNER']),
  reason: z.string().min(1),
  failureClassification: FailureClassificationSchema.optional(),
  metadata: z.record(z.unknown()).default({}),
  timestamp: z.string().datetime(),
});

export type EscalationEvent = z.infer<typeof EscalationEventSchema>;
