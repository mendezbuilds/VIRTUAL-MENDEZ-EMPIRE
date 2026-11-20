import { randomUUID, createHmac } from 'node:crypto';
import {
  transferAgentDepartment,
  type AgentRecord,
  type AgentSupervisor,
  type Department,
  type DepartmentId,
  type DepartmentTransferRecord,
} from '@vme/shared-types';
import type { HierarchyTree } from './hierarchy-tree.js';
import { UnauthorizedHierarchyActionError } from './delegation-rules.js';

export interface AuthoritativeTransferRecord extends DepartmentTransferRecord {
  agentId: string;
  agentCode: string;
}

export function computeTransferAuthorizationSignature(
  record: {
    transferId: string;
    agentId: string;
    agentCode: string;
    fromDepartmentId: DepartmentId;
    toDepartmentId: DepartmentId;
    effectiveDate: string;
    authorizedBy: string;
    reason?: string;
  },
  secret: string = process.env.DB_SESSION_SECRET || 'vme-canonical-hierarchy-authority-secret-2026'
): string {
  const canonical = [
    'TRANSFER_AUTH_V1',
    record.transferId,
    record.agentId,
    record.agentCode,
    record.fromDepartmentId,
    record.toDepartmentId,
    record.effectiveDate,
    record.authorizedBy,
    record.reason ?? '',
  ].join(':');
  return createHmac('sha256', secret).update(canonical).digest('hex');
}

export function verifyTransferAuthorizationSignature(
  agentId: string,
  agentCode: string,
  record: DepartmentTransferRecord,
  secret: string = process.env.DB_SESSION_SECRET || 'vme-canonical-hierarchy-authority-secret-2026'
): boolean {
  if (!record.authorizationSignature || typeof record.authorizationSignature !== 'string') {
    return false;
  }
  const expectedSig = computeTransferAuthorizationSignature(
    {
      transferId: record.transferId,
      agentId,
      agentCode,
      fromDepartmentId: record.fromDepartmentId,
      toDepartmentId: record.toDepartmentId,
      effectiveDate: record.effectiveDate,
      authorizedBy: record.authorizedBy,
      reason: record.reason,
    },
    secret
  );
  return record.authorizationSignature === expectedSig;
}

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
 * tree re-linking, cryptographic authorization, and authoritative registry tracking.
 */
export class DepartmentTransferCoordinator {
  private readonly transferHistory: AuthoritativeTransferRecord[] = [];

  constructor(
    private readonly departments: Map<DepartmentId, Department>,
    private readonly agents: Map<string, AgentRecord>,
    private readonly tree: HierarchyTree
  ) {}

  /**
   * Returns authoritative department transfer history recorded by this hierarchy.
   */
  getTransferHistory(agentIdOrCode?: string): AuthoritativeTransferRecord[] {
    if (agentIdOrCode) {
      return this.transferHistory.filter(
        (t) => t.agentId === agentIdOrCode || t.agentCode === agentIdOrCode
      );
    }
    return [...this.transferHistory];
  }

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

    const transferId = randomUUID();
    const effectiveDate = params.effectiveDate ?? new Date().toISOString();
    const secret = process.env.DB_SESSION_SECRET || 'vme-canonical-hierarchy-authority-secret-2026';
    const signature = computeTransferAuthorizationSignature(
      {
        transferId,
        agentId: currentRecord.id,
        agentCode: currentRecord.agentCode,
        fromDepartmentId: currentRecord.departmentId,
        toDepartmentId: params.toDepartmentId,
        effectiveDate,
        authorizedBy: params.authorizedBy,
        reason: params.reason,
      },
      secret
    );

    // 3. Delegate to M2.1 transferAgentDepartment() for strict validation:
    // - Destination existence
    // - Authorization anchoring to canonical founding executives or Owner
    // - Strict SemVer progression
    // - Strictly advancing timestamps
    // - Frozen transfer record with cryptographic signature
    // - Immutable origin preservation
    const updatedRecord = transferAgentDepartment(currentRecord, {
      transferId,
      authorizationSignature: signature,
      toDepartmentId: params.toDepartmentId,
      reason: params.reason,
      authorizedBy: params.authorizedBy,
      effectiveDate,
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

    const latestTransfer =
      updatedRecord.currentConfig.departmentTransferHistory[
        updatedRecord.currentConfig.departmentTransferHistory.length - 1
      ]!;

    this.transferHistory.push(
      Object.freeze({
        ...latestTransfer,
        agentId: currentRecord.id,
        agentCode: currentRecord.agentCode,
      })
    );

    return updatedRecord;
  }
}
