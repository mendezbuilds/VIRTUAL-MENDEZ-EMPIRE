import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import {
  DepartmentIdSchema,
  OrganizationalLevelSchema,
  compareOrganizationalLevels,
  CANONICAL_DEPARTMENTS,
  type Department,
  type DepartmentId,
  type OrganizationalLevel,
} from './organization.js';
import {
  PermissionProfileSchema,
  MANDATORY_PROHIBITED_FOR_ALL_AGENTS,
  assertNonOwnerProfileValid,
  OWNER_PRINCIPAL_ID,
  CANONICAL_OWNER_PRINCIPAL,
  isOwnerPrincipal,
  type PermissionProfile,
  type OwnerPrincipal,
} from './authority.js';
import type { AgentSpec } from './orchestration.js';

/**
 * Unique Agent Code Schema (e.g. EXEC-CEO, TECH-CTO, OPP-SCOUT, TECH-QA)
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
 * The CEO reports directly to the human Owner principal outside the 30-agent roster.
 */
export const AgentSupervisorSchema = z
  .object({
    supervisorType: z.enum(['AGENT', 'OWNER_PRINCIPAL']).optional(),
    supervisorAgentId: z.string().uuid().nullable(),
    supervisorAgentCode: z.string().optional(),
    ownerPrincipalId: z.string().uuid().optional(),
    reportsToOwner: z.boolean().default(false),
    escalationAgentId: z.string().uuid().optional(),
  })
  .strict();

export type AgentSupervisor = z.infer<typeof AgentSupervisorSchema>;

/**
 * Tool Configuration Reference Schema
 * Models tool capability references and environment/vault secret keys, NEVER raw credentials.
 */
