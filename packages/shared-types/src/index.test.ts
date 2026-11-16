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
  compareSemver,
  parseSemver,
  isAuthorizedTransferAuthority,
  validateDepartmentTransferHistory,
  DepartmentTransferRecordSchema,
  ToolConfigReferenceSchema,
  assertNoRawCredentials,
  AgentModelConfigSchema,
  AgentSupervisorSchema,
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
  CredentialResolverContextSchema,
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
        departmentTransferHistory: [...(a.currentConfig.departmentTransferHistory ?? [])],
      },
      [...a.configHistory]
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

  // =========================================================================
  // 14. M2.1 Final Corrective Pass: Deep Verification of Transfers, Registry, Credentials, and Record Consistency
  // =========================================================================
  describe('14. M2.1 Final Corrective Pass: Deep Verification of Transfers, Registry, Credentials, and Record Consistency', () => {
    // 1. Authorization Integrity
    it('14.1 Enforces strict transfer authorization integrity, anchoring executive authority to canonical founding executive identities and rejecting forged registries', () => {
      const engineer = findAgentByCode('TECH-FSE')!;
      const roster = cloneFoundingRoster();

      // 1. Spoofed Owner identifiers must be rejected
      const spoofedOwnerIds = ['OWNER', 'owner', 'Stephen Mendez', 'owner_principal', randomUUID()];
      for (const spoofed of spoofedOwnerIds) {
        expect(isAuthorizedTransferAuthority(spoofed, roster)).toBe(false);
        expect(() =>
          transferAgentDepartment(engineer, {
            toDepartmentId: 'opportunity_acquisition',
            reason: 'Spoofed owner transfer attempt',
            authorizedBy: spoofed,
          })
        ).toThrow('lacks executive or Owner transfer authorization authority');
      }

      // 2. Legitimate canonical Owner authorization strictly succeeds
      expect(isAuthorizedTransferAuthority(OWNER_PRINCIPAL_ID, roster)).toBe(true);
      expect(isAuthorizedTransferAuthority(CANONICAL_OWNER_PRINCIPAL.principalId, roster)).toBe(true);

      // 3. Legitimate canonical executive authorization strictly succeeds
      expect(isAuthorizedTransferAuthority('EXEC-CEO', roster)).toBe(true);
      expect(isAuthorizedTransferAuthority('EXEC-COO', roster)).toBe(true);
      expect(isAuthorizedTransferAuthority('00000000-0000-0000-0000-000000000001', roster)).toBe(true);
      expect(isAuthorizedTransferAuthority('00000000-0000-0000-0000-000000000002', roster)).toBe(true);

      // 4. Forged executive records must be rejected (not anchored to canonical founding executive identities)
      expect(isAuthorizedTransferAuthority('EXEC-FORGED', roster)).toBe(false);
      expect(isAuthorizedTransferAuthority(randomUUID(), roster)).toBe(false);

      // 5. Inactive executive (e.g. SUSPENDED) cannot authorize
      const suspendedRoster = cloneFoundingRoster();
      const suspendedCeo = suspendedRoster.find((a) => a.agentCode === 'EXEC-CEO')!;
      suspendedCeo.currentConfig.operationalStatus = 'SUSPENDED';
      expect(isAuthorizedTransferAuthority('EXEC-CEO', suspendedRoster)).toBe(false);

      // 6. Non-executive roles (Specialist, Director) cannot authorize
      expect(isAuthorizedTransferAuthority('TECH-QA', roster)).toBe(false);
      expect(isAuthorizedTransferAuthority('FIN-CFO', roster)).toBe(false);

      // 7. Direct calls to isAuthorizedTransferAuthority with a synthetic executive roster must be rejected
      const syntheticExecId = randomUUID();
      const syntheticExecutive = createAgentRecord(
        {
          id: syntheticExecId,
          agentCode: 'EXEC-SYNTH',
          departmentId: 'executive_office',
          createdAt: new Date().toISOString(),
        },
        {
          ...roster[0]!.currentConfig,
          configurationId: randomUUID(),
          agentId: syntheticExecId,
          level: 'EXECUTIVE',
          assignedDepartmentId: 'executive_office',
        }
      );
      const syntheticRoster = [syntheticExecutive];
      expect(isAuthorizedTransferAuthority('EXEC-SYNTH', syntheticRoster)).toBe(false);
      expect(isAuthorizedTransferAuthority(syntheticExecId, syntheticRoster)).toBe(false);

      // 8. Structurally valid 30-agent registry containing a forged executive
      // Replace EXEC-COO with EXEC-ROGUE in a full 30-agent roster (exactly 30 agents, valid departments)
      const cooIndex = roster.findIndex((a) => a.agentCode === 'EXEC-COO');
      const rogueExecId = randomUUID();
      const rogueExecutive = createAgentRecord(
        {
          id: rogueExecId,
          agentCode: 'EXEC-ROGUE',
          departmentId: 'executive_office',
          createdAt: new Date().toISOString(),
        },
        {
          ...roster[cooIndex]!.currentConfig,
          configurationId: randomUUID(),
          agentId: rogueExecId,
          displayName: 'Rogue Chief Operating Officer',
          jobTitle: 'Forged Chief Operating Officer',
          level: 'EXECUTIVE',
          assignedDepartmentId: 'executive_office',
        }
      );
      const structurallyValidForgedRoster = [...roster];
      structurallyValidForgedRoster[cooIndex] = rogueExecutive;

      // Update subordinates who reported to the replaced COO so the roster is structurally valid
      const opsDirIndex = structurallyValidForgedRoster.findIndex((a) => a.agentCode === 'OPS-DIR');
      if (opsDirIndex !== -1) {
        const opsDir = structurallyValidForgedRoster[opsDirIndex]!;
        structurallyValidForgedRoster[opsDirIndex] = createAgentRecord(
          opsDir.identity,
          {
            ...opsDir.currentConfig,
            supervisor: {
              ...opsDir.supervisor,
              supervisorAgentId: rogueExecId,
              supervisorAgentCode: 'EXEC-ROGUE',
            },
          },
          opsDir.configHistory
        );
      }

      // Verify the roster has exactly 30 agents and passes structural registry validation
      expect(structurallyValidForgedRoster).toHaveLength(30);
      expect(validateOrganizationalRegistry(structurallyValidForgedRoster).valid).toBe(true);

      // A forged executive attempting to authorize a transfer must be REJECTED despite valid 30-agent registry
      expect(isAuthorizedTransferAuthority('EXEC-ROGUE', structurallyValidForgedRoster)).toBe(false);
      expect(isAuthorizedTransferAuthority(rogueExecId, structurallyValidForgedRoster)).toBe(false);

      expect(() =>
        transferAgentDepartment(engineer, {
          toDepartmentId: 'opportunity_acquisition',
          reason: 'Forged executive authorization attempt',
          authorizedBy: 'EXEC-ROGUE',
          knownAgents: structurallyValidForgedRoster,
        })
      ).toThrow("Unauthorized department transfer: 'EXEC-ROGUE' lacks executive or Owner transfer authorization authority");
    });

    // 2. Strict SemVer Validation
    it('14.2 Enforces Strict Numeric X.Y.Z Versioning (Restricted SemVer 2.0 Subset), rejecting malformed suffixes, negative values, leading zeros, and unsafe numeric values', () => {
      // Positive tests: valid X.Y.Z SemVer strings
      const validVersions = ['0.0.0', '1.0.0', '0.1.0', '0.0.1', '10.20.30', '999.888.777'];
      for (const v of validVersions) {
        expect(() => parseSemver(v)).not.toThrow();
        expect(compareSemver(v, v)).toBe(0);
      }
      expect(compareSemver('1.2.0', '1.1.0')).toBeGreaterThan(0);
      expect(compareSemver('1.1.0', '1.2.0')).toBeLessThan(0);
      expect(compareSemver('2.0.0', '1.9.9')).toBeGreaterThan(0);

      // Negative tests: malformed suffixes
      const suffixVersions = ['1.0.0-beta', '1.0.0-alpha.1', '1.0.0+build2026', '1.0.0-rc1'];
      for (const v of suffixVersions) {
        expect(() => parseSemver(v)).toThrow('expected strict X.Y.Z');
        expect(() => compareSemver(v, '1.0.0')).toThrow();
      }

      // Negative values
      const negativeVersions = ['-1.0.0', '1.-1.0', '1.0.-1'];
      for (const v of negativeVersions) {
        expect(() => parseSemver(v)).toThrow('expected strict X.Y.Z');
      }

      // Leading zero numeric components where invalid
      const leadingZeroVersions = ['01.0.0', '1.01.0', '1.0.01', '00.1.0'];
      for (const v of leadingZeroVersions) {
        expect(() => parseSemver(v)).toThrow('expected strict X.Y.Z');
      }

      // Truncated, extra segments, whitespace, prefixes
      const malformedVersions = ['1', '1.0', '1.0.0.0', ' 1.0.0', '1.0.0 ', 'v1.0.0', 'V1.0.0', '1.0.x'];
      for (const v of malformedVersions) {
        expect(() => parseSemver(v)).toThrow('expected strict X.Y.Z');
      }

      // Unsafe numeric values
      const unsafeVersion = '9007199254740992.0.0'; // > Number.MAX_SAFE_INTEGER
      expect(() => parseSemver(unsafeVersion)).toThrow('exceeds safe integer limit');
    });

    // 3. Transfer Timestamps Validation
    it('14.3 Enforces strictly increasing transfer timestamps and rejects invalid date strings', () => {
      const engineer = findAgentByCode('TECH-FSE')!;

      // Invalid date strings must throw in transferAgentDepartment
      expect(() =>
        transferAgentDepartment(engineer, {
          toDepartmentId: 'opportunity_acquisition',
          reason: 'Invalid date transfer',
          authorizedBy: 'EXEC-CEO',
          effectiveDate: 'invalid-date-string',
        })
      ).toThrow("Invalid transfer effectiveDate: 'invalid-date-string' is not a valid date string");

      expect(() =>
        transferAgentDepartment(engineer, {
          toDepartmentId: 'opportunity_acquisition',
          reason: 'Empty date transfer',
          authorizedBy: 'EXEC-CEO',
          effectiveDate: '   ',
        })
      ).toThrow('is not a valid date string');

      // Multi-step transfers: strictly increasing timestamps
      const transfer1 = transferAgentDepartment(engineer, {
        toDepartmentId: 'opportunity_acquisition',
        reason: 'First rotation',
        authorizedBy: 'EXEC-CEO',
        effectiveDate: '2026-02-01T10:00:00.000Z',
        newVersion: '1.1.0',
      });

      // Equal timestamp must throw
      expect(() =>
        transferAgentDepartment(transfer1, {
          toDepartmentId: 'research_intelligence',
          reason: 'Same time transfer',
          authorizedBy: 'EXEC-CEO',
          effectiveDate: '2026-02-01T10:00:00.000Z', // Equal timestamp
          newVersion: '1.2.0',
        })
      ).toThrow('Transfer effectiveDate must be strictly increasing');

      // Earlier timestamp must throw
      expect(() =>
        transferAgentDepartment(transfer1, {
          toDepartmentId: 'research_intelligence',
          reason: 'Earlier time transfer',
          authorizedBy: 'EXEC-CEO',
          effectiveDate: '2026-01-15T00:00:00.000Z', // Earlier timestamp
          newVersion: '1.2.0',
        })
      ).toThrow('Transfer effectiveDate must be strictly increasing');

      // Strictly later timestamp succeeds
      const transfer2 = transferAgentDepartment(transfer1, {
        toDepartmentId: 'research_intelligence',
        reason: 'Second rotation',
        authorizedBy: 'EXEC-CEO',
        effectiveDate: '2026-03-01T12:00:00.000Z', // Later timestamp
        newVersion: '1.2.0',
      });
      expect(validateDepartmentTransferHistory(transfer2).valid).toBe(true);

      // validateDepartmentTransferHistory rejects history with equal timestamps or invalid dates
      const equalTimeConfig = {
        ...transfer2.currentConfig,
        departmentTransferHistory: [
          transfer2.departmentTransferHistory[0]!,
          {
            ...transfer2.departmentTransferHistory[1]!,
            effectiveDate: transfer2.departmentTransferHistory[0]!.effectiveDate, // Equal
          },
        ],
      };
      const equalTimeAgent = createAgentRecord(transfer2.identity, equalTimeConfig, transfer2.configHistory);
      const equalCheck = validateDepartmentTransferHistory(equalTimeAgent);
      expect(equalCheck.valid).toBe(false);
      expect(equalCheck.errors.some((e) => e.includes('Transfer history timestamp violation'))).toBe(true);

      const invalidDateConfig = {
        ...transfer2.currentConfig,
        departmentTransferHistory: [
          {
            ...transfer2.departmentTransferHistory[0]!,
            effectiveDate: 'not-a-valid-date',
          },
          transfer2.departmentTransferHistory[1]!,
        ],
      };
      const invalidDateAgent = createAgentRecord(transfer2.identity, invalidDateConfig, transfer2.configHistory);
      const invalidDateCheck = validateDepartmentTransferHistory(invalidDateAgent);
      expect(invalidDateCheck.valid).toBe(false);
      expect(invalidDateCheck.errors.some((e) => e.includes('has invalid effectiveDate'))).toBe(true);
    });

    // 4. Configuration Version Continuity Validation
    it('14.4 Enforces configuration version continuity, rejecting version gaps, regressions, and active-configuration mismatches', () => {
      const engineer = findAgentByCode('TECH-FSE')!;

      const transfer1 = transferAgentDepartment(engineer, {
        toDepartmentId: 'opportunity_acquisition',
        reason: 'Rotation 1',
        authorizedBy: 'EXEC-CEO',
        newVersion: '1.1.0',
        effectiveDate: '2026-02-01T00:00:00.000Z',
      });

      const transfer2 = transferAgentDepartment(transfer1, {
        toDepartmentId: 'research_intelligence',
        reason: 'Rotation 2',
        authorizedBy: OWNER_PRINCIPAL_ID,
        newVersion: '1.2.0',
        effectiveDate: '2026-03-01T00:00:00.000Z',
      });

      expect(validateDepartmentTransferHistory(transfer2).valid).toBe(true);

      // 1. Version Gap: transfer record specifies a version not present in configuration history
      const versionGapConfig = {
        ...transfer2.currentConfig,
        departmentTransferHistory: [
          transfer2.departmentTransferHistory[0]!,
          {
            ...transfer2.departmentTransferHistory[1]!,
            previousConfigVersion: '3.0.0', // Gap: 3.0.0 was never in config history
            newConfigVersion: '3.1.0',
          },
        ],
      };
      const versionGapAgent = createAgentRecord(transfer2.identity, versionGapConfig, transfer2.configHistory);
      const gapCheck = validateDepartmentTransferHistory(versionGapAgent);
      expect(gapCheck.valid).toBe(false);
      expect(gapCheck.errors.some((e) => e.includes('Configuration version gap'))).toBe(true);

      // 2. Version Regression in transfer history: record 1 previousConfigVersion is older than record 0 newConfigVersion
      const versionRegressionConfig = {
        ...transfer2.currentConfig,
        departmentTransferHistory: [
          transfer2.departmentTransferHistory[0]!, // 1.0.0 -> 1.1.0
          {
            ...transfer2.departmentTransferHistory[1]!,
            previousConfigVersion: '1.0.0', // Regression: regresses back behind 1.1.0
            newConfigVersion: '1.1.0',
          },
        ],
      };
      const versionRegressionAgent = createAgentRecord(transfer2.identity, versionRegressionConfig, transfer2.configHistory);
      const regCheck = validateDepartmentTransferHistory(versionRegressionAgent);
      expect(regCheck.valid).toBe(false);
      expect(regCheck.errors.some((e) => e.includes('Transfer history version regression'))).toBe(true);

      // 3. Active Configuration Mismatch: currentConfig.configVersion is older than final transfer version
      const activeMismatchConfig = {
        ...transfer2.currentConfig,
        configVersion: '1.0.0', // Active config is 1.0.0 but final transfer was 1.2.0
      };
      const activeMismatchAgent = createAgentRecord(transfer2.identity, activeMismatchConfig, transfer2.configHistory);
      const mismatchCheck = validateDepartmentTransferHistory(activeMismatchAgent);
      expect(mismatchCheck.valid).toBe(false);
      expect(mismatchCheck.errors.some((e) => e.includes('Active configuration version mismatch'))).toBe(true);

      // 4. Configuration history ordering violation: configHistory entries reordered (non-increasing versions)
      const reorderedConfigHistory = [
        transfer2.configHistory[1]!, // 1.1.0 before 1.0.0
        transfer2.configHistory[0]!, // 1.0.0 after 1.1.0
      ];
      const reorderedAgent = createAgentRecord(transfer2.identity, transfer2.currentConfig, reorderedConfigHistory);
      const reorderedCheck = validateDepartmentTransferHistory(reorderedAgent);
      expect(reorderedCheck.valid).toBe(false);
      expect(reorderedCheck.errors.some((e) => e.includes('Configuration history ordering violation'))).toBe(true);

      // 5. Active configuration version does not strictly advance from latest configHistory
      const nonAdvancingAgent = createAgentRecord(
        transfer2.identity,
        {
          ...transfer2.currentConfig,
          configVersion: transfer2.configHistory[transfer2.configHistory.length - 1]!.configVersion,
        },
        transfer2.configHistory
      );
      const nonAdvancingCheck = validateDepartmentTransferHistory(nonAdvancingAgent);
      expect(nonAdvancingCheck.valid).toBe(false);
      expect(
        nonAdvancingCheck.errors.some(
          (e) => e.includes('Configuration history ordering violation') && e.includes('active config version')
        )
      ).toBe(true);
    });

    // 5. Transfer Continuity and Frozen Records
    it('14.5 Enforces department existence, chain continuity, and non-retrospective modification of frozen transfer records', () => {
      const engineer = findAgentByCode('TECH-FSE')!;

      // Destination department existence check: invalid department must throw
      expect(() =>
        transferAgentDepartment(engineer, {
          toDepartmentId: 'non_existent_dept' as any,
          reason: 'Invalid department transfer',
          authorizedBy: 'EXEC-CEO',
        })
      ).toThrow("Unknown destination department 'non_existent_dept'");

      // Multi-step valid transfer continuity
      const transfer1 = transferAgentDepartment(engineer, {
        toDepartmentId: 'opportunity_acquisition',
        reason: 'Rotate to opportunity scouting',
        authorizedBy: 'EXEC-CEO',
        newVersion: '1.1.0',
        effectiveDate: '2026-02-01T00:00:00.000Z',
      });

      const transfer2 = transferAgentDepartment(transfer1, {
        toDepartmentId: 'research_intelligence',
        reason: 'Rotate to technology research',
        authorizedBy: OWNER_PRINCIPAL_ID,
        newVersion: '1.2.0',
        effectiveDate: '2026-03-01T00:00:00.000Z',
      });

      expect(transfer2.departmentId).toBe('research_intelligence');
      expect(transfer2.originDepartmentId).toBe('technology_engineering');
      expect(transfer2.departmentTransferHistory).toHaveLength(2);

      // Discontinuity between step 1 and step 2
      const brokenConfig = {
        ...transfer2.currentConfig,
        departmentTransferHistory: [
          transfer2.departmentTransferHistory[0]!,
          {
            ...transfer2.departmentTransferHistory[1]!,
            fromDepartmentId: 'business_development' as const, // Expected 'opportunity_acquisition'
          },
        ],
      };
      const brokenChainAgent = createAgentRecord(transfer2.identity, brokenConfig, transfer2.configHistory);
      const brokenCheck = validateDepartmentTransferHistory(brokenChainAgent);
      expect(brokenCheck.valid).toBe(false);
      expect(brokenCheck.errors.some((e) => e.includes('Transfer history discontinuity'))).toBe(true);

      // Retrospective modification prevention: transfer records are frozen
      expect(Object.isFrozen(transfer2.departmentTransferHistory[0])).toBe(true);
    });

    // 6. Workforce Roster Size and Department Counts Explicit Enforcement
    it('14.6 Enforces exact 30-agent workforce roster size and 9 canonical corporate departments in registry validation', () => {
      const fullRoster = cloneFoundingRoster();
      expect(validateOrganizationalRegistry(fullRoster).valid).toBe(true);

      // 1. Roster with 29 agents (one missing) must fail
      const understaffedRoster = fullRoster.slice(0, 29);
      const understaffedCheck = validateOrganizationalRegistry(understaffedRoster);
      expect(understaffedCheck.valid).toBe(false);
      expect(understaffedCheck.errors.some((e) => e.includes('Workforce roster size mismatch: expected exactly 30'))).toBe(true);

      // 2. Roster with 31 agents (one duplicate clone added) must fail
      const extraId = randomUUID();
      const extraAgent = createAgentRecord(
        {
          id: extraId,
          agentCode: 'TECH-EXTRA',
          departmentId: 'technology_engineering',
          createdAt: new Date().toISOString(),
        },
        {
          ...fullRoster[0]!.currentConfig,
          configurationId: randomUUID(),
          agentId: extraId,
          assignedDepartmentId: 'technology_engineering',
        }
      );
      const overstaffedRoster = [...fullRoster, extraAgent];
      const overstaffedCheck = validateOrganizationalRegistry(overstaffedRoster);
      expect(overstaffedCheck.valid).toBe(false);
      expect(overstaffedCheck.errors.some((e) => e.includes('Workforce roster size mismatch: expected exactly 30'))).toBe(true);

      // 3. Department count mismatch (e.g. only 8 departments supplied) must fail
      const incompleteDepts = CANONICAL_DEPARTMENTS.slice(0, 8);
      const incompleteDeptCheck = validateOrganizationalRegistry(fullRoster, incompleteDepts);
      expect(incompleteDeptCheck.valid).toBe(false);
      expect(incompleteDeptCheck.errors.some((e) => e.includes('Department count mismatch: expected exactly 9'))).toBe(true);
    });

    // 7. Owner Reporting Consistency & Restriction to EXEC-CEO
    it('14.7 Enforces strict Owner reporting consistency and restricts direct Owner reporting exclusively to EXEC-CEO', () => {
      const roster = cloneFoundingRoster();

      // 1. Non-CEO Executive (e.g. Chief Operating Officer) attempting to report to Owner is rejected
      const coo = roster.find((a) => a.agentCode === 'EXEC-COO')!;
      coo.currentConfig.supervisor.reportsToOwner = true;
      coo.currentConfig.supervisor.supervisorType = 'OWNER_PRINCIPAL';
      coo.currentConfig.supervisor.ownerPrincipalId = OWNER_PRINCIPAL_ID;
      coo.currentConfig.supervisor.supervisorAgentId = null;

      const cooCheck = validateOrganizationalRegistry(roster);
      expect(cooCheck.valid).toBe(false);
      expect(cooCheck.errors.some((e) => e.includes('Unauthorized Owner reporting: Only the canonical Executive CEO'))).toBe(true);

      // Reset COO
      coo.currentConfig.supervisor.reportsToOwner = false;
      coo.currentConfig.supervisor.supervisorType = 'AGENT';
      coo.currentConfig.supervisor.ownerPrincipalId = undefined;
      coo.currentConfig.supervisor.supervisorAgentId = roster.find((a) => a.agentCode === 'EXEC-CEO')!.id;

      // 2. Inconsistent CEO supervisor configuration: reportsToOwner=true but supervisorType='AGENT'
      const ceo = roster.find((a) => a.agentCode === 'EXEC-CEO')!;
      ceo.currentConfig.supervisor.supervisorType = 'AGENT';
      const supervisorTypeMismatch = validateOrganizationalRegistry(roster);
      expect(supervisorTypeMismatch.valid).toBe(false);
      expect(supervisorTypeMismatch.errors.some((e) => e.includes("supervisorType is not 'OWNER_PRINCIPAL'"))).toBe(true);

      // 3. Inconsistent CEO supervisor configuration: reportsToOwner=true but supervisorAgentId is not null
      ceo.currentConfig.supervisor.supervisorType = 'OWNER_PRINCIPAL';
      ceo.currentConfig.supervisor.supervisorAgentId = randomUUID();
      const ceoNonEmptySupervisor = validateOrganizationalRegistry(roster);
      expect(ceoNonEmptySupervisor.valid).toBe(false);
      expect(ceoNonEmptySupervisor.errors.some((e) => e.includes('supervisorAgentId must be null'))).toBe(true);

      // 4. Inconsistent non-owner agent specifying ownerPrincipalId
      const engineer = roster.find((a) => a.agentCode === 'TECH-FSE')!;
      ceo.currentConfig.supervisor.supervisorAgentId = null;
      engineer.currentConfig.supervisor.ownerPrincipalId = OWNER_PRINCIPAL_ID;
      const illegalOwnerPrincipalRef = validateOrganizationalRegistry(roster);
      expect(illegalOwnerPrincipalRef.valid).toBe(false);
      expect(illegalOwnerPrincipalRef.errors.some((e) => e.includes('non-Owner reporting agent cannot specify ownerPrincipalId'))).toBe(true);
    });

    // 8. Credential Security & Strict Schemas
    it('14.8 Enforces expanded credential property detection, schema strictness, cycle-safety, and resolution boundary', () => {
      // 1. Expanded sensitive property detection (secret, clientSecret, token, refreshToken, authorization, auth, etc.)
      const sensitiveKeys = [
        'secret',
        'token',
        'clientSecret',
        'client_secret',
        'refreshToken',
        'refresh_token',
        'authorization',
        'auth',
        'passphrase',
        'privateKey',
        'password',
      ];

      for (const key of sensitiveKeys) {
        const testObj = { [key]: 'any_dummy_credential_value' };
        const check = assertNoRawCredentials(testObj, 'test');
        expect(check.valid, `Expected property '${key}' to be flagged as disallowed credential`).toBe(false);
        expect(check.errors.some((e) => e.includes(`Disallowed credential property '${key}'`))).toBe(true);
      }

      // 2. Strict schema rejection of unexpected properties (.strict())
      const baseModelConfig = {
        modelProvider: 'mock' as const,
        modelId: 'mock-llm-v1',
        temperature: 0.3,
        systemPrompt: 'System prompt',
        allowedTools: [],
        toolConfigs: [],
        maxParallelTasks: 3,
        timeoutMs: 60000,
      };

      const poisonedModelConfig = {
        ...baseModelConfig,
        injectedMaliciousField: 'unexpected_value',
      };
      expect(AgentModelConfigSchema.safeParse(poisonedModelConfig).success).toBe(false);

      const baseToolConfig = {
        toolName: 'web_search',
        enabled: true,
      };
      const poisonedToolConfig = {
        ...baseToolConfig,
        apiKey: 'sk-12345678901234567890',
      };
      expect(ToolConfigReferenceSchema.safeParse(poisonedToolConfig).success).toBe(false);

      // 3. Cycle-safety in recursive credential inspection
      const cyclicObject: any = {
        name: 'SafeConfig',
        nested: {},
      };
      cyclicObject.nested.parent = cyclicObject; // Circular link
      cyclicObject.self = cyclicObject; // Self reference

      // Must complete safely without recursion overflow or hanging
      const cycleCheck = assertNoRawCredentials(cyclicObject);
      expect(cycleCheck.valid).toBe(true);

      // 4. Credential resolution context boundary contract
      const resolverRequest = {
        requesterAgentId: '00000000-0000-0000-0000-000000000007',
        requesterLevel: 'DIRECTOR' as const,
        credentialReference: 'OPENAI_PRODUCTION_KEY_REF',
        purpose: 'Executing autonomous financial market analysis',
        environment: 'PRODUCTION' as const,
        authorizedAt: new Date().toISOString(),
      };
      expect(CredentialResolverContextSchema.safeParse(resolverRequest).success).toBe(true);
    });

    // 9. Agent Record Consistency
    it('14.9 Enforces agent record internal consistency and specialist-supervisor department alignment', () => {
      const roster = cloneFoundingRoster();

      // 1. Identity ID mismatch in createAgentRecord
      const identity = { ...roster[0]!.identity };
      const configWithMismatchedAgentId = {
        ...roster[0]!.currentConfig,
        agentId: randomUUID(), // Mismatch
      };
      expect(() => createAgentRecord(identity, configWithMismatchedAgentId)).toThrow(
        'Configuration agentId mismatch'
      );

      // 2. Department-supervisor mismatch: Specialist in Technology assigned supervisor in Financial Intelligence
      const corruptedRoster = cloneFoundingRoster();
      const techSpecialist = corruptedRoster.find((a) => a.agentCode === 'TECH-FSE')!;
      const finDirector = corruptedRoster.find((a) => a.agentCode === 'FIN-CFO')!;
      techSpecialist.currentConfig.supervisor.supervisorAgentId = finDirector.id;
      techSpecialist.currentConfig.supervisor.supervisorAgentCode = finDirector.agentCode;

      const mismatchCheck = validateOrganizationalRegistry(corruptedRoster);
      expect(mismatchCheck.valid).toBe(false);
      expect(
        mismatchCheck.errors.some((e) =>
          e.includes("Department supervisor mismatch: Specialist TECH-FSE in department 'technology_engineering' reports to supervisor FIN-CFO in different department 'financial_intelligence'")
        )
      ).toBe(true);
    });
  });
});
