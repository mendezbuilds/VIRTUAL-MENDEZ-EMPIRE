import { z } from 'zod';
import { DepartmentIdSchema, OrganizationalLevelSchema } from './organization.js';

/**
 * Authority Scopes defining boundary of action
 */
export const AuthorityScopeSchema = z.enum([
  'OWNER_ONLY',        // Reserved exclusively for Owner Stephen Mendez
  'EXECUTIVE_WIDE',    // Autonomous executive coordination across entire empire
  'DEPARTMENT_SCOPED', // Scoped strictly to agent's own department
  'SPECIALIST_LOCAL',  // Scoped to direct task execution only
]);

export type AuthorityScope = z.infer<typeof AuthorityScopeSchema>;

/**
 * Canonical Owner Principal ID
 * Unique identifier for the human Owner authority principal outside the 30-agent AI workforce registry.
 */
export const OWNER_PRINCIPAL_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Owner Principal Schema
 * Represents the human Owner (Stephen Mendez) as a distinct authority principal
 * outside the 30-agent corporate workforce registry.
 */
export const OwnerPrincipalSchema = z.object({
  principalId: z.string().uuid(),
  principalType: z.literal('HUMAN_OWNER'),
  name: z.string().min(1),
  title: z.string().min(1),
  authorityScope: z.literal('OWNER_ONLY'),
  email: z.string().email(),
  isActive: z.boolean().default(true),
  authorizedCapabilities: z.array(z.string().min(1)),
  registeredAt: z.string().datetime(),
});

export type OwnerPrincipal = z.infer<typeof OwnerPrincipalSchema>;

/**
 * Canonical Owner Principal Record
 */
export const CANONICAL_OWNER_PRINCIPAL: OwnerPrincipal = {
  principalId: OWNER_PRINCIPAL_ID,
  principalType: 'HUMAN_OWNER',
  name: 'Stephen Mendez',
  title: 'Owner & Founder',
  authorityScope: 'OWNER_ONLY',
  email: 'stephen@virtualmendezempire.internal',
  isActive: true,
  authorizedCapabilities: [
    'strategic_directives',
    'capital_allocation_approval',
    'consequential_action_authorization',
    'governance_overrides',
    'emergency_shutdown_and_recovery',
    'workforce_supervision',
  ],
  registeredAt: '2026-01-01T00:00:00.000Z',
};

/**
 * Helper to test if a given principal ID belongs to the human Owner.
 */
export function isOwnerPrincipal(principalId: string): boolean {
  return principalId === OWNER_PRINCIPAL_ID;
}

/**
 * Returns the canonical Owner principal record.
 */
export function getOwnerPrincipal(): OwnerPrincipal {
  return CANONICAL_OWNER_PRINCIPAL;
}

/**
 * Credential Resolution Context Schema
 * Explicit architectural boundary: Schema validation strictly models and validates credential references
 * (e.g. environment variable names or secret vault URIs).
 * Decrypting or resolving a secret reference to an actual runtime credential is an independent operation
 * guarded by security governance and authorized execution clearance.
 */
export const CredentialResolverContextSchema = z.object({
  requesterAgentId: z.string().uuid(),
  requesterLevel: OrganizationalLevelSchema,
  credentialReference: z.string().min(1),
  purpose: z.string().min(1),
  environment: z.enum(['DEVELOPMENT', 'TEST', 'PRODUCTION']).default('PRODUCTION'),
  authorizedAt: z.string().datetime(),
});

export type CredentialResolverContext = z.infer<typeof CredentialResolverContextSchema>;

/**
 * Consequential and Restricted Action Classification.
 * Any action classified here CANNOT execute autonomously without explicit Owner authorization.
 * Executive or CEO status NEVER grants permission to execute or autonomously authorize these actions.
 */
export const RestrictedActionTypeSchema = z.enum([
  'EXTERNAL_COMMUNICATION',       // Sending cold emails, social posts, public releases
  'JOB_APPLICATION_SUBMISSION',   // Submitting job applications or proposals on Owner behalf
  'BINDING_CONTRACT_ACCEPTANCE',  // Signing or committing to legal/commercial agreements
  'CAPITAL_TRANSFER',             // Moving real funds or treasury capital
  'LIVE_TRADING_EXECUTION',       // Real-money FX/Crypto/Stock order execution
  'SPENDING_EXCEEDING_LIMIT',     // Department expenditure exceeding approved monthly budget
  'GOVERNANCE_OVERRIDE',          // Modifying core system constraints or policies
  'EMERGENCY_SHUTDOWN_OVERRIDE',  // Resuming operations without verified health check
  'PERMISSION_ELEVATION',         // Granting higher privileges to self or other agents
]);

