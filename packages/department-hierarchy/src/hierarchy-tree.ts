import {
  compareOrganizationalLevels,
  OWNER_PRINCIPAL_ID,
  type AgentRecord,
  type OrganizationalLevel,
} from '@vme/shared-types';

export interface HierarchyNode {
  agentId: string;
  agentCode: string;
  record: AgentRecord;
  supervisorId: string | null;
  supervisorCode?: string;
  reportsToOwner: boolean;
  directReportIds: Set<string>;
}

/**
 * Directed acyclic reporting graph representing corporate reporting lines
 * across the AI workforce, anchored by the CEO reporting to the human Owner.
 */
export class HierarchyTree {
  private readonly nodesById = new Map<string, HierarchyNode>();
  private readonly idByCode = new Map<string, string>();

  constructor(agents: AgentRecord[]) {
    // 1. Initialize nodes
    for (const agent of agents) {
      const isOwnerReport =
        agent.supervisor.reportsToOwner ||
        agent.supervisor.supervisorType === 'OWNER_PRINCIPAL';

      const node: HierarchyNode = {
        agentId: agent.id,
        agentCode: agent.agentCode,
        record: agent,
        supervisorId: isOwnerReport ? null : agent.supervisor.supervisorAgentId,
        supervisorCode: agent.supervisor.supervisorAgentCode,
        reportsToOwner: isOwnerReport,
        directReportIds: new Set<string>(),
      };

      this.nodesById.set(agent.id, node);
      this.idByCode.set(agent.agentCode, agent.id);
    }

    // 2. Build outbound direct report edges
    for (const node of this.nodesById.values()) {
      if (node.supervisorId) {
        const supervisorNode = this.nodesById.get(node.supervisorId);
        if (supervisorNode) {
          supervisorNode.directReportIds.add(node.agentId);
        }
      }
    }
  }

  /**
   * Resolves an agent identifier or code to internal UUID.
   */
  private resolveId(idOrCode: string): string | null {
    if (this.nodesById.has(idOrCode)) {
      return idOrCode;
    }
    return this.idByCode.get(idOrCode) ?? null;
  }

  /**
   * Gets an AgentRecord by ID or agent code.
   */
  getAgent(idOrCode: string): AgentRecord | null {
    const id = this.resolveId(idOrCode);
    if (!id) return null;
    return this.nodesById.get(id)?.record ?? null;
  }

  /**
   * Gets the supervisor for an agent.
   * Returns 'OWNER_PRINCIPAL' for EXEC-CEO, the supervisor's AgentRecord for others,
   * or null if the agent does not exist or has no supervisor.
   */
  getSupervisor(idOrCode: string): AgentRecord | 'OWNER_PRINCIPAL' | null {
    const id = this.resolveId(idOrCode);
    if (!id) return null;

    const node = this.nodesById.get(id);
    if (!node) return null;

    if (node.reportsToOwner) {
      return 'OWNER_PRINCIPAL';
    }

    if (!node.supervisorId) {
      return null;
    }

    const supNode = this.nodesById.get(node.supervisorId);
    return supNode?.record ?? null;
  }

  /**
   * Gets all direct reports for an agent.
   */
  getDirectReports(idOrCode: string): AgentRecord[] {
    const id = this.resolveId(idOrCode);
    if (!id) return [];

    const node = this.nodesById.get(id);
    if (!node) return [];

    const reports: AgentRecord[] = [];
    for (const reportId of node.directReportIds) {
      const reportNode = this.nodesById.get(reportId);
      if (reportNode) {
        reports.push(reportNode.record);
      }
    }
    return reports;
  }

  /**
   * Gets the management chain (bottom-up path from immediate supervisor up to EXEC-CEO).
   * For EXEC-CEO, returns [] because CEO reports directly to the human Owner principal.
   */
  getManagementChain(idOrCode: string): AgentRecord[] {
    const id = this.resolveId(idOrCode);
    if (!id) return [];

    const chain: AgentRecord[] = [];
    const visited = new Set<string>();
    let currentId = id;

    while (currentId) {
      if (visited.has(currentId)) {
        break; // Cycle safeguard
      }
      visited.add(currentId);

      const node = this.nodesById.get(currentId);
      if (!node || node.reportsToOwner || !node.supervisorId) {
        break;
      }

      const supNode = this.nodesById.get(node.supervisorId);
      if (!supNode) {
        break;
      }

      chain.push(supNode.record);
      currentId = supNode.agentId;
    }

    return chain;
  }

