import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DepartmentRegistry } from '@vme/department-hierarchy';
import { MessageRouter, DelegationManager } from '@vme/agent-communication';
import { EpisodicMemory, InMemoryEpisodicStorage } from '@vme/agent-memory';
import { AgentRegistry, ModelGateway, MockLLMProvider } from '@vme/orchestrator';
import { EmergencySupervisor } from '@vme/security-governance';
import { KPICalculator, BudgetTracker } from '@vme/performance-management';
import {
  AutonomyCoordinator,
  ExecutiveReporter,
} from './index.js';

describe('VIRTUAL MENDEZ EMPIRE — End-to-End Corporate Lifecycle (Phase 2)', () => {
  it('executes full autonomous corporate workflow: strategy -> delegation -> execution -> memory -> KPIs -> executive reporting', async () => {
    const tenantId = randomUUID();

    // 1. Initialize complete corporate infrastructure
    const hierarchy = new DepartmentRegistry();
    const router = new MessageRouter(hierarchy);
    const delegation = new DelegationManager(hierarchy, router);
    const episodicStorage = new InMemoryEpisodicStorage();
    const episodic = new EpisodicMemory(episodicStorage);

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

    const coordinator = new AutonomyCoordinator(
      hierarchy,
      orchestratorRegistry,
      episodic,
      delegation,
      supervisor
    );

    const kpiCalc = new KPICalculator();
    const budgetTracker = new BudgetTracker(hierarchy);
    const reporter = new ExecutiveReporter(hierarchy, delegation);

    // 2. Owner submits comprehensive Strategic Directive
    const ownerDirective = {
      title: 'Q4 Growth: Expand Remote Software Contracts and Backtest FX Strategy',
      description: 'Discover remote Rust and AI contracts, prepare outreach drafts, and conduct forex paper trading backtests in USD and NGN.',
      targetQuarter: 'Q4-2026',
    };

    // 3. Autonomy engine processes directive
    const executionResult = await coordinator.executeDirective(ownerDirective, tenantId);

    // Verify decomposition
    expect(executionResult.objective.status).toBe('ACTIVE');
    expect(executionResult.completedTasks.length).toBeGreaterThanOrEqual(2);
    expect(executionResult.quarantinedForOwner.length).toBe(1);

    // Verify routine tasks ran autonomously
    const completedTitles = executionResult.completedTasks.map((t) => t.title);
    expect(completedTitles).toContain('Scan Remote Market Channels');
    expect(completedTitles).toContain('Backtest Mean Reversion Strategy');

    // Verify consequential outreach task was quarantined
    const quarantined = executionResult.quarantinedForOwner[0]!;
    expect(quarantined.title).toBe('Prepare Tailored Outreach Dossier');
    expect(quarantined.status).toBe('WAITING_FEEDBACK');

    // Verify Owner authorization queue
    const pendingApprovals = delegation.getPendingOwnerApprovals();
    expect(pendingApprovals).toHaveLength(1);
    expect(pendingApprovals[0]?.actionType).toBe('EXTERNAL_OUTREACH');

    // 4. Record execution KPIs and budget tracking
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

    // 5. Verify institutional memory was populated
    const oppHistory = await episodic.getRecentContext({
      departmentId: 'opportunity_acquisition',
    });
    const finHistory = await episodic.getRecentContext({
      departmentId: 'financial_intelligence',
    });
    expect(oppHistory.length).toBeGreaterThanOrEqual(1);
    expect(finHistory.length).toBeGreaterThanOrEqual(1);

    // 6. Generate final Executive Board Report for the Owner
    const boardReport = reporter.generateReport(
      [executionResult.objective],
      executionResult.completedTasks
    );

    expect(boardReport.companyName).toBe('VIRTUAL MENDEZ EMPIRE');
    expect(boardReport.activeObjectivesCount).toBe(1);
    expect(boardReport.completedTasksCount).toBeGreaterThanOrEqual(2);
    expect(boardReport.pendingOwnerApprovalsCount).toBe(1);
    expect(boardReport.pendingOwnerApprovals[0]?.actionType).toBe('EXTERNAL_OUTREACH');

    // Verify department budget health
    const oppBudget = budgetTracker.getDepartmentBudgetReport('opportunity_acquisition');
    expect(oppBudget.actualSpentUsd).toBe(25.0);
    expect(oppBudget.remainingBudgetUsd).toBe(9975.0);
    expect(oppBudget.burnRatePercentage).toBe(0.25);
  });
});
