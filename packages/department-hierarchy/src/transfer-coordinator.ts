import {
  transferAgentDepartment,
  type AgentRecord,
  type AgentSupervisor,
  type Department,
  type DepartmentId,
} from '@vme/shared-types';
import type { HierarchyTree } from './hierarchy-tree.js';
import { UnauthorizedHierarchyActionError } from './delegation-rules.js';

export interface TransferAgentParams {
  agentIdOrCode: string;
  toDepartmentId: DepartmentId;
  reason: string;
  authorizedBy: string;
  effectiveDate?: string;
  newJobTitle?: string;
  newSupervisor?: AgentSupervisor;
  newVersion?: string;
}

/**
 * Coordinates runtime agent department transfers, ensuring unbroken audit history,
 * tree re-linking, and canonical authorization.
 */
export class DepartmentTransferCoordinator {
  constructor(
    private readonly departments: Map<DepartmentId, Department>,
    private readonly agents: Map<string, AgentRecord>,
    private readonly tree: HierarchyTree
  ) {}

  transferAgent(params: TransferAgentParams): AgentRecord {
    // 1. Resolve agent
    const currentRecord =
      this.agents.get(params.agentIdOrCode) ??
      Array.from(this.agents.values()).find((a) => a.agentCode === params.agentIdOrCode);

    if (!currentRecord) {
      throw new UnauthorizedHierarchyActionError(`Agent '${params.agentIdOrCode}' not found`);
    }

    // 2. Validate destination department exists
    const targetDept = this.departments.get(params.toDepartmentId);
    if (!targetDept) {
      throw new UnauthorizedHierarchyActionError(`Unknown destination department '${params.toDepartmentId}'`);
    }

    // 3. Delegate to M2.1 transferAgentDepartment() for strict validation:
    // - Destination existence
    // - Authorization anchoring to canonical founding executives or Owner
    // - Strict SemVer progression
    // - Strictly advancing timestamps
    // - Frozen transfer record
    // - Immutable origin preservation
    const updatedRecord = transferAgentDepartment(currentRecord, {
      toDepartmentId: params.toDepartmentId,
      reason: params.reason,
      authorizedBy: params.authorizedBy,
      effectiveDate: params.effectiveDate,
      newJobTitle: params.newJobTitle,
      newSupervisor: params.newSupervisor,
      newVersion: params.newVersion,
      knownAgents: Array.from(this.agents.values()),
      knownDepartments: Array.from(this.departments.values()),
    });

    // 4. Update internal registry maps
    this.agents.set(updatedRecord.id, updatedRecord);

    // 5. Update hierarchy tree
    this.tree.updateAgentRecord(updatedRecord);

    return updatedRecord;
  }
}
