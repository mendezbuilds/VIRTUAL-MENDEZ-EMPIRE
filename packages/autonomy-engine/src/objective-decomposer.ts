import { randomUUID } from 'node:crypto';
import type {
  StrategicObjective,
  StrategicInitiative,
  OrchestratedTask,
  DepartmentId,
  TaskPriority,
} from '@vme/shared-types';

export interface RawObjectiveDirective {
  title: string;
  description: string;
  targetQuarter?: string;
  departmentFocus?: DepartmentId[];
}

export class ObjectiveDecomposer {
  /**
   * Decomposes an Owner strategic directive into structured initiatives and tasks.
   */
  decompose(directive: RawObjectiveDirective, tenantId: string): {
    objective: StrategicObjective;
    executableTasks: OrchestratedTask[];
  } {
    const objectiveId = randomUUID();
    const initiatives: StrategicInitiative[] = [];
    const executableTasks: OrchestratedTask[] = [];

    // Derive department focus based on keywords in title & description
    const text = `${directive.title} ${directive.description}`.toLowerCase();

    // 1. Opportunity Acquisition track
    if (text.includes('job') || text.includes('contract') || text.includes('opportunity') || text.includes('lead')) {
      const initId = randomUUID();
      const task1Id = randomUUID();
      const task2Id = randomUUID();

      initiatives.push({
        id: initId,
        departmentId: 'opportunity_acquisition',
        title: 'Lead & Opportunity Harvesting',
        description: 'Automated identification of high-value opportunities matching criteria',
        tasks: [
          {
            id: task1Id,
            title: 'Scan Remote Market Channels',
            description: 'Scrape and filter Web3, Rust, AI and tech engineering opportunities',
            priority: 'HIGH',
            requiresOwnerApproval: false,
            inputData: { targetTech: ['Rust', 'Python', 'AI', 'FullStack'] },
          },
          {
            id: task2Id,
            title: 'Prepare Tailored Outreach Dossier',
            description: 'Draft outreach messages and cover letters. Quarantined for Owner review.',
            priority: 'HIGH',
            requiresOwnerApproval: true,
            inputData: {},
          },
        ],
      });

      executableTasks.push(
        {
          id: task1Id,
          tenantId,
          title: 'Scan Remote Market Channels',
          description: 'Scrape and filter Web3, Rust, AI and tech engineering opportunities',
          departmentId: 'opportunity_acquisition',
          priority: 'HIGH',
          status: 'PENDING',
          inputData: { targetTech: ['Rust', 'Python', 'AI', 'FullStack'] },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          id: task2Id,
          tenantId,
          title: 'Prepare Tailored Outreach Dossier',
          description: 'Draft outreach messages and cover letters. Quarantined for Owner review.',
          departmentId: 'opportunity_acquisition',
          priority: 'HIGH',
          status: 'PENDING',
          inputData: { requiresApproval: true },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
      );
    }

    // 2. Financial Intelligence track
    if (text.includes('trading') || text.includes('finance') || text.includes('forex') || text.includes('crypto')) {
      const initId = randomUUID();
      const task1Id = randomUUID();

      initiatives.push({
        id: initId,
        departmentId: 'financial_intelligence',
        title: 'Algorithmic Market Intelligence',
        description: 'Strategy backtesting and paper trading execution',
        tasks: [
          {
            id: task1Id,
            title: 'Backtest Mean Reversion Strategy',
            description: 'Evaluate 90-day currency volatility. Live execution prohibited.',
            priority: 'MEDIUM',
            requiresOwnerApproval: false,
            inputData: { asset: 'EUR/USD' },
          },
        ],
      });

      executableTasks.push({
        id: task1Id,
        tenantId,
        title: 'Backtest Mean Reversion Strategy',
        description: 'Evaluate 90-day currency volatility. Live execution prohibited.',
        departmentId: 'financial_intelligence',
        priority: 'MEDIUM',
        status: 'PENDING',
        inputData: { asset: 'EUR/USD' },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    // Default general initiative if no specific keyword matched
    if (initiatives.length === 0) {
      const initId = randomUUID();
      const task1Id = randomUUID();
      initiatives.push({
        id: initId,
        departmentId: 'operations_administration',
        title: 'Operational Feasibility Assessment',
        description: 'Analyze operational requirements for directive',
        tasks: [
          {
            id: task1Id,
            title: 'Compile Feasibility Analysis',
            description: directive.description,
            priority: 'MEDIUM',
            requiresOwnerApproval: false,
            inputData: {},
          },
        ],
      });

      executableTasks.push({
        id: task1Id,
        tenantId,
        title: 'Compile Feasibility Analysis',
        description: directive.description,
        departmentId: 'operations_administration',
        priority: 'MEDIUM',
        status: 'PENDING',
        inputData: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    const objective: StrategicObjective = {
      id: objectiveId,
      title: directive.title,
      description: directive.description,
      status: 'ACTIVE',
      initiatives,
      targetQuarter: directive.targetQuarter ?? 'Q4-2026',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    return { objective, executableTasks };
  }
}

