import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { assertNoRawCredentials, type DepartmentId } from '@vme/shared-types';
import type { DepartmentRegistry } from '@vme/department-hierarchy';
import type { EmergencySupervisor } from '@vme/security-governance';
import {
  ConsequentialPolicyEngine,
  type ConsequentialActionType,
  type ConsequentialAuthorizationRecord,
  computeParameterHash,
  ConsequentialPolicyViolationError,
} from '@vme/agent-communication';
import type { PerformanceEventStore } from '@vme/performance-management';
import {
  RealFileSystemAdapter,
  RealTerminalCommandAdapter,
  RealHttpNetworkAdapter,
  TaskExecutionRecorder,
  type TaskExecutionRecord,
  type FileSystemToolInput,
  type TerminalCommandInput,
  type HttpNetworkInput,
} from './real-execution-adapters.js';

export interface ToolDefinition<TInput = Record<string, unknown>, TOutput = unknown> {
  name: string;
  description: string;
  requiredCapability: string;
  departmentScope?: DepartmentId;
  consequentialType?:
    | ConsequentialActionType
    | ((input: TInput) => ConsequentialActionType | null);
  execute: (input: TInput, context: ToolExecutionContext) => Promise<TOutput>;
}

export interface ToolExecutionContext {
  agentId: string;
  agentCode: string;
  departmentId: DepartmentId;
  taskId: string;
}

export interface ToolExecutionLog {
  executionId: string;
  toolName: string;
  agentId: string;
  agentCode: string;
  departmentId: DepartmentId;
  taskId: string;
  isSuccessful: boolean;
  durationMs: number;
  errorMessage?: string;
  executedAt: string;
}

export interface ToolRuntimeOptions {
  emergencySupervisor?: EmergencySupervisor;
  pool?: Pool;
  tenantId?: string;
  workspaceRoot?: string;
  policyEngine?: ConsequentialPolicyEngine;
  eventStore?: PerformanceEventStore;
}

export class ToolExecutionError extends Error {
  constructor(message: string) {
    super(`TOOL RUNTIME ERROR: ${message}`);
    this.name = 'ToolExecutionError';
  }
}

export class QuarantinedActionError extends Error {
  constructor(
    message: string,
    public readonly approvalRequest: ConsequentialAuthorizationRecord
  ) {
    super(`CONSEQUENTIAL ACTION QUARANTINED: ${message}`);
    this.name = 'QuarantinedActionError';
  }
}

export class ToolExecutionRuntime {
  private tools = new Map<string, ToolDefinition<any, any>>();
  private executionLogs: ToolExecutionLog[] = [];
  private activeApprovalLocks = new Set<string>();

  private readonly emergencySupervisor?: EmergencySupervisor;
  public readonly policyEngine?: ConsequentialPolicyEngine;
  public readonly eventStore?: PerformanceEventStore;
  public readonly fsAdapter: RealFileSystemAdapter;
  public readonly terminalAdapter: RealTerminalCommandAdapter;
  public readonly httpAdapter: RealHttpNetworkAdapter;
  public readonly executionRecorder: TaskExecutionRecorder;

  constructor(
    private readonly hierarchy: DepartmentRegistry,
    optionsOrSupervisor?: EmergencySupervisor | ToolRuntimeOptions
  ) {
    if (optionsOrSupervisor && 'assertOperational' in optionsOrSupervisor) {
      this.emergencySupervisor = optionsOrSupervisor;
      this.policyEngine = new ConsequentialPolicyEngine();
      this.executionRecorder = new TaskExecutionRecorder();
      this.fsAdapter = new RealFileSystemAdapter();
      this.terminalAdapter = new RealTerminalCommandAdapter();
      this.httpAdapter = new RealHttpNetworkAdapter();
    } else if (optionsOrSupervisor) {
      const opts = optionsOrSupervisor as ToolRuntimeOptions;
      this.emergencySupervisor = opts.emergencySupervisor;
      this.policyEngine =
        opts.policyEngine ?? new ConsequentialPolicyEngine({ pool: opts.pool, tenantId: opts.tenantId });
      this.eventStore = opts.eventStore;
      this.executionRecorder = new TaskExecutionRecorder(opts.pool, opts.tenantId);
      this.fsAdapter = new RealFileSystemAdapter(opts.workspaceRoot);
      this.terminalAdapter = new RealTerminalCommandAdapter(opts.workspaceRoot);
      this.httpAdapter = new RealHttpNetworkAdapter();
    } else {
      this.policyEngine = new ConsequentialPolicyEngine();
      this.executionRecorder = new TaskExecutionRecorder();
      this.fsAdapter = new RealFileSystemAdapter();
      this.terminalAdapter = new RealTerminalCommandAdapter();
      this.httpAdapter = new RealHttpNetworkAdapter();
    }

    this.registerBuiltinTools();
  }

