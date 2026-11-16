import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DepartmentRegistry } from '@vme/department-hierarchy';
import { MessageRouter, DelegationManager, UnauthorizedOwnerDecisionError } from '@vme/agent-communication';
import {
  EpisodicMemory,
  InMemoryEpisodicStorage,
  WorkingMemory,
  SemanticMemory,
  InMemorySemanticStorage,
  ProceduralMemory,
  InMemoryProceduralStorage,
  AgentMemoryEngine,
} from '@vme/agent-memory';
import { AgentRegistry, ModelGateway, MockLLMProvider } from '@vme/orchestrator';
import { EmergencySupervisor } from '@vme/security-governance';
import {
  KPICalculator,
  BudgetTracker,
  PerformanceReviewEngine,
  DepartmentAnalyticsEngine,
} from '@vme/performance-management';
import { OWNER_PRINCIPAL_ID } from '@vme/shared-types';
import {
  AutonomyCoordinator,
  ExecutiveReporter,
  CEOOrchestrator,
  ToolExecutionRuntime,
} from './index.js';

describe('VIRTUAL MENDEZ EMPIRE — End-to-End Corporate Lifecycle (Phase 2)', () => {
  it('executes full autonomous corporate workflow: strategy -> delegation -> execution -> memory -> KPIs -> executive reporting', async () => {
    const tenantId = randomUUID();

    // 1. Initialize complete corporate infrastructure
    const hierarchy = new DepartmentRegistry();
    const router = new MessageRouter(hierarchy);
    const delegation = new DelegationManager(hierarchy, router);
    const memoryEngine = new AgentMemoryEngine();
    const workingMemory = memoryEngine.working;
    const episodic = memoryEngine.episodic;

    const mockLLM = new MockLLMProvider();
    mockLLM.registerCannedResponse('Rust', 'Found 3 Senior Remote Rust Roles ($180k-$220k)');
    mockLLM.registerCannedResponse('Mean Reversion', 'EUR/USD Strategy backtest completed. 90-day Sharpe: 1.95');

    const modelGateway = new ModelGateway();
    modelGateway.registerAdapter(mockLLM);

    const supervisor = new EmergencySupervisor(undefined, false);
    const orchestratorRegistry = new AgentRegistry(modelGateway, supervisor);
    for (const agent of hierarchy.getAllAgents()) {
      orchestratorRegistry.registerAgent(agent);
    }

    const toolRuntime = new ToolExecutionRuntime(hierarchy, supervisor);

    const coordinator = new AutonomyCoordinator(
      hierarchy,
      orchestratorRegistry,
      episodic,
      delegation,
      {
        workingMemory,
        toolRuntime,
        emergencySupervisor: supervisor,
      }
    );

    const kpiCalc = new KPICalculator();
    const budgetTracker = new BudgetTracker(hierarchy);
    const reporter = new ExecutiveReporter(hierarchy, delegation);
    const ceoOrchestrator = new CEOOrchestrator(
      hierarchy,
      coordinator,
      delegation,
      reporter,
      supervisor
    );
    const reviewEngine = new PerformanceReviewEngine(hierarchy, kpiCalc);
    const analyticsEngine = new DepartmentAnalyticsEngine(hierarchy, kpiCalc, budgetTracker);

    // 2. Owner submits comprehensive Strategic Directive to CEO
    const ownerDirective = {
      title: 'Q4 Growth: Expand Remote Software Contracts and Backtest FX Strategy',
      description: 'Discover remote Rust and AI contracts, prepare outreach drafts, and conduct forex paper trading backtests in USD and NGN.',
      targetQuarter: 'Q4-2026',
    };

    // Verify imposter submission is barred
    await expect(
      ceoOrchestrator.ingestOwnerDirective({
        directive: ownerDirective,
        tenantId,
        submittedBy: 'AGENT_IMPOSTER',
      })
    ).rejects.toThrow(/UNAUTHORIZED STRATEGIC DIRECTIVE/);

    // Owner issues directive
    const executionResult = await ceoOrchestrator.ingestOwnerDirective({
      directive: ownerDirective,
      tenantId,
      submittedBy: OWNER_PRINCIPAL_ID,
    });

    // 3. Verify decomposition and autonomous execution
    expect(executionResult.objective.status).toBe('ACTIVE');
    expect(executionResult.completedTasks.length).toBeGreaterThanOrEqual(2);
    expect(executionResult.quarantinedForOwner.length).toBe(1);

    const completedTitles = executionResult.completedTasks.map((t) => t.title);
    expect(completedTitles).toContain('Scan Remote Market Channels');
    expect(completedTitles).toContain('Backtest Mean Reversion Strategy');

    // 4. Verify consequential outreach task was quarantined for Owner review
    const quarantined = executionResult.quarantinedForOwner[0]!;
    expect(quarantined.title).toBe('Prepare Tailored Outreach Dossier');
    expect(quarantined.status).toBe('WAITING_FEEDBACK');

    const pendingApprovals = delegation.getPendingOwnerApprovals();
    expect(pendingApprovals).toHaveLength(1);
    expect(pendingApprovals[0]?.actionType).toBe('EXTERNAL_OUTREACH');

    // AI agent cannot self-authorize consequential action
    const ceo = hierarchy.getAgentRecord('EXEC-CEO')!;
    expect(() => {
      delegation.authorizeAction(pendingApprovals[0]!.id, 'APPROVED', ceo.id);
    }).toThrow(UnauthorizedOwnerDecisionError);

    // Authentic Owner authorizes the action
    const approvedRequest = delegation.authorizeAction(
      pendingApprovals[0]!.id,
      'APPROVED',
      OWNER_PRINCIPAL_ID,
      'Approved after reviewing dossier preview'
    );
    expect(approvedRequest.status).toBe('APPROVED');
    expect(approvedRequest.decidedBy).toBe(OWNER_PRINCIPAL_ID);

    // 5. Record execution KPIs and budget tracking
    for (const task of executionResult.completedTasks) {
      kpiCalc.recordMetric({
        agentId: task.assignedAgentId!,
        agentName: hierarchy.getAgent(task.assignedAgentId!)!.name,
        departmentId: task.departmentId,
        durationMs: 450,
        tokensUsed: 220,
        costUsd: 0.003,
        isSuccessful: true,
      });

      budgetTracker.recordExpense(task.departmentId, 25.0);
    }

    // 6. Verify institutional episodic memory
    const oppHistory = await episodic.getRecentContext({
      departmentId: 'opportunity_acquisition',
    });
    const finHistory = await episodic.getRecentContext({
      departmentId: 'financial_intelligence',
    });
    expect(oppHistory.length).toBeGreaterThanOrEqual(1);
    expect(finHistory.length).toBeGreaterThanOrEqual(1);

    // 7. Generate performance review and department analytics
    const scoutAgent = hierarchy.getAgentRecord('OPP-SCOUT')!;
    const performanceReview = reviewEngine.generateAgentReview(
      scoutAgent.id,
      '2026-Q4',
      'EXEC-COO'
    );
    expect(performanceReview.overallRating).toBeDefined();

    const deptHealth = analyticsEngine.generateDepartmentHealth('opportunity_acquisition');
    expect(deptHealth.departmentId).toBe('opportunity_acquisition');
    expect(deptHealth.activeAgents).toBe(4);
    expect(deptHealth.budgetReport.actualSpentUsd).toBe(25.0);

    // 8. Generate final Executive Board Report for the Owner
    const boardReport = ceoOrchestrator.generateBoardReport();

    expect(boardReport.companyName).toBe('VIRTUAL MENDEZ EMPIRE');
    expect(boardReport.activeObjectivesCount).toBe(1);
    expect(boardReport.completedTasksCount).toBeGreaterThanOrEqual(2);
    expect(boardReport.departments).toHaveLength(9);
  });
});
