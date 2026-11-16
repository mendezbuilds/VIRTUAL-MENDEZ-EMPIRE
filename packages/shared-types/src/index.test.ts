import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  DepartmentIdSchema,
  DepartmentSchema,
  CANONICAL_DEPARTMENTS,
  OrganizationalLevelSchema,
  compareOrganizationalLevels,
  isLevelSeniorOrEqual,
  AgentIdentitySchema,
  CANONICAL_FOUNDING_AGENTS,
  findAgentById,
  findAgentByCode,
  getDepartmentAgents,
  getDepartmentDirector,
  validateWorkforceHierarchy,
  toAgentSpec,
  AgentCodeSchema,
  AuthorityScopeSchema,
  RestrictedActionTypeSchema,
  PermissionProfileSchema,
  CANONICAL_APPROVAL_REQUIREMENTS,
  requiresOwnerGate,
  validateAgentAction,
  OwnerAuthorizationRequestSchema,
  TaskPrioritySchema,
  TaskStatusSchema,
  TaskSchema,
  TaskAssignmentSchema,
  TaskDelegationSchema,
  TaskResultSchema,
  TaskDependencySchema,
  TaskEscalationSchema,
  CommunicationMessageTypeSchema,
  CommunicationEnvelopeSchema,
  validateCommunicationEnvelope,
  MessageAcknowledgmentSchema,
  ExecutionContextSchema,
  FailureClassificationSchema,
  RetryPolicySchema,
  ExecutionResultSchema,
  EscalationEventSchema,
  JournalEntrySchema,
  EmergencyTierSchema,
  CurrencyCodeSchema,
  StrategicObjectiveSchema,
  AgentMessageTypeSchema,
  type AgentIdentity,
} from './index.js';