  registerTool(tool: ToolDefinition<any, any>): void {
    this.tools.set(tool.name, tool);
  }

  getTool(toolName: string): ToolDefinition<any, any> | undefined {
    return this.tools.get(toolName);
  }

  classifyAction(
    toolName: string,
    tool?: ToolDefinition<any, any>,
    args?: Record<string, unknown>
  ): ConsequentialActionType | null {
    if (tool?.consequentialType) {
      return typeof tool.consequentialType === 'function'
        ? tool.consequentialType(args ?? {})
        : tool.consequentialType;
    }

    if (toolName === 'order_execution') {
      if (args?.mode === 'LIVE' || args?.isLive === true) {
        return 'LIVE_TRADING';
      }
    }

    if (toolName === 'capital_transfer' || toolName === 'treasury_allocation') {
      return 'CAPITAL_TRANSFER';
    }

    if (toolName === 'real_http_client') {
      const method = String(args?.method ?? 'GET').toUpperCase();
      if (method !== 'GET') {
        return 'EXTERNAL_OUTREACH';
      }
    }

    if (toolName === 'real_filesystem') {
      if (args?.action === 'delete') {
        return 'IRREVERSIBLE_OPERATION';
      }
    }

    if (toolName === 'real_terminal_command') {
      const cmd = String(args?.command ?? '').toLowerCase();
      if (cmd.includes('rm') || cmd.includes('del') || cmd.includes('drop')) {
        return 'IRREVERSIBLE_OPERATION';
      }
    }

    return null;
  }

  resolveOperation(
    toolName: string,
    tool?: ToolDefinition<any, any>,
    args?: Record<string, unknown>
  ): string {
    if (args && typeof args.operation === 'string' && args.operation.trim().length > 0) {
      return args.operation.trim();
    }
    if (args && typeof args.action === 'string' && args.action.trim().length > 0) {
      return args.action.trim();
    }
    if (args && typeof args.method === 'string' && args.method.trim().length > 0) {
      return args.method.trim().toUpperCase();
    }
    if (args && typeof args.command === 'string' && args.command.trim().length > 0) {
      return args.command.trim();
    }
    return toolName;
  }