  /**
   * Returns true if descendant is anywhere downstream in ancestor's reporting tree.
   */
  isSubordinate(ancestorIdOrCode: string, descendantIdOrCode: string): boolean {
    const ancestorId = this.resolveId(ancestorIdOrCode);
    const descendantId = this.resolveId(descendantIdOrCode);
    if (!ancestorId || !descendantId || ancestorId === descendantId) {
      return false;
    }

    const managementChain = this.getManagementChain(descendantId);
    return managementChain.some((m) => m.id === ancestorId);
  }

  /**
   * Finds the lowest common supervisor for two agents.
   */
  findCommonSupervisor(
    agentAIdOrCode: string,
    agentBIdOrCode: string
  ): AgentRecord | 'OWNER_PRINCIPAL' | null {
    const idA = this.resolveId(agentAIdOrCode);
    const idB = this.resolveId(agentBIdOrCode);
    if (!idA || !idB) return null;

    if (idA === idB) {
      return this.getSupervisor(idA);
    }

    const nodeA = this.nodesById.get(idA);
    const nodeB = this.nodesById.get(idB);
    if (!nodeA || !nodeB) return null;

    // If both report directly to Owner (or both are CEO)
    if (nodeA.reportsToOwner && nodeB.reportsToOwner) {
      return 'OWNER_PRINCIPAL';
    }

    // If one is the supervisor of the other
    if (this.isSubordinate(idA, idB)) {
      return nodeA.record;
    }
    if (this.isSubordinate(idB, idA)) {
      return nodeB.record;
    }

    // Build ancestor sets
    const ancestorsA = [idA, ...this.getManagementChain(idA).map((a) => a.id)];
    const ancestorsBSet = new Set<string>([idB, ...this.getManagementChain(idB).map((b) => b.id)]);

    for (const ancId of ancestorsA) {
      if (ancestorsBSet.has(ancId) && ancId !== idA && ancId !== idB) {
        return this.nodesById.get(ancId)?.record ?? null;
      }
    }

    // Both eventually terminate at the human Owner
    return 'OWNER_PRINCIPAL';
  }

  /**
   * Detects all cycles in the reporting graph.
   * Returns array of cycle paths, each as array of agent codes.
   */
  detectCycles(): string[][] {
    const cycles: string[][] = [];
    const visited = new Set<string>();

    for (const startNode of this.nodesById.values()) {
      const path: string[] = [];
      const pathSet = new Set<string>();
      let current: HierarchyNode | undefined = startNode;

      while (current && current.supervisorId && !current.reportsToOwner) {
        if (pathSet.has(current.agentId)) {
          // Cycle found
          const cycleStartIndex = path.indexOf(current.agentCode);
          const cyclePath = [...path.slice(cycleStartIndex), current.agentCode];
          cycles.push(cyclePath);
          break;
        }

        path.push(current.agentCode);
        pathSet.add(current.agentId);
        current = this.nodesById.get(current.supervisorId);
      }
    }

    return cycles;
  }

