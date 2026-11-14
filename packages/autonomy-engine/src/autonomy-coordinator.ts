import type {
  OrchestratedTask,
  StrategicObjective,
  AgentSpec,
} from '@vme/shared-types';
import type { DepartmentRegistry } from '@vme/department-hierarchy';
import type { AgentRegistry } from '@vme/orchestrator';
import type { EpisodicMemory } from '@vme/agent-memory';
import type { DelegationManager } from '@vme/agent-communication';
import type { EmergencySupervisor } from '@vme/security-governance';
import { ObjectiveDecomposer, type RawObjectiveDirective } from './objective-decomposer.js';

export interface ExecutionResult {
  objective: StrategicObjective;
  completedTasks: OrchestratedTask[];
  quarantinedForOwner: OrchestratedTask[];
}

export class AutonomyCoordinator {
  private decomposer = new ObjectiveDecomposer();
  private activeObjectives: StrategicObjective[] = [];
  private taskStore = new Map<string, OrchestratedTask>();

  constructor(
    private readonly hierarchy: DepartmentRegistry,
    private readonly orchestratorRegistry: AgentRegistry,
    private readonly episodicMemory: EpisodicMemory,
    private readonly delegationManager: DelegationManager,
    private readonly emergencySupervisor?: EmergencySupervisor
  ) {}

  async executeDirective(
    directive: RawObjectiveDirective,
    tenantId: string
  ): Promise<ExecutionResult> {
    // 1. Assert operational state (Tier 1 & Tier 3 kill switch barrier)
    if (this.emergencySupervisor) {
      this.emergencySupervisor.assertOperational();
    }

    // 2. Decompose directive into initiatives and tasks
    const { objective, executableTasks } = this.decomposer.decompose(directive, tenantId);
    this.activeObjectives.push(objective);

    const completedTasks: OrchestratedTask[] = [];
    const quarantinedForOwner: OrchestratedTask[] = [];

    // 3. Coordinate departmental execution
    for (const task of executableTasks) {
      this.taskStore.set(task.id, task);

      // Check Owner Authorization Boundary
      const isConsequential =
        task.title.toLowerCase().includes('outreach') ||
        task.title.toLowerCase().includes('trade') ||
        Boolean(task.inputData['requiresApproval']);

      if (isConsequential && task.title.toLowerCase().includes('outreach')) {
        // Find specialist in target department
        const specialist = this.findAgentForTask(task);
        if (specialist) {
          this.delegationManager.interceptConsequentialAction(
            specialist.id,
            task.id,
            'EXTERNAL_OUTREACH',
            task.inputData
          );
        }

        task.status = 'WAITING_FEEDBACK';
        task.outputResult = {
          quarantined: true,
          reason: 'Awaiting Owner explicit authorization before transmission',
        };
        quarantinedForOwner.push(task);
        continue;
      }

      // Execute standard autonomous task
      const targetAgent = this.findAgentForTask(task);
      if (!targetAgent) {
        task.status = 'FAILED';
        task.errorMessage = `No eligible active agent in department: ${task.departmentId}`;
        continue;
      }

      // Execute task through AI Orchestration model gateway
      const executed = await this.orchestratorRegistry.executeTask(targetAgent.id, task);
      this.taskStore.set(executed.id, executed);
      completedTasks.push(executed);

      // Store in Episodic institutional memory
      await this.episodicMemory.recordExecution({
        id: executed.id,
        agentId: targetAgent.id,
        departmentId: targetAgent.departmentId,
        taskId: executed.id,
        actionType: 'AUTONOMOUS_TASK_EXECUTION',
        inputSummary: `${executed.title}: ${executed.description}`,
        decisionRationale: `Executed autonomously per strategic objective ${objective.title}`,
        outcome: (executed.outputResult?.['summary'] as string) ?? 'Execution successful',
        recordedAt: new Date().toISOString(),
      });
    }

    return {
      objective,
      completedTasks,
      quarantinedForOwner,
    };
  }

  private findAgentForTask(task: OrchestratedTask): AgentSpec | null {
    const agents = this.hierarchy.listAgentsByDepartment(task.departmentId);
    if (agents.length === 0) return null;

    // Prefer specialists over directors for operational execution
    const specialist = agents.find((a) => a.tier === 'specialist' || a.tier === 'operator');
    return specialist ?? agents[0] ?? null;
  }

  getActiveObjectives(): StrategicObjective[] {
    return this.activeObjectives;
  }
}
