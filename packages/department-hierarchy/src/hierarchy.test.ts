import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  OWNER_PRINCIPAL_ID,
  createAgentRecord,
  type AgentRecord,
  type Department,
} from '@vme/shared-types';
import { EmergencySupervisor, EmergencyHaltError } from '@vme/security-governance';
import {
  DepartmentRegistry,
  UnauthorizedHierarchyActionError,
  HierarchyTree,
  INITIAL_DEPARTMENTS,
  INITIAL_AGENT_RECORDS,
  cloneFoundingWorkforce,
  cloneCanonicalDepartments,
} from './index.js';

describe('@vme/department-hierarchy Corporate Structure & Workforce', () => {
  let registry: DepartmentRegistry;

  beforeEach(() => {
    registry = new DepartmentRegistry();
  });

  // =========================================================================
  // 1. Department Hierarchy & Two-Tier Apex Topology
  // =========================================================================
  describe('1. Department Hierarchy & Two-Tier Apex Topology', () => {
    it('verifies all 9 corporate departments exist with allocated monthly budgets', () => {
      const depts = registry.listDepartments();
      expect(depts).toHaveLength(9);

      const deptIds = depts.map((d) => d.id);
      expect(deptIds).toEqual([
        'executive_office',
        'financial_intelligence',
        'technology_engineering',
        'business_development',
        'marketing_growth',
        'operations_administration',
        'opportunity_acquisition',
        'research_intelligence',
        'security_governance',
      ]);

      // Verify all have budgets > 0 and allowed capabilities
      for (const d of depts) {
        expect(d.budgetMonthlyUsd).toBeGreaterThan(0);
        expect(d.budgetMonthlyAllocationUsd).toBeGreaterThan(0);
        expect(d.allowedCapabilities.length).toBeGreaterThan(0);
      }
    });

    it('enforces the two-tier apex department topology (executive_office as apex parent)', () => {
      // 1. Executive Office is the apex department with NO parent
      expect(registry.isApexDepartment('executive_office')).toBe(true);
      expect(registry.getParentDepartment('executive_office')).toBeNull();

      // 2. Executive Office has all 8 functional departments as sub-departments
      const subDepts = registry.getSubDepartments('executive_office');
      expect(subDepts).toHaveLength(8);
      const subDeptIds = subDepts.map((d) => d.id);
      expect(subDeptIds).not.toContain('executive_office');
      expect(subDeptIds).toContain('financial_intelligence');
      expect(subDeptIds).toContain('technology_engineering');
      expect(subDeptIds).toContain('business_development');
      expect(subDeptIds).toContain('marketing_growth');
      expect(subDeptIds).toContain('operations_administration');
      expect(subDeptIds).toContain('opportunity_acquisition');
      expect(subDeptIds).toContain('research_intelligence');
      expect(subDeptIds).toContain('security_governance');

      // 3. Every functional department has parentDepartmentId === 'executive_office'
      for (const subDept of subDepts) {
        expect(registry.isApexDepartment(subDept.id)).toBe(false);
        const parent = registry.getParentDepartment(subDept.id);
        expect(parent).not.toBeNull();
        expect(parent?.id).toBe('executive_office');
      }
    });

    it('verifies each department has an active Director or Executive assigned', () => {
      const depts = registry.listDepartments();
      for (const d of depts) {
        const director = registry.getDepartmentDirector(d.id);
        expect(director).toBeDefined();
        expect(['director', 'executive']).toContain(director?.tier);

        const directorRecord = registry.getDepartmentDirectorRecord(d.id);
        expect(directorRecord).toBeDefined();
        expect(['DIRECTOR', 'EXECUTIVE']).toContain(directorRecord?.level);
        expect(directorRecord?.operationalStatus).toBe('ACTIVE');
      }
    });
  });

  // =========================================================================
  // 2. Native AgentRecord Storage & Phase 1 Backward Compatibility
  // =========================================================================
  describe('2. Native AgentRecord Storage & Backward Compatibility', () => {
    it('verifies the corporate workforce roster contains exactly 30 specialized AI agents as AgentRecords', () => {
      const agentRecords = registry.listAgentRecords();
      expect(agentRecords).toHaveLength(30);

      // Verify each agent preserves immutable identity and versioned configuration
      for (const agent of agentRecords) {
        expect(agent.identity).toBeDefined();
        expect(agent.identity.id).toBe(agent.id);
        expect(agent.identity.agentCode).toBe(agent.agentCode);
        expect(agent.originDepartmentId).toBeDefined();
        expect(agent.currentConfig).toBeDefined();
        expect(agent.configVersion).toMatch(/^\d+\.\d+\.\d+$/);
      }
    });

    it('supports agent lookup by UUID and by uppercase agent code', () => {
      // Lookup by UUID
      const ceoById = registry.getAgentRecord('00000000-0000-0000-0000-000000000001');
      expect(ceoById).toBeDefined();
      expect(ceoById?.agentCode).toBe('EXEC-CEO');

      // Lookup by Agent Code
      const ceoByCode = registry.getAgentRecord('EXEC-CEO');
      expect(ceoByCode).toBeDefined();
      expect(ceoByCode?.id).toBe('00000000-0000-0000-0000-000000000001');

      // Lookup engineer by code
      const engineer = registry.getAgentRecord('TECH-FSE');
      expect(engineer).toBeDefined();
      expect(engineer?.departmentId).toBe('technology_engineering');
      expect(engineer?.level).toBe('SPECIALIST');
    });

    it('preserves 100% Phase 1 backward compatibility for AgentSpec consumers', () => {
      const allSpecs = registry.getAllAgents();
      expect(allSpecs).toHaveLength(30);

      const ceoSpec = registry.getAgent('00000000-0000-0000-0000-000000000001');
      expect(ceoSpec).toBeDefined();
      expect(ceoSpec?.name).toBe('CEO_AutonomousDirector');
      expect(ceoSpec?.tier).toBe('executive');
      expect(ceoSpec?.isActive).toBe(true);

      const techAgents = registry.listAgentsByDepartment('technology_engineering');
      expect(techAgents).toHaveLength(5);
      for (const a of techAgents) {
        expect(a.departmentId).toBe('technology_engineering');
        expect(a.isActive).toBe(true);
      }
    });
  });

  // =========================================================================
  // 3. Reporting Tree Graph Traversal & Management Chains
  // =========================================================================
  describe('3. Reporting Tree Graph Traversal & Management Chains', () => {
    it('resolves direct supervisors correctly across all seniority levels', () => {
      // 1. EXEC-CEO reports to the human Owner principal
      expect(registry.getSupervisor('EXEC-CEO')).toBe('OWNER_PRINCIPAL');

      // 2. EXEC-COO reports to EXEC-CEO
      const cooSupervisor = registry.getSupervisor('EXEC-COO');
      expect(cooSupervisor).not.toBe('OWNER_PRINCIPAL');
      expect((cooSupervisor as AgentRecord).agentCode).toBe('EXEC-CEO');

      // 3. OPS-DIR reports to EXEC-COO
      const opsDirSupervisor = registry.getSupervisor('OPS-DIR');
      expect(opsDirSupervisor).not.toBe('OWNER_PRINCIPAL');
      expect((opsDirSupervisor as AgentRecord).agentCode).toBe('EXEC-COO');

      // 4. TECH-CTO reports to EXEC-CEO
      const ctoSupervisor = registry.getSupervisor('TECH-CTO');
      expect(ctoSupervisor).not.toBe('OWNER_PRINCIPAL');
      expect((ctoSupervisor as AgentRecord).agentCode).toBe('EXEC-CEO');

      // 5. TECH-FSE reports to TECH-CTO
      const engineerSupervisor = registry.getSupervisor('TECH-FSE');
      expect(engineerSupervisor).not.toBe('OWNER_PRINCIPAL');
      expect((engineerSupervisor as AgentRecord).agentCode).toBe('TECH-CTO');
    });

    it('resolves direct reports correctly', () => {
      // CEO direct reports include COO and 7 department directors
      const ceoReports = registry.getDirectReports('EXEC-CEO');
      const ceoReportCodes = ceoReports.map((r) => r.agentCode);
      expect(ceoReportCodes).toContain('EXEC-COO');
      expect(ceoReportCodes).toContain('FIN-CFO');
      expect(ceoReportCodes).toContain('TECH-CTO');
      expect(ceoReportCodes).toContain('BIZ-DIR');
      expect(ceoReportCodes).toContain('MKT-DIR');
      expect(ceoReportCodes).toContain('OPP-DIR');
      expect(ceoReportCodes).toContain('RES-DIR');
      expect(ceoReportCodes).toContain('SEC-CISO');

      // CTO direct reports include 4 technology specialists
      const ctoReports = registry.getDirectReports('TECH-CTO');
      expect(ctoReports).toHaveLength(4);
      const ctoReportCodes = ctoReports.map((r) => r.agentCode);
      expect(ctoReportCodes).toEqual(['TECH-ARCH', 'TECH-FSE', 'TECH-DEVOPS', 'TECH-QA']);

      // Specialists have 0 direct reports
      expect(registry.getDirectReports('TECH-FSE')).toHaveLength(0);
    });

    it('traverses the management chain from specialist up to CEO', () => {
      // TECH-FSE -> TECH-CTO -> EXEC-CEO
      const engineerChain = registry.getManagementChain('TECH-FSE');
      expect(engineerChain.map((a) => a.agentCode)).toEqual(['TECH-CTO', 'EXEC-CEO']);

      // OPS-COORD -> OPS-DIR -> EXEC-COO -> EXEC-CEO
      const opsChain = registry.getManagementChain('OPS-COORD');
      expect(opsChain.map((a) => a.agentCode)).toEqual(['OPS-DIR', 'EXEC-COO', 'EXEC-CEO']);

      // EXEC-CEO has empty management chain (reports directly to Owner)
      expect(registry.getManagementChain('EXEC-CEO')).toHaveLength(0);
    });

    it('accurately evaluates subordinate relationships (isSubordinate)', () => {
      expect(registry.isSubordinate('EXEC-CEO', 'TECH-FSE')).toBe(true);
      expect(registry.isSubordinate('TECH-CTO', 'TECH-FSE')).toBe(true);
      expect(registry.isSubordinate('EXEC-COO', 'OPS-COORD')).toBe(true);

      // Inverted relationships are false
      expect(registry.isSubordinate('TECH-FSE', 'TECH-CTO')).toBe(false);
      expect(registry.isSubordinate('TECH-FSE', 'EXEC-CEO')).toBe(false);

      // Cross-department non-subordinates are false
      expect(registry.isSubordinate('FIN-CFO', 'TECH-FSE')).toBe(false);
      expect(registry.isSubordinate('TECH-CTO', 'FIN-ACC')).toBe(false);
    });

    it('finds the lowest common supervisor across reporting branches', () => {
      // 1. Two specialists in the same department -> their Director
      const techCommon = registry.findCommonSupervisor('TECH-FSE', 'TECH-QA');
      expect((techCommon as AgentRecord).agentCode).toBe('TECH-CTO');

      // 2. Two specialists in different departments -> EXEC-CEO
      const crossDeptCommon = registry.findCommonSupervisor('TECH-FSE', 'FIN-ACC');
      expect((crossDeptCommon as AgentRecord).agentCode).toBe('EXEC-CEO');

      // 3. Director and their specialist -> Director
      const dirSpecCommon = registry.findCommonSupervisor('TECH-CTO', 'TECH-FSE');
      expect((dirSpecCommon as AgentRecord).agentCode).toBe('TECH-CTO');

      // 4. CEO and any agent -> EXEC-CEO
      const ceoCommon = registry.findCommonSupervisor('EXEC-CEO', 'TECH-FSE');
      expect((ceoCommon as AgentRecord).agentCode).toBe('EXEC-CEO');
    });

    it('detects circular reporting relationships in malformed trees', () => {
      // Canonical tree has zero cycles
      expect(registry.detectReportingCycles()).toHaveLength(0);

      // Construct a corrupted tree with circular loop: A -> B -> C -> A
      const roster = cloneFoundingWorkforce();
      const cto = roster.find((a) => a.agentCode === 'TECH-CTO')!;
      const engineer = roster.find((a) => a.agentCode === 'TECH-FSE')!;
      const devops = roster.find((a) => a.agentCode === 'TECH-DEVOPS')!;

      // Engineer reports to DevOps, DevOps reports to CTO, CTO reports to Engineer (Cycle)
      engineer.currentConfig.supervisor.supervisorAgentId = devops.id;
      engineer.currentConfig.supervisor.supervisorAgentCode = devops.agentCode;
      devops.currentConfig.supervisor.supervisorAgentId = cto.id;
      devops.currentConfig.supervisor.supervisorAgentCode = cto.agentCode;
      cto.currentConfig.supervisor.supervisorAgentId = engineer.id;
      cto.currentConfig.supervisor.supervisorAgentCode = engineer.agentCode;

      const cyclicTree = new HierarchyTree(roster);
      const cycles = cyclicTree.detectCycles();
      expect(cycles.length).toBeGreaterThan(0);
      expect(cyclicTree.validateTree().valid).toBe(false);
    });
  });

  // =========================================================================
  // 4. Corporate Delegation Rules & Seniority Boundaries
  // =========================================================================
  describe('4. Corporate Delegation Rules & Seniority Boundaries', () => {
    it('enforces corporate delegation rules across seniority and department boundaries', () => {
      const ceo = registry.getAllAgents().find((a) => a.name === 'CEO_AutonomousDirector')!;
      const cto = registry.getAllAgents().find((a) => a.name === 'ChiefTechnologyDirector')!;
      const engineer = registry.getAllAgents().find((a) => a.name === 'FullStackEngineerBot')!;
      const marketingSpecialist = registry.getAllAgents().find((a) => a.name === 'ContentStrategistBot')!;

      // 1. CEO -> CTO (Executive to Director) -> Allowed
      expect(registry.validateDelegation(ceo.id, cto.id).allowed).toBe(true);

      // 2. CTO -> Engineer (Director to Specialist in same department) -> Allowed
      expect(registry.validateDelegation(cto.id, engineer.id).allowed).toBe(true);

      // 3. Engineer -> CTO (Specialist delegating upward to Director) -> Rejected
      const upwardDelegation = registry.validateDelegation(engineer.id, cto.id);
      expect(upwardDelegation.allowed).toBe(false);
      expect(upwardDelegation.reason).toContain('cannot delegate to senior role');

      // 4. Marketing Specialist -> Technology Engineer (Cross-department specialist delegation) -> Rejected
      const crossDeptDelegation = registry.validateDelegation(marketingSpecialist.id, engineer.id);
      expect(crossDeptDelegation.allowed).toBe(false);
      expect(crossDeptDelegation.reason).toContain('requires Department Director authority');

      // 5. Director -> Specialist in another department (CTO -> Marketing Specialist) -> Allowed
      const directorCrossDept = registry.validateDelegation(cto.id, marketingSpecialist.id);
      expect(directorCrossDept.allowed).toBe(true);
    });

    it('enforces department capability boundaries', () => {
      const fxAnalyst = registry.getAllAgents().find((a) => a.name === 'FX_TradingAnalyst')!;
      const copywriter = registry.getAllAgents().find((a) => a.name === 'ContentStrategistBot')!;

      // Financial analyst is authorized for fx_paper_trading
      expect(() => registry.assertCapability(fxAnalyst.id, 'fx_paper_trading')).not.toThrow();

      // Copywriter in Marketing is NOT authorized for fx_paper_trading
      expect(() => registry.assertCapability(copywriter.id, 'fx_paper_trading')).toThrow(
        UnauthorizedHierarchyActionError
      );
    });
  });

  // =========================================================================
  // 5. Leadership Governance & Tiered Director Appointments
  // =========================================================================
  describe('5. Leadership Governance & Tiered Director Appointments', () => {
    it('enforces Owner-only authority for Executive Office appointments', () => {
      const coo = registry.getAgentRecord('EXEC-COO')!;

      // 1. Canonical Executive CEO cannot appoint Executive Office leadership
      expect(() =>
        registry.appointDirector({
          departmentId: 'executive_office',
          newDirectorIdOrCode: 'EXEC-COO',
          authorizedBy: 'EXEC-CEO',
          reason: 'Promote COO to Co-Director',
        })
      ).toThrow("lacks authority to appoint director for 'executive_office'");

      // 2. Human Owner principal strictly succeeds for Executive Office appointment
      const result = registry.appointDirector({
        departmentId: 'executive_office',
        newDirectorIdOrCode: 'EXEC-COO',
        authorizedBy: OWNER_PRINCIPAL_ID,
        reason: 'Owner appointed executive leadership reassignment',
        effectiveDate: '2026-03-01T00:00:00.000Z',
      });

      expect(result.newDirectorCode).toBe('EXEC-COO');
      expect(result.appointedBy).toBe(OWNER_PRINCIPAL_ID);
      expect(registry.getDepartmentDirector('executive_office')?.name).toBe(coo.displayName);
    });

    it('allows both Owner and canonical Executive CEO to appoint functional department directors', () => {
      // 1. CEO appoints new Director for Marketing & Growth
      // We'll promote/appoint an existing Director or Executive (e.g. BIZ-DIR or another Director)
      const bizDir = registry.getAgentRecord('BIZ-DIR')!;

      const appointment = registry.appointDirector({
        departmentId: 'marketing_growth',
        newDirectorIdOrCode: 'BIZ-DIR',
        authorizedBy: 'EXEC-CEO',
        reason: 'Strategic leadership rotation to Marketing',
        effectiveDate: '2026-02-15T00:00:00.000Z',
      });

      expect(appointment.newDirectorCode).toBe('BIZ-DIR');
      expect(appointment.previousDirectorCode).toBe('MKT-DIR');
      expect(registry.getDepartmentDirector('marketing_growth')?.name).toBe(bizDir.displayName);

      // 2. History is recorded and deep-frozen
      const history = registry.getLeadershipHistory('marketing_growth');
      expect(history).toHaveLength(1);
      expect(Object.isFrozen(history[0])).toBe(true);

      // 3. Non-executive role (e.g. TECH-QA) attempting appointment is rejected
      expect(() =>
        registry.appointDirector({
          departmentId: 'marketing_growth',
          newDirectorIdOrCode: 'BIZ-DIR',
          authorizedBy: 'TECH-QA',
          reason: 'Illegal appointment attempt',
        })
      ).toThrow("lacks authority to appoint director for 'marketing_growth'");

      // 4. Attempting to appoint a Specialist without Director level fails seniority validation
      expect(() =>
        registry.appointDirector({
          departmentId: 'marketing_growth',
          newDirectorIdOrCode: 'TECH-FSE',
          authorizedBy: 'EXEC-CEO',
          reason: 'Premature promotion attempt',
        })
      ).toThrow("Seniority violation: agent TECH-FSE has level 'SPECIALIST', expected 'DIRECTOR' or 'EXECUTIVE'");
    });
  });

  // =========================================================================
  // 6. Department Transfer Coordination & Tree Re-linking
  // =========================================================================
  describe('6. Department Transfer Coordination & Tree Re-linking', () => {
    it('executes runtime department transfer, updating registry maps and hierarchy tree edges', () => {
      const engineer = registry.getAgentRecord('TECH-FSE')!;
      const originalOrigin = engineer.originDepartmentId;
      expect(engineer.departmentId).toBe('technology_engineering');

      // Transfer TECH-FSE to opportunity_acquisition
      const oppDir = registry.getAgentRecord('OPP-DIR')!;
      const updatedAgent = registry.transferAgent({
        agentIdOrCode: 'TECH-FSE',
        toDepartmentId: 'opportunity_acquisition',
        reason: 'Transfer to Opportunity Acquisition technical scouting',
        authorizedBy: 'EXEC-CEO',
        newJobTitle: 'Opportunity Technical Evaluator',
        newVersion: '1.1.0',
        effectiveDate: '2026-02-01T00:00:00.000Z',
        newSupervisor: {
          supervisorType: 'AGENT',
          supervisorAgentId: oppDir.id,
          supervisorAgentCode: oppDir.agentCode,
          reportsToOwner: false,
        },
      });

      // 1. Active department is updated
      expect(updatedAgent.departmentId).toBe('opportunity_acquisition');
      // 2. Immutable origin is preserved
      expect(updatedAgent.originDepartmentId).toBe(originalOrigin);
      // 3. Audit record is appended and frozen
      expect(updatedAgent.departmentTransferHistory).toHaveLength(1);
      expect(Object.isFrozen(updatedAgent.departmentTransferHistory[0])).toBe(true);

      // 4. Registry maps reflect the transfer
      const activeOppAgents = registry.listAgentRecordsByDepartment('opportunity_acquisition');
      expect(activeOppAgents.some((a) => a.agentCode === 'TECH-FSE')).toBe(true);

      const activeTechAgents = registry.listAgentRecordsByDepartment('technology_engineering');
      expect(activeTechAgents.some((a) => a.agentCode === 'TECH-FSE')).toBe(false);

      // 5. Hierarchy tree reflects updated management chain
      const updatedChain = registry.getManagementChain('TECH-FSE');
      expect(updatedChain.map((a) => a.agentCode)).toEqual(['OPP-DIR', 'EXEC-CEO']);

      // 6. Direct reports of new supervisor includes the transferred agent
      const oppReports = registry.getDirectReports('OPP-DIR');
      expect(oppReports.some((a) => a.agentCode === 'TECH-FSE')).toBe(true);

      // 7. Old supervisor no longer lists transferred agent as direct report
      const ctoReports = registry.getDirectReports('TECH-CTO');
      expect(ctoReports.some((a) => a.agentCode === 'TECH-FSE')).toBe(false);
    });

    it('rejects transfers authorized by unauthorized principals or with invalid departments', () => {
      // 1. Unknown destination department
      expect(() =>
        registry.transferAgent({
          agentIdOrCode: 'TECH-FSE',
          toDepartmentId: 'non_existent_department' as any,
          reason: 'Invalid department transfer',
          authorizedBy: 'EXEC-CEO',
        })
      ).toThrow("Unknown destination department 'non_existent_department'");

      // 2. Unauthorized authorizer (Specialist)
      expect(() =>
        registry.transferAgent({
          agentIdOrCode: 'TECH-FSE',
          toDepartmentId: 'opportunity_acquisition',
          reason: 'Unauthorized transfer attempt',
          authorizedBy: 'TECH-QA',
        })
      ).toThrow('lacks executive or Owner transfer authorization authority');
    });
  });

  // =========================================================================
  // 7. Organizational Auditor & Continuous Integrity Checks
  // =========================================================================
  describe('7. Organizational Auditor & Integrity Verification', () => {
    it('verifies that the initial canonical hierarchy passes all organizational audit checks', () => {
      const audit = registry.auditIntegrity();
      expect(audit.valid).toBe(true);
      expect(audit.errors).toHaveLength(0);
      expect(audit.departmentCount).toBe(9);
      expect(audit.workforceCount).toBe(30);

      expect(() => registry.assertHealthy()).not.toThrow();
    });

    it('detects violations when department topology or cardinality is corrupted', () => {
      const depts = cloneCanonicalDepartments();
      const workforce = cloneFoundingWorkforce();

      // Corrupt apex department by setting a parent
      depts.find((d) => d.id === 'executive_office')!.parentDepartmentId = 'financial_intelligence';

      const corruptedRegistry = new DepartmentRegistry(depts, workforce);
      const audit = corruptedRegistry.auditIntegrity();
      expect(audit.valid).toBe(false);
      expect(
        audit.errors.some((e) => e.includes("Apex department 'executive_office' must not specify a parentDepartmentId"))
      ).toBe(true);

      expect(() => corruptedRegistry.assertHealthy()).toThrow(UnauthorizedHierarchyActionError);
    });
  });

  // =========================================================================
  // 8. Emergency Circuit Breaker Freeze Integration
  // =========================================================================
  describe('8. Emergency Circuit Breaker Freeze Integration', () => {
    it('freezes organizational mutations during active emergency halts while preserving read queries', async () => {
      // Create emergency supervisor with disabled lockfile (in-memory Tier 1 only)
      const emergencySupervisor = new EmergencySupervisor(undefined, false);
      const securedRegistry = new DepartmentRegistry(undefined, undefined, emergencySupervisor);

      // 1. Normal state: mutations succeed
      const bizDir = securedRegistry.getAgentRecord('BIZ-DIR')!;
      expect(
        securedRegistry.appointDirector({
          departmentId: 'marketing_growth',
          newDirectorIdOrCode: 'BIZ-DIR',
          authorizedBy: 'EXEC-CEO',
          reason: 'Pre-emergency rotation',
        }).newDirectorCode
      ).toBe('BIZ-DIR');

      // 2. Trigger Tier 1 Emergency Halt (simulating security incident or kill switch)
      await emergencySupervisor.triggerHalt('Automated security breach containment', 'SEC-CISO');
      expect(emergencySupervisor.isHalted()).toBe(true);

      // 3. Mutations during emergency halt are blocked and throw EmergencyHaltError
      expect(() =>
        securedRegistry.appointDirector({
          departmentId: 'marketing_growth',
          newDirectorIdOrCode: 'MKT-DIR',
          authorizedBy: 'EXEC-CEO',
          reason: 'Post-emergency recovery attempt',
        })
      ).toThrow(EmergencyHaltError);

      expect(() =>
        securedRegistry.transferAgent({
          agentIdOrCode: 'TECH-FSE',
          toDepartmentId: 'opportunity_acquisition',
          reason: 'Emergency transfer attempt',
          authorizedBy: 'EXEC-CEO',
        })
      ).toThrow(EmergencyHaltError);

      // 4. Read-only queries continue to function seamlessly for post-mortem diagnostics
      expect(securedRegistry.listDepartments()).toHaveLength(9);
      expect(securedRegistry.listAgentRecords()).toHaveLength(30);
      expect(securedRegistry.getSupervisor('EXEC-COO')).toBeDefined();
      expect(securedRegistry.getManagementChain('TECH-FSE')).toHaveLength(2);
      expect(securedRegistry.getDepartmentDirector('executive_office')).toBeDefined();

      // 5. Reset emergency halt: mutations resume normal execution
      await emergencySupervisor.resumeOperations(OWNER_PRINCIPAL_ID);
      expect(emergencySupervisor.isHalted()).toBe(false);

      expect(
        securedRegistry.appointDirector({
          departmentId: 'marketing_growth',
          newDirectorIdOrCode: 'BIZ-DIR',
          authorizedBy: OWNER_PRINCIPAL_ID,
          reason: 'Post-resolution leadership restoration',
        }).newDirectorCode
      ).toBe('BIZ-DIR');
    });
  });
});
