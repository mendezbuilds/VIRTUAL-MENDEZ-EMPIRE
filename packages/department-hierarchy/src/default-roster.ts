import {
  CANONICAL_DEPARTMENTS,
  CANONICAL_FOUNDING_AGENTS,
  toAgentSpec,
  createAgentRecord,
  type AgentRecord,
  type AgentSpec,
  type Department,
} from '@vme/shared-types';

/**
 * The 9 Canonical Corporate Departments of Virtual MENDEZ EMPIRE.
 * All 8 functional departments report to the apex executive_office.
 */
export const INITIAL_DEPARTMENTS: Department[] = CANONICAL_DEPARTMENTS;

/**
 * Phase 1 backward-compatible workforce representation as flat AgentSpec array.
 */
export const INITIAL_WORKFORCE: AgentSpec[] = CANONICAL_FOUNDING_AGENTS.map(toAgentSpec);

/**
 * Phase 2 native workforce representation as 30 full AgentRecord instances
 * with decoupled immutable identities, versioned configurations, and audit trails.
 */
export const INITIAL_AGENT_RECORDS: AgentRecord[] = CANONICAL_FOUNDING_AGENTS;

export { CANONICAL_DEPARTMENTS, CANONICAL_FOUNDING_AGENTS };

/**
 * Helper to produce deep clones of the canonical founding workforce records.
 */
export function cloneFoundingWorkforce(): AgentRecord[] {
  return CANONICAL_FOUNDING_AGENTS.map((agent) =>
    createAgentRecord(
      { ...agent.identity },
      {
        ...agent.currentConfig,
        supervisor: { ...agent.currentConfig.supervisor },
        assignedResponsibilities: [...agent.currentConfig.assignedResponsibilities],
        requiredCapabilities: [...agent.currentConfig.requiredCapabilities],
        permissionProfile: {
          ...agent.currentConfig.permissionProfile,
          allowedPermissions: [...agent.currentConfig.permissionProfile.allowedPermissions],
          prohibitedRestrictedActions: [...agent.currentConfig.permissionProfile.prohibitedRestrictedActions],
          requiresOwnerAuthorizationFor: [...agent.currentConfig.permissionProfile.requiresOwnerAuthorizationFor],
        },
        modelConfig: {
          ...agent.currentConfig.modelConfig,
          allowedTools: [...agent.currentConfig.modelConfig.allowedTools],
          toolConfigs: [...agent.currentConfig.modelConfig.toolConfigs],
        },
        departmentTransferHistory: [...agent.currentConfig.departmentTransferHistory],
      },
      agent.configHistory.map((h) => ({
        ...h,
        supervisor: { ...h.supervisor },
        assignedResponsibilities: [...h.assignedResponsibilities],
        requiredCapabilities: [...h.requiredCapabilities],
        permissionProfile: {
          ...h.permissionProfile,
          allowedPermissions: [...h.permissionProfile.allowedPermissions],
        },
        modelConfig: { ...h.modelConfig },
      }))
    )
  );
}

/**
 * Helper to produce deep clones of canonical corporate departments.
 */
export function cloneCanonicalDepartments(): Department[] {
  return CANONICAL_DEPARTMENTS.map((dept) => ({
    ...dept,
    allowedCapabilities: [...dept.allowedCapabilities],
  }));
}
