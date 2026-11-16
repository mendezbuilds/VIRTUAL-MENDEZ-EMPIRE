import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DepartmentRegistry } from '@vme/department-hierarchy';
import { MessageRouter, DelegationManager } from '@vme/agent-communication';
import { EpisodicMemory, InMemoryEpisodicStorage, WorkingMemory } from '@vme/agent-memory';
import { AgentRegistry, ModelGateway, MockLLMProvider } from '@vme/orchestrator';
import { EmergencySupervisor, EmergencyHaltError } from '@vme/security-governance';
import { OWNER_PRINCIPAL_ID } from '@vme/shared-types';
import {
  AutonomyCoordinator,
  ExecutiveReporter,
  ToolExecutionRuntime,
  ToolExecutionError,
  CEOOrchestrator,
} from './index.js';

describe('@vme/autonomy-engine Empire Autonomy Engine', () => {
  const tenantId = randomUUID();
  let hierarchy: DepartmentRegistry;
  let router: MessageRouter;
  let delegation: DelegationManager;
  let episodic: EpisodicMemory;
  let workingMemory: WorkingMemory;
  let orchestratorRegistry: AgentRegistry;
  let supervisor: EmergencySupervisor;
  let toolRuntime: ToolExecutionRuntime;
  let coordinator: AutonomyCoordinator;
  let reporter: ExecutiveReporter;
  let ceoOrchestrator: CEOOrchestrator;

  beforeEach(() => {
    hierarchy = new DepartmentRegistry();
    router = new MessageRouter(hierarchy);
    delegation = new DelegationManager(hierarchy, router);
    episodic = new EpisodicMemory(new InMemoryEpisodicStorage());
    workingMemory = new WorkingMemory();

    const mockLLM = new MockLLMProvider();
    const gateway = new ModelGateway();
    gateway.registerAdapter(mockLLM);

    supervisor = new EmergencySupervisor(undefined, false);
    orchestratorRegistry = new AgentRegistry(gateway, supervisor);

    for (const agent of hierarchy.getAllAgents()) {
      orchestratorRegistry.registerAgent(agent);
    }

    toolRuntime = new ToolExecutionRuntime(hierarchy, supervisor);

    coordinator = new AutonomyCoordinator(
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

    reporter = new ExecutiveReporter(hierarchy, delegation);

    ceoOrchestrator = new CEOOrchestrator(
      hierarchy,
      coordinator,
      delegation,
      reporter,
      supervisor
    );
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

    // 6. Working memory recorded intermediate states
    const workingStatus = workingMemory.get(result.completedTasks[0]!.id, 'status');
    expect(workingStatus).toBe('COMPLETED');
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

  it('CEOOrchestrator ingests directives from Owner, rejects unauthorized callers, and compiles board report', async () => {
    const directive = {
      title: 'Global Tech Sourcing Q4',
      description: 'Scrape Web3 and AI job boards for new contract opportunities',
    };

    // Unauthorized submission fails
    await expect(
      ceoOrchestrator.ingestOwnerDirective({
        directive,
        tenantId,
        submittedBy: 'IMPOSTER_AGENT_007',
      })
    ).rejects.toThrow(/UNAUTHORIZED STRATEGIC DIRECTIVE/);

    // Authorized Owner submission succeeds
    const execResult = await ceoOrchestrator.ingestOwnerDirective({
      directive,
      tenantId,
      submittedBy: OWNER_PRINCIPAL_ID,
    });

    expect(execResult.objective.status).toBe('ACTIVE');

    // Generate board report
    const boardReport = ceoOrchestrator.generateBoardReport();
    expect(boardReport.companyName).toBe('VIRTUAL MENDEZ EMPIRE');
    expect(boardReport.activeObjectivesCount).toBeGreaterThanOrEqual(1);
  });

  it('ToolExecutionRuntime enforces capability gating, credential defense, and emergency halt', async () => {
    const scout = hierarchy.getAgentRecord('OPP-SCOUT')!; // opportunity_acquisition
    const quant = hierarchy.getAgentRecord('FIN-FXA')!; // financial_intelligence

    // 1. Authorized agent runs scraper tool successfully
    const scrapeResult = (await toolRuntime.executeTool(
      'market_scraper',
      { keywords: ['Rust', 'Systems'] },
      {
        agentId: scout.id,
        agentCode: scout.agentCode,
        departmentId: scout.departmentId,
        taskId: randomUUID(),
      }
    )) as { leadsFound: number };

    expect(scrapeResult.leadsFound).toBe(3);
    expect(toolRuntime.getExecutionLogs()).toHaveLength(1);
    expect(toolRuntime.getExecutionLogs()[0]?.isSuccessful).toBe(true);

    // 2. Unauthorized agent (quant running scraper) is blocked by capability check
    await expect(
      toolRuntime.executeTool(
        'market_scraper',
        { keywords: ['Rust'] },
        {
          agentId: quant.id,
          agentCode: quant.agentCode,
          departmentId: quant.departmentId,
          taskId: randomUUID(),
        }
      )
    ).rejects.toThrow(ToolExecutionError);

    // 3. Tool call containing raw secrets is rejected by credential defense
    await expect(
      toolRuntime.executeTool(
        'market_scraper',
        {
          keywords: ['Rust'],
          apiKey: 'sk-ant-api03-abcdef12345678901234567890abcdef',
        },
        {
          agentId: scout.id,
          agentCode: scout.agentCode,
          departmentId: scout.departmentId,
          taskId: randomUUID(),
        }
      )
    ).rejects.toThrow(/Credential defense violation/);

    // 4. Emergency halt freezes tool execution
    supervisor.triggerHalt('Security containment', 'EXEC-CISO');

    await expect(
      toolRuntime.executeTool(
        'market_scraper',
        { keywords: ['Rust'] },
        {
          agentId: scout.id,
          agentCode: scout.agentCode,
          departmentId: scout.departmentId,
          taskId: randomUUID(),
        }
      )
    ).rejects.toThrow(EmergencyHaltError);
  });
});
