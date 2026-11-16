import {
  validateOrganizationalRegistry,
  type AgentRecord,
  type Department,
} from '@vme/shared-types';
import { UnauthorizedHierarchyActionError } from './delegation-rules.js';

export interface AuditReport {
  valid: boolean;
  errors: string[];
  auditedAt: string;
  departmentCount: number;
  workforceCount: number;
}

/**
 * Continuous Organizational Auditor
 * Verifies the 30-agent workforce cardinality, 9-department apex topology,
 * acyclic reporting hierarchy, credential safety, and transfer history continuity.
 */
export class OrganizationalAuditor {
  audit(
    departments: Department[],
    agents: AgentRecord[]
  ): AuditReport {
    const report: AuditReport = {
      valid: true,
      errors: [],
      auditedAt: new Date().toISOString(),
      departmentCount: departments.length,
      workforceCount: agents.length,
    };

    // 1. Delegate to M2.1 core registry validator:
    // - Exact 30 agents cardinality
    // - Exact 9 canonical departments
    // - CEO-only direct Owner reporting
    // - Separation of Owner principal from workforce
    // - Unique IDs and Codes
    // - Missing/Self/Seniority/Specialist-dept supervisor checks
    // - Cycle detection
    // - Raw credential inspection (cycle-safe)
    // - Department transfer history validation
    const m21Check = validateOrganizationalRegistry(agents, departments);
    if (!m21Check.valid) {
      report.valid = false;
      report.errors.push(...m21Check.errors);
    }

    // 2. Validate Two-Tier Apex Topology
    const execDept = departments.find((d) => d.id === 'executive_office');
    if (execDept && execDept.parentDepartmentId) {
      report.valid = false;
      report.errors.push(
        `Apex department 'executive_office' must not specify a parentDepartmentId, found '${execDept.parentDepartmentId}'`
      );
    }

    for (const dept of departments) {
      if (dept.id !== 'executive_office') {
        if (dept.parentDepartmentId !== 'executive_office') {
          report.valid = false;
          report.errors.push(
            `Functional department '${dept.id}' must have parentDepartmentId 'executive_office', found '${dept.parentDepartmentId ?? 'none'}'`
          );
        }
      }
    }

    return report;
  }

  assertHealthy(departments: Department[], agents: AgentRecord[]): void {
    const result = this.audit(departments, agents);
    if (!result.valid) {
      throw new UnauthorizedHierarchyActionError(
        `Organizational audit failed with ${result.errors.length} error(s):\n- ${result.errors.join('\n- ')}`
      );
    }
  }
}
