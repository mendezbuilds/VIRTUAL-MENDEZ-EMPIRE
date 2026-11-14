import { describe, it, expect } from 'vitest';
import {
  DepartmentRegistry,
  UnauthorizedHierarchyActionError,
} from './index.js';

describe('@vme/department-hierarchy Corporate Structure & Workforce', () => {
  const registry = new DepartmentRegistry();

  it('verifies all 9 corporate departments exist with allocated monthly budgets', () => {
    const depts = registry.listDepartments();
    expect(depts).toHaveLength(9);

    const deptIds = depts.map((d) => d.id);
    expect(deptIds).toContain('executive_office');
    expect(deptIds).toContain('financial_intelligence');
    expect(deptIds).toContain('technology_engineering');
    expect(deptIds).toContain('business_development');
    expect(deptIds).toContain('marketing_growth');
    expect(deptIds).toContain('operations_administration');
    expect(deptIds).toContain('opportunity_acquisition');
    expect(deptIds).toContain('research_intelligence');
    expect(deptIds).toContain('security_governance');

    // Verify all have budgets > 0
    for (const d of depts) {
      expect(d.budgetMonthlyUsd).toBeGreaterThan(0);
      expect(d.allowedCapabilities.length).toBeGreaterThan(0);
    }
  });

  it('verifies each department has an active Director or Executive assigned', () => {
    const depts = registry.listDepartments();
    for (const d of depts) {
      const director = registry.getDepartmentDirector(d.id);
      expect(director).toBeDefined();
      expect(['director', 'executive']).toContain(director?.tier);
    }
  });

  it('verifies the corporate workforce roster contains 22 specialized AI agents', () => {
    const agents = registry.getAllAgents();
    expect(agents).toHaveLength(22);
  });

  it('enforces corporate delegation rules across seniority and department boundaries', () => {
    const ceo = registry.getAllAgents().find((a) => a.name === 'CEO_AutonomousDirector')!;
    const cto = registry.getAllAgents().find((a) => a.name === 'ChiefTechnologyDirector')!;
    const engineer = registry.getAllAgents().find((a) => a.name === 'FullStackEngineerBot')!;
    const marketingSpecialist = registry.getAllAgents().find((a) => a.name === 'ContentStrategistBot')!;

    // 1. CEO -> CTO (Executive to Director) -> Allowed
    expect(registry.validateDelegation(ceo.id, cto.id).allowed).toBe(true);

    // 2. CTO -> Engineer (Director to Specialist in same department) -> Allowed
    expect(registry.validateDelegation(cto.id, engineer.id).allowed).toBe(true);

    // 3. Engineer -> CTO (Specialist delegating upward to Director) -> Rejected
    const upwardDelegation = registry.validateDelegation(engineer.id, cto.id);
    expect(upwardDelegation.allowed).toBe(false);
    expect(upwardDelegation.reason).toContain('cannot delegate to senior role');

    // 4. Marketing Specialist -> Technology Engineer (Cross-department specialist delegation) -> Rejected
    const crossDeptDelegation = registry.validateDelegation(marketingSpecialist.id, engineer.id);
    expect(crossDeptDelegation.allowed).toBe(false);
    expect(crossDeptDelegation.reason).toContain('requires Department Director authority');
  });

  it('enforces department capability boundaries', () => {
    const fxAnalyst = registry.getAllAgents().find((a) => a.name === 'FX_TradingAnalyst')!;
    const copywriter = registry.getAllAgents().find((a) => a.name === 'ContentStrategistBot')!;

    // Financial analyst is authorized for fx_paper_trading
    expect(() => registry.assertCapability(fxAnalyst.id, 'fx_paper_trading')).not.toThrow();

    // Copywriter in Marketing is NOT authorized for fx_paper_trading
    expect(() => registry.assertCapability(copywriter.id, 'fx_paper_trading')).toThrow(
      UnauthorizedHierarchyActionError
    );
  });
});