export type RestrictedActionType = z.infer<typeof RestrictedActionTypeSchema>;

/**
 * Mandatory Prohibited Actions for ALL AI employees (including Executive leadership / CEO)
 */
export const MANDATORY_PROHIBITED_FOR_ALL_AGENTS: RestrictedActionType[] = [
  'CAPITAL_TRANSFER',
  'LIVE_TRADING_EXECUTION',
  'BINDING_CONTRACT_ACCEPTANCE',
  'GOVERNANCE_OVERRIDE',
  'PERMISSION_ELEVATION',
];

/**
 * Fine-grained Permission Specification
 */
export const PermissionSchema = z.string().min(1).regex(/^[a-z0-9_-]+:[a-z0-9_*]+$/, {
  message: "Permission must match format 'resource:action' (e.g. 'ledger:post', 'task:create', 'dept:*')",
});

export type Permission = z.infer<typeof PermissionSchema>;

/**
 * Permission Profile defining an agent's operational boundaries.
 * CEO and Executive authority remain strictly subordinate to Owner authority.
 */
export const PermissionProfileSchema = z.object({
  profileId: z.string().uuid(),
  profileCode: z.string().min(1),
  name: z.string().min(1),
  scope: AuthorityScopeSchema,
  allowedPermissions: z.array(z.string().min(1)),
  maxBudgetApprovalUsd: z.number().nonnegative().default(0),
  maxDelegationDepth: z.number().int().min(0).max(5).default(0),
  prohibitedRestrictedActions: z.array(RestrictedActionTypeSchema).default(MANDATORY_PROHIBITED_FOR_ALL_AGENTS),
  requiresOwnerAuthorizationFor: z.array(RestrictedActionTypeSchema).default([
    'EXTERNAL_COMMUNICATION',
    'JOB_APPLICATION_SUBMISSION',
    'SPENDING_EXCEEDING_LIMIT',
    'EMERGENCY_SHUTDOWN_OVERRIDE',
  ]),
  canAuthorizeSubordinates: z.boolean().default(false),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type PermissionProfile = z.infer<typeof PermissionProfileSchema>;

/**
 * Approval Requirement Rule
 */
export const ApprovalRequirementSchema = z.object({
  actionType: RestrictedActionTypeSchema,
  minimumApproverLevel: OrganizationalLevelSchema,
  requiresOwnerApproval: z.boolean(),
  financialThresholdUsd: z.number().nonnegative().optional(),
  description: z.string().min(1),
});

export type ApprovalRequirement = z.infer<typeof ApprovalRequirementSchema>;

/**
 * Canonical Approval Requirements Table
 */
export const CANONICAL_APPROVAL_REQUIREMENTS: ApprovalRequirement[] = [
  {
    actionType: 'LIVE_TRADING_EXECUTION',
    minimumApproverLevel: 'OWNER',
    requiresOwnerApproval: true,
    description: 'Live financial execution is barred; requires Owner hardware/key approval',
  },
  {
    actionType: 'CAPITAL_TRANSFER',
    minimumApproverLevel: 'OWNER',
    requiresOwnerApproval: true,
    financialThresholdUsd: 0,
    description: 'Any real-money capital transfer requires explicit Owner authorization',
  },
  {
    actionType: 'BINDING_CONTRACT_ACCEPTANCE',
    minimumApproverLevel: 'OWNER',
    requiresOwnerApproval: true,
    description: 'Binding contracts and agreements require Owner legal review and sign-off',
  },
  {
    actionType: 'JOB_APPLICATION_SUBMISSION',
    minimumApproverLevel: 'OWNER',
    requiresOwnerApproval: true,
    description: 'Job applications and career submissions for Stephen Mendez require Owner review',
  },
  {
    actionType: 'EXTERNAL_COMMUNICATION',
    minimumApproverLevel: 'OWNER',
    requiresOwnerApproval: true,
    description: 'Outbound emails, cold messages, and public announcements require Owner review',
  },
  {
    actionType: 'SPENDING_EXCEEDING_LIMIT',
    minimumApproverLevel: 'OWNER',
    requiresOwnerApproval: true,
    description: 'Expenditure exceeding department monthly budget requires Owner approval',
  },
  {
    actionType: 'GOVERNANCE_OVERRIDE',
    minimumApproverLevel: 'OWNER',
    requiresOwnerApproval: true,
    description: 'Modifying core architectural rules or permissions requires Owner authorization',
  },
  {
    actionType: 'EMERGENCY_SHUTDOWN_OVERRIDE',
    minimumApproverLevel: 'OWNER',
    requiresOwnerApproval: true,
    description: 'Clearing an active emergency kill switch requires verified Owner sign-off',
  },
  {
    actionType: 'PERMISSION_ELEVATION',
    minimumApproverLevel: 'OWNER',
    requiresOwnerApproval: true,
    description: 'Self-escalating permissions is strictly barred for all AI agents',
  },
];

/**
 * Owner Authorization Request Schema
 * Used when an agent attempts or prepares a restricted consequential action
 */
export const OwnerAuthorizationRequestSchema = z.object({
  requestId: z.string().uuid(),
  tenantId: z.string().uuid(),
  requestingAgentId: z.string().uuid(),
  requestingAgentCode: z.string(),
  requestingDepartmentId: DepartmentIdSchema,
  actionType: RestrictedActionTypeSchema,
  title: z.string().min(1).max(256),
  justification: z.string().min(1),
  payload: z.record(z.unknown()),
  riskAssessment: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  financialImpactUsd: z.number().nonnegative().optional(),
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED']).default('PENDING'),
  decidedBy: z.string().optional(),
  decisionNotes: z.string().optional(),
  requestedAt: z.string().datetime(),
  decidedAt: z.string().datetime().optional(),
  expiresAt: z.string().datetime().optional(),
});

export type OwnerAuthorizationRequest = z.infer<typeof OwnerAuthorizationRequestSchema>;

/**
 * Helper to test if an action requires explicit Owner Authorization
 */
export function requiresOwnerGate(
  actionType: RestrictedActionType,
  amountUsd?: number,
  departmentLimitUsd?: number
): boolean {
  if (actionType === 'SPENDING_EXCEEDING_LIMIT') {
    if (amountUsd !== undefined && departmentLimitUsd !== undefined) {
      return amountUsd > departmentLimitUsd;
    }
    return true;
  }
  const req = CANONICAL_APPROVAL_REQUIREMENTS.find((r) => r.actionType === actionType);
  return req ? req.requiresOwnerApproval : true;
}

/**
 * Validates whether an agent with a given profile can execute an action.
 * Enforces CEO and Executive subordination to Owner authority:
 * Even if an agent has EXECUTIVE_WIDE scope or wildcard permissions,
 * restricted actions NEVER execute without satisfying the Owner gate.
 */
export function validateAgentAction(
  profile: PermissionProfile,
  actionType?: RestrictedActionType,
  requestedPermission?: string
): { allowed: boolean; reason?: string; requiresOwnerReview?: boolean } {
  // 1. Prohibited restricted actions check: CANNOT be executed autonomously by ANY agent
  if (actionType && profile.prohibitedRestrictedActions.includes(actionType)) {
    return {
      allowed: false,
      reason: `Restricted action '${actionType}' is strictly prohibited for this agent profile (CEO/Executive authority remains subordinate to Owner)`,
      requiresOwnerReview: requiresOwnerGate(actionType),
    };
  }

  // 2. Requires Owner authorization check
  if (actionType && profile.requiresOwnerAuthorizationFor.includes(actionType)) {
    return {
      allowed: false,
      reason: `Restricted action '${actionType}' requires Owner authorization gate`,
      requiresOwnerReview: true,
    };
  }

  // 3. Permission string check if provided
  if (requestedPermission) {
    const hasWildcard = profile.allowedPermissions.includes('*');
    const hasPermission = profile.allowedPermissions.includes(requestedPermission);
    const hasNamespaceWildcard = profile.allowedPermissions.some((p) => {
      if (p.endsWith(':*')) {
        const ns = p.slice(0, -2);
        return requestedPermission.startsWith(`${ns}:`);
      }
      return false;
    });

    if (!hasWildcard && !hasPermission && !hasNamespaceWildcard) {
      return {
        allowed: false,
        reason: `Agent does not possess permission '${requestedPermission}'`,
      };
    }
  }

  return { allowed: true };
}

/**
 * Validates that an AI employee's permission profile does NOT hold prohibited Owner-level privileges.
 */
export function assertNonOwnerProfileValid(profile: PermissionProfile): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Non-Owner profiles cannot hold OWNER_ONLY scope
  if (profile.scope === 'OWNER_ONLY') {
    errors.push(`AI employee profile cannot be assigned 'OWNER_ONLY' authority scope`);
  }

  // Must include mandatory prohibited actions
  for (const prohibited of MANDATORY_PROHIBITED_FOR_ALL_AGENTS) {
    if (!profile.prohibitedRestrictedActions.includes(prohibited)) {
      errors.push(`Profile must include '${prohibited}' in prohibitedRestrictedActions`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