  /**
   * Validates the integrity of the hierarchy tree against corporate rules.
   */
  validateTree(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // 1. CEO-only Owner reporting check
    let ceoCount = 0;
    for (const node of this.nodesById.values()) {
      if (node.reportsToOwner) {
        ceoCount++;
        if (node.agentCode !== 'EXEC-CEO' || node.record.level !== 'EXECUTIVE') {
          errors.push(
            `Unauthorized Owner reporting: agent ${node.agentCode} (${node.record.level}) reports to Owner; only EXEC-CEO may report to Owner`
          );
        }
      }
    }
    if (ceoCount === 0) {
      errors.push('Missing CEO Owner reporting: no agent is configured to report to Owner');
    }

    // 2. Supervisor resolution & seniority
    for (const node of this.nodesById.values()) {
      if (node.reportsToOwner) continue;

      if (!node.supervisorId) {
        errors.push(`Agent ${node.agentCode} has no supervisor and does not report to Owner`);
        continue;
      }

      const supNode = this.nodesById.get(node.supervisorId);
      if (!supNode) {
        errors.push(`Agent ${node.agentCode} references non-existent supervisor ID: ${node.supervisorId}`);
        continue;
      }

      // Seniority check
      if (compareOrganizationalLevels(supNode.record.level, node.record.level) > 0) {
        errors.push(
          `Hierarchy seniority violation: ${node.agentCode} (${node.record.level}) reports to less senior ${supNode.agentCode} (${supNode.record.level})`
        );
      }

      // Specialist department alignment check
      if (node.record.level === 'SPECIALIST') {
        if (supNode.record.level !== 'EXECUTIVE' && supNode.record.departmentId !== node.record.departmentId) {
          errors.push(
            `Department supervisor mismatch: Specialist ${node.agentCode} in '${node.record.departmentId}' reports to ${supNode.agentCode} in different department '${supNode.record.departmentId}'`
          );
        }
      }
    }

    // 3. Cycle detection
    const cycles = this.detectCycles();
    if (cycles.length > 0) {
      for (const cycle of cycles) {
        errors.push(`Circular reporting relationship detected: ${cycle.join(' -> ')}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Updates an existing node's AgentRecord and edges.
   */
  updateAgentRecord(updatedRecord: AgentRecord): void {
    const existingNode = this.nodesById.get(updatedRecord.id);
    if (!existingNode) {
      throw new Error(`Cannot update agent ${updatedRecord.agentCode}: not found in hierarchy tree`);
    }

    // Remove from previous supervisor's direct reports if supervisor changed
    const newSupervisorId = updatedRecord.supervisor.reportsToOwner
      ? null
      : updatedRecord.supervisor.supervisorAgentId;

    if (existingNode.supervisorId && existingNode.supervisorId !== newSupervisorId) {
      const oldSup = this.nodesById.get(existingNode.supervisorId);
      if (oldSup) {
        oldSup.directReportIds.delete(updatedRecord.id);
      }
    }

    // Add to new supervisor's direct reports
    if (newSupervisorId && newSupervisorId !== existingNode.supervisorId) {
      const newSup = this.nodesById.get(newSupervisorId);
      if (newSup) {
        newSup.directReportIds.add(updatedRecord.id);
      }
    }

    existingNode.record = updatedRecord;
    existingNode.supervisorId = newSupervisorId;
    existingNode.supervisorCode = updatedRecord.supervisor.supervisorAgentCode;
    existingNode.reportsToOwner = Boolean(updatedRecord.supervisor.reportsToOwner);
  }

  /**
   * Re-links an agent's supervisor.
   */
  relinkSupervisor(agentId: string, newSupervisorId: string | null, reportsToOwner = false): void {
    const node = this.nodesById.get(agentId);
    if (!node) {
      throw new Error(`Agent ${agentId} not found in hierarchy tree`);
    }

    // Remove from old supervisor
    if (node.supervisorId) {
      const oldSup = this.nodesById.get(node.supervisorId);
      if (oldSup) {
        oldSup.directReportIds.delete(agentId);
      }
    }

    // Add to new supervisor
    if (newSupervisorId && !reportsToOwner) {
      const newSup = this.nodesById.get(newSupervisorId);
      if (!newSup) {
        throw new Error(`New supervisor ${newSupervisorId} not found in hierarchy tree`);
      }
      newSup.directReportIds.add(agentId);
      node.supervisorId = newSupervisorId;
      node.supervisorCode = newSup.agentCode;
      node.reportsToOwner = false;
    } else if (reportsToOwner) {
      node.supervisorId = null;
      node.supervisorCode = undefined;
      node.reportsToOwner = true;
    }
  }

  /**
   * Returns total count of tracked workforce nodes.
   */
  get size(): number {
    return this.nodesById.size;
  }

  /**
   * Returns all AgentRecords tracked in the tree.
   */
  getAllRecords(): AgentRecord[] {
    return Array.from(this.nodesById.values()).map((n) => n.record);
  }
}
