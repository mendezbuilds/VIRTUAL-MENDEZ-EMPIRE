import {
  type StrategicObjective,
  type OrchestratedTask,
  type DepartmentId,
  type AgentRecord,
  OWNER_PRINCIPAL_ID,
} from '@vme/shared-types';
import type { DepartmentRegistry } from '@vme/department-hierarchy';
import type { DelegationManager } from '@vme/agent-communication';
import type { EmergencySupervisor } from '@vme/security-governance';
import type { AutonomyCoordinator, ExecutionResult } from './autonomy-coordinator.js';
import type { ExecutiveReporter, ExecutiveReport } from './executive-reporter.js';
import type { RawObjectiveDirective } from './objective-decomposer.js';

export interface CEODirectiveSubmission {
  directive: RawObjectiveDirective;
  tenantId: string;
  submittedBy: string; // Must be Owner
}

export class CEOOrchestrator {
  private ceoAgent: AgentRecord;

  constructor(
    private readonly hierarchy: DepartmentRegistry,
    private readonly coordinator: AutonomyCoordinator,
    private readonly delegationManager: DelegationManager,
    private readonly reporter: ExecutiveReporter,
    private readonly emergencySupervisor?: EmergencySupervisor
  ) {
    const ceo = this.hierarchy.getAgentRecord('EXEC-CEO');
    if (!ceo) {
      throw new Error('EXEC-CEO agent not found in hierarchy registry.');
    }
    this.ceoAgent = ceo;
  }

  /**
   * Ingests a top-level Strategic Directive directly from the Owner (Stephen Mendez).
   * Validates Owner identity, triggers decomposition, orchestrates departmental directors,
   * and oversees end-to-end autonomous execution.
   */
  async ingestOwnerDirective(submission: CEODirectiveSubmission): Promise<ExecutionResult> {
    // 1. Assert operational state (Tier 1 & 3 emergency circuit breaker)
    if (this.emergencySupervisor) {
      this.emergencySupervisor.assertOperational();
    }

    // 2. Validate Owner authority
    if (submission.submittedBy !== OWNER_PRINCIPAL_ID) {
      throw new Error(
        `UNAUTHORIZED STRATEGIC DIRECTIVE: Directives can only be issued by the Owner (Stephen Mendez). Principal '${submission.submittedBy}' is not authorized.`
      );
    }

    // 3. Delegate to AutonomyCoordinator for execution
    const executionResult = await this.coordinator.executeDirective(
      submission.directive,
      submission.tenantId
    );

    return executionResult;
  }

  /**
   * Compiles an executive status report for the Owner board presentation.
   */
  generateBoardReport(): ExecutiveReport {
    const activeObjectives = this.coordinator.getActiveObjectives();
    const completedTasks = this.coordinator.getCompletedTasks();
    return this.reporter.generateReport(activeObjectives, completedTasks);
  }

  getCEOAgent(): AgentRecord {
    return this.ceoAgent;
  }
}
