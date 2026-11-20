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
import {
  getHierarchyAuthoritySecret,
  verifyHierarchyAuthorization,
  ExecutiveAuthenticationService,
} from './hierarchy-authorizer.js';
import { OwnerAuthenticationService } from '@vme/security-governance';

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
  secret: string = getHierarchyAuthoritySecret()
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
  secret: string = getHierarchyAuthoritySecret()
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
  authorizedBy?: unknown;
  authorizerSession?: unknown;
  ownerSession?: unknown;
  executiveSession?: unknown;
  effectiveDate?: string;
  newJobTitle?: string;
  newSupervisor?: AgentSupervisor;
  newVersion?: string;
  ownerAuthService?: OwnerAuthenticationService;
  executiveAuthService?: ExecutiveAuthenticationService;
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
    private readonly tree: HierarchyTree,
    public readonly ownerAuthService?: OwnerAuthenticationService,
    public readonly executiveAuthService?: ExecutiveAuthenticationService
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
    // 1. Resolve agent BEFORE mutation
    const currentRecord =
      this.agents.get(params.agentIdOrCode) ??
      Array.from(this.agents.values()).find((a) => a.agentCode === params.agentIdOrCode);

    if (!currentRecord) {
      throw new UnauthorizedHierarchyActionError(`Agent '${params.agentIdOrCode}' not found`);
    }

    // 2. Validate destination department exists BEFORE mutation
    const targetDept = this.departments.get(params.toDepartmentId);
    if (!targetDept) {
      throw new UnauthorizedHierarchyActionError(`Unknown destination department '${params.toDepartmentId}'`);
    }

    // 3. Ensure securely provisioned DB_SESSION_SECRET exists BEFORE mutation
    const secret = getHierarchyAuthoritySecret();

    // 4. Authenticate the authorizing principal and verify authority BEFORE mutation
    const verifiedAuthorizer = verifyHierarchyAuthorization(
      params,
      'TRANSFER_AGENT',
      params.toDepartmentId,
      currentRecord,
      this.agents,
      secret,
      params.ownerAuthService ?? this.ownerAuthService,
      params.executiveAuthService ?? this.executiveAuthService
    );

    // 5. Generate transfer cryptographic signature
    const transferId = randomUUID();
    const effectiveDate = params.effectiveDate ?? new Date().toISOString();
    const signature = computeTransferAuthorizationSignature(
      {
        transferId,
        agentId: currentRecord.id,
        agentCode: currentRecord.agentCode,
        fromDepartmentId: currentRecord.departmentId,
        toDepartmentId: params.toDepartmentId,
        effectiveDate,
        authorizedBy: verifiedAuthorizer,
        reason: params.reason,
      },
      secret
    );

    // 6. Delegate to M2.1 transferAgentDepartment() for strict validation:
    // - Destination existence
    // - Strict SemVer progression
    // - Strictly advancing timestamps
    // - Frozen transfer record with cryptographic signature
    // - Immutable origin preservation
    const updatedRecord = transferAgentDepartment(currentRecord, {
      transferId,
      authorizationSignature: signature,
      toDepartmentId: params.toDepartmentId,
      reason: params.reason,
      authorizedBy: verifiedAuthorizer,
      effectiveDate,
      newJobTitle: params.newJobTitle,
      newSupervisor: params.newSupervisor,
      newVersion: params.newVersion,
      knownAgents: Array.from(this.agents.values()),
      knownDepartments: Array.from(this.departments.values()),
    });

    // 7. Update internal registry maps
    this.agents.set(updatedRecord.id, updatedRecord);

    // 8. Update hierarchy tree
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
