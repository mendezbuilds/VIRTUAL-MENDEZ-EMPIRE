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
  'OWNER',       // Ultimate authority & capital provider (Stephen Mendez)
  'EXECUTIVE',   // C-Suite (CEO, COO) - strategic coordination
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
 * Canonical Department Data Contract.
 * IMPORTANT: Department budgets are planning allocations, NOT automatic spending permissions.
 * Actual disbursements remain strictly subject to treasury controls, double-entry verification,
 * and Owner authorization thresholds.
 */
export const DepartmentSchema = z.object({
  id: DepartmentIdSchema,
  name: z.string().min(1).max(100),
  description: z.string().min(1),
  directorId: z.string().uuid().optional(),
  directorCode: z.string().optional(),
  // Indicative monthly planning allocations (NOT pre-authorized spending)
  budgetMonthlyAllocationUsd: z.number().nonnegative(),
  budgetMonthlyAllocationNgn: z.number().nonnegative().optional(),
  // Backward compatibility alias for Phase 1 / early Phase 2 tests
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
 * Treasury Spending Control Schema
 * Governs actual spending authorization, independent of planning budget allocations.
 */
export const TreasurySpendingControlSchema = z.object({
  departmentId: DepartmentIdSchema,
  allocationCeilingUsd: z.number().nonnegative(),
  singleTransactionLimitUsd: z.number().nonnegative(),
  requiresOwnerAuthorizationThresholdUsd: z.number().nonnegative(),
  authorizedSignerLevels: z.array(OrganizationalLevelSchema).default(['DIRECTOR', 'EXECUTIVE', 'OWNER']),
  disbursementRequiresDoubleEntryPosting: z.boolean().default(true),
});

export type TreasurySpendingControl = z.infer<typeof TreasurySpendingControlSchema>;

/**
 * Canonical Treasury Spending Controls for all 9 departments
 */
export const CANONICAL_TREASURY_CONTROLS: TreasurySpendingControl[] = [
  {
    departmentId: 'executive_office',
    allocationCeilingUsd: 10000,
    singleTransactionLimitUsd: 2500,
    requiresOwnerAuthorizationThresholdUsd: 5000,
    authorizedSignerLevels: ['EXECUTIVE', 'OWNER'],
    disbursementRequiresDoubleEntryPosting: true,
  },
  {
    departmentId: 'financial_intelligence',
    allocationCeilingUsd: 50000,
    singleTransactionLimitUsd: 10000,
    requiresOwnerAuthorizationThresholdUsd: 20000,
    authorizedSignerLevels: ['DIRECTOR', 'EXECUTIVE', 'OWNER'],
    disbursementRequiresDoubleEntryPosting: true,
  },
  {
    departmentId: 'technology_engineering',
    allocationCeilingUsd: 25000,
    singleTransactionLimitUsd: 5000,
    requiresOwnerAuthorizationThresholdUsd: 10000,
    authorizedSignerLevels: ['DIRECTOR', 'EXECUTIVE', 'OWNER'],
    disbursementRequiresDoubleEntryPosting: true,
  },
  {
    departmentId: 'business_development',
    allocationCeilingUsd: 15000,
    singleTransactionLimitUsd: 3000,
    requiresOwnerAuthorizationThresholdUsd: 5000,
    authorizedSignerLevels: ['DIRECTOR', 'EXECUTIVE', 'OWNER'],
    disbursementRequiresDoubleEntryPosting: true,
  },
  {
    departmentId: 'marketing_growth',
    allocationCeilingUsd: 12000,
    singleTransactionLimitUsd: 2500,
    requiresOwnerAuthorizationThresholdUsd: 5000,
    authorizedSignerLevels: ['DIRECTOR', 'EXECUTIVE', 'OWNER'],
    disbursementRequiresDoubleEntryPosting: true,
  },
  {
    departmentId: 'operations_administration',
    allocationCeilingUsd: 8000,
    singleTransactionLimitUsd: 2000,
    requiresOwnerAuthorizationThresholdUsd: 4000,
    authorizedSignerLevels: ['DIRECTOR', 'EXECUTIVE', 'OWNER'],
    disbursementRequiresDoubleEntryPosting: true,
  },
  {
    departmentId: 'opportunity_acquisition',
    allocationCeilingUsd: 10000,
    singleTransactionLimitUsd: 2000,
    requiresOwnerAuthorizationThresholdUsd: 5000,
    authorizedSignerLevels: ['DIRECTOR', 'EXECUTIVE', 'OWNER'],
    disbursementRequiresDoubleEntryPosting: true,
  },
  {
    departmentId: 'research_intelligence',
    allocationCeilingUsd: 7000,
    singleTransactionLimitUsd: 1500,
    requiresOwnerAuthorizationThresholdUsd: 3000,
    authorizedSignerLevels: ['DIRECTOR', 'EXECUTIVE', 'OWNER'],
    disbursementRequiresDoubleEntryPosting: true,
  },
  {
    departmentId: 'security_governance',
    allocationCeilingUsd: 15000,
    singleTransactionLimitUsd: 5000,
    requiresOwnerAuthorizationThresholdUsd: 10000,
    authorizedSignerLevels: ['DIRECTOR', 'EXECUTIVE', 'OWNER'],
    disbursementRequiresDoubleEntryPosting: true,
  },
];

/**
 * Evaluates whether a requested expenditure is authorized or requires Owner sign-off.
 * Department planning allocations NEVER constitute automatic spending permissions.
 */
export function verifyDepartmentSpendingAuthorization(params: {
  departmentId: DepartmentId;
  amountUsd: number;
  approverLevel: OrganizationalLevel;
  isOwnerApproved?: boolean;
}): { authorized: boolean; reason?: string; requiresOwnerAuthorization: boolean } {
  const control = CANONICAL_TREASURY_CONTROLS.find((c) => c.departmentId === params.departmentId);
  if (!control) {
    return {
      authorized: false,
      reason: `No treasury spending control found for department ${params.departmentId}`,
      requiresOwnerAuthorization: true,
    };
  }

  // 1. Check if exceeding mandatory Owner threshold
  if (params.amountUsd > control.requiresOwnerAuthorizationThresholdUsd && !params.isOwnerApproved) {
    return {
      authorized: false,
      reason: `Expenditure of $${params.amountUsd} exceeds Owner authorization threshold of $${control.requiresOwnerAuthorizationThresholdUsd}`,
      requiresOwnerAuthorization: true,
    };
  }

  // 2. Check if exceeding monthly allocation ceiling
  if (params.amountUsd > control.allocationCeilingUsd && !params.isOwnerApproved) {
    return {
      authorized: false,
      reason: `Expenditure of $${params.amountUsd} exceeds department monthly allocation ceiling of $${control.allocationCeilingUsd}`,
      requiresOwnerAuthorization: true,
    };
  }

  // 3. Check approver seniority for single transaction limits
  if (params.amountUsd > control.singleTransactionLimitUsd && !params.isOwnerApproved) {
    if (!['DIRECTOR', 'EXECUTIVE', 'OWNER'].includes(params.approverLevel)) {
      return {
        authorized: false,
        reason: `Expenditure of $${params.amountUsd} exceeds single transaction limit ($${control.singleTransactionLimitUsd}) for level ${params.approverLevel}`,
        requiresOwnerAuthorization: false,
      };
    }
  }

  // 4. Verify approver has signing level
  if (!control.authorizedSignerLevels.includes(params.approverLevel) && !params.isOwnerApproved) {
    return {
      authorized: false,
      reason: `Level ${params.approverLevel} is not an authorized signer for department ${params.departmentId}`,
      requiresOwnerAuthorization: false,
    };
  }

  return {
    authorized: true,
    requiresOwnerAuthorization: false,
  };
}

/**
 * Reporting Relationship between AI Agents
 */
export const ReportingRelationshipSchema = z.object({
  agentId: z.string().uuid(),
  agentCode: z.string(),
  supervisorType: z.enum(['AGENT', 'OWNER_PRINCIPAL']).optional(),
  supervisorAgentId: z.string().uuid().nullable(),
  ownerPrincipalId: z.string().uuid().optional(),
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
  treasuryControls: z.array(TreasurySpendingControlSchema).default(CANONICAL_TREASURY_CONTROLS),
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
    budgetMonthlyAllocationUsd: 10000,
    budgetMonthlyAllocationNgn: 15000000,
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
    parentDepartmentId: 'executive_office',
    budgetMonthlyAllocationUsd: 50000,
    budgetMonthlyAllocationNgn: 75000000,
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
    parentDepartmentId: 'executive_office',
    budgetMonthlyAllocationUsd: 25000,
    budgetMonthlyAllocationNgn: 37500000,
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
    parentDepartmentId: 'executive_office',
    budgetMonthlyAllocationUsd: 15000,
    budgetMonthlyAllocationNgn: 22500000,
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
    parentDepartmentId: 'executive_office',
    budgetMonthlyAllocationUsd: 12000,
    budgetMonthlyAllocationNgn: 18000000,
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
    parentDepartmentId: 'executive_office',
    budgetMonthlyAllocationUsd: 8000,
    budgetMonthlyAllocationNgn: 12000000,
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
    parentDepartmentId: 'executive_office',
    budgetMonthlyAllocationUsd: 10000,
    budgetMonthlyAllocationNgn: 15000000,
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
    parentDepartmentId: 'executive_office',
    budgetMonthlyAllocationUsd: 7000,
    budgetMonthlyAllocationNgn: 10500000,
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
    parentDepartmentId: 'executive_office',
    budgetMonthlyAllocationUsd: 15000,
    budgetMonthlyAllocationNgn: 22500000,
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
