import { z } from 'zod';

/**
 * The 9 Canonical Corporate Departments of Virtual MENDEZ EMPIRE
 */
export const DepartmentIdSchema = z.enum([
  'executive_office',
  'financial_intelligence',
  'technology_engineering',
  'business_development',
  'marketing_growth',
  'operations_administration',
  'opportunity_acquisition',
  'research_intelligence',
  'security_governance',
]);

export type DepartmentId = z.infer<typeof DepartmentIdSchema>;

/**
 * Organizational Hierarchy Levels with explicit seniority ordering.
 * Lower numeric rank indicates higher corporate seniority.
 */
export const OrganizationalLevelSchema = z.enum([
  'OWNER',       // Ultimate authority & capital provider
  'EXECUTIVE',   // C-Suite (CEO, COO)
  'DIRECTOR',    // Department Heads / Directors
  'MANAGER',     // Tactical Managers / Leads
  'SPECIALIST',  // Functional Execution Specialists
  'OPERATOR',    // Automated Task Operators
]);

export type OrganizationalLevel = z.infer<typeof OrganizationalLevelSchema>;

export const ORGANIZATIONAL_LEVEL_RANKS: Record<OrganizationalLevel, number> = {
  OWNER: 0,
  EXECUTIVE: 1,
  DIRECTOR: 2,
  MANAGER: 3,
  SPECIALIST: 4,
  OPERATOR: 5,
};

/**
 * Compares two organizational levels.
 * Returns negative if levelA is more senior, positive if levelB is more senior, 0 if equal.
 */
export function compareOrganizationalLevels(a: OrganizationalLevel, b: OrganizationalLevel): number {
  return ORGANIZATIONAL_LEVEL_RANKS[a] - ORGANIZATIONAL_LEVEL_RANKS[b];
}

/**
 * Returns true if levelA has senior or equal authority compared to levelB.
 */
export function isLevelSeniorOrEqual(levelA: OrganizationalLevel, levelB: OrganizationalLevel): boolean {
  return ORGANIZATIONAL_LEVEL_RANKS[levelA] <= ORGANIZATIONAL_LEVEL_RANKS[levelB];
}

/**
 * Department Leadership Specification
 */
export const DepartmentLeadershipSchema = z.object({
  directorAgentId: z.string().uuid(),
  directorAgentCode: z.string(),
  directorTitle: z.string(),
  appointedAt: z.string().datetime(),
});

export type DepartmentLeadership = z.infer<typeof DepartmentLeadershipSchema>;

/**
 * Canonical Department Data Contract
 */
