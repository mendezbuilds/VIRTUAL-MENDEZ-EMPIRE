import {
  OWNER_PRINCIPAL_ID,
  CANONICAL_OWNER_PRINCIPAL,
  type MemoryAccessPrincipal,
  type MemoryScope,
} from '@vme/shared-types';

export class UnauthorizedMemoryAccessError extends Error {
  constructor(message: string) {
    super(`MEMORY ACCESS DENIED: ${message}`);
    this.name = 'UnauthorizedMemoryAccessError';
  }
}

export type MemoryOperation = 'READ' | 'WRITE' | 'UPDATE' | 'DELETE' | 'CONSOLIDATE';

export interface MemoryAccessTarget {
  scope: MemoryScope;
  agentId?: string;
  authorAgentId?: string;
  departmentId?: string;
}

/**
 * Centralized Attribute-Based Access Controller (ABAC) for Multi-Tier Agent Memory.
 * Enforces boundary isolation across AGENT_PRIVATE, DEPARTMENT_SCOPED, and ORGANIZATION_WIDE.
 * Seniority alone does not grant access.
 */
export class MemoryAccessController {
  /**
   * Asserts that a principal is authorized to perform the requested operation on a target memory item.
   * Throws UnauthorizedMemoryAccessError if access is denied.
   */
  static assertAccess(
    principal: MemoryAccessPrincipal,
    target: MemoryAccessTarget,
    operation: MemoryOperation
  ): void {
    const isOwner =
      principal.principalType === 'OWNER_PRINCIPAL' ||
      principal.principalId === OWNER_PRINCIPAL_ID ||
      principal.principalId === CANONICAL_OWNER_PRINCIPAL.principalId;

    // 1. Inactive agents are strictly barred
    if (!isOwner && !principal.isActive) {
      throw new UnauthorizedMemoryAccessError(
        `Agent '${principal.principalId}' is inactive and cannot perform memory operation '${operation}'.`
      );
    }

    // 2. Owner Principal has ultimate governance and audit authority
    if (isOwner) {
      return;
    }

    const isExecutive = principal.level === 'EXECUTIVE';
    const isDirector = principal.level === 'DIRECTOR';
    const owningAgentId = target.agentId ?? target.authorAgentId;

    // 3. AGENT_PRIVATE Memory Scope
    if (target.scope === 'AGENT_PRIVATE') {
      // Accessible exclusively by the owning agent
      if (owningAgentId && principal.principalId === owningAgentId) {
        return;
      }
      throw new UnauthorizedMemoryAccessError(
        `Access to AGENT_PRIVATE memory owned by '${owningAgentId}' is denied to agent '${principal.principalId}' (${principal.level}). Seniority does not override private memory boundaries.`
      );
    }

    // 4. DEPARTMENT_SCOPED Memory Scope
    if (target.scope === 'DEPARTMENT_SCOPED') {
      const isSameDepartment = Boolean(
        principal.departmentId && target.departmentId && principal.departmentId === target.departmentId
      );

      // Read access: permitted to agents in the same department, or Executive Office
      if (operation === 'READ') {
        if (isSameDepartment || isExecutive) {
          return;
        }
        throw new UnauthorizedMemoryAccessError(
          `Agent '${principal.principalId}' in department '${principal.departmentId}' cannot read DEPARTMENT_SCOPED memory belonging to '${target.departmentId}'.`
        );
      }

      // Write/Update/Delete/Consolidate: permitted within department
      if (isSameDepartment) {
        if (operation === 'CONSOLIDATE' || operation === 'DELETE') {
          // Consolidation and deletion within department requires Director or Executive authority
          if (isDirector || isExecutive) {
            return;
          }
          throw new UnauthorizedMemoryAccessError(
            `Operation '${operation}' on DEPARTMENT_SCOPED memory requires Director or Executive authority. Agent '${principal.principalId}' is a '${principal.level}'.`
          );
        }
        return;
      }

      // Executives can oversee across departments
      if (isExecutive) {
        return;
      }

      throw new UnauthorizedMemoryAccessError(
        `Operation '${operation}' on DEPARTMENT_SCOPED memory for department '${target.departmentId}' is denied to agent '${principal.principalId}' (${principal.departmentId}).`
      );
    }

    // 5. ORGANIZATION_WIDE Memory Scope
    if (target.scope === 'ORGANIZATION_WIDE') {
      // Universal read for all active workforce agents
      if (operation === 'READ') {
        return;
      }

      // Write, Update, Delete, Consolidate strictly restricted to Executive Office or Owner
      if (isExecutive) {
        return;
      }

      throw new UnauthorizedMemoryAccessError(
        `Operation '${operation}' on ORGANIZATION_WIDE memory strictly requires Executive Office or Owner authorization. Agent '${principal.principalId}' is a '${principal.level}'.`
      );
    }

    throw new UnauthorizedMemoryAccessError(`Unknown memory scope: '${target.scope}'`);
  }
}