  async executeTool(
    toolName: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
    options?: { approvalRequestId?: string }
  ): Promise<unknown> {
    const startTime = Date.now();
    const executionId = randomUUID();
    const approvalRequestId = options?.approvalRequestId;

    if (approvalRequestId) {
      if (this.activeApprovalLocks.has(approvalRequestId)) {
        throw new ToolExecutionError(
          `Consequential action approval '${approvalRequestId}' is already locked for execution. Concurrent replay attempt rejected.`
        );
      }
      this.activeApprovalLocks.add(approvalRequestId);
    }

    try {
      // 1. Emergency Halt Check
      if (this.emergencySupervisor) {
        this.emergencySupervisor.assertOperational();
      }

      // 2. Secret Redaction & Credential Defense
      const credCheck = assertNoRawCredentials(args, `tool_args_${toolName}`);
      if (!credCheck.valid) {
        throw new ToolExecutionError(
          `Credential defense violation in tool '${toolName}': ${credCheck.errors.join('; ')}`
        );
      }

      // 3. Tool Lookup
      const tool = this.tools.get(toolName);
      if (!tool) {
        throw new ToolExecutionError(`Tool '${toolName}' is not registered in the runtime.`);
      }

      // 4. Consequential Action Classification & Approval Guard
      const classifiedActionType = this.classifyAction(toolName, tool, args);

      // 1. Reject approval execution if classifyAction() returns null. An approval must never authorize an unclassified tool action.
      if (approvalRequestId && !classifiedActionType) {
        throw new ToolExecutionError(
          `Approval '${approvalRequestId}' cannot be used to authorize tool '${toolName}': action is unclassified and does not require or accept consequential authorization.`
        );
      }

      // 5. Agent and Capability Verification
      const agent = this.hierarchy.getAgentRecord(context.agentId);
      if (!agent) {
        throw new ToolExecutionError(`Agent '${context.agentId}' not found in corporate hierarchy.`);
      }

      try {
        this.hierarchy.assertCapability(agent.id, tool.requiredCapability);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new ToolExecutionError(
          `Agent '${agent.agentCode}' is unauthorized to execute tool '${toolName}': ${msg}`
        );
      }

      // 6. Centralized Consequential Action Policy Enforcement Point
      if ((classifiedActionType || approvalRequestId) && this.policyEngine) {
        if (!approvalRequestId) {
          // Quarantine the action immediately and cryptographically bind tool identifier, operation, and parameters
          const operation = this.resolveOperation(toolName, tool, args);
          const quarantineRecord = await this.policyEngine.quarantineAction({
            taskId: context.taskId,
            actionType: classifiedActionType!,
            agentId: context.agentId,
            departmentId: context.departmentId,
            payload: {
              tool: toolName,
              operation,
              parameters: args,
            },
          });

          throw new QuarantinedActionError(
            `Consequential action '${classifiedActionType}' invoked via tool '${toolName}' requires authentic Owner authorization. Action has been quarantined under request ID '${quarantineRecord.id}'.`,
            quarantineRecord
          );
        }

        // Revalidate and atomically consume approval against exact parameters, tool, and operation
        const currentOperation = this.resolveOperation(toolName, tool, args);
        const record = await this.policyEngine.getRequestById(approvalRequestId);
        if (!record) {
          throw new ToolExecutionError(
            `Consequential action approval request '${approvalRequestId}' was not found.`
          );
        }

        if (record.status === 'EXECUTED') {
          throw new ToolExecutionError(
            `Replay attack prevented: Consequential action approval '${approvalRequestId}' has already been executed.`
          );
        }

        if (record.status !== 'APPROVED') {
          throw new ToolExecutionError(
            `Cannot execute consequential tool '${toolName}': approval '${approvalRequestId}' status is '${record.status}'. Authentic Owner approval is required.`
          );
        }

        if (record.validUntil && new Date(record.validUntil).getTime() < Date.now()) {
          throw new ToolExecutionError(
            `Cannot execute consequential tool '${toolName}': approval '${approvalRequestId}' has expired.`
          );
        }

        // 3. Require exact equality for action type. Missing action type must fail closed.
        if (!record.actionType || record.actionType !== classifiedActionType) {
          throw new ToolExecutionError(
            `Approval '${approvalRequestId}' action type '${record.actionType ?? 'MISSING'}' does not match required action type '${classifiedActionType}'. Action type mismatch rejected.`
          );
        }

        // 2. Require the approved record to contain a valid tool identifier, operation, and parameter object.
        // Reject missing or malformed binding fields; do not fall back to validating raw args.
        if (!record.payload || typeof record.payload !== 'object' || Array.isArray(record.payload)) {
          throw new ToolExecutionError(
            `Approval '${approvalRequestId}' has missing or malformed payload. Action rejected.`
          );
        }

        const boundTool = record.payload.tool;
        if (typeof boundTool !== 'string' || boundTool.trim().length === 0) {
          throw new ToolExecutionError(
            `Approval '${approvalRequestId}' is missing required tool binding. Malformed approval rejected.`
          );
        }

        const boundOperation = record.payload.operation;
        if (typeof boundOperation !== 'string' || boundOperation.trim().length === 0) {
          throw new ToolExecutionError(
            `Approval '${approvalRequestId}' is missing required operation binding. Malformed approval rejected.`
          );
        }

        const boundParameters = record.payload.parameters;
        if (!boundParameters || typeof boundParameters !== 'object' || Array.isArray(boundParameters)) {
          throw new ToolExecutionError(
            `Approval '${approvalRequestId}' is missing required parameters object. Malformed approval rejected.`
          );
        }

        // 3. Require exact equality for tool and operation.
        if (boundTool !== toolName) {
          throw new ToolExecutionError(
            `Approval '${approvalRequestId}' is cryptographically bound to tool '${boundTool}', but attempted execution with tool '${toolName}'. Tool substitution rejected.`
          );
        }

        if (boundOperation !== currentOperation) {
          throw new ToolExecutionError(
            `Approval '${approvalRequestId}' is cryptographically bound to operation '${boundOperation}', but attempted execution with operation '${currentOperation}'. Operation substitution rejected.`
          );
        }

        // Canonical execution parameters: extract parameters if args is wrapped, otherwise args directly
        const executionParameters =
          args && typeof args.parameters === 'object' && args.parameters !== null
            ? (args.parameters as Record<string, unknown>)
            : args;

        const payloadToRevalidate = {
          tool: toolName,
          operation: currentOperation,
          parameters: executionParameters,
        };

        // 4. Atomically claim / consume the approval before tool execution starts
        if (typeof (this.policyEngine as any).claimApprovalForExecution === 'function') {
          await (this.policyEngine as any).claimApprovalForExecution(approvalRequestId, payloadToRevalidate);
        } else {
          await this.policyEngine.revalidateForExecution(approvalRequestId, payloadToRevalidate);
          record.status = 'EXECUTED';
        }

        // Re-verify emergency halt immediately before execution
        if (this.emergencySupervisor) {
          this.emergencySupervisor.assertOperational();
        }
      }

      // 6. Start Execution Recording
      const taskRecord = await this.executionRecorder.startExecution({
        taskId: context.taskId,
        agentId: context.agentId,
        toolInvoked: toolName,
        authorizedCapability: tool.requiredCapability,
      });

      // 7. Execute Tool with Timing
      try {
        const result = await tool.execute(args, context);
        const durationMs = Date.now() - startTime;

        this.executionLogs.push({
          executionId,
          toolName,
          agentId: context.agentId,
          agentCode: context.agentCode,
          departmentId: context.departmentId,
          taskId: context.taskId,
          isSuccessful: true,
          durationMs,
          executedAt: new Date().toISOString(),
        });

        const artifacts: string[] = [];
        if (
          typeof result === 'object' &&
          result !== null &&
          'absolutePath' in result &&
          typeof (result as any).absolutePath === 'string'
        ) {
          artifacts.push((result as any).absolutePath);
        }

        await this.executionRecorder.completeExecution({
          recordId: taskRecord.id,
          status: 'COMPLETED',
          durationMs,
          outputData:
            typeof result === 'object' && result !== null
              ? (result as Record<string, unknown>)
              : { result },
          artifactReferences: artifacts,
          verificationResult: 'VERIFIED_SUCCESS',
        });

        // Mark approval execution outcome in policy engine
        if (approvalRequestId && this.policyEngine) {
          await this.policyEngine.recordExecutionOutcome(
            approvalRequestId,
            'SUCCESS',
            typeof result === 'object' && result !== null
              ? (result as Record<string, unknown>)
              : { result }
          );
        }

        // Automatically emit persistent performance event
        if (this.eventStore) {
          await this.eventStore.recordEvent({
            agentId: context.agentId,
            departmentId: context.departmentId,
            taskId: context.taskId,
            eventType: toolName,
            durationMs,
            tokensUsed: 180,
            costUsd: 0.002,
            taskComplexity: classifiedActionType ? 2.5 : 1.2,
            qualityScore: 1.0,
            isSuccessful: true,
          });
        }

        return result;
      } catch (err: unknown) {
        const durationMs = Date.now() - startTime;
        const errorMsg = err instanceof Error ? err.message : String(err);

        this.executionLogs.push({
          executionId,
          toolName,
          agentId: context.agentId,
          agentCode: context.agentCode,
          departmentId: context.departmentId,
          taskId: context.taskId,
          isSuccessful: false,
          durationMs,
          errorMessage: errorMsg,
          executedAt: new Date().toISOString(),
        });

        await this.executionRecorder.completeExecution({
          recordId: taskRecord.id,
          status: 'FAILED',
          durationMs,
          errorMessage: errorMsg,
          verificationResult: 'VERIFIED_FAILURE',
        });

        if (approvalRequestId && this.policyEngine) {
          await this.policyEngine.recordExecutionOutcome(approvalRequestId, 'FAILED', {
            error: errorMsg,
          });
        }

        if (this.eventStore) {
          await this.eventStore.recordEvent({
            agentId: context.agentId,
            departmentId: context.departmentId,
            taskId: context.taskId,
            eventType: toolName,
            durationMs,
            tokensUsed: 100,
            costUsd: 0.001,
            taskComplexity: classifiedActionType ? 2.5 : 1.2,
            qualityScore: 0.0,
            isSuccessful: false,
          });
        }

        throw new ToolExecutionError(`Tool execution failed for '${toolName}': ${errorMsg}`);
      }
    } finally {
      if (approvalRequestId) {
        this.activeApprovalLocks.delete(approvalRequestId);
      }
    }
  }

