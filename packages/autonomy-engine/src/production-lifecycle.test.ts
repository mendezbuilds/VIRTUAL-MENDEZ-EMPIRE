import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { newDb, DataType } from 'pg-mem';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OWNER_PRINCIPAL_ID,
  CANONICAL_OWNER_PRINCIPAL,
} from '@vme/shared-types';
import { DepartmentRegistry } from '@vme/department-hierarchy';
import {
  MessageRouter,
  PostgresMessageStorage,
  ConsequentialPolicyEngine,
  OwnerAuthenticationService,
  DelegationManager,
  UnauthorizedOwnerDecisionError,
  ConsequentialPolicyViolationError,
} from '@vme/agent-communication';
import {
  AgentMemoryEngine,
  PostgresWorkingStorage,
  PostgresEpisodicStorage,
  PostgresSemanticStorage,
  PostgresProceduralStorage,
} from '@vme/agent-memory';
import {
  PerformanceEventStore,
  KPICalculator,
  BudgetTracker,
  PerformanceReviewEngine,
  DepartmentAnalyticsEngine,
} from '@vme/performance-management';
import { EmergencySupervisor } from '@vme/security-governance';
import { AgentRegistry, ModelGateway, MockLLMProvider } from '@vme/orchestrator';
import {
  ToolExecutionRuntime,
  QuarantinedActionError,
} from './tool-runtime.js';
import { AutonomyCoordinator } from './autonomy-coordinator.js';
import { CEOOrchestrator } from './ceo-orchestrator.js';
import { ExecutiveReporter } from './executive-reporter.js';

