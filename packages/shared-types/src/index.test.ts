import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  DepartmentIdSchema,
  DepartmentSchema,
  CANONICAL_DEPARTMENTS,
  OrganizationalLevelSchema,
  compareOrganizationalLevels,
  isLevelSeniorOrEqual,
  TreasurySpendingControlSchema,
  CANONICAL_TREASURY_CONTROLS,
  verifyDepartmentSpendingAuthorization,
  AgentIdentitySchema,
  AgentConfigurationSchema,
  createAgentRecord,
  updateAgentConfiguration,
  transferAgentDepartment,
  DepartmentTransferRecordSchema,
  ToolConfigReferenceSchema,
  assertNoRawCredentials,
  AgentModelConfigSchema,
  CANONICAL_FOUNDING_AGENTS,
  findAgentById,
  findAgentByCode,
  getDepartmentAgents,
  getDepartmentDirector,
  validateOrganizationalRegistry,
  validateWorkforceHierarchy,
  toAgentSpec,
  AgentCodeSchema,
  AuthorityScopeSchema,
  RestrictedActionTypeSchema,
  PermissionProfileSchema,
  OWNER_PRINCIPAL_ID,
  OwnerPrincipalSchema,
  CANONICAL_OWNER_PRINCIPAL,
  isOwnerPrincipal,
  CANONICAL_APPROVAL_REQUIREMENTS,
  MANDATORY_PROHIBITED_FOR_ALL_AGENTS,
  assertNonOwnerProfileValid,
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
  createVerifiedCommunicationEnvelope,
  validateCommunicationEnvelope,
  validateMessagePayload,
  MessageAcknowledgmentSchema,
  TaskAssignmentPayloadSchema,
  TaskCompletionPayloadSchema,
  FailureReportPayloadSchema,
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
  type AgentRecord,
  type ExecutionContext,
} from './index.js';

// Helper to deep-clone the founding roster for anomaly injection tests
function cloneFoundingRoster(): AgentRecord[] {
  return CANONICAL_FOUNDING_AGENTS.map((a) =>
    createAgentRecord(
      { ...a.identity },
      {
        ...a.currentConfig,
        supervisor: { ...a.currentConfig.supervisor },
        assignedResponsibilities: [...a.currentConfig.assignedResponsibilities],
        requiredCapabilities: [...a.currentConfig.requiredCapabilities],
        permissionProfile: {
          ...a.currentConfig.permissionProfile,
          allowedPermissions: [...a.currentConfig.permissionProfile.allowedPermissions],
          prohibitedRestrictedActions: [...a.currentConfig.permissionProfile.prohibitedRestrictedActions],
          requiresOwnerAuthorizationFor: [...a.currentConfig.permissionProfile.requiresOwnerAuthorizationFor],
        },
        modelConfig: {
          ...a.currentConfig.modelConfig,
          allowedTools: [...a.currentConfig.modelConfig.allowedTools],
        },
      }
    )
  );
}

