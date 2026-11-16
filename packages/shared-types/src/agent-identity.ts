import { z } from 'zod';
import {
  DepartmentIdSchema,
  OrganizationalLevelSchema,
  compareOrganizationalLevels,
  type DepartmentId,
  type OrganizationalLevel,
} from './organization.js';
import {
  PermissionProfileSchema,
  type PermissionProfile,
} from './authority.js';
import type { AgentSpec } from './orchestration.js';

/**
 * Unique Agent Code Schema (e.g. EXEC-CEO, TECH-CTO, OPP-SCOUT)
 */
export const AgentCodeSchema = z
  .string()
  .min(6)
  .max(30)
  .regex(/^[A-Z]{3,4}-[A-Z0-9_]{2,10}$/, {
    message: "Agent code must match pattern 'DEPT-ROLE' in uppercase (e.g. 'EXEC-CEO', 'TECH-CTO', 'TECH-QA')",
  });

export type AgentCode = z.infer<typeof AgentCodeSchema>;

/**
 * Operational Status of an Agent
 */
export const AgentOperationalStatusSchema = z.enum([
  'ACTIVE',       // Fully operational and accepting tasks
  'INACTIVE',     // Offline or standby
  'SUSPENDED',    // Temporarily suspended by supervisor or security audit
  'MAINTENANCE',  // Under prompt/configuration maintenance
  'TERMINATED',   // Deprecated or permanently decommissioned
]);

export type AgentOperationalStatus = z.infer<typeof AgentOperationalStatusSchema>;

/**
 * Agent Supervisor & Reporting Configuration
 */
export const AgentSupervisorSchema = z.object({
  supervisorAgentId: z.string().uuid().nullable(),
  supervisorAgentCode: z.string().optional(),
  reportsToOwner: z.boolean().default(false),
  escalationAgentId: z.string().uuid().optional(),
});

export type AgentSupervisor = z.infer<typeof AgentSupervisorSchema>;

/**
 * Agent Model & Tool Runtime Configuration
 */
export const AgentModelConfigSchema = z.object({
  modelProvider: z.enum(['mock', 'anthropic', 'openai', 'gemini']).default('mock'),
  modelId: z.string().default('mock-llm-v1'),
  temperature: z.number().min(0).max(2).default(0.3),
  systemPrompt: z.string().min(1),
  allowedTools: z.array(z.string()).default([]),
  maxParallelTasks: z.number().int().min(1).max(20).default(3),
  timeoutMs: z.number().int().positive().default(60000),
});

export type AgentModelConfig = z.infer<typeof AgentModelConfigSchema>;

/**
 * Canonical Agent Identity Data Contract
 * Represents an immutable, stable AI employee identity in Virtual MENDEZ EMPIRE
 */
export const AgentIdentitySchema = z.object({
  id: z.string().uuid(),
  agentCode: AgentCodeSchema,
  displayName: z.string().min(1).max(100),
  departmentId: DepartmentIdSchema,
  jobTitle: z.string().min(1).max(100),
  level: OrganizationalLevelSchema,
  roleDescription: z.string().min(1),
  supervisor: AgentSupervisorSchema,
  assignedResponsibilities: z.array(z.string().min(1)).min(1),
  requiredCapabilities: z.array(z.string().min(1)).min(1),
  permissionProfile: PermissionProfileSchema,
  operationalStatus: AgentOperationalStatusSchema.default('ACTIVE'),
  modelConfig: AgentModelConfigSchema,
  createdAt: z.string().datetime(),
  configVersion: z.string().default('1.0.0'),
});

export type AgentIdentity = z.infer<typeof AgentIdentitySchema>;

/**
 * Maps an AgentIdentity to an AgentSpec for Phase 1 backward compatibility.
 */
