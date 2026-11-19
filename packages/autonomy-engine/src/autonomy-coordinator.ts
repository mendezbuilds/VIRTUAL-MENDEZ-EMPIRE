import { randomUUID } from 'node:crypto';
import type {
  OrchestratedTask,
  StrategicObjective,
  AgentSpec,
  AgentRecord,
} from '@vme/shared-types';
import type { DepartmentRegistry } from '@vme/department-hierarchy';
import type { AgentRegistry } from '@vme/orchestrator';
import type { EpisodicMemory, WorkingMemory } from '@vme/agent-memory';
import type { DelegationManager, ConsequentialActionType } from '@vme/agent-communication';
import type { EmergencySupervisor } from '@vme/security-governance';
import { ObjectiveDecomposer, type RawObjectiveDirective } from './objective-decomposer.js';
import type { ToolExecutionRuntime } from './tool-runtime.js';

export interface ExecutionResult {
  objective: StrategicObjective;
  completedTasks: OrchestratedTask[];
  quarantinedForOwner: OrchestratedTask[];
}

export interface AutonomyCoordinatorOptions {
  workingMemory?: WorkingMemory;
  toolRuntime?: ToolExecutionRuntime;
  emergencySupervisor?: EmergencySupervisor;
}

export class AutonomyCoordinator {
  private decomposer = new ObjectiveDecomposer();
  private activeObjectives: StrategicObjective[] = [];
  private taskStore = new Map<string, OrchestratedTask>();
  private completedTasksList: OrchestratedTask[] = [];

  private readonly workingMemory?: WorkingMemory;
  private readonly toolRuntime?: ToolExecutionRuntime;
  private readonly emergencySupervisor?: EmergencySupervisor;

  constructor(
    private readonly hierarchy: DepartmentRegistry,
    private readonly orchestratorRegistry: AgentRegistry,
    private readonly episodicMemory: EpisodicMemory,
    private readonly delegationManager: DelegationManager,
    optionsOrSupervisor?: EmergencySupervisor | AutonomyCoordinatorOptions
  ) {
    if (optionsOrSupervisor && 'assertOperational' in optionsOrSupervisor) {
      this.emergencySupervisor = optionsOrSupervisor;
    } else if (optionsOrSupervisor) {
      const opts = optionsOrSupervisor as AutonomyCoordinatorOptions;
      this.workingMemory = opts.workingMemory;
      this.toolRuntime = opts.toolRuntime;
      this.emergencySupervisor = opts.emergencySupervisor;
    }
  }

  async executeDirective(
    directive: RawObjectiveDirective,
    tenantId: string
  ): Promise<ExecutionResult> {
    // 1. Assert operational state (Tier 1 & Tier 3 circuit breaker)
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

      // Centralized Policy-Based Consequential Action Classification
      const consequentialClassification = this.classifyConsequentialAction(task);

      if (consequentialClassification) {
        const specialist = this.findAgentForTask(task);
        if (specialist) {
          if (!task.inputData.tool || !task.inputData.operation || !task.inputData.parameters) {
            task.inputData = {
              tool: 'dispatch_outreach_dossier',
              operation: 'dispatch_outreach_dossier',
              parameters: task.inputData,
            };
          }
          this.delegationManager.interceptConsequentialAction(
            specialist.id,
            task.id,
            consequentialClassification,
            task.inputData
          );
        }

        task.status = 'WAITING_FEEDBACK';
        task.outputResult = {
          quarantined: true,
          actionType: consequentialClassification,
          reason: 'Awaiting Owner explicit authorization before execution',
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

      // Initialize working memory scratchpad for task
      if (this.workingMemory) {
        this.workingMemory.set(task.id, 'taskTitle', task.title);
        this.workingMemory.set(task.id, 'status', 'IN_PROGRESS');
      }

      // Execute task through AI Orchestration model gateway
      const executed = await this.orchestratorRegistry.executeTask(targetAgent.id, task);
      this.taskStore.set(executed.id, executed);
      completedTasks.push(executed);
      this.completedTasksList.push(executed);

      if (this.workingMemory) {
        this.workingMemory.set(task.id, 'status', 'COMPLETED');
        this.workingMemory.set(task.id, 'output', executed.outputResult);
      }

      // Store in Episodic institutional memory with full schema adherence
      const agentRec = this.hierarchy.getAgentRecord(targetAgent.id);
      await this.episodicMemory.recordExecution({
        id: randomUUID(),
        agentId: targetAgent.id,
        agentCode: agentRec?.agentCode,
        departmentId: targetAgent.departmentId,
        taskId: executed.id,
        actionType: 'AUTONOMOUS_TASK_EXECUTION',
        inputSummary: `${executed.title}: ${executed.description}`,
        decisionRationale: `Executed autonomously per strategic objective ${objective.title}`,
        outcome: (executed.outputResult?.['summary'] as string) ?? 'Execution successful',
        status: 'SUCCESS',
        scope: 'DEPARTMENT_SCOPED',
        importanceScore: 7,
        metadata: {
          initiativeTitle: objective.title,
        },
        recordedAt: new Date().toISOString(),
      });
    }

    return {
      objective,
      completedTasks,
      quarantinedForOwner,
    };
  }

  private classifyConsequentialAction(task: OrchestratedTask): ConsequentialActionType | null {
    if (task.inputData['consequentialActionType']) {
      return task.inputData['consequentialActionType'] as ConsequentialActionType;
    }
    if (task.inputData['actionType'] === 'LIVE_TRADING' || task.inputData['actionType'] === 'EXTERNAL_OUTREACH') {
      return task.inputData['actionType'] as ConsequentialActionType;
    }
    // Strategic classification based on corporate department mandate
    if (
      task.departmentId === 'opportunity_acquisition' &&
      (task.title.toLowerCase().includes('outreach') || Boolean(task.inputData['requiresApproval']))
    ) {
      return 'EXTERNAL_OUTREACH';
    }
    if (
      task.departmentId === 'financial_intelligence' &&
      (task.title.toLowerCase().includes('trade') || task.title.toLowerCase().includes('transfer'))
    ) {
      return 'LIVE_TRADING';
    }
    return null;
  }

  private findAgentForTask(task: { departmentId: any }): AgentSpec | null {
    const agents = this.hierarchy.listAgentsByDepartment(task.departmentId);
    if (agents.length === 0) return null;

    // Prefer specialists over directors for operational execution
    const specialist = agents.find((a) => a.tier === 'specialist' || a.tier === 'operator');
    return specialist ?? agents[0] ?? null;
  }

  getActiveObjectives(): StrategicObjective[] {
    return this.activeObjectives;
  }

  getCompletedTasks(): OrchestratedTask[] {
    return [...this.completedTasksList];
  }

  getTask(taskId: string): OrchestratedTask | undefined {
    return this.taskStore.get(taskId);
  }
}
