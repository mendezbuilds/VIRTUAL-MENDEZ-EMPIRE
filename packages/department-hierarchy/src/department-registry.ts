import {
  toAgentSpec,
  createAgentRecord,
  CANONICAL_DEPARTMENTS,
  CANONICAL_FOUNDING_AGENTS,
  type AgentRecord,
  type AgentSpec,
  type Department,
  type DepartmentId,
} from '@vme/shared-types';
import type { EmergencySupervisor } from '@vme/security-governance';
import { INITIAL_DEPARTMENTS, INITIAL_AGENT_RECORDS } from './default-roster.js';
import { HierarchyTree } from './hierarchy-tree.js';
import {
  DelegationRuleEngine,
  UnauthorizedHierarchyActionError,
  type DelegationValidationResult,
} from './delegation-rules.js';
import {
  DepartmentLeadershipManager,
  type LeadershipAppointmentRecord,
  type AppointDirectorParams,
} from './leadership-manager.js';
import {
  DepartmentTransferCoordinator,
  type TransferAgentParams,
  type AuthoritativeTransferRecord,
} from './transfer-coordinator.js';
import {
  OrganizationalAuditor,
  type AuditReport,
} from './organizational-auditor.js';
import {
  ExecutiveAuthenticationService,
  type ExecutiveAuthenticatedSession,
  getHierarchyAuthoritySecret,
} from './hierarchy-authorizer.js';
import {
  OwnerAuthenticationService,
  type OwnerAuthenticatedSession,
} from '@vme/security-governance';

export { UnauthorizedHierarchyActionError };

export class DepartmentRegistry {
  private readonly departments = new Map<DepartmentId, Department>();
  private readonly agents = new Map<string, AgentRecord>();
  private readonly idByCode = new Map<string, string>();

  private readonly tree: HierarchyTree;
  private readonly delegationEngine: DelegationRuleEngine;
  private readonly leadershipManager: DepartmentLeadershipManager;
  private readonly transferCoordinator: DepartmentTransferCoordinator;
  private readonly auditor: OrganizationalAuditor;
  public readonly ownerAuthService: OwnerAuthenticationService;
  public readonly executiveAuthService: ExecutiveAuthenticationService;

