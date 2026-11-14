import { z } from 'zod';

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

export const RoleTierSchema = z.enum([
  'executive',
  'director',
  'manager',
  'specialist',
  'operator',
]);

export type RoleTier = z.infer<typeof RoleTierSchema>;

export const DepartmentSchema = z.object({
  id: DepartmentIdSchema,
  name: z.string(),
  description: z.string(),
  directorId: z.string().uuid().optional(),
  budgetMonthlyUsd: z.number().nonnegative(),
  allowedCapabilities: z.array(z.string()),
  parentDepartmentId: DepartmentIdSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Department = z.infer<typeof DepartmentSchema>;

export const EmployeeRoleSchema = z.object({
  id: z.string().uuid(),
  departmentId: DepartmentIdSchema,
  roleName: z.string(),
  tier: RoleTierSchema,
  reportsToRoleId: z.string().uuid().optional(),
  permissions: z.array(z.string()),
  maxDelegationDepth: z.number().int().min(0).max(5),
  maxBudgetApprovalUsd: z.number().nonnegative().default(0),
});

export type EmployeeRole = z.infer<typeof EmployeeRoleSchema>;