describe('Milestone 2.1 — Shared Hierarchy & Communication Schemas', () => {
  // =========================================================================
  // 1. All Nine Department Definitions
  // =========================================================================
  describe('1. Department Definitions & Canonical Structure', () => {
    it('verifies all 9 canonical corporate departments exist and validate against schema', () => {
      expect(CANONICAL_DEPARTMENTS).toHaveLength(9);

      const expectedDepts = [
        'executive_office',
        'financial_intelligence',
        'technology_engineering',
        'business_development',
        'marketing_growth',
        'operations_administration',
        'opportunity_acquisition',
        'research_intelligence',
        'security_governance',
      ] as const;

      const registeredDeptIds = CANONICAL_DEPARTMENTS.map((d) => d.id);
      for (const expectedId of expectedDepts) {
        expect(registeredDeptIds).toContain(expectedId);
      }

      for (const dept of CANONICAL_DEPARTMENTS) {
        const parseResult = DepartmentSchema.safeParse(dept);
        expect(parseResult.success, `Department ${dept.id} failed validation: ${JSON.stringify(parseResult)}`).toBe(true);
        expect(dept.budgetMonthlyUsd).toBeGreaterThan(0);
        expect(dept.allowedCapabilities.length).toBeGreaterThan(0);
        expect(dept.directorId).toBeDefined();
        expect(dept.directorCode).toBeDefined();
        expect(dept.isActive).toBe(true);
      }
    });

    it('rejects invalid department IDs', () => {
      expect(DepartmentIdSchema.safeParse('invalid_department').success).toBe(false);
      expect(DepartmentIdSchema.safeParse('venture_capital').success).toBe(false);
      expect(DepartmentIdSchema.safeParse('').success).toBe(false);
    });
  });

  // =========================================================================
  // 2. All 30 Founding Agent Identities
  // =========================================================================
  describe('2. Founding Agent Workforce Registry (30 AI Employees)', () => {
    it('verifies the corporate workforce roster contains exactly 30 founding AI employee identities', () => {
      expect(CANONICAL_FOUNDING_AGENTS).toHaveLength(30);

      for (const agent of CANONICAL_FOUNDING_AGENTS) {
        const result = AgentIdentitySchema.safeParse(agent);
        expect(
          result.success,
          `Agent ${agent.agentCode} failed validation: ${result.error?.message}`
        ).toBe(true);
      }
    });

    it('verifies agent distribution across all 9 departments conforms to target plan', () => {
      const counts: Record<string, number> = {};
      for (const agent of CANONICAL_FOUNDING_AGENTS) {
        counts[agent.departmentId] = (counts[agent.departmentId] || 0) + 1;
      }

      expect(counts['executive_office']).toBe(2);
      expect(counts['financial_intelligence']).toBe(4);
      expect(counts['technology_engineering']).toBe(5);
      expect(counts['business_development']).toBe(3);
      expect(counts['marketing_growth']).toBe(3);
      expect(counts['operations_administration']).toBe(3);
      expect(counts['opportunity_acquisition']).toBe(4);
      expect(counts['research_intelligence']).toBe(3);
      expect(counts['security_governance']).toBe(3);

      const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
      expect(total).toBe(30);
    });

    it('verifies every agent has all mandatory attributes populated', () => {
      for (const agent of CANONICAL_FOUNDING_AGENTS) {
        expect(agent.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
        expect(agent.agentCode).toMatch(/^[A-Z0-9]+-[A-Z0-9_]+$/);
        expect(agent.displayName.length).toBeGreaterThan(0);
        expect(agent.jobTitle.length).toBeGreaterThan(0);
        expect(agent.roleDescription.length).toBeGreaterThan(0);
        expect(agent.assignedResponsibilities.length).toBeGreaterThan(0);
        expect(agent.requiredCapabilities.length).toBeGreaterThan(0);
        expect(agent.permissionProfile).toBeDefined();
        expect(agent.operationalStatus).toBe('ACTIVE');
        expect(agent.configVersion).toBe('1.0.0');
        expect(agent.createdAt).toBeDefined();
        expect(agent.modelConfig.systemPrompt.length).toBeGreaterThan(0);
      }
    });
  });

  // =========================================================================
  // 3. Unique Agent IDs and Codes
  // =========================================================================
  describe('3. Agent Identity Uniqueness & Code Formatting', () => {
    it('verifies all 30 agent UUIDs are strictly unique', () => {
      const ids = CANONICAL_FOUNDING_AGENTS.map((a) => a.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(30);
    });

    it('verifies all 30 agent codes are strictly unique and match code schema', () => {
      const codes = CANONICAL_FOUNDING_AGENTS.map((a) => a.agentCode);
      const uniqueCodes = new Set(codes);
      expect(uniqueCodes.size).toBe(30);

      for (const code of codes) {
        expect(AgentCodeSchema.safeParse(code).success).toBe(true);
      }
    });

    it('rejects malformed agent codes', () => {
      expect(AgentCodeSchema.safeParse('exec_ceo').success).toBe(false); // lowercase
      expect(AgentCodeSchema.safeParse('EXEC').success).toBe(false); // missing hyphen
      expect(AgentCodeSchema.safeParse('EXEC CEO').success).toBe(false); // space
      expect(AgentCodeSchema.safeParse('E-1').success).toBe(false); // too short
    });
  });

  // =========================================================================
  // 4. Valid Organizational Relationships
  // =========================================================================
  describe('4. Organizational Hierarchy & Chain of Command', () => {
    it('verifies the full workforce hierarchy validates without errors', () => {
      const validation = validateWorkforceHierarchy(CANONICAL_FOUNDING_AGENTS);
      expect(validation.errors).toEqual([]);
      expect(validation.valid).toBe(true);
    });

    it('verifies the CEO reports to Owner with null supervisorAgentId', () => {
      const ceo = findAgentByCode('EXEC-CEO')!;
      expect(ceo).toBeDefined();
      expect(ceo.supervisor.reportsToOwner).toBe(true);
      expect(ceo.supervisor.supervisorAgentId).toBeNull();
      expect(ceo.level).toBe('EXECUTIVE');
    });

    it('verifies all Department Directors report to Executive leadership', () => {
      const directors = CANONICAL_FOUNDING_AGENTS.filter((a) => a.level === 'DIRECTOR');
      expect(directors).toHaveLength(8); // 8 department directors (excluding executive office)

      for (const director of directors) {
        expect(director.supervisor.reportsToOwner).toBe(false);
        expect(director.supervisor.supervisorAgentId).toBeDefined();
        const supervisor = findAgentById(director.supervisor.supervisorAgentId!);
        expect(supervisor).toBeDefined();
        expect(supervisor?.level).toBe('EXECUTIVE');
      }
    });

    it('verifies all Specialists report to their Department Director', () => {
      const specialists = CANONICAL_FOUNDING_AGENTS.filter((a) => a.level === 'SPECIALIST');
      expect(specialists).toHaveLength(20); // 20 specialized AI employees

      for (const specialist of specialists) {
        const supervisor = findAgentById(specialist.supervisor.supervisorAgentId!);
        expect(supervisor).toBeDefined();
        expect(['DIRECTOR', 'EXECUTIVE']).toContain(supervisor?.level);
        // Specialists must report within their own department
        expect(specialist.departmentId).toBe(supervisor?.departmentId);
      }
    });

    it('verifies seniority comparison logic between levels', () => {
      expect(compareOrganizationalLevels('OWNER', 'EXECUTIVE')).toBeLessThan(0);
      expect(compareOrganizationalLevels('EXECUTIVE', 'DIRECTOR')).toBeLessThan(0);
      expect(compareOrganizationalLevels('DIRECTOR', 'SPECIALIST')).toBeLessThan(0);
      expect(compareOrganizationalLevels('SPECIALIST', 'OPERATOR')).toBeLessThan(0);

      expect(isLevelSeniorOrEqual('DIRECTOR', 'SPECIALIST')).toBe(true);
      expect(isLevelSeniorOrEqual('SPECIALIST', 'DIRECTOR')).toBe(false);
      expect(isLevelSeniorOrEqual('DIRECTOR', 'DIRECTOR')).toBe(true);
    });
  });

  // =========================================================================
  // 5. Invalid or Circular Reporting Relationships
  // =========================================================================
  describe('5. Hierarchy Anomaly & Cycle Detection', () => {
    it('detects and rejects a circular reporting chain (Agent A -> Agent B -> Agent A)', () => {
      const corruptedRoster: AgentIdentity[] = JSON.parse(JSON.stringify(CANONICAL_FOUNDING_AGENTS));
      const cto = corruptedRoster.find((a) => a.agentCode === 'TECH-CTO')!;
      const architect = corruptedRoster.find((a) => a.agentCode === 'TECH-ARCH')!;

      // Make CTO report to Architect, while Architect reports to CTO
      cto.supervisor.supervisorAgentId = architect.id;
      architect.supervisor.supervisorAgentId = cto.id;

      const result = validateWorkforceHierarchy(corruptedRoster);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Circular reporting relationship'))).toBe(true);
    });

    it('detects and rejects an agent reporting to itself', () => {
      const corruptedRoster: AgentIdentity[] = JSON.parse(JSON.stringify(CANONICAL_FOUNDING_AGENTS));
      const cfo = corruptedRoster.find((a) => a.agentCode === 'FIN-CFO')!;
      cfo.supervisor.supervisorAgentId = cfo.id;

      const result = validateWorkforceHierarchy(corruptedRoster);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Circular reporting relationship'))).toBe(true);
    });

    it('detects when an agent references a non-existent supervisor ID', () => {
      const corruptedRoster: AgentIdentity[] = JSON.parse(JSON.stringify(CANONICAL_FOUNDING_AGENTS));
      const engineer = corruptedRoster.find((a) => a.agentCode === 'TECH-FSE')!;
      engineer.supervisor.supervisorAgentId = randomUUID(); // Non-existent ID

      const result = validateWorkforceHierarchy(corruptedRoster);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('references non-existent supervisor ID'))).toBe(true);
    });

    it('detects a seniority violation (e.g. Director reporting to Specialist)', () => {
      const corruptedRoster: AgentIdentity[] = JSON.parse(JSON.stringify(CANONICAL_FOUNDING_AGENTS));
      const cto = corruptedRoster.find((a) => a.agentCode === 'TECH-CTO')!;
      const engineer = corruptedRoster.find((a) => a.agentCode === 'TECH-FSE')!;

      // CTO reports to Engineer
      cto.supervisor.supervisorAgentId = engineer.id;

      const result = validateWorkforceHierarchy(corruptedRoster);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Hierarchy seniority violation'))).toBe(true);
    });
  });

  // =========================================================================
  // 6. Missing or Invalid Department References
  // =========================================================================
  describe('6. Department Reference Integrity', () => {
    it('rejects an agent configured with an invalid department ID', () => {
      const baseAgent = CANONICAL_FOUNDING_AGENTS[0];
      const invalidAgent = {
        ...baseAgent,
        id: randomUUID(),
        agentCode: 'TEST-001',
        departmentId: 'non_existent_department',
      };

      const result = AgentIdentitySchema.safeParse(invalidAgent);
      expect(result.success).toBe(false);
    });

    it('correctly queries agents and directors by valid department ID', () => {
      const techAgents = getDepartmentAgents('technology_engineering');
      expect(techAgents).toHaveLength(5);

      const techDirector = getDepartmentDirector('technology_engineering');
      expect(techDirector).toBeDefined();
      expect(techDirector?.agentCode).toBe('TECH-CTO');

      const nonExistentDirector = getDepartmentDirector('non_existent' as any);
      expect(nonExistentDirector).toBeUndefined();
    });
  });

  // =========================================================================
  // 7. Communication Envelope Validation
  // =========================================================================
  describe('7. Standardized Communication Protocol & Envelope Validation', () => {
    it('validates all 14 mandatory message categories', () => {
      const mandatoryCategories = [
        'TASK_ASSIGNMENT',
        'TASK_ACCEPTANCE',
        'TASK_REJECTION',
        'TASK_STATUS_UPDATE',
        'TASK_COMPLETION',
        'DELEGATION_REQUEST',
        'DELEGATION_RESPONSE',
        'INFORMATION_REQUEST',
        'INFORMATION_RESPONSE',
        'APPROVAL_REQUEST',
        'APPROVAL_RESPONSE',
        'FAILURE_REPORT',
        'ESCALATION',
        'EXECUTIVE_REPORT',
      ];

      for (const cat of mandatoryCategories) {
        expect(CommunicationMessageTypeSchema.safeParse(cat).success).toBe(true);
      }
    });

    it('maintains backward compatibility with legacy message types', () => {
      const legacyTypes = [
        'TASK_DELEGATION',
        'REVIEW_REQUEST',
        'REVIEW_APPROVAL',
        'REVIEW_REJECTION',
        'INFO_REQUEST',
        'INFO_RESPONSE',
      ];
      for (const t of legacyTypes) {
        expect(CommunicationMessageTypeSchema.safeParse(t).success).toBe(true);
      }
    });

    it('successfully parses a fully populated communication envelope', () => {
      const validEnvelope = {
        messageId: randomUUID(),
        senderAgentId: '00000000-0000-0000-0000-000000000001',
        senderAgentCode: 'EXEC-CEO',
        senderDepartmentId: 'executive_office',
        recipientAgentId: '00000000-0000-0000-0000-000000000007',
        recipientAgentCode: 'TECH-CTO',
        recipientDepartmentId: 'technology_engineering',
        type: 'TASK_ASSIGNMENT',
        priority: 'HIGH',
        taskId: randomUUID(),
        payload: {
          objective: 'Implement Schema Test Suite',
          milestone: '2.1',
        },
        correlationId: randomUUID(),
        causationId: randomUUID(),
        sentAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        deliveryStatus: 'PENDING',
        requiresResponse: true,
      };

      const result = CommunicationEnvelopeSchema.safeParse(validEnvelope);
      expect(result.success).toBe(true);
    });

    it('validates message acknowledgment contract', () => {
      const ack = {
        acknowledgmentId: randomUUID(),
        messageId: randomUUID(),
        recipientAgentId: randomUUID(),
        receivedAt: new Date().toISOString(),
        status: 'ACCEPTED',
      };

      expect(MessageAcknowledgmentSchema.safeParse(ack).success).toBe(true);
    });
  });

  // =========================================================================
  // 8. Invalid Sender and Recipient References & Anti-Spoofing
  // =========================================================================
  describe('8. Sender Authentication & Anti-Spoofing Verification', () => {
    it('detects and rejects sender identity spoofing when caller does not match declared sender', () => {
      const declaredSenderId = randomUUID();
      const actualCallerId = randomUUID();

      const envelope = {
        messageId: randomUUID(),
        senderAgentId: declaredSenderId, // Attempting to impersonate
        senderDepartmentId: 'executive_office',
        recipientAgentId: randomUUID(),
        recipientDepartmentId: 'financial_intelligence',
        type: 'TASK_ASSIGNMENT',
        priority: 'MEDIUM',
        payload: { data: 'test' },
        correlationId: randomUUID(),
        sentAt: new Date().toISOString(),
      };

      // When verified caller does not match declared sender, validateCommunicationEnvelope must reject
      const check = validateCommunicationEnvelope(envelope, actualCallerId);
      expect(check.valid).toBe(false);
      expect(check.error).toContain('Sender identity spoofing rejected');
    });

    it('accepts envelope when verified caller matches declared sender', () => {
      const validSenderId = randomUUID();

      const envelope = {
        messageId: randomUUID(),
        senderAgentId: validSenderId,
        senderDepartmentId: 'executive_office',
        recipientAgentId: randomUUID(),
        recipientDepartmentId: 'financial_intelligence',
        type: 'TASK_ASSIGNMENT',
        priority: 'MEDIUM',
        payload: { data: 'test' },
        correlationId: randomUUID(),
        sentAt: new Date().toISOString(),
      };

      const check = validateCommunicationEnvelope(envelope, validSenderId);
      expect(check.valid).toBe(true);
      expect(check.envelope).toBeDefined();
    });

    it('rejects envelope missing both recipient agent and recipient department', () => {
      const envelope = {
        messageId: randomUUID(),
        senderAgentId: randomUUID(),
        senderDepartmentId: 'executive_office',
        type: 'TASK_ASSIGNMENT',
        priority: 'MEDIUM',
        payload: {},
        correlationId: randomUUID(),
        sentAt: new Date().toISOString(),
      };

      const check = validateCommunicationEnvelope(envelope);
      expect(check.valid).toBe(false);
    });
  });

  // =========================================================================
  // 9. Task Assignment and Delegation Schema Validation
  // =========================================================================
  describe('9. Task Lifecycle, Assignment & Delegation Schemas', () => {
    it('validates canonical Task with WAITING_APPROVAL and ESCALATED statuses', () => {
      const allStatuses = [
        'PENDING',
        'ASSIGNED',
        'IN_PROGRESS',
        'WAITING_FEEDBACK',
        'WAITING_APPROVAL',
        'COMPLETED',
        'FAILED',
        'CANCELLED',
        'ESCALATED',
      ];
      for (const s of allStatuses) {
        expect(TaskStatusSchema.safeParse(s).success).toBe(true);
      }

      const task = {
        id: randomUUID(),
        tenantId: randomUUID(),
        title: 'Draft Cold Outreach Email for Owner',
        description: 'Prepare tailored intro email for VP Engineering at Stripe',
        departmentId: 'opportunity_acquisition',
        assignedAgentId: '00000000-0000-0000-0000-000000000018',
        assignedAgentCode: 'OPP-OUTR',
        priority: 'HIGH',
        status: 'WAITING_APPROVAL',
        requiresOwnerApproval: true,
        inputData: { targetCompany: 'Stripe' },
        tags: ['track-a', 'outreach'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      expect(TaskSchema.safeParse(task).success).toBe(true);
    });

    it('validates TaskAssignment contract', () => {
      const assignment = {
        assignmentId: randomUUID(),
        taskId: randomUUID(),
        assignerAgentId: randomUUID(),
        assigneeAgentId: randomUUID(),
        departmentId: 'technology_engineering',
        instructions: 'Implement test coverage for shared-types',
        priority: 'HIGH',
        assignedAt: new Date().toISOString(),
      };

      expect(TaskAssignmentSchema.safeParse(assignment).success).toBe(true);
    });

    it('validates TaskDelegation contract with bounded depth', () => {
      const validDelegation = {
        delegationId: randomUUID(),
        parentTaskId: randomUUID(),
        delegatedTaskId: randomUUID(),
        delegatorAgentId: randomUUID(),
        delegatorDepartmentId: 'executive_office',
        delegateeAgentId: randomUUID(),
        delegateeDepartmentId: 'technology_engineering',
        delegationDepth: 2,
        delegatedAt: new Date().toISOString(),
      };
      expect(TaskDelegationSchema.safeParse(validDelegation).success).toBe(true);

      // Max delegation depth is 5: depth 6 should fail validation
      const invalidDelegation = { ...validDelegation, delegationDepth: 6 };
      expect(TaskDelegationSchema.safeParse(invalidDelegation).success).toBe(false);
    });

    it('validates TaskResult, TaskDependency, and TaskEscalation contracts', () => {
      const result = {
        resultId: randomUUID(),
        taskId: randomUUID(),
        executingAgentId: randomUUID(),
        status: 'SUCCESS',
        outputData: { testsPassed: 12 },
        summary: 'All 12 schema test suites passed',
        tokensUsed: 1500,
        executionDurationMs: 450,
        completedAt: new Date().toISOString(),
      };
      expect(TaskResultSchema.safeParse(result).success).toBe(true);

      const dep = {
        dependencyId: randomUUID(),
        taskId: randomUUID(),
        dependsOnTaskId: randomUUID(),
        dependencyType: 'BLOCKING',
        isResolved: false,
      };
      expect(TaskDependencySchema.safeParse(dep).success).toBe(true);

      const escalation = {
        escalationId: randomUUID(),
        taskId: randomUUID(),
        originatingAgentId: randomUUID(),
        targetSupervisorId: randomUUID(),
        departmentId: 'technology_engineering',
        reason: 'Upstream schema parse failure on corrupted test fixture',
        severity: 'CRITICAL',
        status: 'OPEN',
        escalatedAt: new Date().toISOString(),
      };
      expect(TaskEscalationSchema.safeParse(escalation).success).toBe(true);
    });
  });

  // =========================================================================
  // 10. Permission and Authority Classification
  // =========================================================================
  describe('10. Authority Scopes & Permission Profile Boundaries', () => {
    it('validates authority scopes and permission profile schema', () => {
      const scopes = ['OWNER_ONLY', 'EXECUTIVE_WIDE', 'DEPARTMENT_SCOPED', 'SPECIALIST_LOCAL'];
      for (const scope of scopes) {
        expect(AuthorityScopeSchema.safeParse(scope).success).toBe(true);
      }

      const cfo = findAgentByCode('FIN-CFO')!;
      expect(PermissionProfileSchema.safeParse(cfo.permissionProfile).success).toBe(true);
      expect(cfo.permissionProfile.scope).toBe('DEPARTMENT_SCOPED');
      expect(cfo.permissionProfile.maxBudgetApprovalUsd).toBe(50000);
      expect(cfo.permissionProfile.canAuthorizeSubordinates).toBe(true);
    });

    it('validates permission checking logic: allowed vs unauthorized actions', () => {
      const cfo = findAgentByCode('FIN-CFO')!;

      // 1. Authorized financial action
      const check1 = validateAgentAction(cfo.permissionProfile, undefined, 'financial:audit');
      expect(check1.allowed).toBe(true);

      // 2. Unauthorized engineering action
      const check2 = validateAgentAction(cfo.permissionProfile, undefined, 'tech:deploy');
      expect(check2.allowed).toBe(false);
      expect(check2.reason).toContain("does not possess permission 'tech:deploy'");

      // 3. Prohibited action: LIVE_TRADING_EXECUTION is strictly barred
      const check3 = validateAgentAction(cfo.permissionProfile, 'LIVE_TRADING_EXECUTION');
      expect(check3.allowed).toBe(false);
      expect(check3.reason).toContain('is strictly prohibited');
    });

    it('enforces that no agent profile can self-elevate permissions', () => {
      for (const agent of CANONICAL_FOUNDING_AGENTS) {
        const check = validateAgentAction(agent.permissionProfile, 'PERMISSION_ELEVATION');
        expect(check.allowed).toBe(false);
        expect(agent.permissionProfile.prohibitedRestrictedActions).toContain('PERMISSION_ELEVATION');
      }
    });
  });

  // =========================================================================
  // 11. Restricted Action Approval Requirements & Owner Gate
  // =========================================================================
  describe('11. Consequential Action Barriers & Owner Authorization Requests', () => {
    it('verifies that all classified restricted actions require Owner approval', () => {
      const restrictedActions = [
        'EXTERNAL_COMMUNICATION',
        'JOB_APPLICATION_SUBMISSION',
        'BINDING_CONTRACT_ACCEPTANCE',
        'CAPITAL_TRANSFER',
        'LIVE_TRADING_EXECUTION',
        'SPENDING_EXCEEDING_LIMIT',
        'GOVERNANCE_OVERRIDE',
        'EMERGENCY_SHUTDOWN_OVERRIDE',
        'PERMISSION_ELEVATION',
      ] as const;

      for (const action of restrictedActions) {
        expect(RestrictedActionTypeSchema.safeParse(action).success).toBe(true);
        expect(requiresOwnerGate(action)).toBe(true);
      }
    });

    it('evaluates department spending limit triggers for Owner gate', () => {
      // Spending within budget ($5,000 <= $10,000) does not require Owner gate
      expect(requiresOwnerGate('SPENDING_EXCEEDING_LIMIT', 5000, 10000)).toBe(false);

      // Spending exceeding budget ($15,000 > $10,000) triggers Owner gate
      expect(requiresOwnerGate('SPENDING_EXCEEDING_LIMIT', 15000, 10000)).toBe(true);
    });

    it('validates OwnerAuthorizationRequest schema', () => {
      const authRequest = {
        requestId: randomUUID(),
        tenantId: randomUUID(),
        requestingAgentId: '00000000-0000-0000-0000-000000000018',
        requestingAgentCode: 'OPP-OUTR',
        requestingDepartmentId: 'opportunity_acquisition',
        actionType: 'EXTERNAL_COMMUNICATION',
        title: 'Authorize Sending Job Application Outreach to OpenAI',
        justification: 'Application drafted for Senior Distributed Systems role matching Owner skills',
        payload: {
          recipientEmail: 'recruiting@openai.com',
          subject: 'Application: Senior Systems Engineer - Stephen Mendez',
          body: 'Dear Hiring Team...',
        },
        riskAssessment: 'MEDIUM',
        status: 'PENDING',
        requestedAt: new Date().toISOString(),
      };

      const result = OwnerAuthorizationRequestSchema.safeParse(authRequest);
      expect(result.success).toBe(true);
    });
  });

  // =========================================================================
  // 12. Compatibility with Phase 1 Types
  // =========================================================================
  describe('12. Phase 1 Backward Compatibility', () => {
    it('verifies toAgentSpec transforms AgentIdentity into fully valid Phase 1 AgentSpec', () => {
      for (const agent of CANONICAL_FOUNDING_AGENTS) {
        const spec = toAgentSpec(agent);
        expect(spec.id).toBe(agent.id);
        expect(spec.name).toBe(agent.displayName);
        expect(spec.departmentId).toBe(agent.departmentId);
        expect(spec.systemPrompt).toBe(agent.modelConfig.systemPrompt);
        expect(spec.isActive).toBe(true);
        expect(spec.modelProvider).toBe('mock');
      }
    });

    it('preserves working Phase 1 double-entry journal validation', () => {
      const invalidEntry = {
        id: randomUUID(),
        tenantId: randomUUID(),
        entryNumber: 1,
        description: 'Single posting test',
        referenceType: 'MANUAL',
        referenceId: 'REF-001',
        status: 'POSTED',
        postings: [
          {
            id: randomUUID(),
            journalEntryId: randomUUID(),
            accountId: randomUUID(),
            direction: 'DEBIT',
            amount: '100.00',
            currency: 'USD',
          },
        ],
        previousHash: '0'.repeat(64),
        payloadHash: 'a'.repeat(64),
        entryHash: 'b'.repeat(64),
        txId: 'tx-1',
        committedAt: new Date().toISOString(),
      };

      // Double-entry requires at least 2 postings
      expect(JournalEntrySchema.safeParse(invalidEntry).success).toBe(false);
    });

    it('preserves working Phase 1 4-tier emergency shutdown schema', () => {
      expect(EmergencyTierSchema.safeParse('TIER_1_PROCESS_ATOMIC').success).toBe(true);
      expect(EmergencyTierSchema.safeParse('TIER_2_DISTRIBUTED_STATE').success).toBe(true);
      expect(EmergencyTierSchema.safeParse('TIER_3_FILE_LOCK').success).toBe(true);
      expect(EmergencyTierSchema.safeParse('TIER_4_OS_WATCHDOG').success).toBe(true);
    });

    it('preserves working Phase 1 NGN currency support alongside USD', () => {
      expect(CurrencyCodeSchema.safeParse('NGN').success).toBe(true);
      expect(CurrencyCodeSchema.safeParse('USD').success).toBe(true);
      expect(CurrencyCodeSchema.safeParse('FAKE_COIN').success).toBe(false);
    });

    it('preserves working Phase 1 StrategicObjective schema', () => {
      const validObjective = {
        id: randomUUID(),
        title: 'Accelerate Autonomous Job Acquisition',
        description: 'Discover remote high-paying software contracts for Owner',
        status: 'ACTIVE',
        initiatives: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      expect(StrategicObjectiveSchema.safeParse(validObjective).success).toBe(true);
    });

    it('preserves working Execution schema contracts', () => {
      const execContext = {
        contextId: randomUUID(),
        agentId: randomUUID(),
        agentCode: 'EXEC-CEO',
        departmentId: 'executive_office',
        tenantId: randomUUID(),
        callerVerified: true,
        environment: 'TEST',
        traceId: randomUUID(),
        initiatedAt: new Date().toISOString(),
      };
      expect(ExecutionContextSchema.safeParse(execContext).success).toBe(true);

      const retryPolicy = {
        maxRetries: 3,
        backoffStrategy: 'EXPONENTIAL',
        initialDelayMs: 1000,
        maxDelayMs: 15000,
        retryableFailures: ['TRANSIENT_NETWORK', 'LLM_RATE_LIMIT'],
      };
      expect(RetryPolicySchema.safeParse(retryPolicy).success).toBe(true);

      const execResult = {
        executionId: randomUUID(),
        taskId: randomUUID(),
        agentId: randomUUID(),
        status: 'SUCCESS',
        durationMs: 250,
        tokensUsed: 120,
        executedAt: new Date().toISOString(),
      };
      expect(ExecutionResultSchema.safeParse(execResult).success).toBe(true);

      const escalationEvent = {
        eventId: randomUUID(),
        originatingAgentId: randomUUID(),
        targetRecipientId: randomUUID(),
        escalationTier: 'OWNER',
        reason: 'Consequential action quarantined for Owner review',
        failureClassification: 'CONSEQUENTIAL_ACTION_BLOCKED',
        timestamp: new Date().toISOString(),
      };
      expect(EscalationEventSchema.safeParse(escalationEvent).success).toBe(true);
    });
  });
});