export const DepartmentSchema = z.object({
  id: DepartmentIdSchema,
  name: z.string().min(1).max(100),
  description: z.string().min(1),
  directorId: z.string().uuid().optional(),
  directorCode: z.string().optional(),
  budgetMonthlyUsd: z.number().nonnegative(),
  budgetMonthlyNgn: z.number().nonnegative().optional(),
  allowedCapabilities: z.array(z.string().min(1)),
  parentDepartmentId: DepartmentIdSchema.optional(),
  isActive: z.boolean().default(true),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Department = z.infer<typeof DepartmentSchema>;

/**
 * Reporting Relationship between AI Agents
 */
export const ReportingRelationshipSchema = z.object({
  agentId: z.string().uuid(),
  agentCode: z.string(),
  supervisorAgentId: z.string().uuid().nullable(),
  reportsToOwner: z.boolean().default(false),
  departmentId: DepartmentIdSchema,
  level: OrganizationalLevelSchema,
  directReportAgentIds: z.array(z.string().uuid()).default([]),
});

export type ReportingRelationship = z.infer<typeof ReportingRelationshipSchema>;

/**
 * Full Organizational Hierarchy Structure
 */
export const OrganizationalHierarchySchema = z.object({
  version: z.string().default('1.0.0'),
  departments: z.array(DepartmentSchema),
  reportingRelationships: z.array(ReportingRelationshipSchema),
  lastAuditTimestamp: z.string().datetime(),
});

export type OrganizationalHierarchy = z.infer<typeof OrganizationalHierarchySchema>;

/**
 * Canonical 9 Corporate Departments Definition for Virtual MENDEZ EMPIRE
 */
export const CANONICAL_DEPARTMENTS: Department[] = [
  {
    id: 'executive_office',
    name: 'Executive Office',
    description: 'Autonomous corporate governance, strategy formulation, Owner reporting, and department direction',
    directorId: '00000000-0000-0000-0000-000000000001',
    directorCode: 'EXEC-CEO',
    budgetMonthlyUsd: 10000,
    budgetMonthlyNgn: 15000000,
    allowedCapabilities: [
      'strategic_planning',
      'executive_reporting',
      'budget_allocation',
      'cross_dept_governance',
      'objective_decomposition',
    ],
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'financial_intelligence',
    name: 'Financial Intelligence',
    description: 'Treasury operations, immutable double-entry accounting, FX & Crypto market intelligence and paper trading',
    directorId: '00000000-0000-0000-0000-000000000003',
    directorCode: 'FIN-CFO',
    budgetMonthlyUsd: 50000,
    budgetMonthlyNgn: 75000000,
    allowedCapabilities: [
      'ledger_accounting',
      'treasury_management',
      'fx_paper_trading',
      'crypto_paper_trading',
      'risk_auditing',
      'verify_hash_chain',
    ],
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'technology_engineering',
    name: 'Technology & Engineering',
    description: 'Architecture, software engineering, continuous delivery, agent tooling and platform reliability',
    directorId: '00000000-0000-0000-0000-000000000007',
    directorCode: 'TECH-CTO',
    budgetMonthlyUsd: 25000,
    budgetMonthlyNgn: 37500000,
    allowedCapabilities: [
      'software_architecture',
      'code_generation',
      'ci_cd_automation',
      'platform_security',
      'automated_testing',
      'infrastructure_management',
    ],
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'business_development',
    name: 'Business Development',
    description: 'Enterprise contract sourcing, B2B deal negotiation, partnerships, and subsidiary incubation',
    directorId: '00000000-0000-0000-0000-000000000010',
    directorCode: 'BIZ-DIR',
    budgetMonthlyUsd: 15000,
    budgetMonthlyNgn: 22500000,
    allowedCapabilities: [
      'deal_sourcing',
      'b2b_negotiation',
      'partnership_development',
      'contract_drafting',
      'rfp_analysis',
    ],
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'marketing_growth',
    name: 'Marketing & Growth',
    description: 'Audience acquisition, brand consistency, social distribution, and multi-channel marketing campaigns',
    directorId: '00000000-0000-0000-0000-000000000012',
    directorCode: 'MKT-DIR',
    budgetMonthlyUsd: 12000,
    budgetMonthlyNgn: 18000000,
    allowedCapabilities: [
      'content_strategy',
      'social_distribution',
      'brand_monitoring',
      'campaign_management',
      'copywriting',
    ],
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'operations_administration',
    name: 'Operations & Administration',
    description: 'Process optimization, corporate compliance, workflow coordination, and resource scheduling',
    directorId: '00000000-0000-0000-0000-000000000014',
    directorCode: 'OPS-DIR',
    budgetMonthlyUsd: 8000,
    budgetMonthlyNgn: 12000000,
    allowedCapabilities: [
      'workflow_orchestration',
      'compliance_monitoring',
      'operational_audit',
      'process_automation',
      'sla_tracking',
    ],
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'opportunity_acquisition',
    name: 'Opportunity Acquisition',
    description: 'Dual-track acquisition engine: Track A (Owner jobs/contracts) & Track B (Empire B2B leads and bounties)',
    directorId: '00000000-0000-0000-0000-000000000016',
    directorCode: 'OPP-DIR',
    budgetMonthlyUsd: 10000,
    budgetMonthlyNgn: 15000000,
    allowedCapabilities: [
      'job_market_scraping',
      'outreach_drafting',
      'lead_generation',
      'bounty_hunting',
      'application_preparation',
    ],
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'research_intelligence',
    name: 'Research & Intelligence',
    description: 'Deep market analysis, competitive intelligence, algorithmic tokenomics, and intelligence dossiers',
    directorId: '00000000-0000-0000-0000-000000000020',
    directorCode: 'RES-DIR',
    budgetMonthlyUsd: 7000,
    budgetMonthlyNgn: 10500000,
    allowedCapabilities: [
      'market_forecasting',
      'competitive_benchmarking',
      'sentiment_analysis',
      'dossier_compilation',
      'tokenomics_analysis',
    ],
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'security_governance',
    name: 'Security & Governance',
    description: 'Multi-tier circuit breakers, credential protection, RBAC/ABAC enforcement, and audit trail validation',
    directorId: '00000000-0000-0000-0000-000000000022',
    directorCode: 'SEC-CISO',
    budgetMonthlyUsd: 15000,
    budgetMonthlyNgn: 22500000,
    allowedCapabilities: [
      'circuit_breaker_control',
      'access_governance',
      'security_audit',
      'credential_isolation',
      'tamper_detection',
    ],
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];
