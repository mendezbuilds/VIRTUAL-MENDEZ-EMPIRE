import type { AgentSpec, DepartmentId, OrchestratedTask } from '@vme/shared-types';
import type { EmergencySupervisor } from '@vme/security-governance';
import type { ModelGateway } from './model-gateway.js';

export class AgentRegistry {
  private agents = new Map<string, AgentSpec>();

  constructor(
    private readonly modelGateway: ModelGateway,
    private readonly emergencySupervisor?: EmergencySupervisor
  ) {}

  registerAgent(agent: AgentSpec): void {
    this.agents.set(agent.id, agent);
  }

  getAgent(id: string): AgentSpec | null {
    return this.agents.get(id) ?? null;
  }

  listAgentsByDepartment(departmentId: DepartmentId): AgentSpec[] {
    return Array.from(this.agents.values()).filter(
      (a) => a.departmentId === departmentId && a.isActive
    );
  }

  /**
   * Executes an orchestrated task with an agent, enforcing circuit breaker checks.
   */
  async executeTask(agentId: string, task: OrchestratedTask): Promise<OrchestratedTask> {
    // 1. Enforce emergency halt barrier
    if (this.emergencySupervisor) {
      this.emergencySupervisor.assertOperational();
    }

    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    if (!agent.isActive) {
      throw new Error(`Agent is inactive: ${agent.name} (${agentId})`);
    }

    // 2. Dispatch to Model Gateway
    const response = await this.modelGateway.complete(agent.modelProvider, {
      messages: [
        { role: 'system', content: agent.systemPrompt },
        {
          role: 'user',
          content: `Task: ${task.title}\nDescription: ${task.description}\nData: ${JSON.stringify(task.inputData)}`,
        },
      ],
      temperature: 0.3,
    });

    return {
      ...task,
      status: 'COMPLETED',
      assignedAgentId: agent.id,
      outputResult: {
        summary: response.content,
        tokensUsed: response.usage.totalTokens,
        completedAt: new Date().toISOString(),
      },
      updatedAt: new Date().toISOString(),
    };
  }
}

