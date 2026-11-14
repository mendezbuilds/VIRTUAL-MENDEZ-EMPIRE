import type { AgentSpec, Department, DepartmentId } from '@vme/shared-types';
import { INITIAL_DEPARTMENTS, INITIAL_WORKFORCE } from './default-roster.js';

export class UnauthorizedHierarchyActionError extends Error {
  constructor(message: string) {
    super(`HIERARCHY VIOLATION: ${message}`);
    this.name = 'UnauthorizedHierarchyActionError';
  }
}

export class DepartmentRegistry {
  private departments = new Map<DepartmentId, Department>();
  private agents = new Map<string, AgentSpec>();

  constructor(
    customDepartments: Department[] = INITIAL_DEPARTMENTS,
    customWorkforce: AgentSpec[] = INITIAL_WORKFORCE
  ) {
    for (const dept of customDepartments) {
      this.departments.set(dept.id, { ...dept });
    }
    for (const agent of customWorkforce) {
      this.agents.set(agent.id, { ...agent });
    }
  }

  getDepartment(id: DepartmentId): Department | null {
    return this.departments.get(id) ?? null;
  }

  listDepartments(): Department[] {
    return Array.from(this.departments.values());
  }

  getDepartmentDirector(departmentId: DepartmentId): AgentSpec | null {
    return (
      Array.from(this.agents.values()).find(
        (a) =>
          a.departmentId === departmentId &&
          (a.tier === 'director' || a.tier === 'executive') &&
          a.isActive
      ) ?? null
    );
  }

  getAgent(id: string): AgentSpec | null {
    return this.agents.get(id) ?? null;
  }

  listAgentsByDepartment(departmentId: DepartmentId): AgentSpec[] {
    return Array.from(this.agents.values()).filter(
      (a) => a.departmentId === departmentId && a.isActive
    );
  }

  getAllAgents(): AgentSpec[] {
    return Array.from(this.agents.values());
  }

  /**
   * Validates corporate reporting hierarchy and delegation authority.
   */
  validateDelegation(
    senderAgentId: string,
    recipientAgentId: string
  ): { allowed: boolean; reason?: string } {
    const sender = this.agents.get(senderAgentId);
    const recipient = this.agents.get(recipientAgentId);

    if (!sender) return { allowed: false, reason: `Sender agent ${senderAgentId} not found` };
    if (!recipient) return { allowed: false, reason: `Recipient agent ${recipientAgentId} not found` };

    const tierWeight: Record<AgentSpec['tier'], number> = {
      executive: 4,
      director: 3,
      manager: 2,
      specialist: 1,
      operator: 0,
    };

    const senderWeight = tierWeight[sender.tier];
    const recipientWeight = tierWeight[recipient.tier];

    // Executive can delegate to any Director or Manager across any department
    if (sender.tier === 'executive') {
      return { allowed: true };
    }

    // A lower tier can NEVER delegate tasks downward or upward to a higher tier
    if (senderWeight < recipientWeight) {
      return {
        allowed: false,
        reason: `${sender.name} (${sender.tier}) cannot delegate to senior role ${recipient.name} (${recipient.tier})`,
      };
    }

    // Same department delegation downward or peer
    if (sender.departmentId === recipient.departmentId) {
      return { allowed: true };
    }

    // Cross-department delegation: Only Directors can initiate cross-department collaboration requests
    if (sender.tier === 'director') {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: `Cross-department delegation requires Department Director authority. ${sender.name} is a ${sender.tier}.`,
    };
  }

  /**
   * Asserts that an agent's department is authorized for a specified capability.
   */
  assertCapability(agentId: string, requiredCapability: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new UnauthorizedHierarchyActionError(`Agent ${agentId} not found`);
    }

    const dept = this.departments.get(agent.departmentId);
    if (!dept) {
      throw new UnauthorizedHierarchyActionError(`Department ${agent.departmentId} not found`);
    }

    if (!dept.allowedCapabilities.includes(requiredCapability) && !dept.allowedCapabilities.includes('*')) {
      throw new UnauthorizedHierarchyActionError(
        `Capability '${requiredCapability}' is not authorized for department '${dept.name}'.`
      );
    }
  }
}
