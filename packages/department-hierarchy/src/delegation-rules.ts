import type {
  AgentRecord,
  AgentSpec,
  Department,
  OrganizationalLevel,
} from '@vme/shared-types';

export class UnauthorizedHierarchyActionError extends Error {
  constructor(message: string) {
    super(`HIERARCHY VIOLATION: ${message}`);
    this.name = 'UnauthorizedHierarchyActionError';
  }
}

export interface DelegationValidationResult {
  allowed: boolean;
  reason?: string;
}

const TIER_WEIGHTS: Record<string, number> = {
  OWNER: 5,
  EXECUTIVE: 4,
  executive: 4,
  DIRECTOR: 3,
  director: 3,
  MANAGER: 2,
  manager: 2,
  SPECIALIST: 1,
  specialist: 1,
  OPERATOR: 0,
  operator: 0,
};

/**
 * Corporate Delegation Rule Engine
 * Enforces seniority, departmental boundaries, and capability gating.
 */
export class DelegationRuleEngine {
  /**
   * Validates corporate reporting hierarchy and delegation authority between two agents.
   * Compatible with both AgentRecord (Phase 2) and AgentSpec (Phase 1).
   */
  validateDelegation(
    sender: AgentRecord | AgentSpec,
    recipient: AgentRecord | AgentSpec
  ): DelegationValidationResult {
    const senderTier = (sender as any).level ?? (sender as any).tier;
    const recipientTier = (recipient as any).level ?? (recipient as any).tier;
    const senderName = (sender as any).displayName ?? (sender as any).name;
    const recipientName = (recipient as any).displayName ?? (recipient as any).name;
    const senderDept = (sender as any).departmentId;
    const recipientDept = (recipient as any).departmentId;

    const senderWeight = TIER_WEIGHTS[senderTier] ?? 0;
    const recipientWeight = TIER_WEIGHTS[recipientTier] ?? 0;

    // 1. Executive can delegate to any Director, Manager or Specialist across any department
    if (senderTier === 'EXECUTIVE' || senderTier === 'executive' || senderTier === 'OWNER') {
      return { allowed: true };
    }

    // 2. A subordinate can NEVER delegate tasks upward to a more senior role
    if (senderWeight < recipientWeight) {
      return {
        allowed: false,
        reason: `${senderName} (${senderTier}) cannot delegate to senior role ${recipientName} (${recipientTier})`,
      };
    }

    // 3. Same department delegation (downward or peer consultation)
    if (senderDept === recipientDept) {
      return { allowed: true };
    }

    // 4. Cross-department delegation: Only Directors (or Executives) can initiate cross-department collaboration
    if (senderTier === 'DIRECTOR' || senderTier === 'director') {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: `Cross-department delegation requires Department Director authority. ${senderName} is a ${senderTier}.`,
    };
  }

  /**
   * Asserts that an agent's department is authorized for a specified capability.
   */
  assertCapability(
    department: Department,
    requiredCapability: string,
    agentIdentifier?: string
  ): void {
    if (
      !department.allowedCapabilities.includes(requiredCapability) &&
      !department.allowedCapabilities.includes('*')
    ) {
      const agentCtx = agentIdentifier ? ` for agent '${agentIdentifier}'` : '';
      throw new UnauthorizedHierarchyActionError(
        `Capability '${requiredCapability}' is not authorized for department '${department.name}'${agentCtx}.`
      );
    }
  }
}