export const ToolConfigReferenceSchema = z
  .object({
    toolName: z.string().min(1),
    enabled: z.boolean().default(true),
    credentialReference: z
      .string()
      .regex(/^[A-Z0-9_]{3,64}$|^secret:\/\/.+/, {
        message: "Tool credential reference must be an environment variable name (e.g. 'GITHUB_TOKEN_REF') or secret URI (e.g. 'secret://...'), never a raw credential",
      })
      .optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

export type ToolConfigReference = z.infer<typeof ToolConfigReferenceSchema>;

export const RAW_CREDENTIAL_PATTERN = /(sk-[a-zA-Z0-9_-]{20,}|sk-ant-[a-zA-Z0-9_-]{20,}|AIza[0-9A-Za-z-_]{35}|Bearer\s+[a-zA-Z0-9._-]{20,}|ghp_[a-zA-Z0-9]{36})/i;

export const DISALLOWED_CREDENTIAL_PROPERTY_NAMES = new Set([
  'apikey',
  'api_key',
  'apitoken',
  'api_token',
  'secretkey',
  'secret_key',
  'secret',
  'clientsecret',
  'client_secret',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'privatekey',
  'private_key',
  'password',
  'passphrase',
  'token',
  'authtoken',
  'auth_token',
  'authorization',
  'auth',
]);

/**
 * Validates that an arbitrary configuration object contains NO raw credentials, API keys,
 * bearer tokens, or forbidden credential property names.
 * Implements cycle-safe object traversal to prevent stack overflows on circular references.
 */
export function assertNoRawCredentials(
  data: unknown,
  path = 'config',
  seen = new WeakSet<object>()
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  function inspect(value: unknown, currentPath: string): void {
    if (!value) return;

    if (typeof value === 'string') {
      if (RAW_CREDENTIAL_PATTERN.test(value)) {
        errors.push(`Raw API key / token detected at '${currentPath}'. Store as environment or vault credential reference instead.`);
      }
    } else if (typeof value === 'object') {
      if (seen.has(value)) {
        return; // Cycle detected: safe termination
      }
      seen.add(value);

      if (Array.isArray(value)) {
        value.forEach((item, idx) => inspect(item, `${currentPath}[${idx}]`));
      } else {
        for (const [k, v] of Object.entries(value)) {
          const normalizedKey = k.toLowerCase().replace(/[^a-z0-9]/g, '');
          if (DISALLOWED_CREDENTIAL_PROPERTY_NAMES.has(normalizedKey)) {
            errors.push(
              `Disallowed credential property '${k}' found at '${currentPath}.${k}'. Raw credentials cannot be stored in agent configuration.`
            );
          }
          inspect(v, `${currentPath}.${k}`);
        }
      }
    }
  }

  inspect(data, path);
  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Agent Model & Tool Runtime Configuration
 * Models provider, tool references and environment credential names.
 * Strictly prohibits storage of raw API keys or access tokens.
 */
export const AgentModelConfigSchema = z
  .object({
    modelProvider: z.enum(['mock', 'anthropic', 'openai', 'gemini']).default('mock'),
    modelId: z.string().default('mock-llm-v1'),
    temperature: z.number().min(0).max(2).default(0.3),
    systemPrompt: z.string().min(1),
    allowedTools: z.array(z.string()).default([]),
    toolConfigs: z.array(ToolConfigReferenceSchema).default([]),
    credentialReference: z
      .string()
      .regex(/^[A-Z0-9_]{3,64}$|^secret:\/\/.+/, {
        message: "Credential reference must be an environment variable name (e.g. 'OPENAI_API_KEY') or secret URI, never a raw secret",
      })
      .optional(),
    maxParallelTasks: z.number().int().min(1).max(20).default(3),
    timeoutMs: z.number().int().positive().default(60000),
  })
  .strict()
  .refine(
    (cfg) => {
      const check = assertNoRawCredentials(cfg, 'AgentModelConfig');
      return check.valid;
    },
    {
      message: 'Raw API keys, access tokens, and bearer credentials are strictly barred from AgentModelConfig. Use credential references instead.',
    }
  );

export type AgentModelConfig = z.infer<typeof AgentModelConfigSchema>;

/**
 * Department Transfer Record Schema
 * Records the formal transfer of an employee between corporate departments,
 * preserving their immutable founding department origin while updating active assignment.
 */
export const DepartmentTransferRecordSchema = z
  .object({
    transferId: z.string().uuid(),
    fromDepartmentId: DepartmentIdSchema,
    toDepartmentId: DepartmentIdSchema,
    effectiveDate: z.string().datetime(),
    reason: z.string().min(1),
    authorizedBy: z.string().min(1), // e.g. Owner principal ID or CEO
    previousConfigVersion: z.string().regex(/^\d+\.\d+\.\d+$/, { message: 'Must be valid SemVer X.Y.Z' }),
    newConfigVersion: z.string().regex(/^\d+\.\d+\.\d+$/, { message: 'Must be valid SemVer X.Y.Z' }),
  })
  .strict();

export type DepartmentTransferRecord = z.infer<typeof DepartmentTransferRecordSchema>;

/**
 * PERMANENT IMMUTABLE AGENT IDENTITY
 * Represents an unchangeable identity anchor that survives title, supervisor,
 * responsibility, department transfer, and permission reconfigurations.
 * The founding departmentId / originDepartmentId remains permanently anchored here.
 */
export const AgentIdentitySchema = z
  .object({
    id: z.string().uuid(),
    agentCode: AgentCodeSchema,
    departmentId: DepartmentIdSchema, // Permanent founding origin department
    originDepartmentId: DepartmentIdSchema.optional(), // Explicit alias for clarity
    createdAt: z.string().datetime(),
  })
  .strict();

export type AgentIdentity = z.infer<typeof AgentIdentitySchema>;

/**
 * MUTABLE VERSIONED AGENT CONFIGURATION
 * Encapsulates all attributes that may evolve over an employee's lifecycle
 * (job title, supervisor, capabilities, permissions, operational status, version).
 */
export const AgentConfigurationSchema = z
  .object({
    configurationId: z.string().uuid(),
    agentId: z.string().uuid(),
    displayName: z.string().min(1).max(100),
    jobTitle: z.string().min(1).max(100),
    level: OrganizationalLevelSchema,
    roleDescription: z.string().min(1),
    assignedDepartmentId: DepartmentIdSchema.optional(), // Current active department assignment
    supervisor: AgentSupervisorSchema,
    assignedResponsibilities: z.array(z.string().min(1)).min(1),
    requiredCapabilities: z.array(z.string().min(1)).min(1),
    permissionProfile: PermissionProfileSchema,
    operationalStatus: AgentOperationalStatusSchema.default('ACTIVE'),
    modelConfig: AgentModelConfigSchema,
    departmentTransferHistory: z.array(DepartmentTransferRecordSchema).default([]),
    configVersion: z.string().regex(/^\d+\.\d+\.\d+$/).default('1.0.0'),
    effectiveFrom: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type AgentConfiguration = z.infer<typeof AgentConfigurationSchema>;

/**
 * COMPOSITE AGENT EMPLOYEE RECORD
 * Combines permanent immutable identity with current versioned mutable configuration.
 * Exposes flat convenience properties for seamless backward compatibility.
 */
export interface AgentRecord {
  // Immutable identity partition
  identity: AgentIdentity;
  // Current versioned configuration partition
  currentConfig: AgentConfiguration;
  // Historical snapshots of superseded configurations
  configHistory: AgentConfiguration[];

  // Flattened convenience accessors (backward compatible with AgentIdentity interface)
  id: string;
  agentCode: string;
  departmentId: DepartmentId; // Current active assigned department
  originDepartmentId: DepartmentId; // Permanent founding origin department
  createdAt: string;
  displayName: string;
  jobTitle: string;
  level: OrganizationalLevel;
  roleDescription: string;
  supervisor: AgentSupervisor;
  assignedResponsibilities: string[];
  requiredCapabilities: string[];
  permissionProfile: PermissionProfile;
  operationalStatus: AgentOperationalStatus;
  modelConfig: AgentModelConfig;
  configVersion: string;
  departmentTransferHistory: DepartmentTransferRecord[];
}

/**
 * Helper to construct a canonical AgentRecord from identity and configuration.
 */
export function createAgentRecord(
  identity: AgentIdentity,
  currentConfig: AgentConfiguration,
  configHistory: AgentConfiguration[] = []
): AgentRecord {
  // Validate that configuration references the correct immutable identity ID
  if (currentConfig.agentId !== identity.id) {
    throw new Error(
      `Configuration agentId mismatch: config references '${currentConfig.agentId}', but identity ID is '${identity.id}'`
    );
  }

  return {
    identity: { ...identity },
    currentConfig: { ...currentConfig },
    configHistory: [...configHistory],
    get id() { return this.identity.id; },
    get agentCode() { return this.identity.agentCode; },
    get originDepartmentId() { return this.identity.originDepartmentId ?? this.identity.departmentId; },
    get departmentId() { return this.currentConfig.assignedDepartmentId ?? this.identity.departmentId; },
    get createdAt() { return this.identity.createdAt; },
    get displayName() { return this.currentConfig.displayName; },
    get jobTitle() { return this.currentConfig.jobTitle; },
    get level() { return this.currentConfig.level; },
    get roleDescription() { return this.currentConfig.roleDescription; },
    get supervisor() { return this.currentConfig.supervisor; },
    get assignedResponsibilities() { return this.currentConfig.assignedResponsibilities; },
    get requiredCapabilities() { return this.currentConfig.requiredCapabilities; },
    get permissionProfile() { return this.currentConfig.permissionProfile; },
    get operationalStatus() { return this.currentConfig.operationalStatus; },
    get modelConfig() { return this.currentConfig.modelConfig; },
    get configVersion() { return this.currentConfig.configVersion; },
    get departmentTransferHistory() { return this.currentConfig.departmentTransferHistory ?? []; },
  };
}

/**
 * Updates mutable agent configuration without modifying permanent immutable identity.
 * Changing title, supervisor, responsibilities, or permissions strictly preserves
 * the permanent agent ID and agent code.
 */
export function updateAgentConfiguration(
  record: AgentRecord,
  updates: Partial<Omit<AgentConfiguration, 'configurationId' | 'agentId' | 'effectiveFrom' | 'updatedAt'>>,
  newVersion?: string
): AgentRecord {
  const updatedConfig: AgentConfiguration = {
    ...record.currentConfig,
    ...updates,
    configurationId: randomUUID(),
    agentId: record.identity.id, // Strictly preserve immutable ID
    configVersion: newVersion ?? incrementPatchVersion(record.currentConfig.configVersion),
    effectiveFrom: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  return createAgentRecord(record.identity, updatedConfig, [...record.configHistory, record.currentConfig]);
}

/**
 * Compares two SemVer strings (format X.Y.Z).
 * Returns positive if v1 > v2, negative if v1 < v2, 0 if equal.
 */
export function compareSemver(v1: string, v2: string): number {
  const parse = (v: string): [number, number, number] => {
    const parts = v.split('.').map((p) => parseInt(p, 10));
    if (
      parts.length !== 3 ||
      parts.some(isNaN) ||
      parts[0] === undefined ||
      parts[1] === undefined ||
      parts[2] === undefined
    ) {
      throw new Error(`Invalid SemVer format: '${v}' (expected X.Y.Z)`);
    }
    return [parts[0], parts[1], parts[2]];
  };

  const [maj1, min1, pat1] = parse(v1);
  const [maj2, min2, pat2] = parse(v2);

  if (maj1 !== maj2) return maj1 - maj2;
  if (min1 !== min2) return min1 - min2;
  return pat1 - pat2;
}

/**
 * Evaluates whether an authorizer identifier or code possesses authority to approve department transfers.
 * Only the human Owner (OWNER_PRINCIPAL_ID) or active Executive leadership (e.g. EXEC-CEO) can authorize transfers.
 */
export function isAuthorizedTransferAuthority(
  authorizerIdOrCode: string,
  agents: AgentRecord[] = CANONICAL_FOUNDING_AGENTS
): boolean {
  if (
    authorizerIdOrCode === OWNER_PRINCIPAL_ID ||
    authorizerIdOrCode === 'OWNER' ||
    authorizerIdOrCode === CANONICAL_OWNER_PRINCIPAL.principalId
  ) {
    return true;
  }
  const authorizer = agents.find((a) => a.id === authorizerIdOrCode || a.agentCode === authorizerIdOrCode);
  if (authorizer && authorizer.level === 'EXECUTIVE' && authorizer.operationalStatus === 'ACTIVE') {
    return true;
  }
  return false;
}

/**
 * Transfers an agent to a new corporate department.
 * Preserves the permanent immutable founding department origin in identity,
 * validates destination existence, verifies transfer authorization,
 * enforces monotonically increasing SemVer, and appends an immutable audit record to departmentTransferHistory.
 */
export function transferAgentDepartment(
  record: AgentRecord,
  params: {
    toDepartmentId: DepartmentId;
    reason: string;
    authorizedBy: string;
    effectiveDate?: string;
    newJobTitle?: string;
    newSupervisor?: AgentSupervisor;
    newVersion?: string;
    knownAgents?: AgentRecord[];
    knownDepartments?: Department[];
  }
): AgentRecord {
  const departments = params.knownDepartments ?? CANONICAL_DEPARTMENTS;
  const agents = params.knownAgents ?? CANONICAL_FOUNDING_AGENTS;

  // 1. Validate destination department exists
  if (!departments.some((d) => d.id === params.toDepartmentId)) {
    throw new Error(`Unknown destination department '${params.toDepartmentId}'`);
  }

  // 2. Reject transfer to same department
  const fromDepartmentId = record.departmentId;
  if (fromDepartmentId === params.toDepartmentId) {
    throw new Error(`Cannot transfer agent ${record.agentCode} to same department '${fromDepartmentId}'`);
  }

  // 3. Verify transfer authorization (Owner or Executive authority required)
  if (!isAuthorizedTransferAuthority(params.authorizedBy, agents)) {
    throw new Error(
      `Unauthorized department transfer: '${params.authorizedBy}' lacks executive or Owner transfer authorization authority`
    );
  }

  // 4. Validate or compute monotonically increasing configuration version
  let nextVersion: string;
  if (params.newVersion) {
    if (compareSemver(params.newVersion, record.currentConfig.configVersion) <= 0) {
      throw new Error(
        `Invalid version transition: new version '${params.newVersion}' must be strictly greater than current version '${record.currentConfig.configVersion}'`
      );
    }
    nextVersion = params.newVersion;
  } else {
    nextVersion = incrementMinorVersion(record.currentConfig.configVersion);
  }

  // 5. Construct transfer record
  const transferRecord: DepartmentTransferRecord = Object.freeze({
    transferId: randomUUID(),
    fromDepartmentId,
    toDepartmentId: params.toDepartmentId,
    effectiveDate: params.effectiveDate ?? new Date().toISOString(),
    reason: params.reason,
    authorizedBy: params.authorizedBy,
    previousConfigVersion: record.currentConfig.configVersion,
    newConfigVersion: nextVersion,
  });

  // 6. Deep clone and freeze existing transfer history to prevent retrospective modification
  const existingHistory = (record.currentConfig.departmentTransferHistory ?? []).map((t) => Object.freeze({ ...t }));
  const updatedTransferHistory = Object.freeze([...existingHistory, transferRecord]);

  const updatedConfig: AgentConfiguration = {
    ...record.currentConfig,
    jobTitle: params.newJobTitle ?? record.currentConfig.jobTitle,
    supervisor: params.newSupervisor ?? record.currentConfig.supervisor,
    assignedDepartmentId: params.toDepartmentId,
    departmentTransferHistory: updatedTransferHistory as DepartmentTransferRecord[],
    configurationId: randomUUID(),
    agentId: record.identity.id,
    configVersion: nextVersion,
    effectiveFrom: transferRecord.effectiveDate,
    updatedAt: new Date().toISOString(),
  };

  // 7. Retain immutable founding identity anchor: identity.departmentId is NEVER rewritten
  return createAgentRecord(record.identity, updatedConfig, [...record.configHistory, record.currentConfig]);
}

/**
 * Validates the full chain-of-custody and historical continuity of an agent's department transfers.
 */
export function validateDepartmentTransferHistory(
  agent: AgentRecord,
  departments: Department[] = CANONICAL_DEPARTMENTS
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const validDeptIds = new Set(departments.map((d) => d.id));
  const history = agent.departmentTransferHistory ?? [];

  if (history.length === 0) {
    if (agent.departmentId !== agent.originDepartmentId) {
      errors.push(
        `Department inconsistency for ${agent.agentCode}: agent has active department '${agent.departmentId}' different from origin '${agent.originDepartmentId}' without transfer history`
      );
    }
    return { valid: errors.length === 0, errors };
  }

  // First transfer must start from permanent founding department origin
  const first = history[0]!;
  if (first.fromDepartmentId !== agent.originDepartmentId) {
    errors.push(
      `Transfer history broken for ${agent.agentCode}: first transfer originates from '${first.fromDepartmentId}', expected founding origin '${agent.originDepartmentId}'`
    );
  }

  for (let i = 0; i < history.length; i++) {
    const cur = history[i]!;
    if (!validDeptIds.has(cur.fromDepartmentId)) {
      errors.push(`Transfer history record ${i} on ${agent.agentCode} has invalid fromDepartmentId: '${cur.fromDepartmentId}'`);
    }
    if (!validDeptIds.has(cur.toDepartmentId)) {
      errors.push(`Transfer history record ${i} on ${agent.agentCode} has invalid toDepartmentId: '${cur.toDepartmentId}'`);
    }
    if (cur.fromDepartmentId === cur.toDepartmentId) {
      errors.push(`Transfer history record ${i} on ${agent.agentCode} has identical from/to department: '${cur.fromDepartmentId}'`);
    }

    // Monotonic versioning check within record
    try {
      if (compareSemver(cur.newConfigVersion, cur.previousConfigVersion) <= 0) {
        errors.push(
          `Transfer history record ${i} on ${agent.agentCode} has non-increasing version: '${cur.previousConfigVersion}' -> '${cur.newConfigVersion}'`
        );
      }
    } catch (e: any) {
      errors.push(`Transfer history record ${i} on ${agent.agentCode} has invalid version string: ${e.message}`);
    }

    if (i > 0) {
      const prev = history[i - 1]!;
      // Continuity: current fromDepartmentId must equal previous toDepartmentId
      if (cur.fromDepartmentId !== prev.toDepartmentId) {
        errors.push(
          `Transfer history discontinuity on ${agent.agentCode}: record ${i} fromDepartmentId '${cur.fromDepartmentId}' does not match previous toDepartmentId '${prev.toDepartmentId}'`
        );
      }
      // Version continuity: current previousConfigVersion must equal or exceed previous newConfigVersion
      try {
        if (compareSemver(cur.previousConfigVersion, prev.newConfigVersion) < 0) {
          errors.push(
            `Transfer history version mismatch on ${agent.agentCode}: record ${i} previous version '${cur.previousConfigVersion}' is older than previous transfer result '${prev.newConfigVersion}'`
          );
        }
      } catch (e: any) {
        errors.push(`Transfer history version error on ${agent.agentCode}: ${e.message}`);
      }
      // Monotonic timestamps
      if (new Date(cur.effectiveDate).getTime() < new Date(prev.effectiveDate).getTime()) {
        errors.push(
          `Transfer history timestamp regression on ${agent.agentCode}: record ${i} (${cur.effectiveDate}) precedes previous transfer (${prev.effectiveDate})`
        );
      }
    }
  }

  // Final agreement: active department MUST match last transfer's toDepartmentId
  const last = history[history.length - 1]!;
  if (agent.departmentId !== last.toDepartmentId) {
    errors.push(
      `Department disagreement for ${agent.agentCode}: active department '${agent.departmentId}' does not match final transfer target '${last.toDepartmentId}'`
    );
  }

  return { valid: errors.length === 0, errors };
}

function incrementMinorVersion(version: string): string {
  const parts = version.split('.').map((p) => parseInt(p, 10));
  if (parts.length === 3 && parts[0] !== undefined && parts[1] !== undefined && !parts.some(isNaN)) {
    return `${parts[0]}.${parts[1] + 1}.0`;
  }
  return `${version}.1`;
}

function incrementPatchVersion(version: string): string {
  const parts = version.split('.').map((p) => parseInt(p, 10));
  if (parts.length === 3 && parts[0] !== undefined && parts[1] !== undefined && parts[2] !== undefined && !parts.some(isNaN)) {
    return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
  }
  return `${version}.1`;
}

/**
 * Maps an AgentRecord / AgentIdentity to an AgentSpec for Phase 1 backward compatibility.
 */
export function toAgentSpec(agent: AgentRecord): AgentSpec {
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
    updatedAt: agent.currentConfig.updatedAt,
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
    prohibitedRestrictedActions: MANDATORY_PROHIBITED_FOR_ALL_AGENTS,
    requiresOwnerAuthorizationFor: [
      'EXTERNAL_COMMUNICATION',
      'JOB_APPLICATION_SUBMISSION',
      'SPENDING_EXCEEDING_LIMIT',
      'EMERGENCY_SHUTDOWN_OVERRIDE',
    ],
    canAuthorizeSubordinates,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function createFoundingAgent(
  id: string,
  agentCode: string,
  departmentId: DepartmentId,
  displayName: string,
  jobTitle: string,
  level: OrganizationalLevel,
  roleDescription: string,
  supervisor: AgentSupervisor,
  assignedResponsibilities: string[],
  requiredCapabilities: string[],
  permissionProfile: PermissionProfile,
  systemPrompt: string,
  allowedTools: string[],
  maxParallelTasks = 3
): AgentRecord {
  const identity: AgentIdentity = {
    id,
    agentCode,
    departmentId,
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  const currentConfig: AgentConfiguration = {
    configurationId: `20000000-0000-0000-0000-${agentCode.replace(/[^0-9]/g, '').padStart(12, '0')}`,
    agentId: id,
    displayName,
    jobTitle,
    level,
    roleDescription,
    supervisor: {
      supervisorType: supervisor.supervisorType ?? (supervisor.reportsToOwner ? 'OWNER_PRINCIPAL' : 'AGENT'),
      ...supervisor,
    },
    assignedResponsibilities,
    requiredCapabilities,
    permissionProfile,
    operationalStatus: 'ACTIVE',
    modelConfig: {
      modelProvider: 'mock',
      modelId: 'mock-llm-v1',
      temperature: level === 'DIRECTOR' || level === 'EXECUTIVE' ? 0.2 : 0.3,
      systemPrompt,
      allowedTools,
      toolConfigs: [],
      maxParallelTasks,
      timeoutMs: 60000,
    },
    departmentTransferHistory: [],
    configVersion: '1.0.0',
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  return createAgentRecord(identity, currentConfig, []);
}

/**
 * CANONICAL 30 FOUNDING AI EMPLOYEE IDENTITIES
 * With complete separation of immutable permanent identity and versioned mutable configuration.
 * All executive permissions are explicitly non-escalating and subordinate to Owner authority.
 */
export const CANONICAL_FOUNDING_AGENTS: AgentRecord[] = [
  // =========================================================================
  // 1. Executive Office (2 agents)
  // =========================================================================
  createFoundingAgent(
    '00000000-0000-0000-0000-000000000001',
    'EXEC-CEO',
    'executive_office',
    'CEO_AutonomousDirector',
    'Chief Executive Officer & Autonomous Director',
    'EXECUTIVE',
    'Translates Owner directives into corporate strategy, coordinates all 9 departments, and compiles executive board reports. Subordinate to Owner authority.',
    {
      supervisorType: 'OWNER_PRINCIPAL',
      supervisorAgentId: null,
      supervisorAgentCode: undefined,
      ownerPrincipalId: OWNER_PRINCIPAL_ID,
      reportsToOwner: true,
    },
    [
      'Translate Owner directives into actionable initiatives',
      'Coordinate and oversee all department directors',
      'Compile weekly executive board reports',
      'Recommend departmental monthly operational budget allocations',
    ],
    [
      'strategic_planning',
      'executive_reporting',
      'budget_allocation',
      'cross_dept_governance',
      'objective_decomposition',
    ],
    buildPermissionProfile(
      '001',
      'Executive CEO Profile',
      'EXECUTIVE_WIDE',
      [
        'strategic:plan',
        'strategic:decompose',
        'executive:report',
        'executive:coordinate',
        'dept:supervise',
        'task:assign',
        'task:delegate',
        'budget:recommend',
        'kpi:review',
      ],
      10000,
      5,
      true
    ),
    'You are the CEO and Autonomous Director of Virtual Mendez Empire. You translate Owner directives into corporate strategy and hold all department directors accountable. You remain subordinate to Owner authority; capital transfers, live trading, and binding contracts are barred.',
    ['decompose_objective', 'delegate_task', 'approve_budget', 'compile_board_report'],
    10
  ),
  createFoundingAgent(
    '00000000-0000-0000-0000-000000000002',
    'EXEC-COO',
    'executive_office',
    'ChiefOperatingOfficer',
    'Chief Operating Officer',
    'EXECUTIVE',
    'Oversees operational execution across departments, resolves cross-department bottlenecks, and monitors SLAs.',
    {
      supervisorAgentId: '00000000-0000-0000-0000-000000000001',
      supervisorAgentCode: 'EXEC-CEO',
      reportsToOwner: false,
      escalationAgentId: '00000000-0000-0000-0000-000000000001',
    },
    [
      'Monitor company-wide execution health and SLAs',
      'Triage and resolve cross-department operational blockers',
      'Supervise Operations & Administration department head',
      'Coordinate resource scheduling and load balancing',
    ],
    [
      'inspect_operations',
      'reassign_task',
      'escalate_incident',
      'cross_dept_governance',
      'workflow_orchestration',
    ],
    buildPermissionProfile(
      '002',
      'Executive COO Profile',
      'EXECUTIVE_WIDE',
      ['ops:inspect', 'ops:reassign', 'task:reassign', 'task:escalate', 'report:compile'],
      5000,
      4,
      true
    ),
    'You are the COO of Virtual Mendez Empire. You oversee interdepartmental execution, resolve operational bottlenecks, and monitor company-wide SLAs.',
    ['inspect_operations', 'reassign_task', 'escalate_incident'],
    8
  ),

  // =========================================================================
  // 2. Financial Intelligence (4 agents)
  // =========================================================================
  createFoundingAgent(
    '00000000-0000-0000-0000-000000000003',
    'FIN-CFO',
    'financial_intelligence',
    'ChiefFinancialDirector',
    'Chief Financial Officer & Director of Financial Intelligence',
    'DIRECTOR',
    'Safeguards the central treasury, enforces double-entry immutability, manages dual-currency (USD/NGN) budget burn, and supervises financial analysts.',
    {
      supervisorAgentId: '00000000-0000-0000-0000-000000000001',
      supervisorAgentCode: 'EXEC-CEO',
      reportsToOwner: false,
    },
    [
      'Enforce zero-sum double-entry ledger immutability',
      'Authorize department spending requests within approved budget',
      'Supervise Treasury Accountant, FX Analyst, and Crypto Analyst',
      'Enforce strict ban on unauthorized live trading and capital transfer',
    ],
    [
      'approve_expenditure',
      'audit_ledger',
      'verify_hash_chain',
      'treasury_management',
      'ledger_accounting',
    ],
    buildPermissionProfile(
      '003',
      'Financial Intelligence Director Profile',
      'DEPARTMENT_SCOPED',
      ['financial:audit', 'financial:approve', 'ledger:audit', 'treasury:manage', 'task:delegate'],
      50000,
      3,
      true
    ),
    'You are the CFO and Director of Financial Intelligence. You safeguard the central treasury, enforce double-entry immutability, and manage financial risk.',
    ['approve_expenditure', 'audit_ledger', 'verify_hash_chain'],
    5
  ),
  createFoundingAgent(
    '00000000-0000-0000-0000-000000000004',
    'FIN-ACC',
    'financial_intelligence',
    'TreasuryAccountant',
    'Lead Treasury & Ledger Accountant',
    'SPECIALIST',
    'Prepares cryptographically chained double-entry journal postings in USD and NGN, and reconciles balances.',
    {
      supervisorAgentId: '00000000-0000-0000-0000-000000000003',
      supervisorAgentCode: 'FIN-CFO',
      reportsToOwner: false,
    },
    [
      'Post verified double-entry journal entries',
      'Verify cryptographic hash chains across journal records',
      'Reconcile multi-currency account balances (USD and NGN)',
    ],
    [
      'post_journal_entry',
      'reconcile_balances',
      'ledger_accounting',
      'verify_hash_chain',
    ],
    buildPermissionProfile(
      '004',
      'Treasury Accountant Specialist Profile',
      'SPECIALIST_LOCAL',
      ['ledger:post', 'ledger:read', 'account:reconcile'],
      0,
      0,
      false
    ),
    'You are the Treasury Accountant. You prepare double-entry journal postings in USD, NGN, and reserve currencies.',
    ['post_journal_entry', 'reconcile_balances'],
    3
  ),
  createFoundingAgent(
    '00000000-0000-0000-0000-000000000005',
    'FIN-FXA',
    'financial_intelligence',
    'FX_TradingAnalyst',
    'Foreign Exchange & Macro Paper Trading Analyst',
    'SPECIALIST',
    'Researches foreign exchange markets, backtests strategies, and executes simulated paper trades. Live trading is strictly prohibited.',
    {
      supervisorAgentId: '00000000-0000-0000-0000-000000000003',
      supervisorAgentCode: 'FIN-CFO',
      reportsToOwner: false,
    },
    [
      'Perform historical FX strategy backtests',
      'Execute simulated paper trades in sandbox environment',
      'Synthesize macro currency intelligence reports',
    ],
    [
      'backtest_fx',
      'paper_trade_fx',
      'analyze_forex_news',
      'risk_auditing',
    ],
    buildPermissionProfile(
      '005',
      'FX Analyst Specialist Profile',
      'SPECIALIST_LOCAL',
      ['fx:backtest', 'fx:paper_trade', 'market:read'],
      0,
      0,
      false
    ),
    'You are the FX Market Analyst. You backtest currency strategies and conduct simulated paper trading. Live trading is strictly prohibited.',
    ['backtest_fx', 'paper_trade_fx', 'analyze_forex_news'],
    3
  ),
  createFoundingAgent(
    '00000000-0000-0000-0000-000000000006',
    'FIN-CRY',
    'financial_intelligence',
    'CryptoDegenAnalyst',
    'Crypto & DeFi Risk Analyst',
    'SPECIALIST',
    'Researches on-chain liquidity, evaluates DeFi protocols, and executes paper trading of digital assets.',
    {
      supervisorAgentId: '00000000-0000-0000-0000-000000000003',
      supervisorAgentCode: 'FIN-CFO',
      reportsToOwner: false,
    },
    [
      'Analyze on-chain liquidity pools and smart contract risks',
      'Backtest algorithmic cryptocurrency strategies',
      'Execute simulated crypto paper trades with strict zero live capital',
    ],
    [
      'analyze_onchain_metrics',
      'paper_trade_crypto',
      'audit_smart_contract_risk',
      'crypto_paper_trading',
    ],
    buildPermissionProfile(
      '006',
      'Crypto Analyst Specialist Profile',
      'SPECIALIST_LOCAL',
      ['crypto:analyze', 'crypto:paper_trade', 'defi:audit'],
      0,
      0,
      false
    ),
    'You are the Crypto and DeFi Analyst. You research on-chain liquidity, tokenomics, and paper trade digital assets.',
    ['analyze_onchain_metrics', 'paper_trade_crypto', 'audit_smart_contract_risk'],
    3
  ),

  // =========================================================================
  // 3. Technology & Engineering (5 agents)
  // =========================================================================
  createFoundingAgent(
    '00000000-0000-0000-0000-000000000007',
    'TECH-CTO',
    'technology_engineering',
    'ChiefTechnologyDirector',
    'Chief Technology Officer & Director of Technology',
    'DIRECTOR',
    'Leads engineering strategy, software architecture, code reviews, automated CI/CD gates, and engineering hygiene.',
    {
      supervisorAgentId: '00000000-0000-0000-0000-000000000001',
      supervisorAgentCode: 'EXEC-CEO',
      reportsToOwner: false,
    },
    [
      'Review and approve system architectures and ADRs',
      'Enforce testing and verification gates across the codebase',
      'Direct software development, infrastructure, and QA specialists',
    ],
    [
      'review_architecture',
      'enforce_testing_gate',
      'approve_release',
      'software_architecture',
      'platform_security',
    ],
    buildPermissionProfile(
      '007',
      'Technology Director Profile',
      'DEPARTMENT_SCOPED',
      ['tech:review', 'tech:approve', 'code:review', 'repo:manage', 'task:delegate'],
      25000,
      3,
      true
    ),
    'You are the CTO and Director of Technology & Engineering. You enforce software architecture, test coverage, and modular code hygiene.',
    ['review_architecture', 'enforce_testing_gate', 'approve_release'],
    5
  ),
  createFoundingAgent(
    '00000000-0000-0000-0000-000000000008',
    'TECH-ARCH',
    'technology_engineering',
    'SoftwareArchitectBot',
    'Lead Software Architect',
    'SPECIALIST',
    'Designs domain schemas, data models, system interfaces, and authors Architectural Decision Records (ADRs).',
    {
      supervisorAgentId: '00000000-0000-0000-0000-000000000007',
      supervisorAgentCode: 'TECH-CTO',
      reportsToOwner: false,
    },
    [
      'Design modular, strongly-typed TypeScript and database schemas',
      'Draft Architectural Decision Records (ADRs)',
      'Analyze codebase consistency and eliminate circular dependencies',
    ],
    [
      'design_system',
      'write_adr',
      'generate_schemas',
      'software_architecture',
    ],
    buildPermissionProfile(
      '008',
      'Software Architect Specialist Profile',
      'SPECIALIST_LOCAL',
      ['code:read', 'code:design', 'doc:write'],
      0,
      0,
      false
    ),
    'You are the Lead Software Architect. You design data structures, API contracts, and scalable services.',
    ['design_system', 'write_adr', 'generate_schemas'],
    3
  ),
  createFoundingAgent(
    '00000000-0000-0000-0000-000000000009',
    'TECH-FSE',
    'technology_engineering',
    'FullStackEngineerBot',
    'Senior Full Stack Engineer',
    'SPECIALIST',
    'Implements production TypeScript services, API routes, database integrations, and comprehensive unit tests.',
    {
      supervisorAgentId: '00000000-0000-0000-0000-000000000007',
      supervisorAgentCode: 'TECH-CTO',
      reportsToOwner: false,
    },
    [
      'Implement robust backend and frontend software components',
      'Write exhaustive unit and integration tests with Vitest',
      'Refactor services for modularity and performance',
    ],
    [
      'implement_feature',
      'write_unit_tests',
      'refactor_code',
      'code_generation',
    ],
    buildPermissionProfile(
      '009',
      'Full Stack Engineer Specialist Profile',
      'SPECIALIST_LOCAL',
      ['code:read', 'code:write', 'test:run'],
      0,
      0,
      false
    ),
    'You are the Full Stack Engineer. You implement clean TypeScript services, API endpoints, and database interactions.',
    ['implement_feature', 'write_unit_tests', 'refactor_code'],
    4
  ),
  createFoundingAgent(
    '00000000-0000-0000-0000-000000000023',
    'TECH-DEVOPS',
    'technology_engineering',
    'DevOpsPlatformEngineerBot',
    'DevOps & Platform Reliability Engineer',
    'SPECIALIST',
    'Manages CI/CD automation pipelines, container infrastructure, system telemetry, and platform uptime.',
    {
      supervisorAgentId: '00000000-0000-0000-0000-000000000007',
      supervisorAgentCode: 'TECH-CTO',
      reportsToOwner: false,
    },
    [
      'Maintain automated build, lint, and test pipelines',
      'Configure Docker containers and PostgreSQL/Redis instances',
      'Monitor application metrics, error rates, and system logs',
    ],
    [
      'manage_infrastructure',
      'monitor_telemetry',
      'deploy_service',
      'ci_cd_automation',
    ],
    buildPermissionProfile(
      '023',
      'DevOps Platform Specialist Profile',
      'SPECIALIST_LOCAL',
      ['infra:manage', 'telemetry:read', 'ci:execute'],
      0,
      0,
      false
    ),
    'You are the DevOps & Platform Reliability Engineer. You ensure pipeline reliability, infrastructure stability, and deployment automation.',
    ['manage_infrastructure', 'monitor_telemetry', 'deploy_service'],
    3
  ),
  createFoundingAgent(
    '00000000-0000-0000-0000-000000000024',
    'TECH-QA',
    'technology_engineering',
    'QASystemsVerifierBot',
    'QA & Systems Verification Specialist',
    'SPECIALIST',
    'Executes automated end-to-end regression suites, verifies bug fixes, and enforces quality metrics across all packages.',
    {
      supervisorAgentId: '00000000-0000-0000-0000-000000000007',
      supervisorAgentCode: 'TECH-CTO',
      reportsToOwner: false,
    },
    [
      'Execute continuous verification test suites across all packages',
      'Verify schema constraints and boundary cases',
      'Audit test pass rates and report quality benchmarks to CTO',
    ],
    [
      'execute_test_suite',
      'verify_regressions',
      'report_quality_metrics',
      'ci_cd_automation',
    ],
    buildPermissionProfile(
      '024',
      'QA Systems Verifier Specialist Profile',
      'SPECIALIST_LOCAL',
      ['test:run', 'test:write', 'metrics:report'],
      0,
      0,
      false
    ),
    'You are the QA Systems Verification Specialist. You audit software quality, run regression suites, and guarantee zero defects.',
    ['execute_test_suite', 'verify_regressions', 'report_quality_metrics'],
    3
  ),

  // =========================================================================
  // 4. Business Development (3 agents)
  // =========================================================================
  createFoundingAgent(
    '00000000-0000-0000-0000-000000000010',
    'BIZ-DIR',
    'business_development',
    'BusinessDevDirector',
    'Director of Business Development',
    'DIRECTOR',
    'Drives enterprise B2B deal acquisition, strategic partnerships, commercial pipeline, and new venture revenue.',
    {
      supervisorAgentId: '00000000-0000-0000-0000-000000000001',
      supervisorAgentCode: 'EXEC-CEO',
      reportsToOwner: false,
    },
    [
      'Qualify B2B partnerships and commercial leads',
      'Approve commercial proposal structures and pricing models',
      'Manage sales and enterprise partnership pipelines',
    ],
    [
      'qualify_opportunity',
      'approve_deal_structure',
      'manage_pipeline',
      'deal_sourcing',
      'b2b_negotiation',
    ],
    buildPermissionProfile(
      '010',
      'Business Development Director Profile',
      'DEPARTMENT_SCOPED',
      ['biz:qualify', 'biz:approve_structure', 'pipeline:manage', 'task:delegate'],
      15000,
      3,
      true
    ),
    'You are the Director of Business Development. You drive enterprise client acquisition, strategic partnerships, and new venture revenue.',
    ['qualify_opportunity', 'approve_deal_structure', 'manage_pipeline'],
    5
  ),
  createFoundingAgent(
    '00000000-0000-0000-0000-000000000011',
    'BIZ-PART',
    'business_development',
    'PartnershipSourcingBot',
    'Strategic Partnership Sourcing Specialist',
    'SPECIALIST',
    'Identifies prospective enterprise partners, conducts synergy evaluations, and prepares partnership briefs.',
    {
      supervisorAgentId: '00000000-0000-0000-0000-000000000010',
      supervisorAgentCode: 'BIZ-DIR',
      reportsToOwner: false,
    },
    [
      'Research target technology platforms and consultancies',
      'Score strategic fit and potential partnership value',
      'Draft partnership memos and integration briefs',
    ],
    [
      'search_companies',
      'evaluate_fit',
      'draft_partnership_brief',
      'partnership_development',
    ],
    buildPermissionProfile(
      '011',
      'Partnership Sourcing Specialist Profile',
      'SPECIALIST_LOCAL',
      ['biz:research', 'partner:evaluate'],
      0,
      0,
      false
    ),
    'You are the Partnership Sourcing Specialist. You identify synergetic technology platforms and explore co-marketing or integration opportunities.',
    ['search_companies', 'evaluate_fit', 'draft_partnership_brief'],
    3
  ),
  createFoundingAgent(
    '00000000-0000-0000-0000-000000000025',
    'BIZ-PROP',
    'business_development',
    'B2BProposalSpecialistBot',
    'B2B Deal Structuring & Proposal Specialist',
    'SPECIALIST',
    'Analyzes client RFPs, structures commercial terms, estimates project budgets, and drafts statements of work.',
    {
      supervisorAgentId: '00000000-0000-0000-0000-000000000010',
      supervisorAgentCode: 'BIZ-DIR',
      reportsToOwner: false,
    },
    [
      'Deconstruct enterprise RFPs into deliverable scopes',
      'Prepare project pricing matrices and resource estimates',
      'Draft detailed Statements of Work (SOWs) for Director review',
    ],
    [
      'analyze_rfp',
      'structure_commercial_terms',
      'draft_sow',
      'contract_drafting',
    ],
    buildPermissionProfile(
      '025',
      'B2B Proposal Specialist Profile',
      'SPECIALIST_LOCAL',
      ['rfp:analyze', 'sow:draft', 'pricing:calculate'],
      0,
      0,
      false
    ),
    'You are the B2B Proposal Specialist. You analyze client RFPs, structure commercial terms, and draft statements of work.',
    ['analyze_rfp', 'structure_commercial_terms', 'draft_sow'],
    3
  ),

  // =========================================================================
  // 5. Marketing & Growth (3 agents)
  // =========================================================================
  createFoundingAgent(
    '00000000-0000-0000-0000-000000000012',
    'MKT-DIR',
    'marketing_growth',
    'MarketingDirector',
    'Director of Marketing & Growth',
    'DIRECTOR',
    'Directs brand positioning, marketing funnels, multi-channel distribution strategy, and content approval.',
    {
      supervisorAgentId: '00000000-0000-0000-0000-000000000001',
      supervisorAgentCode: 'EXEC-CEO',
      reportsToOwner: false,
    },
    [
      'Oversee brand voice and messaging consistency',
      'Approve marketing campaigns and distribution strategies',
      'Analyze growth conversion metrics and campaign ROI',
    ],
    [
      'approve_campaign',
      'review_copy',
      'analyze_metrics',
      'content_strategy',
      'campaign_management',
    ],
    buildPermissionProfile(
      '012',
      'Marketing Director Profile',
      'DEPARTMENT_SCOPED',
      ['marketing:approve', 'campaign:review', 'brand:govern', 'task:delegate'],
      12000,
      3,
      true
    ),
    'You are the Director of Marketing & Growth. You direct brand positioning, audience funnels, and corporate communications.',
    ['approve_campaign', 'review_copy', 'analyze_metrics'],
    5
  ),
  createFoundingAgent(
    '00000000-0000-0000-0000-000000000013',
    'MKT-CONT',
    'marketing_growth',
    'ContentStrategistBot',
    'Content Strategist & Copywriter',
    'SPECIALIST',
    'Drafts technical articles, thought leadership threads, educational posts, and SEO-optimized copy.',
    {
      supervisorAgentId: '00000000-0000-0000-0000-000000000012',
      supervisorAgentCode: 'MKT-DIR',
      reportsToOwner: false,
    },
    [
      'Draft in-depth technical blogs and research summaries',
      'Craft high-authority social media threads',
      'Perform keyword research and SEO content optimization',
    ],
    [
      'draft_article',
      'create_thread',
      'optimize_seo',
      'brand_monitoring',
    ],
    buildPermissionProfile(
      '013',
      'Content Strategist Specialist Profile',
      'SPECIALIST_LOCAL',
      ['content:draft', 'seo:optimize'],
      0,
      0,
      false
    ),
    'You are the Content Strategist. You draft high-authority articles, technical announcements, and social content.',
    ['draft_article', 'create_thread', 'optimize_seo'],
    3
  ),
  createFoundingAgent(
    '00000000-0000-0000-0000-000000000026',
    'MKT-SOC',
    'marketing_growth',
    'SocialMediaSpecialistBot',
    'Social Media & Omnichannel Distribution Specialist',
    'SPECIALIST',
    'Schedules and manages content distribution across channels, monitors brand mentions, and analyzes audience engagement.',
    {
      supervisorAgentId: '00000000-0000-0000-0000-000000000012',
      supervisorAgentCode: 'MKT-DIR',
      reportsToOwner: false,
    },
    [
      'Prepare distribution schedules for marketing content',
      'Track engagement analytics and audience growth across channels',
      'Monitor brand sentiment and social discussions',
    ],
    [
      'schedule_distribution',
      'track_engagement',
      'monitor_brand_sentiment',
      'social_distribution',
    ],
    buildPermissionProfile(
      '026',
      'Social Media Specialist Profile',
      'SPECIALIST_LOCAL',
      ['social:schedule', 'metrics:track'],
      0,
      0,
      false
    ),
    'You are the Social Media Specialist. You organize distribution schedules, analyze user engagement, and monitor brand sentiment.',
    ['schedule_distribution', 'track_engagement', 'monitor_brand_sentiment'],
    3
  ),

  // =========================================================================
  // 6. Operations & Administration (3 agents)
  // =========================================================================
  createFoundingAgent(
    '00000000-0000-0000-0000-000000000014',
    'OPS-DIR',
    'operations_administration',
    'OperationsDirector',
    'Director of Operations & Administration',
    'DIRECTOR',
    'Orchestrates corporate background automations, audits internal processes, coordinates task schedules, and enforces compliance.',
    {
      supervisorAgentId: '00000000-0000-0000-0000-000000000002', // Reports to COO
      supervisorAgentCode: 'EXEC-COO',
      reportsToOwner: false,
    },
    [
      'Oversee corporate workflow automation and scheduling',
      'Enforce operational compliance and audit routines',
      'Coordinate administrative resources and log retention policies',
    ],
    [
      'audit_process',
      'schedule_automation',
      'manage_resources',
      'workflow_orchestration',
      'compliance_monitoring',
    ],
    buildPermissionProfile(
      '014',
      'Operations Director Profile',
      'DEPARTMENT_SCOPED',
      ['ops:audit', 'cron:manage', 'compliance:enforce', 'task:delegate'],
      8000,
      3,
      true
    ),
    'You are the Director of Operations. You orchestrate corporate workflows, regulatory compliance, and scheduling.',
    ['audit_process', 'schedule_automation', 'manage_resources'],
    5
  ),
  createFoundingAgent(
    '00000000-0000-0000-0000-000000000015',
    'OPS-COORD',
    'operations_administration',
    'WorkflowCoordinator',
    'Workflow Orchestration & Scheduling Coordinator',
    'SPECIALIST',
    'Coordinates automated background tasks, schedules recurring crons, and tracks task execution SLAs.',
    {
      supervisorAgentId: '00000000-0000-0000-0000-000000000014',
      supervisorAgentCode: 'OPS-DIR',
      reportsToOwner: false,
    },
    [
      'Monitor scheduled background jobs and recurring automations',
      'Track task turnaround cycle times and SLA thresholds',
      'Archive audit logs and operational execution traces',
    ],
    [
      'track_sla',
      'trigger_cron',
      'archive_logs',
      'process_automation',
    ],
    buildPermissionProfile(
      '015',
      'Workflow Coordinator Specialist Profile',
      'SPECIALIST_LOCAL',
      ['cron:trigger', 'sla:track', 'log:archive'],
      0,
      0,
      false
    ),
    'You coordinate automated background tasks and monitor execution SLAs across departments.',
    ['track_sla', 'trigger_cron', 'archive_logs'],
    3
  ),
  createFoundingAgent(
    '00000000-0000-0000-0000-000000000027',
    'OPS-COMP',
    'operations_administration',
    'ComplianceAuditorBot',
    'Compliance & Operational Process Auditor',
    'SPECIALIST',
    'Audits business operations against statutory and empire governance rules, inspecting task logs and execution records.',
    {
      supervisorAgentId: '00000000-0000-0000-0000-000000000014',
      supervisorAgentCode: 'OPS-DIR',
      reportsToOwner: false,
    },
    [
      'Conduct regular audits of agent task executions against policies',
      'Verify that restricted actions strictly adhered to approval gates',
      'Flag operational non-compliance incidents to Operations Director',
    ],
    [
      'audit_compliance',
      'verify_process_standards',
      'inspect_audit_trail',
      'compliance_monitoring',
    ],
    buildPermissionProfile(
      '027',
      'Compliance Auditor Specialist Profile',
      'SPECIALIST_LOCAL',
      ['compliance:audit', 'log:inspect'],
      0,
      0,
      false
    ),
    'You are the Compliance Auditor. You audit corporate processes, verify policy adherence, and flag governance violations.',
    ['audit_compliance', 'verify_process_standards', 'inspect_audit_trail'],
    3
  ),

  // =========================================================================
  // 7. Opportunity Acquisition (4 agents)
  // =========================================================================
  createFoundingAgent(
    '00000000-0000-0000-0000-000000000016',
    'OPP-DIR',
    'opportunity_acquisition',
    'OpportunityDirector',
    'Director of Opportunity Acquisition',
    'DIRECTOR',
    'Directs dual-track acquisition engine: Track A (Owner high-paying remote roles) and Track B (Empire enterprise clients, bounties, grants).',
    {
      supervisorAgentId: '00000000-0000-0000-0000-000000000001',
      supervisorAgentCode: 'EXEC-CEO',
      reportsToOwner: false,
    },
    [
      'Oversee Track A (Owner opportunities) and Track B (Empire opportunities)',
      'Review lead quality and conversion effectiveness',
      'Approve outbound outreach campaigns before submitting to Owner gate',
    ],
    [
      'review_lead_quality',
      'approve_outreach_campaign',
      'monitor_conversion',
      'job_market_scraping',
      'lead_generation',
    ],
    buildPermissionProfile(
      '016',
      'Opportunity Acquisition Director Profile',
      'DEPARTMENT_SCOPED',
      ['opp:review', 'lead:approve', 'outreach:approve_campaign', 'task:delegate'],
      10000,
      3,
      true
    ),
    'You are the Director of Opportunity Acquisition. You lead Track A (Owner career & contracts) and Track B (Empire enterprise leads).',
    ['review_lead_quality', 'approve_outreach_campaign', 'monitor_conversion'],
    5
  ),
  createFoundingAgent(
    '00000000-0000-0000-0000-000000000017',
    'OPP-SCOUT',
    'opportunity_acquisition',
    'OwnerJobScoutBot',
    'Owner Career & Job Scout Specialist (Track A)',
    'SPECIALIST',
    'Scans global job boards for high-paying remote engineering, Web3, Rust, AI, and systems roles tailored to Stephen Mendez.',
    {
      supervisorAgentId: '00000000-0000-0000-0000-000000000016',
      supervisorAgentCode: 'OPP-DIR',
      reportsToOwner: false,
    },
    [
      'Continuously scan remote job boards (Greenhouse, Lever, LinkedIn, Web3 boards)',
      'Filter roles matching compensation thresholds and tech stack criteria',
      'Extract hiring manager contacts and company context',
    ],
    [
      'scan_job_boards',
      'filter_by_compensation',
      'extract_hiring_manager',
      'job_market_scraping',
    ],
    buildPermissionProfile(
      '017',
      'Owner Job Scout Specialist Profile',
      'SPECIALIST_LOCAL',
      ['job:scan', 'lead:extract'],
      0,
      0,
      false
    ),
    'You are the Owner Job Scout. You search for high-paying remote roles in Rust, Web3, Python, and AI engineering for Stephen Mendez.',
    ['scan_job_boards', 'filter_by_compensation', 'extract_hiring_manager'],
    3
  ),
  createFoundingAgent(
    '00000000-0000-0000-0000-000000000018',
    'OPP-OUTR',
    'opportunity_acquisition',
    'OwnerOutreachPreparerBot',
    'Owner Outreach & Application Preparer (Track A)',
    'SPECIALIST',
    'Drafts highly customized resumes, cover letters, and outreach emails for Owner. Autonomous sending is strictly barred pending Owner sign-off.',
    {
      supervisorAgentId: '00000000-0000-0000-0000-000000000016',
      supervisorAgentCode: 'OPP-DIR',
      reportsToOwner: false,
    },
    [
      'Generate tailored resumes and cover letters matching job descriptions',
      'Draft concise, personalized hiring manager cold emails',
      'Quarantine drafts in WAITING_FEEDBACK state for Owner approval',
    ],
    [
      'draft_cover_letter',
      'personalize_email',
      'queue_for_approval',
      'outreach_drafting',
    ],
    buildPermissionProfile(
      '018',
      'Owner Outreach Preparer Specialist Profile',
      'SPECIALIST_LOCAL',
      ['outreach:draft', 'approval:queue'],
      0,
      0,
      false
    ),
    'You draft tailored resumes, cover letters, and cold outreach emails. Consequential sending is blocked pending Owner approval.',
    ['draft_cover_letter', 'personalize_email', 'queue_for_approval'],
    3
  ),
  createFoundingAgent(
    '00000000-0000-0000-0000-000000000019',
    'OPP-LEAD',
    'opportunity_acquisition',
    'EnterpriseLeadGenBot',
    'Enterprise Lead Generation Specialist (Track B)',
    'SPECIALIST',
    'Discovers commercial startups and enterprises requiring AI automation, software engineering, or consulting services.',
    {
      supervisorAgentId: '00000000-0000-0000-0000-000000000016',
      supervisorAgentCode: 'OPP-DIR',
      reportsToOwner: false,
    },
    [
      'Discover business leads, developer bounties, and startup grants',
      'Enrich prospect company data with tech stack and executive info',
      'Draft tailored B2B service pitch proposals for Director review',
    ],
    [
      'discover_leads',
      'enrich_company_data',
      'draft_b2b_proposal',
      'bounty_hunting',
    ],
    buildPermissionProfile(
      '019',
      'Enterprise Lead Gen Specialist Profile',
      'SPECIALIST_LOCAL',
      ['lead:discover', 'lead:enrich', 'proposal:draft'],
      0,
      0,
      false
    ),
    'You identify startups and businesses needing autonomous AI or software engineering consulting.',
    ['discover_leads', 'enrich_company_data', 'draft_b2b_proposal'],
    3
  ),

  // =========================================================================
  // 8. Research & Intelligence (3 agents)
  // =========================================================================
  createFoundingAgent(
    '00000000-0000-0000-0000-000000000020',
    'RES-DIR',
    'research_intelligence',
    'ResearchDirector',
    'Director of Research & Intelligence',
    'DIRECTOR',
    'Synthesizes market signals, competitive data, and macro indicators into high-impact strategic intelligence briefings.',
    {
      supervisorAgentId: '00000000-0000-0000-0000-000000000001',
      supervisorAgentCode: 'EXEC-CEO',
      reportsToOwner: false,
    },
    [
      'Commission in-depth market and technology research studies',
      'Validate analytical hypotheses and cross-check evidence',
      'Publish executive intelligence dossiers for leadership',
    ],
    [
      'commission_research',
      'validate_hypothesis',
      'publish_intelligence_dossier',
      'market_forecasting',
    ],
    buildPermissionProfile(
      '020',
      'Research Director Profile',
      'DEPARTMENT_SCOPED',
      ['research:commission', 'research:publish', 'intelligence:compile', 'task:delegate'],
      7000,
      3,
      true
    ),
    'You are the Director of Research & Intelligence. You synthesize market signals into strategic intelligence briefings.',
    ['commission_research', 'validate_hypothesis', 'publish_intelligence_dossier'],
    5
  ),
  createFoundingAgent(
    '00000000-0000-0000-0000-000000000021',
    'RES-FORE',
    'research_intelligence',
    'MarketForecasterBot',
    'Macroeconomic & Market Trend Forecaster',
    'SPECIALIST',
    'Tracks global macroeconomic indicators, interest rates, AI sector developments, and statistical trends.',
    {
      supervisorAgentId: '00000000-0000-0000-0000-000000000020',
      supervisorAgentCode: 'RES-DIR',
      reportsToOwner: false,
    },
    [
      'Aggregate macroeconomic and industry statistical data',
      'Model trend projections and sentiment shifts',
      'Generate weekly macro trend briefing summaries',
    ],
    [
      'gather_macro_data',
      'forecast_trends',
      'generate_summary',
      'sentiment_analysis',
    ],
    buildPermissionProfile(
      '021',
      'Market Forecaster Specialist Profile',
      'SPECIALIST_LOCAL',
      ['macro:gather', 'trend:forecast', 'sentiment:analyze'],
      0,
      0,
      false
    ),
    'You track macroeconomic trends, interest rates, and AI industry developments.',
    ['gather_macro_data', 'forecast_trends', 'generate_summary'],
    3
  ),
  createFoundingAgent(
    '00000000-0000-0000-0000-000000000028',
    'RES-COMP',
    'research_intelligence',
    'CompetitiveAnalystBot',
    'Competitive Intelligence & Tokenomics Analyst',
    'SPECIALIST',
    'Benchmarks competitive autonomous AI frameworks, analyzes crypto tokenomics, and monitors technological disruptions.',
    {
      supervisorAgentId: '00000000-0000-0000-0000-000000000020',
      supervisorAgentCode: 'RES-DIR',
      reportsToOwner: false,
    },
    [
      'Perform feature, architecture, and pricing benchmarks of competitors',
      'Analyze tokenomic supply models and staking incentives',
      'Compile rapid-response competitive intelligence briefs',
    ],
    [
      'benchmark_competitors',
      'analyze_tokenomics',
      'compile_competitive_brief',
      'competitive_benchmarking',
    ],
    buildPermissionProfile(
      '028',
      'Competitive Analyst Specialist Profile',
      'SPECIALIST_LOCAL',
      ['competitor:benchmark', 'tokenomics:analyze'],
      0,
      0,
      false
    ),
    'You are the Competitive Intelligence Analyst. You benchmark industry competitors, inspect tokenomics, and analyze technological shifts.',
    ['benchmark_competitors', 'analyze_tokenomics', 'compile_competitive_brief'],
    3
  ),

  // =========================================================================
  // 9. Security & Governance (3 agents)
  // =========================================================================
  createFoundingAgent(
    '00000000-0000-0000-0000-000000000022',
    'SEC-CISO',
    'security_governance',
    'ChiefSecurityDirector',
    'Chief Information Security Officer (CISO) & Director of Security',
    'DIRECTOR',
    'Maintains the 4-tier emergency shutdown system, credential vault isolation, RBAC/ABAC enforcement, and corporate security boundaries.',
    {
      supervisorAgentId: '00000000-0000-0000-0000-000000000001',
      supervisorAgentCode: 'EXEC-CEO',
      reportsToOwner: false,
    },
    [
      'Monitor and trigger multi-tier emergency circuit breakers',
      'Enforce RBAC/ABAC boundary policies across all services',
      'Audit token integrity, cryptographic signatures, and credentials',
    ],
    [
      'trigger_emergency_halt',
      'audit_permissions',
      'verify_token_integrity',
      'circuit_breaker_control',
      'access_governance',
    ],
    buildPermissionProfile(
      '022',
      'CISO Security Director Profile',
      'DEPARTMENT_SCOPED',
      ['security:trigger_halt', 'security:audit_permissions', 'security:verify_token', 'task:delegate'],
      15000,
      3,
      true
    ),
    'You are the Chief Information Security Officer (CISO). You hold the authority to trigger multi-tier emergency halt and enforce security boundaries.',
    ['trigger_emergency_halt', 'audit_permissions', 'verify_token_integrity'],
    5
  ),
  createFoundingAgent(
    '00000000-0000-0000-0000-000000000029',
    'SEC-IAM',
    'security_governance',
    'IdentityAccessSentinelBot',
    'Identity, Access & Vault Governance Sentinel',
    'SPECIALIST',
    'Verifies agent caller contexts, checks permission profiles against action attempts, and monitors credential vaults.',
    {
      supervisorAgentId: '00000000-0000-0000-0000-000000000022',
      supervisorAgentCode: 'SEC-CISO',
      reportsToOwner: false,
    },
    [
      'Inspect caller authentication contexts and token signatures',
      'Detect and block unauthorized permission elevation attempts',
      'Audit cryptographic secret access and credential vault interactions',
    ],
    [
      'verify_token_integrity',
      'audit_rbac_permissions',
      'inspect_vault_access',
      'access_governance',
    ],
    buildPermissionProfile(
      '029',
      'IAM Sentinel Specialist Profile',
      'SPECIALIST_LOCAL',
      ['iam:verify', 'vault:audit', 'token:inspect'],
      0,
      0,
      false
    ),
    'You are the Identity and Access Governance Sentinel. You verify caller identities, audit permission boundaries, and prevent privilege escalation.',
    ['verify_token_integrity', 'audit_rbac_permissions', 'inspect_vault_access'],
    3
  ),
  createFoundingAgent(
    '00000000-0000-0000-0000-000000000030',
    'SEC-AUD',
    'security_governance',
    'SecurityAuditSentinelBot',
    'Security Audit Trail & Incident Sentinel',
    'SPECIALIST',
    'Continuously monitors system audit event streams, validates cryptographic hash chaining, and detects tampering or anomalies.',
    {
      supervisorAgentId: '00000000-0000-0000-0000-000000000022',
      supervisorAgentCode: 'SEC-CISO',
      reportsToOwner: false,
    },
    [
      'Verify cryptographic integrity of audit and journal records',
      'Scan event streams for anomalous execution patterns',
      'Trigger security escalation events upon detecting anomalous mutations',
    ],
    [
      'monitor_security_events',
      'detect_anomalies',
      'validate_audit_log_hashes',
      'security_audit',
    ],
    buildPermissionProfile(
      '030',
      'Security Audit Sentinel Specialist Profile',
      'SPECIALIST_LOCAL',
      ['audit:stream_read', 'anomaly:detect', 'hash:verify'],
      0,
      0,
      false
    ),
    'You are the Security Audit Trail Sentinel. You monitor event logs, verify hash chains, and detect tampering attempts in real time.',
    ['monitor_security_events', 'detect_anomalies', 'validate_audit_log_hashes'],
    3
  ),
];

// ---------------------------------------------------------------------------
// Registry Query and Hierarchy Integrity Verification Functions
// ---------------------------------------------------------------------------

/**
 * Finds an agent identity/record by immutable UUID
 */
export function findAgentById(id: string): AgentRecord | undefined {
  return CANONICAL_FOUNDING_AGENTS.find((a) => a.id === id);
}

/**
 * Finds an agent identity/record by unique uppercase Agent Code
 */
export function findAgentByCode(code: string): AgentRecord | undefined {
  return CANONICAL_FOUNDING_AGENTS.find((a) => a.agentCode === code);
}

/**
 * Returns all active agents belonging to a department
 */
export function getDepartmentAgents(deptId: DepartmentId): AgentRecord[] {
  return CANONICAL_FOUNDING_AGENTS.filter(
    (a) => a.departmentId === deptId && a.operationalStatus === 'ACTIVE'
  );
}

/**
 * Finds the appointed Director of a department
 */
export function getDepartmentDirector(deptId: DepartmentId): AgentRecord | undefined {
  return CANONICAL_FOUNDING_AGENTS.find(
    (a) => a.departmentId === deptId && a.level === 'DIRECTOR' && a.operationalStatus === 'ACTIVE'
  );
}

/**
 * Exhaustive organizational registry validator.
 * Validates:
 * 1. Exactly 30 agents across 9 departments
 * 2. Uniqueness of all UUIDs and Agent Codes
 * 3. Invalid department references (both origin and assigned)
 * 4. Missing directors: Every department has an active Director or Executive assigned
 * 5. Missing supervisors: Non-CEO agents must have a valid supervisor
 * 6. Non-existent supervisor references
 * 7. Self-reporting: Agent reporting to itself
 * 8. Circular reporting chains: Acyclic hierarchy guarantee
 * 9. Seniority violations: Supervisors must be senior or equal
 * 10. Prohibited Owner-level permission assignments
 * 11. CEO reporting to Owner principal: Only Executive CEO may report to Owner principal
 * 12. Owner principal boundary: The human Owner principal is distinct and excluded from workforce roster
 * 13. Credential safety: Agent and tool configurations contain zero raw API keys or secrets
 * 14. Department transfer history integrity
 * 15. Record, identity, and configuration consistency
 */
export function validateOrganizationalRegistry(
  agents: AgentRecord[] = CANONICAL_FOUNDING_AGENTS,
  departments: Department[] = CANONICAL_DEPARTMENTS
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const idMap = new Map<string, AgentRecord>();
  const codeMap = new Map<string, AgentRecord>();
  const validDeptIds = new Set(departments.map((d) => d.id));

  // 0. Workforce Roster Size and Department Counts Explicit Enforcement
  if (agents.length !== 30) {
    errors.push(`Workforce roster size mismatch: expected exactly 30 founding AI employee records, received ${agents.length}`);
  }

  if (departments.length !== 9) {
    errors.push(`Department count mismatch: expected exactly 9 canonical departments, received ${departments.length}`);
  }

  const MANDATORY_CANONICAL_DEPTS = [
    'executive_office',
    'financial_intelligence',
    'technology_engineering',
    'business_development',
    'marketing_growth',
    'operations_administration',
    'opportunity_acquisition',
    'research_intelligence',
    'security_governance',
  ] as const;

  for (const mDept of MANDATORY_CANONICAL_DEPTS) {
    if (!validDeptIds.has(mDept)) {
      errors.push(`Missing mandatory canonical department: '${mDept}'`);
    }
  }

  // 1. Separation of Human Owner Principal from AI Workforce Registry
  for (const agent of agents) {
    if (
      agent.id === OWNER_PRINCIPAL_ID ||
      agent.agentCode === 'OWNER' ||
      agent.displayName === 'Stephen Mendez' ||
      agent.permissionProfile.scope === 'OWNER_ONLY'
    ) {
      errors.push(
        `Owner principal '${OWNER_PRINCIPAL_ID}' or OWNER_ONLY scope cannot be included in the AI workforce registry. The Owner is a distinct human authority principal.`
      );
    }
  }

  // 2. Uniqueness of IDs, Codes, Record Consistency & Department Validity
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

    // Identity and Record consistency checks
    if (agent.id !== agent.identity.id) {
      errors.push(`Agent ID inconsistency: record.id '${agent.id}' does not match identity.id '${agent.identity.id}'`);
    }
    if (agent.currentConfig.agentId !== agent.identity.id) {
      errors.push(
        `Agent configuration inconsistency: currentConfig.agentId '${agent.currentConfig.agentId}' does not match identity.id '${agent.identity.id}'`
      );
    }
    if (agent.agentCode !== agent.identity.agentCode) {
      errors.push(
        `Agent code inconsistency: record.agentCode '${agent.agentCode}' does not match identity.agentCode '${agent.identity.agentCode}'`
      );
    }
    if (agent.originDepartmentId !== agent.identity.departmentId) {
      errors.push(
        `Agent origin department inconsistency: originDepartmentId '${agent.originDepartmentId}' does not match identity.departmentId '${agent.identity.departmentId}'`
      );
    }

    const expectedActiveDept = agent.currentConfig.assignedDepartmentId ?? agent.identity.departmentId;
    if (agent.departmentId !== expectedActiveDept) {
      errors.push(
        `Agent active department inconsistency: record.departmentId '${agent.departmentId}' does not match expected active department '${expectedActiveDept}'`
      );
    }

    // Invalid department reference
    if (!validDeptIds.has(agent.departmentId) || !validDeptIds.has(agent.originDepartmentId)) {
      errors.push(`Agent ${agent.agentCode} references invalid department: '${agent.departmentId}'`);
    }

    // Prohibited Owner-level permission assignment check
    const profileCheck = assertNonOwnerProfileValid(agent.permissionProfile);
    if (!profileCheck.valid) {
      errors.push(`Agent ${agent.agentCode} has invalid permission profile: ${profileCheck.errors.join('; ')}`);
    }

    // Model configuration & tool configuration credential safety check (cycle-safe)
    const credentialCheck = assertNoRawCredentials(agent.currentConfig, agent.agentCode);
    if (!credentialCheck.valid) {
      errors.push(
        `Agent ${agent.agentCode} configuration contains raw credentials: ${credentialCheck.errors.join('; ')}`
      );
    }

    // Department transfer history validation
    const transferCheck = validateDepartmentTransferHistory(agent, departments);
    if (!transferCheck.valid) {
      errors.push(...transferCheck.errors);
    }
  }

  // 3. Department Director Assignment Check
  for (const dept of departments) {
    const director = agents.find(
      (a) => a.departmentId === dept.id && (a.level === 'DIRECTOR' || a.level === 'EXECUTIVE') && a.operationalStatus === 'ACTIVE'
    );
    if (!director) {
      errors.push(`Department '${dept.id}' has no active Director or Executive assigned`);
    }
  }

  // 4. Supervisor Resolution, Consistency, Seniority & Self-Reporting Check
  for (const agent of agents) {
    const isOwnerReport = agent.supervisor.reportsToOwner || agent.supervisor.supervisorType === 'OWNER_PRINCIPAL';

    if (isOwnerReport) {
      // ONLY canonical Executive CEO can report to Owner principal
      if (agent.agentCode !== 'EXEC-CEO' || agent.level !== 'EXECUTIVE') {
        errors.push(
          `Unauthorized Owner reporting: Only the canonical Executive CEO (EXEC-CEO) may report directly to the Owner principal; agent ${agent.agentCode} (${agent.level}) cannot report directly to the Owner principal.`
        );
      }

      // Exact field consistency for Owner reporting
      if (!agent.supervisor.reportsToOwner) {
        errors.push(
          `Supervisor consistency mismatch on ${agent.agentCode}: supervisorType is 'OWNER_PRINCIPAL' but reportsToOwner is false`
        );
      }
      if (agent.supervisor.supervisorType !== 'OWNER_PRINCIPAL') {
        errors.push(
          `Supervisor consistency mismatch on ${agent.agentCode}: reportsToOwner is true but supervisorType is not 'OWNER_PRINCIPAL'`
        );
      }
      if (agent.supervisor.supervisorAgentId !== null) {
        errors.push(`Supervisor consistency mismatch on ${agent.agentCode}: reports to Owner; supervisorAgentId must be null`);
      }
      if (agent.supervisor.ownerPrincipalId !== OWNER_PRINCIPAL_ID) {
        errors.push(
          `Invalid Owner principal reference on agent ${agent.agentCode}: expected '${OWNER_PRINCIPAL_ID}', got '${agent.supervisor.ownerPrincipalId}'`
        );
      }
      continue;
    }

    // Non-owner reporting agents
    if (agent.supervisor.ownerPrincipalId !== undefined) {
      errors.push(
        `Supervisor consistency mismatch on ${agent.agentCode}: non-Owner reporting agent cannot specify ownerPrincipalId`
      );
    }
    if (agent.supervisor.supervisorType && agent.supervisor.supervisorType !== 'AGENT') {
      errors.push(
        `Supervisor consistency mismatch on ${agent.agentCode}: non-Owner reporting agent must have supervisorType 'AGENT'`
      );
    }

    const supId = agent.supervisor.supervisorAgentId;
    // Missing supervisor check
    if (!supId) {
      errors.push(`Agent ${agent.agentCode} has missing supervisor (must set supervisorAgentId or reportsToOwner=true)`);
      continue;
    }

    // Self-reporting check
    if (supId === agent.id) {
      errors.push(`Self-reporting prohibited: Agent ${agent.agentCode} (${agent.id}) reports to itself`);
      continue;
    }

    const supervisor = idMap.get(supId);
    // Non-existent supervisor reference check
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

    // Specialist department consistency check:
    // Specialists must report within their own active department, or to an Executive
    if (agent.level === 'SPECIALIST') {
      if (supervisor.level !== 'EXECUTIVE' && supervisor.departmentId !== agent.departmentId) {
        errors.push(
          `Department supervisor mismatch: Specialist ${agent.agentCode} in department '${agent.departmentId}' reports to supervisor ${supervisor.agentCode} in different department '${supervisor.departmentId}'`
        );
      }
    }
  }

  // 5. Circular Reporting Chain Detection (Cycles)
  for (const agent of agents) {
    const visited = new Set<string>();
    let current: AgentRecord | undefined = agent;

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

/**
 * Backward compatibility alias for validateOrganizationalRegistry
 */
export const validateWorkforceHierarchy = validateOrganizationalRegistry;
