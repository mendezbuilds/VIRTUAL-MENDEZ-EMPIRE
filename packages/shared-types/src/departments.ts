import { z } from 'zod';
import { DepartmentIdSchema } from './organization.js';

export {
  DepartmentIdSchema,
  type DepartmentId,
  DepartmentSchema,
  type Department,
  OrganizationalLevelSchema,
  type OrganizationalLevel,
  ORGANIZATIONAL_LEVEL_RANKS,
  CANONICAL_DEPARTMENTS,
} from './organization.js';

export const RoleTierSchema = z.enum([
  'executive',
  'director',
  'manager',
  'specialist',
  'operator',
]);

export type RoleTier = z.infer<typeof RoleTierSchema>;

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