describe('Milestone 2.1 — Shared Hierarchy & Communication Schemas', () => {
  // =========================================================================
  // 1. Department Definitions & Canonical Structure (Point 1 & Point 5)
  // =========================================================================
  describe('1. Department Definitions, Planning Allocations & Treasury Controls', () => {
    it('verifies all 9 canonical corporate departments exist and match diagram counts', () => {
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
        expect(parseResult.success, `Department ${dept.id} failed validation`).toBe(true);
        expect(dept.budgetMonthlyAllocationUsd).toBeGreaterThan(0);
        expect(dept.budgetMonthlyUsd).toBeGreaterThan(0);
        expect(dept.allowedCapabilities.length).toBeGreaterThan(0);
        expect(dept.directorId).toBeDefined();
        expect(dept.directorCode).toBeDefined();
        expect(dept.isActive).toBe(true);
      }
    });

    it('enforces that department budgets are planning allocations, not automatic spending permissions', () => {
      // 1. Spending within single transaction limit and authorized level succeeds
      const normalSpend = verifyDepartmentSpendingAuthorization({
        departmentId: 'technology_engineering',
        amountUsd: 2500, // <= $5,000 single transaction limit
        approverLevel: 'DIRECTOR',
      });
      expect(normalSpend.authorized).toBe(true);
      expect(normalSpend.requiresOwnerAuthorization).toBe(false);

      // 2. Spending above single transaction limit for non-Director fails
      const specialistSpend = verifyDepartmentSpendingAuthorization({
        departmentId: 'technology_engineering',
        amountUsd: 6000,
        approverLevel: 'SPECIALIST',
      });
      expect(specialistSpend.authorized).toBe(false);
      expect(specialistSpend.reason).toContain('exceeds single transaction limit');

      // 3. Spending above mandatory Owner threshold ($10,000 for Tech) requires explicit Owner authorization
      const largeSpend = verifyDepartmentSpendingAuthorization({
        departmentId: 'technology_engineering',
        amountUsd: 12000,
        approverLevel: 'DIRECTOR',
        isOwnerApproved: false,
      });
      expect(largeSpend.authorized).toBe(false);
      expect(largeSpend.requiresOwnerAuthorization).toBe(true);
      expect(largeSpend.reason).toContain('exceeds Owner authorization threshold');

      // 4. Large spend with Owner approval succeeds
      const approvedLargeSpend = verifyDepartmentSpendingAuthorization({
        departmentId: 'technology_engineering',
        amountUsd: 12000,
        approverLevel: 'DIRECTOR',
        isOwnerApproved: true,
      });
      expect(approvedLargeSpend.authorized).toBe(true);
    });

    it('rejects invalid department IDs', () => {
      expect(DepartmentIdSchema.safeParse('invalid_department').success).toBe(false);
      expect(DepartmentIdSchema.safeParse('venture_capital').success).toBe(false);
      expect(DepartmentIdSchema.safeParse('').success).toBe(false);
    });
  });

  // =========================================================================
  // 2. Immutable Identity vs. Mutable Configuration (Point 2)
  // =========================================================================
  describe('2. Separation of Immutable Agent Identity from Mutable Configuration', () => {
    it('verifies the corporate workforce roster contains exactly 30 founding AI employee records', () => {
      expect(CANONICAL_FOUNDING_AGENTS).toHaveLength(30);

      for (const agent of CANONICAL_FOUNDING_AGENTS) {
        // Validate immutable identity partition
        const idParse = AgentIdentitySchema.safeParse(agent.identity);
        expect(idParse.success, `Identity for ${agent.agentCode} failed: ${idParse.error?.message}`).toBe(true);

        // Validate mutable configuration partition
        const configParse = AgentConfigurationSchema.safeParse(agent.currentConfig);
        expect(configParse.success, `Config for ${agent.agentCode} failed: ${configParse.error?.message}`).toBe(true);

        // Verify config references identity
        expect(agent.currentConfig.agentId).toBe(agent.identity.id);
      }
    });

    it('verifies agent distribution across all 9 departments conforms to corrected diagram counts', () => {
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

    it('guarantees changing mutable configuration preserves permanent immutable identity and agent code', () => {
      const originalAgent = findAgentByCode('TECH-FSE')!;
      expect(originalAgent).toBeDefined();

      const immutableId = originalAgent.identity.id;
      const immutableCode = originalAgent.identity.agentCode;
      const immutableDept = originalAgent.identity.departmentId;
      const immutableCreatedAt = originalAgent.identity.createdAt;

      // Update title, supervisor, responsibilities, and permissions
      const promotedAgent = updateAgentConfiguration(originalAgent, {
        jobTitle: 'Staff Full Stack Engineer & Tech Lead',
        displayName: 'StaffFullStackEngineerBot',
        assignedResponsibilities: [
          ...originalAgent.assignedResponsibilities,
          'Lead technical design reviews across engineering team',
        ],
      });

      // Immutable identity partition MUST remain identical
      expect(promotedAgent.identity.id).toBe(immutableId);
      expect(promotedAgent.identity.agentCode).toBe(immutableCode);
      expect(promotedAgent.identity.departmentId).toBe(immutableDept);
      expect(promotedAgent.identity.createdAt).toBe(immutableCreatedAt);
      expect(promotedAgent.id).toBe(immutableId);
      expect(promotedAgent.agentCode).toBe(immutableCode);

      // Mutable configuration partition MUST reflect updates
      expect(promotedAgent.jobTitle).toBe('Staff Full Stack Engineer & Tech Lead');
      expect(promotedAgent.displayName).toBe('StaffFullStackEngineerBot');
      expect(promotedAgent.assignedResponsibilities).toContain('Lead technical design reviews across engineering team');
      expect(promotedAgent.currentConfig.configVersion).toBe('1.0.1');
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
  // 4. Valid Organizational Relationships & Chain of Command
  // =========================================================================
  describe('4. Organizational Hierarchy & Chain of Command', () => {
    it('verifies the full workforce hierarchy validates without errors', () => {
      const validation = validateOrganizationalRegistry(CANONICAL_FOUNDING_AGENTS);
      expect(validation.errors).toEqual([]);
      expect(validation.valid).toBe(true);
    });

    it('verifies the CEO reports to Owner principal with null supervisorAgentId', () => {
      const ceo = findAgentByCode('EXEC-CEO')!;
      expect(ceo).toBeDefined();
      expect(ceo.supervisor.reportsToOwner).toBe(true);
      expect(ceo.supervisor.supervisorType).toBe('OWNER_PRINCIPAL');
      expect(ceo.supervisor.ownerPrincipalId).toBe(OWNER_PRINCIPAL_ID);
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
      expect(specialists).toHaveLength(20);

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
  // 5. Complete Organizational Registry Validation (Point 6)
  // =========================================================================
  describe('5. Comprehensive Organizational Registry Validation', () => {
    it('detects and rejects a circular reporting chain (Agent A -> Agent B -> Agent A)', () => {
      const corruptedRoster = cloneFoundingRoster();
      const cto = corruptedRoster.find((a) => a.agentCode === 'TECH-CTO')!;
      const architect = corruptedRoster.find((a) => a.agentCode === 'TECH-ARCH')!;

      // Make CTO report to Architect, while Architect reports to CTO
      cto.currentConfig.supervisor.supervisorAgentId = architect.id;
      architect.currentConfig.supervisor.supervisorAgentId = cto.id;

      const result = validateOrganizationalRegistry(corruptedRoster);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Circular reporting relationship'))).toBe(true);
    });

    it('detects and rejects an agent reporting to itself', () => {
      const corruptedRoster = cloneFoundingRoster();
      const cfo = corruptedRoster.find((a) => a.agentCode === 'FIN-CFO')!;
      cfo.currentConfig.supervisor.supervisorAgentId = cfo.id;

      const result = validateOrganizationalRegistry(corruptedRoster);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Self-reporting prohibited'))).toBe(true);
    });

    it('detects when an agent has a missing supervisor', () => {
      const corruptedRoster = cloneFoundingRoster();
      const engineer = corruptedRoster.find((a) => a.agentCode === 'TECH-FSE')!;
      engineer.currentConfig.supervisor.supervisorAgentId = null;

      const result = validateOrganizationalRegistry(corruptedRoster);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('has missing supervisor'))).toBe(true);
    });

    it('detects when an agent references a non-existent supervisor ID', () => {
      const corruptedRoster = cloneFoundingRoster();
      const engineer = corruptedRoster.find((a) => a.agentCode === 'TECH-FSE')!;
      engineer.currentConfig.supervisor.supervisorAgentId = randomUUID();

      const result = validateOrganizationalRegistry(corruptedRoster);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('references non-existent supervisor ID'))).toBe(true);
    });

    it('detects a seniority violation (e.g. Director reporting to Specialist)', () => {
      const corruptedRoster = cloneFoundingRoster();
      const cto = corruptedRoster.find((a) => a.agentCode === 'TECH-CTO')!;
      const engineer = corruptedRoster.find((a) => a.agentCode === 'TECH-FSE')!;

      // CTO reports to Engineer
      cto.currentConfig.supervisor.supervisorAgentId = engineer.id;

      const result = validateOrganizationalRegistry(corruptedRoster);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Hierarchy seniority violation'))).toBe(true);
    });

    it('detects when a department has no active Director assigned', () => {
      const corruptedRoster = cloneFoundingRoster();
      // Deactivate the CFO
      const cfo = corruptedRoster.find((a) => a.agentCode === 'FIN-CFO')!;
      cfo.currentConfig.operationalStatus = 'TERMINATED';

      const result = validateOrganizationalRegistry(corruptedRoster);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("Department 'financial_intelligence' has no active Director"))).toBe(true);
    });

    it('detects and rejects duplicate agent IDs or duplicate agent codes', () => {
      const corruptedRoster = cloneFoundingRoster();
      const agentA = corruptedRoster[0]!;
      const agentB = corruptedRoster[1]!;

      // Inject duplicate ID
      agentB.identity.id = agentA.identity.id;
      agentB.currentConfig.agentId = agentA.identity.id;

      const result = validateOrganizationalRegistry(corruptedRoster);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Duplicate agent ID'))).toBe(true);
    });

    it('detects and rejects prohibited Owner-level permission assignments on AI employees', () => {
      const corruptedRoster = cloneFoundingRoster();
      const cto = corruptedRoster.find((a) => a.agentCode === 'TECH-CTO')!;

      // Attempt to grant OWNER_ONLY scope or remove prohibited actions
      cto.currentConfig.permissionProfile.scope = 'OWNER_ONLY';

      const result = validateOrganizationalRegistry(corruptedRoster);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("cannot be assigned 'OWNER_ONLY' authority scope"))).toBe(true);
    });
  });

  // =========================================================================
  // 6. Department Reference Integrity
  // =========================================================================
  describe('6. Department Reference Integrity', () => {
    it('rejects an agent configured with an invalid department ID', () => {
      const corruptedRoster = cloneFoundingRoster();
      (corruptedRoster[0]!.identity as any).departmentId = 'unknown_department';

      const result = validateOrganizationalRegistry(corruptedRoster);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("references invalid department: 'unknown_department'"))).toBe(true);
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
  // 7. Communication Envelope Validation & Typed Payloads (Point 4)
  // =========================================================================
  describe('7. Standardized Communication Protocol & Type-Specific Payloads', () => {
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

    it('validates message payloads against message-type-specific schemas', () => {
      // 1. Valid TASK_ASSIGNMENT payload
      const validAssignment = {
        taskId: randomUUID(),
        title: 'Build Schema Test Suite',
        instructions: 'Implement Vitest suite for shared-types',
        priority: 'HIGH',
      };
      expect(validateMessagePayload('TASK_ASSIGNMENT', validAssignment).valid).toBe(true);

      // 2. Invalid TASK_ASSIGNMENT payload (missing title & instructions)
      const invalidAssignment = { taskId: randomUUID() };
      const invalidCheck = validateMessagePayload('TASK_ASSIGNMENT', invalidAssignment);
      expect(invalidCheck.valid).toBe(false);
      expect(invalidCheck.error).toContain('instructions');

      // 3. Valid TASK_COMPLETION payload
      const validCompletion = {
        taskId: randomUUID(),
        status: 'SUCCESS',
        summary: 'All schemas verified',
        outputData: { testCount: 80 },
      };
      expect(validateMessagePayload('TASK_COMPLETION', validCompletion).valid).toBe(true);

      // 4. Valid FAILURE_REPORT payload
      const validFailure = {
        taskId: randomUUID(),
        failureClassification: 'CIRCUIT_BREAKER_HALTED',
        errorMessage: 'Emergency kill switch latched',
      };
      expect(validateMessagePayload('FAILURE_REPORT', validFailure).valid).toBe(true);
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
          taskId: randomUUID(),
          title: 'Implement Schema Test Suite',
          instructions: 'Milestone 2.1 complete tests',
          priority: 'HIGH',
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
  // 8. Trusted Sender Context & Anti-Spoofing (Point 4)
  // =========================================================================
  describe('8. Trusted Backend Execution Context & Anti-Spoofing Verification', () => {
    const trustedContext: ExecutionContext = {
      contextId: randomUUID(),
      agentId: '00000000-0000-0000-0000-000000000007',
      agentCode: 'TECH-CTO',
      departmentId: 'technology_engineering',
      tenantId: randomUUID(),
      callerVerified: true,
      callerSignature: 'sig-verified-cto-token',
      environment: 'PRODUCTION',
      traceId: randomUUID(),
      initiatedAt: new Date().toISOString(),
      timeoutMs: 60000,
    };

    it('derives sender identity strictly from trusted ExecutionContext via createVerifiedCommunicationEnvelope', () => {
      const envelope = createVerifiedCommunicationEnvelope(trustedContext, {
        recipientDepartmentId: 'technology_engineering',
        recipientAgentId: '00000000-0000-0000-0000-000000000009',
        recipientAgentCode: 'TECH-FSE',
        type: 'TASK_ASSIGNMENT',
        priority: 'HIGH',
        payload: {
          taskId: randomUUID(),
          title: 'Implement verified envelope',
          instructions: 'Derive sender from context',
          priority: 'HIGH',
        },
      });

      // Sender MUST match trusted execution context exactly
      expect(envelope.senderAgentId).toBe(trustedContext.agentId);
      expect(envelope.senderAgentCode).toBe(trustedContext.agentCode);
      expect(envelope.senderDepartmentId).toBe(trustedContext.departmentId);
      expect(envelope.verifiedSenderSignature).toBe(trustedContext.callerSignature);

      // Verify the envelope passes validation against the trusted context
      const validation = validateCommunicationEnvelope(envelope, trustedContext);
      expect(validation.valid).toBe(true);
    });

    it('detects and rejects sender identity spoofing when payload contains arbitrary senderAgentId', () => {
      const impersonatorId = randomUUID();

      const forgedEnvelope = {
        messageId: randomUUID(),
        senderAgentId: impersonatorId, // Forged sender
        senderDepartmentId: 'technology_engineering',
        recipientAgentId: randomUUID(),
        recipientDepartmentId: 'financial_intelligence',
        type: 'TASK_ASSIGNMENT',
        priority: 'MEDIUM',
        payload: {
          taskId: randomUUID(),
          title: 'Unauthorized Task',
          instructions: 'Execute funds transfer',
        },
        correlationId: randomUUID(),
        sentAt: new Date().toISOString(),
      };

      // When validated against the true trusted caller context, it MUST reject
      const check = validateCommunicationEnvelope(forgedEnvelope, trustedContext);
      expect(check.valid).toBe(false);
      expect(check.error).toContain('Sender identity spoofing rejected');
    });

    it('rejects envelope if payload does not conform to message-type-specific schema', () => {
      const envelopeWithMalformedPayload = {
        messageId: randomUUID(),
        senderAgentId: trustedContext.agentId,
        senderDepartmentId: trustedContext.departmentId,
        recipientAgentId: randomUUID(),
        recipientDepartmentId: 'technology_engineering',
        type: 'TASK_ASSIGNMENT',
        priority: 'MEDIUM',
        payload: { invalidField: 'missing required title and instructions' }, // Malformed payload
        correlationId: randomUUID(),
        sentAt: new Date().toISOString(),
      };

      const check = validateCommunicationEnvelope(envelopeWithMalformedPayload, trustedContext);
      expect(check.valid).toBe(false);
      expect(check.error).toContain("Invalid payload for message type 'TASK_ASSIGNMENT'");
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
  // 10. CEO & Executive Authority Subordination to Owner (Point 3)
  // =========================================================================
  describe('10. CEO & Executive Authority Subordination to Owner Authority', () => {
    it('enforces that the CEO profile does not possess Owner-level permissions or wildcards', () => {
      const ceo = findAgentByCode('EXEC-CEO')!;
      expect(ceo.permissionProfile.allowedPermissions).not.toContain('*');
      expect(ceo.permissionProfile.scope).toBe('EXECUTIVE_WIDE');

      // CEO cannot authorize capital transfers, live trading, binding contracts, or governance overrides
      for (const prohibited of MANDATORY_PROHIBITED_FOR_ALL_AGENTS) {
        expect(ceo.permissionProfile.prohibitedRestrictedActions).toContain(prohibited);
        const check = validateAgentAction(ceo.permissionProfile, prohibited);
        expect(check.allowed).toBe(false);
        expect(check.reason).toContain('CEO/Executive authority remains subordinate to Owner');
      }
    });

    it('enforces that no agent profile can self-elevate permissions', () => {
      for (const agent of CANONICAL_FOUNDING_AGENTS) {
        const check = validateAgentAction(agent.permissionProfile, 'PERMISSION_ELEVATION');
        expect(check.allowed).toBe(false);
        expect(agent.permissionProfile.prohibitedRestrictedActions).toContain('PERMISSION_ELEVATION');
      }
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
  // 12. Compatibility with Phase 1 Types & Regression Checks (Point 7)
  // =========================================================================
  describe('12. Phase 1 Backward Compatibility & Regression Tests', () => {
    it('verifies toAgentSpec transforms AgentRecord into fully valid Phase 1 AgentSpec', () => {
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

  // =========================================================================
  // 13. Final Refinements: Department Origin Immutability, Owner Principal & Credential Safety
  // =========================================================================
  describe('13. Final Refinements: Department Origin Immutability, Owner Principal & Credential Safety', () => {
    // Refinement 1
    it('preserves immutable founding department origin and records department transfers in versioned history', () => {
      const engineer = findAgentByCode('TECH-FSE')!;
      expect(engineer.originDepartmentId).toBe('technology_engineering');
      expect(engineer.departmentId).toBe('technology_engineering');
      expect(engineer.departmentTransferHistory).toHaveLength(0);

      // Execute department transfer
      const transferred = transferAgentDepartment(engineer, {
        toDepartmentId: 'opportunity_acquisition',
        reason: 'Temporary rotation as Technical Opportunity Scout',
        authorizedBy: 'EXEC-CEO',
        newJobTitle: 'Technical Opportunity Scout',
      });

      // 1. Permanent origin department must remain UNCHANGED
      expect(transferred.originDepartmentId).toBe('technology_engineering');
      expect(transferred.identity.departmentId).toBe('technology_engineering');
      expect(transferred.identity.id).toBe(engineer.identity.id);
      expect(transferred.identity.agentCode).toBe(engineer.identity.agentCode);

      // 2. Active department and job title must reflect transfer
      expect(transferred.departmentId).toBe('opportunity_acquisition');
      expect(transferred.jobTitle).toBe('Technical Opportunity Scout');
      expect(transferred.configVersion).toBe('1.1.0');

      // 3. Department transfer history must record audit trail
      expect(transferred.departmentTransferHistory).toHaveLength(1);
      const transferAudit = transferred.departmentTransferHistory[0]!;
      expect(transferAudit.fromDepartmentId).toBe('technology_engineering');
      expect(transferAudit.toDepartmentId).toBe('opportunity_acquisition');
      expect(transferAudit.reason).toContain('Technical Opportunity Scout');
      expect(transferAudit.authorizedBy).toBe('EXEC-CEO');
      expect(transferAudit.previousConfigVersion).toBe('1.0.0');
      expect(transferAudit.newConfigVersion).toBe('1.1.0');

      // 4. Configuration history preserves previous state
      expect(transferred.configHistory).toHaveLength(1);
      expect(transferred.configHistory[0]!.jobTitle).toBe(engineer.jobTitle);

      // 5. Attempting to transfer to same department throws error
      expect(() =>
        transferAgentDepartment(transferred, {
          toDepartmentId: 'opportunity_acquisition',
          reason: 'Redundant transfer',
          authorizedBy: 'EXEC-CEO',
        })
      ).toThrow("Cannot transfer agent TECH-FSE to same department 'opportunity_acquisition'");
    });

    // Refinement 2
    it('represents the Owner as a distinct authority principal outside the 30-agent workforce registry', () => {
      // 1. Verify Owner principal schema and canonical record
      expect(OwnerPrincipalSchema.safeParse(CANONICAL_OWNER_PRINCIPAL).success).toBe(true);
      expect(CANONICAL_OWNER_PRINCIPAL.principalId).toBe(OWNER_PRINCIPAL_ID);
      expect(CANONICAL_OWNER_PRINCIPAL.principalType).toBe('HUMAN_OWNER');
      expect(CANONICAL_OWNER_PRINCIPAL.name).toBe('Stephen Mendez');
      expect(CANONICAL_OWNER_PRINCIPAL.authorityScope).toBe('OWNER_ONLY');
      expect(isOwnerPrincipal(OWNER_PRINCIPAL_ID)).toBe(true);
      expect(isOwnerPrincipal(randomUUID())).toBe(false);

      // 2. Verify Owner principal is NOT part of the 30-agent workforce roster
      expect(CANONICAL_FOUNDING_AGENTS.some((a) => a.id === OWNER_PRINCIPAL_ID)).toBe(false);

      // 3. Verify CEO reports to the Owner principal
      const ceo = findAgentByCode('EXEC-CEO')!;
      expect(ceo.supervisor.supervisorType).toBe('OWNER_PRINCIPAL');
      expect(ceo.supervisor.ownerPrincipalId).toBe(OWNER_PRINCIPAL_ID);
      expect(ceo.supervisor.supervisorAgentId).toBeNull();
      expect(ceo.supervisor.reportsToOwner).toBe(true);

      // 4. Anomaly test: Reject workforce registry if Owner principal is mistakenly added as an agent
      const corruptedRosterWithOwner = cloneFoundingRoster();
      corruptedRosterWithOwner[0]!.identity.id = OWNER_PRINCIPAL_ID;
      corruptedRosterWithOwner[0]!.currentConfig.agentId = OWNER_PRINCIPAL_ID;
      const ownerInRosterCheck = validateOrganizationalRegistry(corruptedRosterWithOwner);
      expect(ownerInRosterCheck.valid).toBe(false);
      expect(ownerInRosterCheck.errors.some((e) => e.includes('Owner principal'))).toBe(true);

      // 5. Anomaly test: Reject non-executive agent attempting to report directly to Owner principal
      const corruptedRosterWithIllegalReport = cloneFoundingRoster();
      const engineer = corruptedRosterWithIllegalReport.find((a) => a.agentCode === 'TECH-FSE')!;
      engineer.currentConfig.supervisor.supervisorType = 'OWNER_PRINCIPAL';
      engineer.currentConfig.supervisor.ownerPrincipalId = OWNER_PRINCIPAL_ID;
      engineer.currentConfig.supervisor.supervisorAgentId = null;
      engineer.currentConfig.supervisor.reportsToOwner = true;
      const illegalReportCheck = validateOrganizationalRegistry(corruptedRosterWithIllegalReport);
      expect(illegalReportCheck.valid).toBe(false);
      expect(illegalReportCheck.errors.some((e) => e.includes('cannot report directly to the Owner principal'))).toBe(true);
    });

    // Refinement 3
    it('models configuration references for LLM providers and tools, but strictly bars raw credentials', () => {
      // 1. All 30 canonical founding agents must contain zero raw credentials
      for (const agent of CANONICAL_FOUNDING_AGENTS) {
        const check = assertNoRawCredentials(agent.currentConfig, agent.agentCode);
        expect(check.valid, `Agent ${agent.agentCode} contains credentials: ${check.errors.join(', ')}`).toBe(true);
      }

      // 2. Valid model and tool credential references succeed
      const validConfig = {
        modelProvider: 'openai' as const,
        modelId: 'gpt-4o',
        temperature: 0.2,
        systemPrompt: 'You are an autonomous corporate research specialist.',
        allowedTools: ['web_search', 'code_interpreter'],
        toolConfigs: [
          {
            toolName: 'web_search',
            enabled: true,
            credentialReference: 'TAVILY_API_KEY_REF',
          },
        ],
        credentialReference: 'OPENAI_API_KEY_SECRET',
        maxParallelTasks: 3,
        timeoutMs: 60000,
      };
      expect(AgentModelConfigSchema.safeParse(validConfig).success).toBe(true);

      // 3. Raw OpenAI API key in credentialReference is rejected
      const rawKeyConfig = {
        ...validConfig,
        credentialReference: 'sk-proj-abc1234567890abcdef1234567890abcdef12',
      };
      expect(AgentModelConfigSchema.safeParse(rawKeyConfig).success).toBe(false);

      // 4. Raw Anthropic API key in systemPrompt is rejected
      const rawPromptConfig = {
        ...validConfig,
        systemPrompt: 'Use Anthropic key sk-ant-api03-abcdef1234567890abcdef1234567890 for queries',
      };
      expect(AgentModelConfigSchema.safeParse(rawPromptConfig).success).toBe(false);

      // 5. Disallowed credential field name ('apiKey') in configuration is caught by assertNoRawCredentials
      const configWithRawField = {
        ...validConfig,
        apiKey: 'secret_value_123',
      };
      const checkField = assertNoRawCredentials(configWithRawField);
      expect(checkField.valid).toBe(false);
      expect(checkField.errors.some((e) => e.includes("Disallowed credential property 'apiKey'"))).toBe(true);
    });
  });
});
