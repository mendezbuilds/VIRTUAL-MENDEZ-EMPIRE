import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DepartmentRegistry } from '@vme/department-hierarchy';
import { MessageRouter, DelegationManager } from '@vme/agent-communication';
import { EpisodicMemory, InMemoryEpisodicStorage } from '@vme/agent-memory';
import { AgentRegistry, ModelGateway, MockLLMProvider } from '@vme/orchestrator';
import { EmergencySupervisor, EmergencyHaltError } from '@vme/security-governance';
import {
  AutonomyCoordinator,
  ExecutiveReporter,
} from './index.js';

describe('@vme/autonomy-engine Empire Autonomy Engine', () => {
  const tenantId = randomUUID();
  let hierarchy: DepartmentRegistry;
  let router: MessageRouter;
  let delegation: DelegationManager;
  let episodic: EpisodicMemory;
  let orchestratorRegistry: AgentRegistry;
  let supervisor: EmergencySupervisor;
  let coordinator: AutonomyCoordinator;
  let reporter: ExecutiveReporter;

  beforeEach(() => {
    hierarchy = new DepartmentRegistry();
    router = new MessageRouter(hierarchy);
    delegation = new DelegationManager(hierarchy, router);
    episodic = new EpisodicMemory(new InMemoryEpisodicStorage());

    const mockLLM = new MockLLMProvider();
    const gateway = new ModelGateway();
    gateway.registerAdapter(mockLLM);

    supervisor = new EmergencySupervisor(undefined, false);
    orchestratorRegistry = new AgentRegistry(gateway, supervisor);

    // Register all hierarchy agents in orchestrator
    for (const agent of hierarchy.getAllAgents()) {
      orchestratorRegistry.registerAgent(agent);
    }

    coordinator = new AutonomyCoordinator(
      hierarchy,
      orchestratorRegistry,
      episodic,
      delegation,
      supervisor
    );

    reporter = new ExecutiveReporter(hierarchy, delegation);
  });

  it('decomposes directive, executes routine tasks autonomously, and quarantines consequential outreach for Owner review', async () => {
    const directive = {
      title: 'Accelerate Senior Remote Rust Opportunities',
      description: 'Discover remote Rust engineering contracts and prepare personalized cold outreach.',
      targetQuarter: 'Q4-2026',
    };

    const result = await coordinator.executeDirective(directive, tenantId);

    // 1. Strategic objective created
    expect(result.objective.title).toBe(directive.title);
    expect(result.objective.status).toBe('ACTIVE');

    // 2. Routine scan task completed autonomously
    expect(result.completedTasks).toHaveLength(1);
    expect(result.completedTasks[0]?.title).toBe('Scan Remote Market Channels');
    expect(result.completedTasks[0]?.status).toBe('COMPLETED');

    // 3. Consequential outreach task quarantined for Owner authorization
    expect(result.quarantinedForOwner).toHaveLength(1);
    expect(result.quarantinedForOwner[0]?.title).toBe('Prepare Tailored Outreach Dossier');
    expect(result.quarantinedForOwner[0]?.status).toBe('WAITING_FEEDBACK');

    // 4. Pending Owner approvals registered
    const pendingApprovals = delegation.getPendingOwnerApprovals();
    expect(pendingApprovals).toHaveLength(1);
    expect(pendingApprovals[0]?.actionType).toBe('EXTERNAL_OUTREACH');

    // 5. Institutional memory recorded for the completed task
    const recentEpisodic = await episodic.getRecentContext({
      departmentId: 'opportunity_acquisition',
    });
    expect(recentEpisodic).toHaveLength(1);
    expect(recentEpisodic[0]?.actionType).toBe('AUTONOMOUS_TASK_EXECUTION');
  });

  it('generates an executive company performance report for the Owner', async () => {
    const directive = {
      title: 'Analyze FX Currency Markets',
      description: 'Conduct backtesting on forex strategies',
    };

    const result = await coordinator.executeDirective(directive, tenantId);
    const report = reporter.generateReport([result.objective], result.completedTasks);

    expect(report.companyName).toBe('VIRTUAL MENDEZ EMPIRE');
    expect(report.activeObjectivesCount).toBe(1);
    expect(report.completedTasksCount).toBe(1);
    expect(report.departments).toHaveLength(9);
  });

  it('blocks directive execution when emergency circuit breaker is active', async () => {
    await supervisor.triggerHalt('Security perimeter alert', 'SYSTEM');

    await expect(
      coordinator.executeDirective(
        { title: 'Emergency Task', description: 'Do something' },
        tenantId
      )
    ).rejects.toThrow(EmergencyHaltError);
  });
});