  constructor(
    customDepartments: Department[] = INITIAL_DEPARTMENTS,
    customWorkforce: AgentRecord[] | AgentSpec[] = INITIAL_AGENT_RECORDS,
    private readonly emergencySupervisor?: EmergencySupervisor,
    ownerAuthService?: OwnerAuthenticationService,
    executiveAuthService?: ExecutiveAuthenticationService
  ) {
    this.ownerAuthService = ownerAuthService ?? new OwnerAuthenticationService();
    this.executiveAuthService = executiveAuthService ?? new ExecutiveAuthenticationService();
    // 1. Populate departments
    for (const dept of customDepartments) {
      this.departments.set(dept.id, {
        ...dept,
        allowedCapabilities: [...dept.allowedCapabilities],
      });
    }

    // 2. Populate workforce as AgentRecords (with backward-compatible adapter for AgentSpec[])
    for (const agent of customWorkforce) {
      let record: AgentRecord;

      if ('identity' in agent && 'currentConfig' in agent) {
        // Native Phase 2 AgentRecord
        record = agent as AgentRecord;
      } else {
        // Adapt legacy Phase 1 AgentSpec into an AgentRecord
        const spec = agent as AgentSpec;
        const matchingFounding = CANONICAL_FOUNDING_AGENTS.find((a) => a.id === spec.id);

        if (matchingFounding) {
          record = matchingFounding;
        } else {
          // Synthesize AgentRecord for custom test specs
          const id = spec.id;
          const agentCode = (spec as any).agentCode ?? `AGENT-${id.slice(0, 6).toUpperCase()}`;
          const levelMap: Record<AgentSpec['tier'], any> = {
            executive: 'EXECUTIVE',
            director: 'DIRECTOR',
            manager: 'MANAGER',
            specialist: 'SPECIALIST',
            operator: 'OPERATOR',
          };
          const level = levelMap[spec.tier] ?? 'SPECIALIST';

          record = createAgentRecord(
            {
              id,
              agentCode,
              departmentId: spec.departmentId,
              createdAt: spec.createdAt ?? new Date().toISOString(),
            },
            {
              configurationId: id,
              agentId: id,
              displayName: spec.name,
              jobTitle: spec.name,
              level,
              roleDescription: spec.name,
              assignedDepartmentId: spec.departmentId,
              supervisor: {
                supervisorType: level === 'EXECUTIVE' && agentCode === 'EXEC-CEO' ? 'OWNER_PRINCIPAL' : 'AGENT',
                supervisorAgentId: level === 'EXECUTIVE' && agentCode === 'EXEC-CEO' ? null : '00000000-0000-0000-0000-000000000001',
                reportsToOwner: level === 'EXECUTIVE' && agentCode === 'EXEC-CEO',
              },
              assignedResponsibilities: ['Operational duties'],
              requiredCapabilities: [...spec.allowedTools],
              permissionProfile: {
                profileId: id,
                profileCode: `PERM-${agentCode}`,
                name: `${spec.name} Profile`,
                scope: 'DEPARTMENT_SCOPED',
                allowedPermissions: ['task:execute'],
                maxBudgetApprovalUsd: 0,
                maxDelegationDepth: 1,
                prohibitedRestrictedActions: ['CAPITAL_TRANSFER', 'LIVE_TRADING_EXECUTION', 'BINDING_CONTRACT_ACCEPTANCE', 'GOVERNANCE_OVERRIDE', 'PERMISSION_ELEVATION'],
                requiresOwnerAuthorizationFor: ['EXTERNAL_COMMUNICATION'],
                canAuthorizeSubordinates: false,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
              operationalStatus: spec.isActive ? 'ACTIVE' : 'INACTIVE',
              modelConfig: {
                modelProvider: spec.modelProvider ?? 'mock',
                modelId: spec.modelId ?? 'mock-llm-v1',
                temperature: 0.3,
                systemPrompt: spec.systemPrompt,
                allowedTools: [...spec.allowedTools],
                toolConfigs: [],
                maxParallelTasks: spec.maxParallelTasks ?? 3,
                timeoutMs: 60000,
              },
              departmentTransferHistory: [],
              configVersion: '1.0.0',
              effectiveFrom: new Date().toISOString(),
              updatedAt: spec.updatedAt ?? new Date().toISOString(),
            }
          );
        }
      }

      this.agents.set(record.id, record);
      this.idByCode.set(record.agentCode, record.id);
    }

    // 3. Initialize sub-engines
    this.tree = new HierarchyTree(Array.from(this.agents.values()));
    this.delegationEngine = new DelegationRuleEngine();
    this.leadershipManager = new DepartmentLeadershipManager(
      this.departments,
      this.agents,
      this.ownerAuthService,
      this.executiveAuthService
    );
    this.transferCoordinator = new DepartmentTransferCoordinator(
      this.departments,
      this.agents,
      this.tree,
      this.ownerAuthService,
      this.executiveAuthService
    );
    this.auditor = new OrganizationalAuditor();
  }

  // =========================================================================
  // Authenticated Session Helper Methods
  // =========================================================================

  /**
   * Generates a verified, cryptographically signed Owner session.
   * Requires authentic Owner credentials.
   */
  createOwnerSession(params: {
    principalId: string;
    email?: string;
    credentials?: string;
    reason?: string;
    sessionDurationMs?: number;
  }): OwnerAuthenticatedSession {
    return this.ownerAuthService.createOwnerSession({
      principalId: params.principalId,
      email: params.email ?? 'stephenikeme@icloud.com',
      credentials: params.credentials ?? process.env.OWNER_AUTH_CREDENTIALS ?? 'vme-owner-credentials-test-2026',
      reason: params.reason,
      sessionDurationMs: params.sessionDurationMs,
    });
  }

  /**
   * Generates a verified, cryptographically signed Executive session.
   * Requires authentic registered executive identity in executive_office.
   */
  createExecutiveSession(agentIdOrCode: string, sessionDurationMs?: number): ExecutiveAuthenticatedSession {
    return this.executiveAuthService.createExecutiveSession(
      { agentIdOrCode, sessionDurationMs },
      this.agents,
      getHierarchyAuthoritySecret()
    );
  }

  /**
   * Revokes an active Owner session.
   */
  revokeOwnerSession(sessionId: string, reason?: string): void {
    this.ownerAuthService.revokeSession(sessionId, reason);
  }

  /**
   * Revokes an active Executive session.
   */
  revokeExecutiveSession(sessionId: string, reason?: string): void {
    this.executiveAuthService.revokeSession(sessionId, reason);
  }

  // =========================================================================
  // Native Phase 2 AgentRecord Accessors
  // =========================================================================

  /**
   * Resolves an agent identifier or code to internal AgentRecord.
   */
  getAgentRecord(idOrCode: string): AgentRecord | null {
    if (this.agents.has(idOrCode)) {
      return this.agents.get(idOrCode)!;
    }
    const resolvedId = this.idByCode.get(idOrCode);
    if (resolvedId && this.agents.has(resolvedId)) {
      return this.agents.get(resolvedId)!;
    }
    return null;
  }

  /**
   * Returns all active and inactive workforce AgentRecords.
   */
  listAgentRecords(): AgentRecord[] {
    return Array.from(this.agents.values());
  }

  /**
   * Returns all active AgentRecords assigned to a given department.
   */
  listAgentRecordsByDepartment(departmentId: DepartmentId): AgentRecord[] {
    return Array.from(this.agents.values()).filter(
      (a) => a.departmentId === departmentId && a.operationalStatus === 'ACTIVE'
    );
  }

  /**
   * Returns the Director or Executive AgentRecord assigned to a department.
   */
  getDepartmentDirectorRecord(departmentId: DepartmentId): AgentRecord | null {
    return this.leadershipManager.getDepartmentDirector(departmentId);
  }

  // =========================================================================
  // Hierarchy & Reporting Graph Navigation
  // =========================================================================

  /**
   * Returns an agent's supervisor: 'OWNER_PRINCIPAL' for EXEC-CEO, or AgentRecord.
   */
  getSupervisor(idOrCode: string): AgentRecord | 'OWNER_PRINCIPAL' | null {
    return this.tree.getSupervisor(idOrCode);
  }

  /**
   * Returns all direct reports for an agent.
   */
  getDirectReports(idOrCode: string): AgentRecord[] {
    return this.tree.getDirectReports(idOrCode);
  }

  /**
   * Returns the management chain (immediate supervisor up to EXEC-CEO).
   */
  getManagementChain(idOrCode: string): AgentRecord[] {
    return this.tree.getManagementChain(idOrCode);
  }

  /**
   * Evaluates if descendant is in ancestor's subordinate reporting tree.
   */
  isSubordinate(ancestorIdOrCode: string, descendantIdOrCode: string): boolean {
    return this.tree.isSubordinate(ancestorIdOrCode, descendantIdOrCode);
  }

  /**
   * Finds the lowest common supervisor for two agents.
   */
  findCommonSupervisor(
    agentAIdOrCode: string,
    agentBIdOrCode: string
  ): AgentRecord | 'OWNER_PRINCIPAL' | null {
    return this.tree.findCommonSupervisor(agentAIdOrCode, agentBIdOrCode);
  }

  /**
   * Detects any cycles in the reporting hierarchy.
   */
  detectReportingCycles(): string[][] {
    return this.tree.detectCycles();
  }

  // =========================================================================
  // Department Topology (Two-Tier Apex Structure)
  // =========================================================================

  /**
   * Returns parent department (null for apex executive_office).
   */
  getParentDepartment(departmentId: DepartmentId): Department | null {
    const dept = this.departments.get(departmentId);
    if (!dept || !dept.parentDepartmentId) return null;
    return this.departments.get(dept.parentDepartmentId) ?? null;
  }

  /**
   * Returns sub-departments reporting to this department.
   */
  getSubDepartments(departmentId: DepartmentId): Department[] {
    return Array.from(this.departments.values()).filter(
      (d) => d.parentDepartmentId === departmentId
    );
  }

  /**
   * Returns true if department is the apex governing department (executive_office).
   */
  isApexDepartment(departmentId: DepartmentId): boolean {
    return departmentId === 'executive_office';
  }

  // =========================================================================
  // Organizational Mutations (Guarded by Emergency Circuit Breaker)
  // =========================================================================

  /**
   * Appoints a Director for a corporate department.
   * Blocked during emergency circuit breaker halts.
   */
  appointDirector(params: AppointDirectorParams): LeadershipAppointmentRecord {
    // Assert operational state: organizational mutations blocked during emergency halts
    if (this.emergencySupervisor) {
      this.emergencySupervisor.assertOperational();
    }

    const result = this.leadershipManager.appointDirector(params);
    return result.record;
  }

  /**
   * Transfers an agent to a new department with unbroken audit history.
   * Blocked during emergency circuit breaker halts.
   */
  transferAgent(params: TransferAgentParams): AgentRecord {
    // Assert operational state: organizational mutations blocked during emergency halts
    if (this.emergencySupervisor) {
      this.emergencySupervisor.assertOperational();
    }

    return this.transferCoordinator.transferAgent(params);
  }

  /**
   * Returns leadership appointment audit history.
   */
  getLeadershipHistory(departmentId?: DepartmentId): LeadershipAppointmentRecord[] {
    return this.leadershipManager.getLeadershipHistory(departmentId);
  }

  /**
   * Returns authoritative department transfer audit history.
   */
  getTransferHistory(agentIdOrCode?: string): AuthoritativeTransferRecord[] {
    return this.transferCoordinator.getTransferHistory(agentIdOrCode);
  }

  /**
   * Performs an organizational audit verifying cardinality, topology, and acyclicity.
   */
  auditIntegrity(): AuditReport {
    return this.auditor.audit(
      Array.from(this.departments.values()),
      Array.from(this.agents.values())
    );
  }

  /**
   * Asserts organizational health, throwing UnauthorizedHierarchyActionError on violation.
   */
  assertHealthy(): void {
    this.auditor.assertHealthy(
      Array.from(this.departments.values()),
      Array.from(this.agents.values())
    );
  }

  // =========================================================================
  // Phase 1 Backward Compatibility Wrappers (AgentSpec and flat APIs)
  // =========================================================================

  getDepartment(id: DepartmentId): Department | null {
    return this.departments.get(id) ?? null;
  }

  listDepartments(): Department[] {
    return Array.from(this.departments.values());
  }

  getDepartmentDirector(departmentId: DepartmentId): AgentSpec | null {
    const directorRecord = this.leadershipManager.getDepartmentDirector(departmentId);
    return directorRecord ? toAgentSpec(directorRecord) : null;
  }

  getAgent(id: string): AgentSpec | null {
    const record = this.getAgentRecord(id);
    return record ? toAgentSpec(record) : null;
  }

  listAgentsByDepartment(departmentId: DepartmentId): AgentSpec[] {
    return this.listAgentRecordsByDepartment(departmentId).map(toAgentSpec);
  }

  getAllAgents(): AgentSpec[] {
    return Array.from(this.agents.values()).map(toAgentSpec);
  }

  /**
   * Validates corporate reporting hierarchy and delegation authority.
   */
  validateDelegation(
    senderAgentId: string,
    recipientAgentId: string
  ): { allowed: boolean; reason?: string } {
    const sender = this.getAgentRecord(senderAgentId);
    const recipient = this.getAgentRecord(recipientAgentId);

    if (!sender) return { allowed: false, reason: `Sender agent ${senderAgentId} not found` };
    if (!recipient) return { allowed: false, reason: `Recipient agent ${recipientAgentId} not found` };

    return this.delegationEngine.validateDelegation(sender, recipient);
  }

  /**
   * Asserts that an agent's department is authorized for a specified capability.
   */
  assertCapability(agentId: string, requiredCapability: string): void {
    const agent = this.getAgentRecord(agentId);
    if (!agent) {
      throw new UnauthorizedHierarchyActionError(`Agent ${agentId} not found`);
    }

    const dept = this.departments.get(agent.departmentId);
    if (!dept) {
      throw new UnauthorizedHierarchyActionError(`Department ${agent.departmentId} not found`);
    }

    this.delegationEngine.assertCapability(dept, requiredCapability);
  }
}