  getExecutionLogs(): ToolExecutionLog[] {
    return [...this.executionLogs];
  }

  getExecutionRecords(): TaskExecutionRecord[] {
    return this.executionRecorder.listRecords();
  }

  private registerBuiltinTools(): void {
    // Real Execution Adapters
    this.registerTool({
      name: 'real_filesystem',
      description: 'Sandboxed filesystem operations (read, write, list, stat, exists)',
      requiredCapability: 'software_architecture',
      departmentScope: 'technology_engineering',
      execute: async (input: FileSystemToolInput) => this.fsAdapter.execute(input),
    });

    this.registerTool({
      name: 'real_terminal_command',
      description: 'Sandboxed subprocess and CLI command execution with timeout control',
      requiredCapability: 'software_architecture',
      departmentScope: 'technology_engineering',
      execute: async (input: TerminalCommandInput) => this.terminalAdapter.execute(input),
    });

    this.registerTool({
      name: 'real_http_client',
      description: 'Real HTTP/HTTPS request execution for market APIs and feeds',
      requiredCapability: 'job_market_scraping',
      departmentScope: 'opportunity_acquisition',
      execute: async (input: HttpNetworkInput) => this.httpAdapter.execute(input),
    });

    // 1. Market Scraper Tool
    this.registerTool({
      name: 'market_scraper',
      description: 'Scrapes public market boards and job feeds for opportunities',
      requiredCapability: 'job_market_scraping',
      departmentScope: 'opportunity_acquisition',
      execute: async (input: { keywords?: string[]; minRate?: number }) => {
        const keywords = input.keywords ?? ['Rust', 'AI'];
        return {
          leadsFound: 3,
          results: [
            { title: 'Principal Rust Engineer', company: 'Solana Ecosystem Labs', budgetUsd: 195000 },
            { title: 'AI Systems Architect', company: 'Autonomous Protocols Inc', budgetUsd: 210000 },
          ],
          keywords,
        };
      },
    });

    // 2. Financial Backtester Tool
    this.registerTool({
      name: 'financial_backtester',
      description: 'Runs historical mean-reversion and momentum backtests',
      requiredCapability: 'fx_paper_trading',
      departmentScope: 'financial_intelligence',
      execute: async (input: { pair?: string; windowDays?: number }) => {
        return {
          pair: input.pair ?? 'EUR/USD',
          windowDays: input.windowDays ?? 90,
          sharpeRatio: 1.92,
          maxDrawdownPct: 4.8,
          recommendation: 'PROCEED_PAPER_TRADING',
        };
      },
    });

    // 3. Code Analyzer Tool
    this.registerTool({
      name: 'code_analyzer',
      description: 'Performs static analysis and architectural validation on codebase',
      requiredCapability: 'software_architecture',
      departmentScope: 'technology_engineering',
      execute: async (input: { targetDir?: string }) => {
        return {
          targetDir: input.targetDir ?? 'src',
          zeroCostViolations: 0,
          circularDeps: 0,
          testCoveragePct: 98.4,
          status: 'CLEAN',
        };
      },
    });

    // 4. Outreach Drafter Tool
    this.registerTool({
      name: 'outreach_drafter',
      description: 'Drafts candidate proposals and client communication dossiers',
      requiredCapability: 'outreach_drafting',
      departmentScope: 'opportunity_acquisition',
      execute: async (input: { leadTitle?: string; clientName?: string }) => {
        return {
          subject: `Stephen Mendez — Application: ${input.leadTitle ?? 'Senior Engineer'}`,
          bodyPreview: `Dear Hiring Team, I am submitting Stephen Mendez's credentials...`,
          status: 'DRAFT_GENERATED',
        };
      },
    });
  }
}