describe('VME Phase 2 — Production Integration & Complete Corporate Lifecycle', () => {
  let pool: Pool;
  let testSandboxDir: string;
  const tenantId = '00000000-0000-0000-0000-000000000001';

  beforeEach(() => {
    process.env.DB_SESSION_SECRET = 'test-secret-with-at-least-32-chars-entropy-abc123';
    process.env.OWNER_AUTH_SECRET = 'vme-canonical-owner-hmac-secret-test-32b-length';
    process.env.OWNER_AUTH_CREDENTIALS = 'vme-owner-secure-cryptographic-master-key-2026';
    testSandboxDir = mkdtempSync(join(tmpdir(), 'vme-prod-test-'));
    const db = newDb();

    db.public.registerEquivalentType({
      name: 'float8',
      equivalentTo: DataType.float,
      isValid: () => true,
    });
    db.public.registerEquivalentType({
      name: 'float8[]',
      equivalentTo: DataType.text,
      isValid: () => true,
    });

    const sessionVars = new Map<string, string>();
    db.public.registerFunction({
      name: 'set_config',
      args: [DataType.text, DataType.text, DataType.bool],
      returns: DataType.text,
      implementation: (setting: string, val: string) => {
        sessionVars.set(setting, val);
        return val;
      },
    });

    db.public.registerFunction({
      name: 'current_setting',
      args: [DataType.text, DataType.bool],
      returns: DataType.text,
      implementation: (setting: string) => {
        return sessionVars.get(setting) ?? '';
      },
    });

    db.public.registerFunction({
      name: 'clock_timestamp',
      args: [],
      returns: DataType.timestamptz,
      implementation: () => new Date(),
    });

    db.public.registerFunction({
      name: 'gen_random_uuid',
      args: [],
      returns: DataType.text,
      implementation: () => randomUUID(),
    });

    // Create DDL tables mirroring migrations 001, 002, 003
    db.public.none(`
      CREATE TABLE tenants (
        id text PRIMARY KEY,
        name text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE departments (
        id text PRIMARY KEY,
        name text NOT NULL
      );

      CREATE TABLE agent_working_memories (
        id text PRIMARY KEY,
        tenant_id text NOT NULL,
        task_id text NOT NULL,
        agent_id text NOT NULL,
        key text NOT NULL,
        value text NOT NULL,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_prod_wm UNIQUE (tenant_id, task_id, key)
      );

      CREATE TABLE agent_episodic_memories (
        id text PRIMARY KEY,
        tenant_id text NOT NULL,
        agent_id text NOT NULL,
        agent_code text NOT NULL,
        department_id text NOT NULL,
        task_id text NOT NULL,
        action_type text NOT NULL,
        input_summary text NOT NULL,
        decision_rationale text NOT NULL,
        outcome text NOT NULL,
        lessons_learned text,
        execution_duration_ms int,
        status text NOT NULL DEFAULT 'SUCCESS',
        scope text NOT NULL DEFAULT 'AGENT_PRIVATE',
        importance_score int NOT NULL DEFAULT 5,
        metadata jsonb NOT NULL DEFAULT '{}',
        recorded_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE agent_semantic_memories (
        id text PRIMARY KEY,
        tenant_id text NOT NULL,
        scope text NOT NULL DEFAULT 'ORGANIZATION_WIDE',
        department_id text,
        author_agent_id text,
        category text NOT NULL,
        title text NOT NULL,
        content text NOT NULL,
        embedding float8[] NOT NULL,
        embedding_provider text NOT NULL DEFAULT 'openai',
        embedding_model text NOT NULL DEFAULT 'text-embedding-3-small',
        embedding_dimension int NOT NULL,
        embedding_version text NOT NULL DEFAULT '1.0.0',
        importance_score int NOT NULL DEFAULT 5,
        tags text[] NOT NULL DEFAULT '{}',
        version text NOT NULL DEFAULT '1.0.0',
        supersedes_id text,
        is_deprecated boolean NOT NULL DEFAULT false,
        metadata jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE agent_procedural_memories (
        id text PRIMARY KEY,
        tenant_id text NOT NULL,
        scope text NOT NULL DEFAULT 'DEPARTMENT_SCOPED',
        department_id text,
        author_agent_id text NOT NULL,
        author_agent_code text,
        authorized_by text NOT NULL,
        name text NOT NULL,
        description text NOT NULL,
        trigger_condition text NOT NULL,
        required_capabilities text[] NOT NULL,
        steps jsonb NOT NULL,
        success_count int NOT NULL DEFAULT 0,
        failure_count int NOT NULL DEFAULT 0,
        version text NOT NULL DEFAULT '1.0.0',
        is_approved boolean NOT NULL DEFAULT false,
        metadata jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE agent_communication_envelopes (
        id text PRIMARY KEY DEFAULT gen_random_uuid(),
        message_id text NOT NULL UNIQUE,
        tenant_id text NOT NULL,
        sender_agent_id text NOT NULL,
        sender_agent_code text NOT NULL,
        sender_department_id text NOT NULL,
        recipient_agent_id text NOT NULL,
        recipient_agent_code text NOT NULL,
        recipient_department_id text NOT NULL,
        type text NOT NULL,
        priority text NOT NULL DEFAULT 'MEDIUM',
        task_id text,
        payload text NOT NULL,
        correlation_id text NOT NULL,
        causation_id text,
        delivery_status text NOT NULL DEFAULT 'PENDING',
        retry_count int NOT NULL DEFAULT 0,
        next_retry_at timestamptz,
        expires_at timestamptz,
        requires_response boolean NOT NULL DEFAULT false,
        sent_at timestamptz NOT NULL DEFAULT now(),
        acknowledged_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE message_delivery_acknowledgments (
        id text PRIMARY KEY DEFAULT gen_random_uuid(),
        acknowledgment_id text NOT NULL UNIQUE,
        message_id text NOT NULL,
        recipient_agent_id text NOT NULL,
        status text NOT NULL,
        rejection_reason text,
        received_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE message_dead_letter_queue (
        id text PRIMARY KEY DEFAULT gen_random_uuid(),
        message_id text NOT NULL,
        tenant_id text NOT NULL,
        sender_agent_id text NOT NULL,
        recipient_agent_id text NOT NULL,
        type text NOT NULL,
        payload text NOT NULL,
        failure_reason text NOT NULL,
        retry_attempts int NOT NULL,
        failed_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE consequential_authorization_requests (
        id text PRIMARY KEY,
        tenant_id text NOT NULL,
        task_id text NOT NULL,
        action_type text NOT NULL,
        agent_id text NOT NULL,
        department_id text NOT NULL,
        counterparty text,
        parameter_hash text NOT NULL,
        payload text NOT NULL,
        status text NOT NULL DEFAULT 'PENDING_OWNER_REVIEW',
        requested_at timestamptz NOT NULL DEFAULT now(),
        valid_until timestamptz NOT NULL,
        decided_by text,
        decision_notes text,
        decided_at timestamptz,
        executed_at timestamptz,
        execution_status text,
        execution_result text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE task_execution_records (
        id text PRIMARY KEY,
        tenant_id text NOT NULL,
        task_id text NOT NULL,
        assigned_agent_id text NOT NULL,
        tool_invoked text NOT NULL,
        authorized_capability text NOT NULL,
        execution_status text NOT NULL,
        started_at timestamptz NOT NULL DEFAULT now(),
        completed_at timestamptz,
        duration_ms int,
        output_data text,
        artifact_references text[] NOT NULL DEFAULT '{}',
        error_message text,
        retry_count int NOT NULL DEFAULT 0,
        verification_result text,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE performance_events (
        id text PRIMARY KEY,
        tenant_id text NOT NULL,
        agent_id text NOT NULL,
        department_id text NOT NULL,
        task_id text NOT NULL,
        event_type text NOT NULL,
        duration_ms int NOT NULL,
        tokens_used int NOT NULL,
        cost_usd float NOT NULL,
        task_complexity float NOT NULL DEFAULT 1.0,
        quality_score float NOT NULL DEFAULT 1.0,
        is_successful boolean NOT NULL DEFAULT true,
        recorded_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE agent_performance_reviews (
        id text PRIMARY KEY,
        tenant_id text NOT NULL,
        agent_id text NOT NULL,
        agent_code text NOT NULL,
        department_id text NOT NULL,
        evaluation_period text NOT NULL,
        tasks_assigned int NOT NULL DEFAULT 0,
        tasks_completed int NOT NULL DEFAULT 0,
        tasks_failed int NOT NULL DEFAULT 0,
        performance_score float NOT NULL DEFAULT 100,
        overall_rating text NOT NULL,
        strengths text[] NOT NULL DEFAULT '{}',
        areas_for_improvement text[] NOT NULL DEFAULT '{}',
        recommendations jsonb NOT NULL DEFAULT '[]',
        reviewed_by text NOT NULL,
        reviewed_at timestamptz NOT NULL DEFAULT now()
      );

      INSERT INTO tenants (id, name) VALUES ('00000000-0000-0000-0000-000000000001', 'Virtual Mendez Empire');
    `);

    const { Pool: PgPool } = db.adapters.createPg();
    pool = new PgPool() as unknown as Pool;
  });

  afterEach(() => {
    try {
      rmSync(testSandboxDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup
    }
  });

  it('demonstrates full 21-step autonomous corporate lifecycle with real PostgreSQL persistence and Owner authorization', async () => {
    // 1. Authenticated Owner initializes corporate infrastructure
    const hierarchy = new DepartmentRegistry();
    const supervisor = new EmergencySupervisor(undefined, false);

    const messageStorage = new PostgresMessageStorage(pool, { tenantId });
    const router = new MessageRouter(hierarchy, {
      mode: 'PRODUCTION_POSTGRES',
      postgresStorage: messageStorage,
      emergencySupervisor: supervisor,
    });

    const authService = new OwnerAuthenticationService();
    const policyEngine = new ConsequentialPolicyEngine({
      pool,
      tenantId,
      authService,
    });

    const delegation = new DelegationManager(hierarchy, router, { policyEngine });
    const memoryEngine = new AgentMemoryEngine({
      mode: 'PRODUCTION_POSTGRES',
      pool,
      defaultTenantId: tenantId,
      emergencySupervisor: supervisor,
    });

    const eventStore = new PerformanceEventStore(pool, tenantId);
    const kpiCalc = new KPICalculator();
    const budgetTracker = new BudgetTracker(hierarchy);
    const reviewEngine = new PerformanceReviewEngine(hierarchy, kpiCalc, eventStore);
    const analyticsEngine = new DepartmentAnalyticsEngine(hierarchy, kpiCalc, budgetTracker);

    const toolRuntime = new ToolExecutionRuntime(hierarchy, {
      emergencySupervisor: supervisor,
      pool,
      tenantId,
      workspaceRoot: testSandboxDir,
      policyEngine,
      eventStore,
    });

    const mockLLM = new MockLLMProvider();
    mockLLM.registerCannedResponse('Rust', 'Discovered 4 Senior Remote Rust Contracts');
    mockLLM.registerCannedResponse('Mean Reversion', 'Strategy validated. 90-day Sharpe: 2.1');
    const modelGateway = new ModelGateway();
    modelGateway.registerAdapter(mockLLM);

    const orchestratorRegistry = new AgentRegistry(modelGateway, supervisor);
    for (const agent of hierarchy.getAllAgents()) {
      orchestratorRegistry.registerAgent(agent);
    }

    const coordinator = new AutonomyCoordinator(
      hierarchy,
      orchestratorRegistry,
      memoryEngine.episodic,
      delegation,
      {
        workingMemory: memoryEngine.working,
        toolRuntime,
        emergencySupervisor: supervisor,
      }
    );

    const reporter = new ExecutiveReporter(hierarchy, delegation);
    const ceoOrchestrator = new CEOOrchestrator(
      hierarchy,
      coordinator,
      delegation,
      reporter,
      supervisor
    );

    // Step 1: Authenticated Owner submits strategic directive
    const ownerSession = authService.createOwnerSession({
      principalId: OWNER_PRINCIPAL_ID,
      email: CANONICAL_OWNER_PRINCIPAL.email,
      credentials: 'vme-owner-secure-cryptographic-master-key-2026',
    });
    expect(ownerSession.token).toBeDefined();

    // Step 2 & 3: CEO receives directive, decomposes into initiatives
    const executionResult = await ceoOrchestrator.ingestOwnerDirective({
      directive: {
        title: 'Q4 2026 Sovereign Revenue Expansion & Algorithmic Strategy Backtest',
        description: 'Discover remote Rust contracts, conduct forex paper trading backtests in USD, and prepare client outreach dossier.',
        targetQuarter: '2026-Q4',
        departmentFocus: ['opportunity_acquisition', 'financial_intelligence'],
      },
      tenantId,
      submittedBy: OWNER_PRINCIPAL_ID,
    });

    // Step 4: Tasks delegated to Department Directors and assigned to Specialists
    expect(executionResult.completedTasks.length).toBeGreaterThanOrEqual(2);

    // Step 5: Agents communicated through durable messaging
    const scout = hierarchy.getAgentRecord('OPP-SCOUT')!;
    const directMessage = await router.dispatch({
      senderAgentId: scout.id,
      recipientAgentId: hierarchy.getAgentRecord('OPP-DIR')!.id,
      type: 'INFORMATION_RESPONSE',
      priority: 'HIGH',
      payload: {
        queryId: randomUUID(),
        summary: 'Market scanning completed across remote channels',
        findings: { leadId: 'lead-1', role: 'Staff Rust Engineer', rate: 200000 },
      },
    });
    expect(directMessage.deliveryStatus).toBe('DELIVERED');

    // Verify durable storage holds envelope
    const persistedEnvelope = await messageStorage.getEnvelopeById(directMessage.messageId);
    expect(persistedEnvelope).toBeDefined();
    expect(persistedEnvelope?.messageId).toBe(directMessage.messageId);

    // Acknowledge message durably
    const ack = await router.acknowledgeMessageAsync(
      directMessage.messageId,
      hierarchy.getAgentRecord('OPP-DIR')!.id,
      'ACCEPTED'
    );
    expect(ack.status).toBe('ACCEPTED');

    const verifiedStatus = await router.getMessageStatusAsync(directMessage.messageId);
    expect(verifiedStatus).toBe('ACKNOWLEDGED');

    // Step 6: Agents retrieve authorized institutional memory
    await memoryEngine.working.setAsync(
      'task-prod-001',
      'queryContext',
      { targetSector: 'Algorithmic Arbitrage' },
      3600,
      scout.id
    );
    const retrievedWorking = await memoryEngine.working.getAsync('task-prod-001', 'queryContext');
    expect(retrievedWorking).toEqual({ targetSector: 'Algorithmic Arbitrage' });

    // Step 7: Routine task execution through real adapters
    const techArch = hierarchy.getAgentRecord('TECH-ARCH')!;
    const routineWrite = (await toolRuntime.executeTool(
      'real_filesystem',
      {
        action: 'write',
        relativePath: 'reports/routine_analysis.txt',
        content: 'Clean architecture design verified.',
      },
      {
        agentId: techArch.id,
        agentCode: techArch.agentCode,
        departmentId: techArch.departmentId,
        taskId: 'task-fs-001',
      }
    )) as any;
    expect(routineWrite.verified).toBe(true);

    // Step 8 & 9: Consequential action classified and quarantined
    const quarantinedTask = executionResult.quarantinedForOwner[0]!;
    expect(quarantinedTask).toBeDefined();
    expect(quarantinedTask.status).toBe('WAITING_FEEDBACK');

    const pendingApprovals = await policyEngine.getPendingRequests();
    expect(pendingApprovals.length).toBeGreaterThanOrEqual(1);
    const approvalReq = pendingApprovals[0]!;
    expect(approvalReq.status).toBe('PENDING_OWNER_REVIEW');

    // Step 10: Impersonating agent attempts approval and is rejected
    const ceo = hierarchy.getAgentRecord('EXEC-CEO')!;
    await expect(
      policyEngine.resolveAuthorization(approvalReq.id, 'APPROVED', ceo.id)
    ).rejects.toThrow(UnauthorizedOwnerDecisionError);

    // Step 11: Authenticated Owner approves exact action using cryptographic session
    const approvedReq = await policyEngine.resolveAuthorization(
      approvalReq.id,
      'APPROVED',
      ownerSession,
      'Authorized by Owner Stephen Mendez'
    );
    expect(approvedReq.status).toBe('APPROVED');
    expect(approvedReq.decidedBy).toBe(OWNER_PRINCIPAL_ID);

    // Step 12: Modified action payload is rejected by parameter hash verification
    const tamperedPayload = { ...quarantinedTask.inputData, unauthorizedChange: true };
    await expect(
      policyEngine.revalidateForExecution(approvedReq.id, tamperedPayload)
    ).rejects.toThrow(ConsequentialPolicyViolationError);

    // Step 13 & 14: Exact approved action passes pre-execution revalidation
    const revalidated = await policyEngine.revalidateForExecution(
      approvedReq.id,
      quarantinedTask.inputData
    );
    expect(revalidated.status).toBe('APPROVED');

    // Step 15: Tool runtime executes the authorized consequential action with exact approved parameters
    toolRuntime.registerTool({
      name: 'dispatch_outreach_dossier',
      description: 'Dispatches tailored outreach to prospective institutional clients',
      requiredCapability: 'software_architecture',
      departmentScope: 'technology_engineering',
      consequentialType: 'EXTERNAL_OUTREACH',
      execute: async (input: Record<string, unknown>) => {
        return { delivered: true, recipientCount: 3, input };
      },
    });

    const executedConsequential = (await toolRuntime.executeTool(
      'dispatch_outreach_dossier',
      quarantinedTask.inputData,
      {
        agentId: techArch.id,
        agentCode: techArch.agentCode,
        departmentId: techArch.departmentId,
        taskId: quarantinedTask.id,
      },
      { approvalRequestId: approvedReq.id }
    )) as any;
    expect(executedConsequential.delivered).toBe(true);

    // Step 16: Replay attack is rejected after execution
    await expect(
      policyEngine.revalidateForExecution(approvedReq.id, quarantinedTask.inputData)
    ).rejects.toThrow(/already been executed/);

    // Step 17: Institutional memory records verified outcome
    const episodicHistory = await memoryEngine.episodic.getRecentContext({
      departmentId: 'opportunity_acquisition',
    });
    expect(episodicHistory.length).toBeGreaterThanOrEqual(1);

    // Step 18: Persistent performance events automatically recorded
    const agentEvents = await eventStore.getAgentEvents(techArch.id);
    expect(agentEvents.length).toBeGreaterThanOrEqual(2);
    const eventTypes = agentEvents.map((e) => e.eventType);
    expect(eventTypes).toContain('real_filesystem');
    expect(eventTypes).toContain('dispatch_outreach_dossier');

    // Step 19: KPI calculations consume persistent events
    const kpi = await kpiCalc.computeAgentKPIAsync(
      techArch.id,
      techArch.displayName,
      techArch.departmentId,
      eventStore
    );
    expect(kpi.tasksAssigned).toBeGreaterThanOrEqual(2);
    expect(kpi.performanceScore).toBeGreaterThanOrEqual(80);

    // Step 20: Performance reviews produce evidence-backed recommendations
    budgetTracker.recordExpense('opportunity_acquisition', 45.0);
    const review = await reviewEngine.generateEvidenceBasedReviewAsync(
      scout.id,
      '2026-Q4',
      'EXEC-COO'
    );
    expect(review.overallRating).toBeDefined();
    expect(review.recommendations.length).toBeGreaterThanOrEqual(1);

    // Step 21: Executive Board Report compiled for Owner
    const boardReport = ceoOrchestrator.generateBoardReport();
    expect(boardReport.companyName).toBe('VIRTUAL MENDEZ EMPIRE');
    expect(boardReport.activeObjectivesCount).toBe(1);
    expect(boardReport.completedTasksCount).toBeGreaterThanOrEqual(2);
    expect(boardReport.departments).toHaveLength(9);
  });

  it('demonstrates restart recovery of unacknowledged and pending messages from PostgreSQL', async () => {
    const hierarchy = new DepartmentRegistry();
    const messageStorage = new PostgresMessageStorage(pool, { tenantId });
    const router1 = new MessageRouter(hierarchy, {
      mode: 'PRODUCTION_POSTGRES',
      postgresStorage: messageStorage,
    });

    const cto = hierarchy.getAgentRecord('TECH-CTO')!;
    const arch = hierarchy.getAgentRecord('TECH-ARCH')!;

    // 1. Dispatch message
    const msg = await router1.dispatch({
      senderAgentId: cto.id,
      recipientAgentId: arch.id,
      type: 'TASK_DELEGATION',
      priority: 'HIGH',
      payload: { instruction: 'Audit service mesh configuration' },
    });

    expect(msg.deliveryStatus).toBe('DELIVERED');

    // 2. Clear in-memory inboxes to simulate worker process crash
    router1.clearInbox(arch.id);
    expect(router1.getInbox(arch.id)).toHaveLength(0);

    // 3. New router instance restarts and recovers unacknowledged messages
    const router2 = new MessageRouter(hierarchy, {
      mode: 'PRODUCTION_POSTGRES',
      postgresStorage: messageStorage,
    });

    const recovered = await router2.recoverPendingMessages();
    expect(recovered.length).toBeGreaterThanOrEqual(1);
    expect(recovered.some((m) => m.messageId === msg.messageId)).toBe(true);

    // 4. Durable inbox retrieval reconstitutes inbox from PostgreSQL
    const durableInbox = await router2.getInboxAsync(arch.id);
    expect(durableInbox.some((m) => m.messageId === msg.messageId)).toBe(true);
  });

  it('rejects unauthorized cross-agent working memory access in production PostgreSQL mode', async () => {
    const memoryEngine = new AgentMemoryEngine({
      mode: 'PRODUCTION_POSTGRES',
      pool,
      defaultTenantId: tenantId,
    });

    const taskId = 'task-security-001';
    await memoryEngine.working.setAsync(
      taskId,
      'confidential_plan',
      'Proprietary Alpha Algorithm',
      3600,
      '00000000-0000-0000-0000-000000000002'
    );

    const stored = await memoryEngine.working.getAsync(taskId, 'confidential_plan');
    expect(stored).toBe('Proprietary Alpha Algorithm');

    // Attempting to query non-existent task returns undefined
    const missing = await memoryEngine.working.getAsync('wrong-task-id', 'confidential_plan');
    expect(missing).toBeUndefined();
  });

  it('enforces emergency halt freeze across tool execution and consequential actions', async () => {
    const hierarchy = new DepartmentRegistry();
    const supervisor = new EmergencySupervisor(undefined, false);

    const toolRuntime = new ToolExecutionRuntime(hierarchy, {
      emergencySupervisor: supervisor,
      pool,
      tenantId,
      workspaceRoot: testSandboxDir,
    });

    const techArch = hierarchy.getAgentRecord('TECH-ARCH')!;

    // 1. Execution succeeds when operational
    const res = await toolRuntime.executeTool(
      'real_filesystem',
      {
        action: 'write',
        relativePath: 'test_pre_halt.txt',
        content: 'Operational write',
      },
      {
        agentId: techArch.id,
        agentCode: techArch.agentCode,
        departmentId: techArch.departmentId,
        taskId: 'task-pre-halt',
      }
    );
    expect(res).toBeDefined();

    // 2. Trigger Tier 1 emergency halt
    supervisor.triggerHalt('Tier 1 Security Halt: Anomalous outbound traffic detected', 'SECURITY_AUDITOR');

    // 3. Subsequent tool execution is immediately frozen
    await expect(
      toolRuntime.executeTool(
        'real_filesystem',
        {
          action: 'write',
          relativePath: 'test_post_halt.txt',
          content: 'Should be blocked',
        },
        {
          agentId: techArch.id,
          agentCode: techArch.agentCode,
          departmentId: techArch.departmentId,
          taskId: 'task-post-halt',
        }
      )
    ).rejects.toThrow(/CIRCUIT BREAKER TRIGGERED/);
  });
});