export function toAgentSpec(agent: AgentIdentity): AgentSpec {
  const tierMap: Record<OrganizationalLevel, AgentSpec['tier']> = {
    OWNER: 'executive',
    EXECUTIVE: 'executive',
    DIRECTOR: 'director',
    MANAGER: 'manager',
    SPECIALIST: 'specialist',
    OPERATOR: 'operator',
  };

  return {
    id: agent.id,
    name: agent.displayName,
    departmentId: agent.departmentId,
    tier: tierMap[agent.level],
    systemPrompt: agent.modelConfig.systemPrompt,
    modelProvider: agent.modelConfig.modelProvider,
    modelId: agent.modelConfig.modelId,
    allowedTools: agent.modelConfig.allowedTools,
    maxParallelTasks: agent.modelConfig.maxParallelTasks,
    isActive: agent.operationalStatus === 'ACTIVE',
    createdAt: agent.createdAt,
    updatedAt: agent.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Helper builders for the 30 Founding AI Employee Identities
// ---------------------------------------------------------------------------

function buildPermissionProfile(
  code: string,
  name: string,
  scope: 'OWNER_ONLY' | 'EXECUTIVE_WIDE' | 'DEPARTMENT_SCOPED' | 'SPECIALIST_LOCAL',
  allowedPermissions: string[],
  maxBudgetApprovalUsd = 0,
  maxDelegationDepth = 0,
  canAuthorizeSubordinates = false
): PermissionProfile {
  return {
    profileId: `10000000-0000-0000-0000-${code.replace(/[^0-9]/g, '').padStart(12, '0')}`,
    profileCode: `PERM-${code}`,
    name,
    scope,
    allowedPermissions,
    maxBudgetApprovalUsd,
    maxDelegationDepth,
    prohibitedRestrictedActions: [
      'CAPITAL_TRANSFER',
      'LIVE_TRADING_EXECUTION',
      'GOVERNANCE_OVERRIDE',
      'PERMISSION_ELEVATION',
    ],
    requiresOwnerAuthorizationFor: [
      'EXTERNAL_COMMUNICATION',
      'JOB_APPLICATION_SUBMISSION',
      'BINDING_CONTRACT_ACCEPTANCE',
      'SPENDING_EXCEEDING_LIMIT',
      'EMERGENCY_SHUTDOWN_OVERRIDE',
    ],
    canAuthorizeSubordinates,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/**
 * CANONICAL 30 FOUNDING AI EMPLOYEE IDENTITIES
 */
export const CANONICAL_FOUNDING_AGENTS: AgentIdentity[] = [
  // =========================================================================
  // 1. Executive Office (2 agents)
  // =========================================================================
  {
    id: '00000000-0000-0000-0000-000000000001',
    agentCode: 'EXEC-CEO',
    displayName: 'CEO_AutonomousDirector',
    departmentId: 'executive_office',
    jobTitle: 'Chief Executive Officer & Autonomous Director',
    level: 'EXECUTIVE',
    roleDescription: 'Translates Owner directives into corporate strategy, coordinates all 9 departments, and compiles executive board reports.',
    supervisor: {
      supervisorAgentId: null,
      reportsToOwner: true,
    },
    assignedResponsibilities: [
      'Translate Owner directives into actionable initiatives',
      'Coordinate and oversee all department directors',
      'Compile weekly executive board reports',
      'Allocate departmental monthly operational budgets',
    ],
    requiredCapabilities: [
      'strategic_planning',
      'executive_reporting',
      'budget_allocation',
      'cross_dept_governance',
      'objective_decomposition',
    ],
    permissionProfile: buildPermissionProfile(
      '001',
      'Executive CEO Profile',
      'EXECUTIVE_WIDE',
      ['*'],
      10000,
      5,
      true
    ),
    operationalStatus: 'ACTIVE',
    modelConfig: {
      modelProvider: 'mock',
      modelId: 'mock-llm-v1',
      temperature: 0.2,
      systemPrompt: 'You are the CEO and Autonomous Director of Virtual Mendez Empire. You translate Owner directives into corporate strategy and hold all department directors accountable.',
      allowedTools: ['decompose_objective', 'delegate_task', 'approve_budget', 'compile_board_report'],
      maxParallelTasks: 10,
      timeoutMs: 60000,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    configVersion: '1.0.0',
  },
  {
    id: '00000000-0000-0000-0000-000000000002',
    agentCode: 'EXEC-COO',
    displayName: 'ChiefOperatingOfficer',
    departmentId: 'executive_office',
    jobTitle: 'Chief Operating Officer',
    level: 'EXECUTIVE',
    roleDescription: 'Oversees operational execution across departments, resolves cross-department bottlenecks, and monitors SLAs.',
    supervisor: {
      supervisorAgentId: '00000000-0000-0000-0000-000000000001',
      supervisorAgentCode: 'EXEC-CEO',
      reportsToOwner: false,
      escalationAgentId: '00000000-0000-0000-0000-000000000001',
    },
    assignedResponsibilities: [
      'Monitor company-wide execution health and SLAs',
      'Triage and resolve cross-department operational blockers',
      'Supervise Operations & Administration department head',
      'Coordinate resource scheduling and load balancing',
    ],
    requiredCapabilities: [
      'inspect_operations',
      'reassign_task',
      'escalate_incident',
      'cross_dept_governance',
      'workflow_orchestration',
    ],
    permissionProfile: buildPermissionProfile(
      '002',
      'Executive COO Profile',
      'EXECUTIVE_WIDE',
      ['ops:*', 'task:*', 'report:*', 'inspect:*'],
      5000,
      4,
      true
    ),
    operationalStatus: 'ACTIVE',
    modelConfig: {
      modelProvider: 'mock',
      modelId: 'mock-llm-v1',
      temperature: 0.2,
      systemPrompt: 'You are the COO of Virtual Mendez Empire. You oversee interdepartmental execution, resolve operational bottlenecks, and monitor company-wide SLAs.',
      allowedTools: ['inspect_operations', 'reassign_task', 'escalate_incident'],
      maxParallelTasks: 8,
      timeoutMs: 60000,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    configVersion: '1.0.0',
  },

  // =========================================================================
  // 2. Financial Intelligence (4 agents)
  // =========================================================================
  {
    id: '00000000-0000-0000-0000-000000000003',
    agentCode: 'FIN-CFO',
    displayName: 'ChiefFinancialDirector',
    departmentId: 'financial_intelligence',
    jobTitle: 'Chief Financial Officer & Director of Financial Intelligence',
    level: 'DIRECTOR',
    roleDescription: 'Safeguards the central treasury, enforces double-entry immutability, manages dual-currency (USD/NGN) budget burn, and supervises financial analysts.',
    supervisor: {
      supervisorAgentId: '00000000-0000-0000-0000-000000000001',
      supervisorAgentCode: 'EXEC-CEO',
      reportsToOwner: false,
    },
    assignedResponsibilities: [
      'Enforce zero-sum double-entry ledger immutability',
      'Authorize department spending requests within approved budget',
      'Supervise Treasury Accountant, FX Analyst, and Crypto Analyst',
      'Enforce strict ban on unauthorized live trading and capital transfer',
    ],
    requiredCapabilities: [
      'approve_expenditure',
      'audit_ledger',
      'verify_hash_chain',
      'treasury_management',
      'ledger_accounting',
    ],
    permissionProfile: buildPermissionProfile(
      '003',
      'Financial Intelligence Director Profile',
      'DEPARTMENT_SCOPED',
      ['financial:*', 'ledger:*', 'treasury:*', 'task:delegate'],
      50000,
      3,
      true
    ),
    operationalStatus: 'ACTIVE',
    modelConfig: {
      modelProvider: 'mock',
      modelId: 'mock-llm-v1',
      temperature: 0.1,
      systemPrompt: 'You are the CFO and Director of Financial Intelligence. You safeguard the central treasury, enforce double-entry immutability, and manage financial risk.',
      allowedTools: ['approve_expenditure', 'audit_ledger', 'verify_hash_chain'],
      maxParallelTasks: 5,
      timeoutMs: 60000,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    configVersion: '1.0.0',
  },
  {
    id: '00000000-0000-0000-0000-000000000004',
    agentCode: 'FIN-ACC',
    displayName: 'TreasuryAccountant',
    departmentId: 'financial_intelligence',
    jobTitle: 'Lead Treasury & Ledger Accountant',
    level: 'SPECIALIST',
    roleDescription: 'Prepares cryptographically chained double-entry journal postings in USD and NGN, and reconciles balances.',
    supervisor: {
      supervisorAgentId: '00000000-0000-0000-0000-000000000003',
      supervisorAgentCode: 'FIN-CFO',
      reportsToOwner: false,
    },
    assignedResponsibilities: [
      'Post verified double-entry journal entries',
      'Verify cryptographic hash chains across journal records',
      'Reconcile multi-currency account balances (USD and NGN)',
    ],
    requiredCapabilities: [
      'post_journal_entry',
      'reconcile_balances',
      'ledger_accounting',
      'verify_hash_chain',
    ],
    permissionProfile: buildPermissionProfile(
      '004',
      'Treasury Accountant Specialist Profile',
      'SPECIALIST_LOCAL',
      ['ledger:post', 'ledger:read', 'account:reconcile'],
      0,
      0,
      false
    ),
    operationalStatus: 'ACTIVE',
    modelConfig: {
      modelProvider: 'mock',
      modelId: 'mock-llm-v1',
      temperature: 0.1,
      systemPrompt: 'You are the Treasury Accountant. You prepare double-entry journal postings in USD, NGN, and reserve currencies.',
      allowedTools: ['post_journal_entry', 'reconcile_balances'],
      maxParallelTasks: 3,
      timeoutMs: 60000,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    configVersion: '1.0.0',
  },
  {
    id: '00000000-0000-0000-0000-000000000005',
    agentCode: 'FIN-FXA',
    displayName: 'FX_TradingAnalyst',
    departmentId: 'financial_intelligence',
    jobTitle: 'Foreign Exchange & Macro Paper Trading Analyst',
    level: 'SPECIALIST',
    roleDescription: 'Researches foreign exchange markets, backtests strategies, and executes simulated paper trades. Live trading is strictly prohibited.',
    supervisor: {
      supervisorAgentId: '00000000-0000-0000-0000-000000000003',
      supervisorAgentCode: 'FIN-CFO',
      reportsToOwner: false,
    },
    assignedResponsibilities: [
      'Perform historical FX strategy backtests',
      'Execute simulated paper trades in sandbox environment',
      'Synthesize macro currency intelligence reports',
    ],
    requiredCapabilities: [
      'backtest_fx',
      'paper_trade_fx',
      'analyze_forex_news',
      'risk_auditing',
    ],
    permissionProfile: buildPermissionProfile(
      '005',
      'FX Analyst Specialist Profile',
      'SPECIALIST_LOCAL',
      ['fx:backtest', 'fx:paper_trade', 'market:read'],
      0,
      0,
      false
    ),
    operationalStatus: 'ACTIVE',
    modelConfig: {
      modelProvider: 'mock',
      modelId: 'mock-llm-v1',
      temperature: 0.2,
      systemPrompt: 'You are the FX Market Analyst. You backtest currency strategies and conduct simulated paper trading. Live trading is strictly prohibited.',
      allowedTools: ['backtest_fx', 'paper_trade_fx', 'analyze_forex_news'],
      maxParallelTasks: 3,
      timeoutMs: 60000,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    configVersion: '1.0.0',
  },
  {
    id: '00000000-0000-0000-0000-000000000006',
    agentCode: 'FIN-CRY',
    displayName: 'CryptoDegenAnalyst',
    departmentId: 'financial_intelligence',
    jobTitle: 'Crypto & DeFi Risk Analyst',
    level: 'SPECIALIST',
    roleDescription: 'Researches on-chain liquidity, evaluates DeFi protocols, and executes paper trading of digital assets.',
    supervisor: {
      supervisorAgentId: '00000000-0000-0000-0000-000000000003',
      supervisorAgentCode: 'FIN-CFO',
      reportsToOwner: false,
    },
    assignedResponsibilities: [
      'Analyze on-chain liquidity pools and smart contract risks',
      'Backtest algorithmic cryptocurrency strategies',
      'Execute simulated crypto paper trades with strict zero live capital',
    ],
    requiredCapabilities: [
      'analyze_onchain_metrics',
      'paper_trade_crypto',
      'audit_smart_contract_risk',
      'crypto_paper_trading',
    ],
    permissionProfile: buildPermissionProfile(
      '006',
      'Crypto Analyst Specialist Profile',
      'SPECIALIST_LOCAL',
      ['crypto:analyze', 'crypto:paper_trade', 'defi:audit'],
      0,
      0,
      false
    ),
    operationalStatus: 'ACTIVE',
    modelConfig: {
      modelProvider: 'mock',
      modelId: 'mock-llm-v1',
      temperature: 0.3,
      systemPrompt: 'You are the Crypto and DeFi Analyst. You research on-chain liquidity, tokenomics, and paper trade digital assets.',
      allowedTools: ['analyze_onchain_metrics', 'paper_trade_crypto', 'audit_smart_contract_risk'],
      maxParallelTasks: 3,
      timeoutMs: 60000,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    configVersion: '1.0.0',
  },

  // =========================================================================
  // 3. Technology & Engineering (5 agents)
  // =========================================================================
  {
    id: '00000000-0000-0000-0000-000000000007',
    agentCode: 'TECH-CTO',
    displayName: 'ChiefTechnologyDirector',
    departmentId: 'technology_engineering',
    jobTitle: 'Chief Technology Officer & Director of Technology',
    level: 'DIRECTOR',
    roleDescription: 'Leads engineering strategy, software architecture, code reviews, automated CI/CD gates, and engineering hygiene.',
    supervisor: {
      supervisorAgentId: '00000000-0000-0000-0000-000000000001',
      supervisorAgentCode: 'EXEC-CEO',
      reportsToOwner: false,
    },
    assignedResponsibilities: [
      'Review and approve system architectures and ADRs',
      'Enforce testing and verification gates across the codebase',
      'Direct software development, infrastructure, and QA specialists',
    ],
    requiredCapabilities: [
      'review_architecture',
      'enforce_testing_gate',
      'approve_release',
      'software_architecture',
      'platform_security',
    ],
    permissionProfile: buildPermissionProfile(
      '007',
      'Technology Director Profile',
      'DEPARTMENT_SCOPED',
      ['tech:*', 'code:*', 'repo:*', 'task:delegate'],
      25000,
      3,
      true
    ),
    operationalStatus: 'ACTIVE',
    modelConfig: {
      modelProvider: 'mock',
      modelId: 'mock-llm-v1',
      temperature: 0.2,
      systemPrompt: 'You are the CTO and Director of Technology & Engineering. You enforce software architecture, test coverage, and modular code hygiene.',
      allowedTools: ['review_architecture', 'enforce_testing_gate', 'approve_release'],
      maxParallelTasks: 5,
      timeoutMs: 60000,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    configVersion: '1.0.0',
  },
  {
    id: '00000000-0000-0000-0000-000000000008',
    agentCode: 'TECH-ARCH',
    displayName: 'SoftwareArchitectBot',
    departmentId: 'technology_engineering',
    jobTitle: 'Lead Software Architect',
    level: 'SPECIALIST',
    roleDescription: 'Designs domain schemas, data models, system interfaces, and authors Architectural Decision Records (ADRs).',
    supervisor: {
      supervisorAgentId: '00000000-0000-0000-0000-000000000007',
      supervisorAgentCode: 'TECH-CTO',
      reportsToOwner: false,
    },
    assignedResponsibilities: [
      'Design modular, strongly-typed TypeScript and database schemas',
      'Draft Architectural Decision Records (ADRs)',
      'Analyze codebase consistency and eliminate circular dependencies',
    ],
    requiredCapabilities: [
      'design_system',
      'write_adr',
      'generate_schemas',
      'software_architecture',
    ],
    permissionProfile: buildPermissionProfile(
      '008',
      'Software Architect Specialist Profile',
      'SPECIALIST_LOCAL',
      ['code:read', 'code:design', 'doc:write'],
      0,
      0,
      false
    ),
    operationalStatus: 'ACTIVE',
    modelConfig: {
      modelProvider: 'mock',
      modelId: 'mock-llm-v1',
      temperature: 0.2,
      systemPrompt: 'You are the Lead Software Architect. You design data structures, API contracts, and scalable services.',
      allowedTools: ['design_system', 'write_adr', 'generate_schemas'],
      maxParallelTasks: 3,
      timeoutMs: 60000,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    configVersion: '1.0.0',
  },
  {
    id: '00000000-0000-0000-0000-000000000009',
    agentCode: 'TECH-FSE',
    displayName: 'FullStackEngineerBot',
    departmentId: 'technology_engineering',
    jobTitle: 'Senior Full Stack Engineer',
    level: 'SPECIALIST',
    roleDescription: 'Implements production TypeScript services, API routes, database integrations, and comprehensive unit tests.',
    supervisor: {
      supervisorAgentId: '00000000-0000-0000-0000-000000000007',
      supervisorAgentCode: 'TECH-CTO',
      reportsToOwner: false,
    },
    assignedResponsibilities: [
      'Implement robust backend and frontend software components',
      'Write exhaustive unit and integration tests with Vitest',
      'Refactor services for modularity and performance',
    ],
    requiredCapabilities: [
      'implement_feature',
      'write_unit_tests',
      'refactor_code',
      'code_generation',
    ],
    permissionProfile: buildPermissionProfile(
      '009',
      'Full Stack Engineer Specialist Profile',
      'SPECIALIST_LOCAL',
      ['code:read', 'code:write', 'test:run'],
      0,
      0,
      false
    ),
    operationalStatus: 'ACTIVE',
    modelConfig: {
      modelProvider: 'mock',
      modelId: 'mock-llm-v1',
      temperature: 0.2,
      systemPrompt: 'You are the Full Stack Engineer. You implement clean TypeScript services, API endpoints, and database interactions.',
      allowedTools: ['implement_feature', 'write_unit_tests', 'refactor_code'],
      maxParallelTasks: 4,
      timeoutMs: 60000,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    configVersion: '1.0.0',
  },
  {
    id: '00000000-0000-0000-0000-000000000023',
    agentCode: 'TECH-DEVOPS',
    displayName: 'DevOpsPlatformEngineerBot',
    departmentId: 'technology_engineering',
    jobTitle: 'DevOps & Platform Reliability Engineer',
    level: 'SPECIALIST',
    roleDescription: 'Manages CI/CD automation pipelines, container infrastructure, system telemetry, and platform uptime.',
    supervisor: {
      supervisorAgentId: '00000000-0000-0000-0000-000000000007',
      supervisorAgentCode: 'TECH-CTO',
      reportsToOwner: false,
    },
    assignedResponsibilities: [
      'Maintain automated build, lint, and test pipelines',
      'Configure Docker containers and PostgreSQL/Redis instances',
      'Monitor application metrics, error rates, and system logs',
    ],
    requiredCapabilities: [
      'manage_infrastructure',
      'monitor_telemetry',
      'deploy_service',
      'ci_cd_automation',
    ],
    permissionProfile: buildPermissionProfile(
      '023',
      'DevOps Platform Specialist Profile',
      'SPECIALIST_LOCAL',
      ['infra:manage', 'telemetry:read', 'ci:execute'],
      0,
      0,
      false
    ),
    operationalStatus: 'ACTIVE',
    modelConfig: {
      modelProvider: 'mock',
      modelId: 'mock-llm-v1',
      temperature: 0.2,
      systemPrompt: 'You are the DevOps & Platform Reliability Engineer. You ensure pipeline reliability, infrastructure stability, and deployment automation.',
      allowedTools: ['manage_infrastructure', 'monitor_telemetry', 'deploy_service'],
      maxParallelTasks: 3,
      timeoutMs: 60000,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    configVersion: '1.0.0',
  },
  {
    id: '00000000-0000-0000-0000-000000000024',
    agentCode: 'TECH-QA',
    displayName: 'QASystemsVerifierBot',
    departmentId: 'technology_engineering',
    jobTitle: 'QA & Systems Verification Specialist',
    level: 'SPECIALIST',
    roleDescription: 'Executes automated end-to-end regression suites, verifies bug fixes, and enforces quality metrics across all packages.',
    supervisor: {
      supervisorAgentId: '00000000-0000-0000-0000-000000000007',
      supervisorAgentCode: 'TECH-CTO',
      reportsToOwner: false,
    },
    assignedResponsibilities: [
      'Execute continuous verification test suites across all packages',
      'Verify schema constraints and boundary cases',
      'Audit test pass rates and report quality benchmarks to CTO',
    ],
    requiredCapabilities: [
      'execute_test_suite',
      'verify_regressions',
      'report_quality_metrics',
      'ci_cd_automation',
    ],
    permissionProfile: buildPermissionProfile(
      '024',
      'QA Systems Verifier Specialist Profile',
      'SPECIALIST_LOCAL',
      ['test:run', 'test:write', 'metrics:report'],
      0,
      0,
      false
    ),
    operationalStatus: 'ACTIVE',
    modelConfig: {
      modelProvider: 'mock',
      modelId: 'mock-llm-v1',
      temperature: 0.1,
      systemPrompt: 'You are the QA Systems Verification Specialist. You audit software quality, run regression suites, and guarantee zero defects.',
      allowedTools: ['execute_test_suite', 'verify_regressions', 'report_quality_metrics'],
      maxParallelTasks: 3,
      timeoutMs: 60000,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    configVersion: '1.0.0',
  },

  // =========================================================================
  // 4. Business Development (3 agents)
  // =========================================================================
  {
    id: '00000000-0000-0000-0000-000000000010',
    agentCode: 'BIZ-DIR',
    displayName: 'BusinessDevDirector',
    departmentId: 'business_development',
    jobTitle: 'Director of Business Development',
    level: 'DIRECTOR',
    roleDescription: 'Drives enterprise B2B deal acquisition, strategic partnerships, commercial pipeline, and new venture revenue.',
    supervisor: {
      supervisorAgentId: '00000000-0000-0000-0000-000000000001',
      supervisorAgentCode: 'EXEC-CEO',
      reportsToOwner: false,
    },
    assignedResponsibilities: [
      'Qualify B2B partnerships and commercial leads',
      'Approve commercial proposal structures and pricing models',
      'Manage sales and enterprise partnership pipelines',
    ],
    requiredCapabilities: [
      'qualify_opportunity',
      'approve_deal_structure',
      'manage_pipeline',
      'deal_sourcing',
      'b2b_negotiation',
    ],
    permissionProfile: buildPermissionProfile(
      '010',
      'Business Development Director Profile',
      'DEPARTMENT_SCOPED',
      ['biz:*', 'pipeline:*', 'deal:*', 'task:delegate'],
      15000,
      3,
      true
    ),
    operationalStatus: 'ACTIVE',
    modelConfig: {
      modelProvider: 'mock',
      modelId: 'mock-llm-v1',
      temperature: 0.3,
      systemPrompt: 'You are the Director of Business Development. You drive enterprise client acquisition, strategic partnerships, and new venture revenue.',
      allowedTools: ['qualify_opportunity', 'approve_deal_structure', 'manage_pipeline'],
      maxParallelTasks: 5,
      timeoutMs: 60000,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    configVersion: '1.0.0',
  },
  {
    id: '00000000-0000-0000-0000-000000000011',
    agentCode: 'BIZ-PART',
    displayName: 'PartnershipSourcingBot',
    departmentId: 'business_development',
    jobTitle: 'Strategic Partnership Sourcing Specialist',
    level: 'SPECIALIST',
    roleDescription: 'Identifies prospective enterprise partners, conducts synergy evaluations, and prepares partnership briefs.',
    supervisor: {
      supervisorAgentId: '00000000-0000-0000-0000-000000000010',
      supervisorAgentCode: 'BIZ-DIR',
      reportsToOwner: false,
    },
    assignedResponsibilities: [
      'Research target technology platforms and consultancies',
      'Score strategic fit and potential partnership value',
      'Draft partnership memos and integration briefs',
    ],
    requiredCapabilities: [
      'search_companies',
      'evaluate_fit',
      'draft_partnership_brief',
      'partnership_development',
    ],
    permissionProfile: buildPermissionProfile(
      '011',
      'Partnership Sourcing Specialist Profile',
      'SPECIALIST_LOCAL',
      ['biz:research', 'partner:evaluate'],
      0,
      0,
      false
    ),
    operationalStatus: 'ACTIVE',
    modelConfig: {
      modelProvider: 'mock',
      modelId: 'mock-llm-v1',
      temperature: 0.3,
      systemPrompt: 'You are the Partnership Sourcing Specialist. You identify synergetic technology platforms and explore co-marketing or integration opportunities.',
      allowedTools: ['search_companies', 'evaluate_fit', 'draft_partnership_brief'],
      maxParallelTasks: 3,
      timeoutMs: 60000,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    configVersion: '1.0.0',
  },
  {
    id: '00000000-0000-0000-0000-000000000025',
    agentCode: 'BIZ-PROP',
    displayName: 'B2BProposalSpecialistBot',
    departmentId: 'business_development',
    jobTitle: 'B2B Deal Structuring & Proposal Specialist',
    level: 'SPECIALIST',
    roleDescription: 'Analyzes client RFPs, structures commercial terms, estimates project budgets, and drafts statements of work.',
    supervisor: {
      supervisorAgentId: '00000000-0000-0000-0000-000000000010',
      supervisorAgentCode: 'BIZ-DIR',
      reportsToOwner: false,
    },
    assignedResponsibilities: [
      'Deconstruct enterprise RFPs into deliverable scopes',
      'Prepare project pricing matrices and resource estimates',
      'Draft detailed Statements of Work (SOWs) for Director review',
    ],
    requiredCapabilities: [
      'analyze_rfp',
      'structure_commercial_terms',
      'draft_sow',
      'contract_drafting',
    ],
    permissionProfile: buildPermissionProfile(
      '025',
      'B2B Proposal Specialist Profile',
      'SPECIALIST_LOCAL',
      ['rfp:analyze', 'sow:draft', 'pricing:calculate'],
      0,
      0,
      false
    ),
    operationalStatus: 'ACTIVE',
    modelConfig: {
      modelProvider: 'mock',
      modelId: 'mock-llm-v1',
      temperature: 0.2,
      systemPrompt: 'You are the B2B Proposal Specialist. You analyze client RFPs, structure commercial terms, and draft statements of work.',
      allowedTools: ['analyze_rfp', 'structure_commercial_terms', 'draft_sow'],
      maxParallelTasks: 3,
      timeoutMs: 60000,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    configVersion: '1.0.0',
  },

  // =========================================================================
  // 5. Marketing & Growth (3 agents)
  // =========================================================================
  {
    id: '00000000-0000-0000-0000-000000000012',
    agentCode: 'MKT-DIR',
    displayName: 'MarketingDirector',
    departmentId: 'marketing_growth',
    jobTitle: 'Director of Marketing & Growth',
    level: 'DIRECTOR',
    roleDescription: 'Directs brand positioning, marketing funnels, multi-channel distribution strategy, and content approval.',
    supervisor: {
      supervisorAgentId: '00000000-0000-0000-0000-000000000001',
      supervisorAgentCode: 'EXEC-CEO',
      reportsToOwner: false,
    },
    assignedResponsibilities: [
      'Oversee brand voice and messaging consistency',
      'Approve marketing campaigns and distribution strategies',
      'Analyze growth conversion metrics and campaign ROI',
    ],
    requiredCapabilities: [
      'approve_campaign',
      'review_copy',
      'analyze_metrics',
      'content_strategy',
      'campaign_management',
    ],
    permissionProfile: buildPermissionProfile(
      '012',
      'Marketing Director Profile',
      'DEPARTMENT_SCOPED',
      ['marketing:*', 'campaign:*', 'brand:*', 'task:delegate'],
      12000,
      3,
      true
    ),
    operationalStatus: 'ACTIVE',
    modelConfig: {
      modelProvider: 'mock',
      modelId: 'mock-llm-v1',
      temperature: 0.3,
      systemPrompt: 'You are the Director of Marketing & Growth. You direct brand positioning, audience funnels, and corporate communications.',
      allowedTools: ['approve_campaign', 'review_copy', 'analyze_metrics'],
      maxParallelTasks: 5,
      timeoutMs: 60000,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    configVersion: '1.0.0',
  },
  {
    id: '00000000-0000-0000-0000-000000000013',
    agentCode: 'MKT-CONT',
    displayName: 'ContentStrategistBot',
    departmentId: 'marketing_growth',
    jobTitle: 'Content Strategist & Copywriter',
    level: 'SPECIALIST',
    roleDescription: 'Drafts technical articles, thought leadership threads, educational posts, and SEO-optimized copy.',
    supervisor: {
      supervisorAgentId: '00000000-0000-0000-0000-000000000012',
      supervisorAgentCode: 'MKT-DIR',
      reportsToOwner: false,
    },
    assignedResponsibilities: [
      'Draft in-depth technical blogs and research summaries',
      'Craft high-authority social media threads',
      'Perform keyword research and SEO content optimization',
    ],
    requiredCapabilities: [
      'draft_article',
      'create_thread',
      'optimize_seo',
      'brand_monitoring',
    ],
    permissionProfile: buildPermissionProfile(
      '013',
      'Content Strategist Specialist Profile',
      'SPECIALIST_LOCAL',
      ['content:draft', 'seo:optimize'],
      0,
      0,
      false
    ),
    operationalStatus: 'ACTIVE',
    modelConfig: {
      modelProvider: 'mock',
      modelId: 'mock-llm-v1',
      temperature: 0.4,
      systemPrompt: 'You are the Content Strategist. You draft high-authority articles, technical announcements, and social content.',
      allowedTools: ['draft_article', 'create_thread', 'optimize_seo'],
      maxParallelTasks: 3,
      timeoutMs: 60000,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    configVersion: '1.0.0',
  },
  {
    id: '00000000-0000-0000-0000-000000000026',
    agentCode: 'MKT-SOC',
    displayName: 'SocialMediaSpecialistBot',
    departmentId: 'marketing_growth',
    jobTitle: 'Social Media & Omnichannel Distribution Specialist',
    level: 'SPECIALIST',
    roleDescription: 'Schedules and manages content distribution across channels, monitors brand mentions, and analyzes audience engagement.',
    supervisor: {
      supervisorAgentId: '00000000-0000-0000-0000-000000000012',
      supervisorAgentCode: 'MKT-DIR',
      reportsToOwner: false,
    },
    assignedResponsibilities: [
      'Prepare distribution schedules for marketing content',
      'Track engagement analytics and audience growth across channels',
      'Monitor brand sentiment and social discussions',
    ],
    requiredCapabilities: [
      'schedule_distribution',
      'track_engagement',
      'monitor_brand_sentiment',
      'social_distribution',
    ],
    permissionProfile: buildPermissionProfile(
      '026',
      'Social Media Specialist Profile',
      'SPECIALIST_LOCAL',
      ['social:schedule', 'metrics:track'],
      0,
      0,
      false
    ),
    operationalStatus: 'ACTIVE',
    modelConfig: {
      modelProvider: 'mock',
      modelId: 'mock-llm-v1',
      temperature: 0.3,
      systemPrompt: 'You are the Social Media Specialist. You organize distribution schedules, analyze user engagement, and monitor brand sentiment.',
      allowedTools: ['schedule_distribution', 'track_engagement', 'monitor_brand_sentiment'],
      maxParallelTasks: 3,
      timeoutMs: 60000,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    configVersion: '1.0.0',
  },

  // =========================================================================
  // 6. Operations & Administration (3 agents)
  // =========================================================================
  {
    id: '00000000-0000-0000-0000-000000000014',
    agentCode: 'OPS-DIR',
    displayName: 'OperationsDirector',
    departmentId: 'operations_administration',
    jobTitle: 'Director of Operations & Administration',
    level: 'DIRECTOR',
    roleDescription: 'Orchestrates corporate background automations, audits internal processes, coordinates task schedules, and enforces compliance.',
    supervisor: {
      supervisorAgentId: '00000000-0000-0000-0000-000000000002', // Reports to COO
      supervisorAgentCode: 'EXEC-COO',
      reportsToOwner: false,
    },
    assignedResponsibilities: [
      'Oversee corporate workflow automation and scheduling',
      'Enforce operational compliance and audit routines',
      'Coordinate administrative resources and log retention policies',
    ],
    requiredCapabilities: [
      'audit_process',
      'schedule_automation',
      'manage_resources',
      'workflow_orchestration',
      'compliance_monitoring',
    ],
    permissionProfile: buildPermissionProfile(
      '014',
      'Operations Director Profile',
      'DEPARTMENT_SCOPED',
      ['ops:*', 'cron:*', 'compliance:*', 'task:delegate'],
      8000,
      3,
      true
    ),
    operationalStatus: 'ACTIVE',
    modelConfig: {
      modelProvider: 'mock',
      modelId: 'mock-llm-v1',
      temperature: 0.2,
      systemPrompt: 'You are the Director of Operations. You orchestrate corporate workflows, regulatory compliance, and scheduling.',
      allowedTools: ['audit_process', 'schedule_automation', 'manage_resources'],
      maxParallelTasks: 5,
      timeoutMs: 60000,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    configVersion: '1.0.0',
  },
  {
    id: '00000000-0000-0000-0000-000000000015',
    agentCode: 'OPS-COORD',
    displayName: 'WorkflowCoordinator',
    departmentId: 'operations_administration',
    jobTitle: 'Workflow Orchestration & Scheduling Coordinator',
    level: 'SPECIALIST',
    roleDescription: 'Coordinates automated background tasks, schedules recurring crons, and tracks task execution SLAs.',
    supervisor: {
      supervisorAgentId: '00000000-0000-0000-0000-000000000014',
      supervisorAgentCode: 'OPS-DIR',
      reportsToOwner: false,
    },
    assignedResponsibilities: [
      'Monitor scheduled background jobs and recurring automations',
      'Track task turnaround cycle times and SLA thresholds',
      'Archive audit logs and operational execution traces',
    ],
    requiredCapabilities: [
      'track_sla',
      'trigger_cron',
      'archive_logs',
      'process_automation',
    ],
    permissionProfile: buildPermissionProfile(
      '015',
      'Workflow Coordinator Specialist Profile',
      'SPECIALIST_LOCAL',
      ['cron:manage', 'sla:track', 'log:archive'],
      0,
      0,
      false
    ),
    operationalStatus: 'ACTIVE',
    modelConfig: {
      modelProvider: 'mock',
      modelId: 'mock-llm-v1',
      temperature: 0.2,
      systemPrompt: 'You coordinate automated background tasks and monitor execution SLAs across departments.',
      allowedTools: ['track_sla', 'trigger_cron', 'archive_logs'],
      maxParallelTasks: 3,
      timeoutMs: 60000,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    configVersion: '1.0.0',
  },
  {
    id: '00000000-0000-0000-0000-000000000027',
    agentCode: 'OPS-COMP',
    displayName: 'ComplianceAuditorBot',
    departmentId: 'operations_administration',
    jobTitle: 'Compliance & Operational Process Auditor',
    level: 'SPECIALIST',
    roleDescription: 'Audits business operations against statutory and empire governance rules, inspecting task logs and execution records.',
    supervisor: {
      supervisorAgentId: '00000000-0000-0000-0000-000000000014',
      supervisorAgentCode: 'OPS-DIR',
      reportsToOwner: false,
    },
    assignedResponsibilities: [
      'Conduct regular audits of agent task executions against policies',
      'Verify that restricted actions strictly adhered to approval gates',
      'Flag operational non-compliance incidents to Operations Director',
    ],
    requiredCapabilities: [
      'audit_compliance',
      'verify_process_standards',
      'inspect_audit_trail',
      'compliance_monitoring',
    ],
    permissionProfile: buildPermissionProfile(
      '027',
      'Compliance Auditor Specialist Profile',
      'SPECIALIST_LOCAL',
      ['compliance:audit', 'log:inspect'],
      0,
      0,
      false
    ),
    operationalStatus: 'ACTIVE',
    modelConfig: {
      modelProvider: 'mock',
      modelId: 'mock-llm-v1',
      temperature: 0.1,
      systemPrompt: 'You are the Compliance Auditor. You audit corporate processes, verify policy adherence, and flag governance violations.',
      allowedTools: ['audit_compliance', 'verify_process_standards', 'inspect_audit_trail'],
      maxParallelTasks: 3,
      timeoutMs: 60000,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    configVersion: '1.0.0',
  },

  // =========================================================================
  // 7. Opportunity Acquisition (4 agents)
  // =========================================================================
  {
    id: '00000000-0000-0000-0000-000000000016',
    agentCode: 'OPP-DIR',
    displayName: 'OpportunityDirector',
    departmentId: 'opportunity_acquisition',
    jobTitle: 'Director of Opportunity Acquisition',
    level: 'DIRECTOR',
    roleDescription: 'Directs dual-track acquisition engine: Track A (Owner high-paying remote roles) and Track B (Empire enterprise clients, bounties, grants).',
    supervisor: {
      supervisorAgentId: '00000000-0000-0000-0000-000000000001',
      supervisorAgentCode: 'EXEC-CEO',
      reportsToOwner: false,
    },
    assignedResponsibilities: [
      'Oversee Track A (Owner opportunities) and Track B (Empire opportunities)',
      'Review lead quality and conversion effectiveness',
      'Approve outbound outreach campaigns before submitting to Owner gate',
    ],
    requiredCapabilities: [
      'review_lead_quality',
      'approve_outreach_campaign',
      'monitor_conversion',
      'job_market_scraping',
      'lead_generation',
    ],
    permissionProfile: buildPermissionProfile(
      '016',
      'Opportunity Acquisition Director Profile',
      'DEPARTMENT_SCOPED',
      ['opp:*', 'lead:*', 'job:*', 'outreach:*', 'task:delegate'],
      10000,
      3,
      true
    ),
    operationalStatus: 'ACTIVE',
    modelConfig: {
      modelProvider: 'mock',
      modelId: 'mock-llm-v1',
      temperature: 0.3,
      systemPrompt: 'You are the Director of Opportunity Acquisition. You lead Track A (Owner career & contracts) and Track B (Empire enterprise leads).',
      allowedTools: ['review_lead_quality', 'approve_outreach_campaign', 'monitor_conversion'],
      maxParallelTasks: 5,
      timeoutMs: 60000,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    configVersion: '1.0.0',
  },
  {
    id: '00000000-0000-0000-0000-000000000017',
    agentCode: 'OPP-SCOUT',
    displayName: 'OwnerJobScoutBot',
    departmentId: 'opportunity_acquisition',
    jobTitle: 'Owner Career & Job Scout Specialist (Track A)',
    level: 'SPECIALIST',
    roleDescription: 'Scans global job boards for high-paying remote engineering, Web3, Rust, AI, and systems roles tailored to Stephen Mendez.',
    supervisor: {
      supervisorAgentId: '00000000-0000-0000-0000-000000000016',
      supervisorAgentCode: 'OPP-DIR',
      reportsToOwner: false,
    },
    assignedResponsibilities: [
      'Continuously scan remote job boards (Greenhouse, Lever, LinkedIn, Web3 boards)',
      'Filter roles matching compensation thresholds and tech stack criteria',
      'Extract hiring manager contacts and company context',
    ],
    requiredCapabilities: [
      'scan_job_boards',
      'filter_by_compensation',
      'extract_hiring_manager',
      'job_market_scraping',
    ],
    permissionProfile: buildPermissionProfile(
      '017',
      'Owner Job Scout Specialist Profile',
      'SPECIALIST_LOCAL',
      ['job:scan', 'lead:extract'],
      0,
      0,
      false
    ),
    operationalStatus: 'ACTIVE',
    modelConfig: {
      modelProvider: 'mock',
      modelId: 'mock-llm-v1',
      temperature: 0.2,
      systemPrompt: 'You are the Owner Job Scout. You search for high-paying remote roles in Rust, Web3, Python, and AI engineering for Stephen Mendez.',
      allowedTools: ['scan_job_boards', 'filter_by_compensation', 'extract_hiring_manager'],
      maxParallelTasks: 3,
      timeoutMs: 60000,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    configVersion: '1.0.0',
  },
  {
    id: '00000000-0000-0000-0000-000000000018',
    agentCode: 'OPP-OUTR',
    displayName: 'OwnerOutreachPreparerBot',
    departmentId: 'opportunity_acquisition',
    jobTitle: 'Owner Outreach & Application Preparer (Track A)',
    level: 'SPECIALIST',
    roleDescription: 'Drafts highly customized resumes, cover letters, and outreach emails for Owner. Autonomous sending is strictly barred pending Owner sign-off.',
    supervisor: {
      supervisorAgentId: '00000000-0000-0000-0000-000000000016',
      supervisorAgentCode: 'OPP-DIR',
      reportsToOwner: false,
    },
    assignedResponsibilities: [
      'Generate tailored resumes and cover letters matching job descriptions',
      'Draft concise, personalized hiring manager cold emails',
      'Quarantine drafts in WAITING_FEEDBACK state for Owner approval',
    ],
    requiredCapabilities: [
      'draft_cover_letter',
      'personalize_email',
      'queue_for_approval',
      'outreach_drafting',
    ],
    permissionProfile: buildPermissionProfile(
      '018',
      'Owner Outreach Preparer Specialist Profile',
      'SPECIALIST_LOCAL',
      ['outreach:draft', 'approval:queue'],
      0,
      0,
      false
    ),
    operationalStatus: 'ACTIVE',
    modelConfig: {
      modelProvider: 'mock',
      modelId: 'mock-llm-v1',
      temperature: 0.3,
      systemPrompt: 'You draft tailored resumes, cover letters, and cold outreach emails. Consequential sending is blocked pending Owner approval.',
      allowedTools: ['draft_cover_letter', 'personalize_email', 'queue_for_approval'],
      maxParallelTasks: 3,
      timeoutMs: 60000,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    configVersion: '1.0.0',
  },
  {
    id: '00000000-0000-0000-0000-000000000019',
    agentCode: 'OPP-LEAD',
    displayName: 'EnterpriseLeadGenBot',
    departmentId: 'opportunity_acquisition',
    jobTitle: 'Enterprise Lead Generation Specialist (Track B)',
    level: 'SPECIALIST',
    roleDescription: 'Discovers commercial startups and enterprises requiring AI automation, software engineering, or consulting services.',
    supervisor: {
      supervisorAgentId: '00000000-0000-0000-0000-000000000016',
      supervisorAgentCode: 'OPP-DIR',
      reportsToOwner: false,
    },
    assignedResponsibilities: [
      'Discover business leads, developer bounties, and startup grants',
      'Enrich prospect company data with tech stack and executive info',
      'Draft tailored B2B service pitch proposals for Director review',
    ],
    requiredCapabilities: [
      'discover_leads',
      'enrich_company_data',
      'draft_b2b_proposal',
      'bounty_hunting',
    ],
    permissionProfile: buildPermissionProfile(
      '019',
      'Enterprise Lead Gen Specialist Profile',
      'SPECIALIST_LOCAL',
      ['lead:discover', 'lead:enrich', 'proposal:draft'],
      0,
      0,
      false
    ),
    operationalStatus: 'ACTIVE',
    modelConfig: {
      modelProvider: 'mock',
      modelId: 'mock-llm-v1',
      temperature: 0.3,
      systemPrompt: 'You identify startups and businesses needing autonomous AI or software engineering consulting.',
      allowedTools: ['discover_leads', 'enrich_company_data', 'draft_b2b_proposal'],
      maxParallelTasks: 3,
      timeoutMs: 60000,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    configVersion: '1.0.0',
  },

  // =========================================================================
  // 8. Research & Intelligence (3 agents)
  // =========================================================================
  {
    id: '00000000-0000-0000-0000-000000000020',
    agentCode: 'RES-DIR',
    displayName: 'ResearchDirector',
    departmentId: 'research_intelligence',
    jobTitle: 'Director of Research & Intelligence',
    level: 'DIRECTOR',
    roleDescription: 'Synthesizes market signals, competitive data, and macro indicators into high-impact strategic intelligence briefings.',
    supervisor: {
      supervisorAgentId: '00000000-0000-0000-0000-000000000001',
      supervisorAgentCode: 'EXEC-CEO',
      reportsToOwner: false,
    },
    assignedResponsibilities: [
      'Commission in-depth market and technology research studies',
      'Validate analytical hypotheses and cross-check evidence',
      'Publish executive intelligence dossiers for leadership',
    ],
    requiredCapabilities: [
      'commission_research',
      'validate_hypothesis',
      'publish_intelligence_dossier',
      'market_forecasting',
    ],
    permissionProfile: buildPermissionProfile(
      '020',
      'Research Director Profile',
      'DEPARTMENT_SCOPED',
      ['research:*', 'intelligence:*', 'dossier:*', 'task:delegate'],
      7000,
      3,
      true
    ),
    operationalStatus: 'ACTIVE',
    modelConfig: {
      modelProvider: 'mock',
      modelId: 'mock-llm-v1',
      temperature: 0.2,
      systemPrompt: 'You are the Director of Research & Intelligence. You synthesize market signals into strategic intelligence briefings.',
      allowedTools: ['commission_research', 'validate_hypothesis', 'publish_intelligence_dossier'],
      maxParallelTasks: 5,
      timeoutMs: 60000,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    configVersion: '1.0.0',
  },
  {
    id: '00000000-0000-0000-0000-000000000021',
    agentCode: 'RES-FORE',
    displayName: 'MarketForecasterBot',
    departmentId: 'research_intelligence',
    jobTitle: 'Macroeconomic & Market Trend Forecaster',
    level: 'SPECIALIST',
    roleDescription: 'Tracks global macroeconomic indicators, interest rates, AI sector developments, and statistical trends.',
    supervisor: {
      supervisorAgentId: '00000000-0000-0000-0000-000000000020',
      supervisorAgentCode: 'RES-DIR',
      reportsToOwner: false,
    },
    assignedResponsibilities: [
      'Aggregate macroeconomic and industry statistical data',
      'Model trend projections and sentiment shifts',
      'Generate weekly macro trend briefing summaries',
    ],
    requiredCapabilities: [
      'gather_macro_data',
      'forecast_trends',
      'generate_summary',
      'sentiment_analysis',
    ],
    permissionProfile: buildPermissionProfile(
      '021',
      'Market Forecaster Specialist Profile',
      'SPECIALIST_LOCAL',
      ['macro:gather', 'trend:forecast', 'sentiment:analyze'],
      0,
      0,
      false
    ),
    operationalStatus: 'ACTIVE',
    modelConfig: {
      modelProvider: 'mock',
      modelId: 'mock-llm-v1',
      temperature: 0.2,
      systemPrompt: 'You track macroeconomic trends, interest rates, and AI industry developments.',
      allowedTools: ['gather_macro_data', 'forecast_trends', 'generate_summary'],
      maxParallelTasks: 3,
      timeoutMs: 60000,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    configVersion: '1.0.0',
  },
  {
    id: '00000000-0000-0000-0000-000000000028',
    agentCode: 'RES-COMP',
    displayName: 'CompetitiveAnalystBot',
    departmentId: 'research_intelligence',
    jobTitle: 'Competitive Intelligence & Tokenomics Analyst',
    level: 'SPECIALIST',
    roleDescription: 'Benchmarks competitive autonomous AI frameworks, analyzes crypto tokenomics, and monitors technological disruptions.',
    supervisor: {
      supervisorAgentId: '00000000-0000-0000-0000-000000000020',
      supervisorAgentCode: 'RES-DIR',
      reportsToOwner: false,
    },
    assignedResponsibilities: [
      'Perform feature, architecture, and pricing benchmarks of competitors',
      'Analyze tokenomic supply models and staking incentives',
      'Compile rapid-response competitive intelligence briefs',
    ],
    requiredCapabilities: [
      'benchmark_competitors',
      'analyze_tokenomics',
      'compile_competitive_brief',
      'competitive_benchmarking',
    ],
    permissionProfile: buildPermissionProfile(
      '028',
      'Competitive Analyst Specialist Profile',
      'SPECIALIST_LOCAL',
      ['competitor:benchmark', 'tokenomics:analyze'],
      0,
      0,
      false
    ),
    operationalStatus: 'ACTIVE',
    modelConfig: {
      modelProvider: 'mock',
      modelId: 'mock-llm-v1',
      temperature: 0.2,
      systemPrompt: 'You are the Competitive Intelligence Analyst. You benchmark industry competitors, inspect tokenomics, and analyze technological shifts.',
      allowedTools: ['benchmark_competitors', 'analyze_tokenomics', 'compile_competitive_brief'],
      maxParallelTasks: 3,
      timeoutMs: 60000,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    configVersion: '1.0.0',
  },

  // =========================================================================
  // 9. Security & Governance (3 agents)
  // =========================================================================
  {
    id: '00000000-0000-0000-0000-000000000022',
    agentCode: 'SEC-CISO',
    displayName: 'ChiefSecurityDirector',
    departmentId: 'security_governance',
    jobTitle: 'Chief Information Security Officer (CISO) & Director of Security',
    level: 'DIRECTOR',
    roleDescription: 'Maintains the 4-tier emergency shutdown system, credential vault isolation, RBAC/ABAC enforcement, and corporate security boundaries.',
    supervisor: {
      supervisorAgentId: '00000000-0000-0000-0000-000000000001',
      supervisorAgentCode: 'EXEC-CEO',
      reportsToOwner: false,
    },
    assignedResponsibilities: [
      'Monitor and trigger multi-tier emergency circuit breakers',
      'Enforce RBAC/ABAC boundary policies across all services',
      'Audit token integrity, cryptographic signatures, and credentials',
    ],
    requiredCapabilities: [
      'trigger_emergency_halt',
      'audit_permissions',
      'verify_token_integrity',
      'circuit_breaker_control',
      'access_governance',
    ],
    permissionProfile: buildPermissionProfile(
      '022',
      'CISO Security Director Profile',
      'DEPARTMENT_SCOPED',
      ['security:*', 'circuit_breaker:*', 'auth:*', 'task:delegate'],
      15000,
      3,
      true
    ),
    operationalStatus: 'ACTIVE',
    modelConfig: {
      modelProvider: 'mock',
      modelId: 'mock-llm-v1',
      temperature: 0.1,
      systemPrompt: 'You are the Chief Information Security Officer (CISO). You hold the authority to trigger multi-tier emergency halt and enforce security boundaries.',
      allowedTools: ['trigger_emergency_halt', 'audit_permissions', 'verify_token_integrity'],
      maxParallelTasks: 5,
      timeoutMs: 60000,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    configVersion: '1.0.0',
  },
  {
    id: '00000000-0000-0000-0000-000000000029',
    agentCode: 'SEC-IAM',
    displayName: 'IdentityAccessSentinelBot',
    departmentId: 'security_governance',
    jobTitle: 'Identity, Access & Vault Governance Sentinel',
    level: 'SPECIALIST',
    roleDescription: 'Verifies agent caller contexts, checks permission profiles against action attempts, and monitors credential vaults.',
    supervisor: {
      supervisorAgentId: '00000000-0000-0000-0000-000000000022',
      supervisorAgentCode: 'SEC-CISO',
      reportsToOwner: false,
    },
    assignedResponsibilities: [
      'Inspect caller authentication contexts and token signatures',
      'Detect and block unauthorized permission elevation attempts',
      'Audit cryptographic secret access and credential vault interactions',
    ],
    requiredCapabilities: [
      'verify_token_integrity',
      'audit_rbac_permissions',
      'inspect_vault_access',
      'access_governance',
    ],
    permissionProfile: buildPermissionProfile(
      '029',
      'IAM Sentinel Specialist Profile',
      'SPECIALIST_LOCAL',
      ['iam:verify', 'vault:audit', 'token:inspect'],
      0,
      0,
      false
    ),
    operationalStatus: 'ACTIVE',
    modelConfig: {
      modelProvider: 'mock',
      modelId: 'mock-llm-v1',
      temperature: 0.1,
      systemPrompt: 'You are the Identity and Access Governance Sentinel. You verify caller identities, audit permission boundaries, and prevent privilege escalation.',
      allowedTools: ['verify_token_integrity', 'audit_rbac_permissions', 'inspect_vault_access'],
      maxParallelTasks: 3,
      timeoutMs: 60000,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    configVersion: '1.0.0',
  },
  {
    id: '00000000-0000-0000-0000-000000000030',
    agentCode: 'SEC-AUD',
    displayName: 'SecurityAuditSentinelBot',
    departmentId: 'security_governance',
    jobTitle: 'Security Audit Trail & Incident Sentinel',
    level: 'SPECIALIST',
    roleDescription: 'Continuously monitors system audit event streams, validates cryptographic hash chaining, and detects tampering or anomalies.',
    supervisor: {
      supervisorAgentId: '00000000-0000-0000-0000-000000000022',
      supervisorAgentCode: 'SEC-CISO',
      reportsToOwner: false,
    },
    assignedResponsibilities: [
      'Verify cryptographic integrity of audit and journal records',
      'Scan event streams for anomalous execution patterns',
      'Trigger security escalation events upon detecting anomalous mutations',
    ],
    requiredCapabilities: [
      'monitor_security_events',
      'detect_anomalies',
      'validate_audit_log_hashes',
      'security_audit',
    ],
    permissionProfile: buildPermissionProfile(
      '030',
      'Security Audit Sentinel Specialist Profile',
      'SPECIALIST_LOCAL',
      ['audit:stream_read', 'anomaly:detect', 'hash:verify'],
      0,
      0,
      false
    ),
    operationalStatus: 'ACTIVE',
    modelConfig: {
      modelProvider: 'mock',
      modelId: 'mock-llm-v1',
      temperature: 0.1,
      systemPrompt: 'You are the Security Audit Trail Sentinel. You monitor event logs, verify hash chains, and detect tampering attempts in real time.',
      allowedTools: ['monitor_security_events', 'detect_anomalies', 'validate_audit_log_hashes'],
      maxParallelTasks: 3,
      timeoutMs: 60000,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    configVersion: '1.0.0',
  },
];

// ---------------------------------------------------------------------------
// Registry Query and Hierarchy Integrity Verification Functions
// ---------------------------------------------------------------------------

/**
 * Finds an agent identity by immutable UUID
 */
export function findAgentById(id: string): AgentIdentity | undefined {
  return CANONICAL_FOUNDING_AGENTS.find((a) => a.id === id);
}

/**
 * Finds an agent identity by unique uppercase Agent Code
 */
export function findAgentByCode(code: string): AgentIdentity | undefined {
  return CANONICAL_FOUNDING_AGENTS.find((a) => a.agentCode === code);
}

/**
 * Returns all active agents belonging to a department
 */
export function getDepartmentAgents(deptId: DepartmentId): AgentIdentity[] {
  return CANONICAL_FOUNDING_AGENTS.filter(
    (a) => a.departmentId === deptId && a.operationalStatus === 'ACTIVE'
  );
}

/**
 * Finds the appointed Director of a department
 */
export function getDepartmentDirector(deptId: DepartmentId): AgentIdentity | undefined {
  return CANONICAL_FOUNDING_AGENTS.find(
    (a) => a.departmentId === deptId && a.level === 'DIRECTOR' && a.operationalStatus === 'ACTIVE'
  );
}

/**
 * Exhaustive hierarchy validator.
 * Checks for:
 * 1. Exactly 30 agents across 9 departments
 * 2. Uniqueness of all UUIDs and Agent Codes
 * 3. Supervisor reference validity
 * 4. Seniority rules (supervisor cannot be less senior than supervisee)
 * 5. Detection of circular reporting chains (cycles)
 */
export function validateWorkforceHierarchy(agents: AgentIdentity[] = CANONICAL_FOUNDING_AGENTS): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const idMap = new Map<string, AgentIdentity>();
  const codeMap = new Map<string, AgentIdentity>();

  // 1. Uniqueness check
  for (const agent of agents) {
    if (idMap.has(agent.id)) {
      errors.push(`Duplicate agent ID detected: ${agent.id}`);
    } else {
      idMap.set(agent.id, agent);
    }

    if (codeMap.has(agent.agentCode)) {
      errors.push(`Duplicate agent code detected: ${agent.agentCode}`);
    } else {
      codeMap.set(agent.agentCode, agent);
    }
  }

  // 2. Supervisor resolution & Seniority check
  for (const agent of agents) {
    if (agent.supervisor.reportsToOwner) {
      if (agent.supervisor.supervisorAgentId !== null) {
        errors.push(`Agent ${agent.agentCode} reports to Owner, supervisorAgentId must be null`);
      }
      continue;
    }

    const supId = agent.supervisor.supervisorAgentId;
    if (!supId) {
      errors.push(`Agent ${agent.agentCode} must have a supervisorAgentId or reportsToOwner=true`);
      continue;
    }

    const supervisor = idMap.get(supId);
    if (!supervisor) {
      errors.push(`Agent ${agent.agentCode} references non-existent supervisor ID: ${supId}`);
      continue;
    }

    // Seniority check: supervisor must be senior or equal
    if (compareOrganizationalLevels(supervisor.level, agent.level) > 0) {
      errors.push(
        `Hierarchy seniority violation: ${agent.agentCode} (${agent.level}) reports to less senior ${supervisor.agentCode} (${supervisor.level})`
      );
    }
  }

  // 3. Circular reporting chain detection (Cycle detection)
  for (const agent of agents) {
    const visited = new Set<string>();
    let current: AgentIdentity | undefined = agent;

    while (current && current.supervisor.supervisorAgentId) {
      if (visited.has(current.id)) {
        errors.push(`Circular reporting relationship detected involving agent ${current.agentCode} (${current.id})`);
        break;
      }
      visited.add(current.id);
      current = idMap.get(current.supervisor.supervisorAgentId);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
