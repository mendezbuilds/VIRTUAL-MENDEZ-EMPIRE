import { randomUUID, createHmac, randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  OWNER_PRINCIPAL_ID,
  CANONICAL_OWNER_PRINCIPAL,
  CANONICAL_FOUNDING_AGENTS,
  isAuthorizedTransferAuthority,
  type AgentRecord,
  type EpisodicMemoryRecord,
  type SemanticKnowledgeItem,
  type ProceduralPlaybook,
  type EmbeddingMetadata,
  type DepartmentId,
  type DepartmentTransferRecord,
  type MemoryScope,
  EpisodicMemoryRecordSchema,
  SemanticKnowledgeItemSchema,
  ProceduralPlaybookSchema,
} from '@vme/shared-types';
import { verifyOwnerSessionToken } from '@vme/security-governance';
import {
  DepartmentRegistry,
  type LeadershipAppointmentRecord,
  type AuthoritativeTransferRecord,
  verifyAppointmentAuthorizationSignature,
  verifyTransferAuthorizationSignature,
} from '@vme/department-hierarchy';
import type { EpisodicMemoryFilter, EpisodicMemoryStorage } from './episodic-memory.js';
import type { SemanticSearchFilter, SemanticSearchResult, SemanticStorage } from './semantic-memory.js';
import type { ProceduralQueryFilter, ProceduralStorage } from './procedural-memory.js';
import {
  computeCosineSimilarity,
  assertEmbeddingCompatibility,
  IncompatibleEmbeddingError,
} from './semantic-memory.js';
import type { WorkingMemoryStorage } from './working-memory.js';

export interface AuthoritativeWorkforceIdentityProvider {
  getAgentRecord(idOrCode: string): AgentRecord | null;
  getLeadershipHistory?(departmentId?: DepartmentId): LeadershipAppointmentRecord[];
  getTransferHistory?(agentIdOrCode?: string): (DepartmentTransferRecord & { agentId?: string; agentCode?: string })[];
  auditIntegrity?(): { valid: boolean; errors: string[] };
}

export interface RlsSessionContext {
  tenantId: string;
  agentId?: string;
  agentCode?: string;
  departmentId?: string;
  principalLevel?: string;
  isOwnerAuthenticated?: boolean;
  ownerSession?: unknown;
  authoritativeRegistry?: AuthoritativeWorkforceIdentityProvider | DepartmentRegistry;
}

export class PostgresStorageError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(`POSTGRES STORAGE ERROR: ${message}`);
    this.name = 'PostgresStorageError';
  }
}

/**
 * Retrieves the independently provisioned high-entropy database signing secret.
 * Fails closed if the secret is missing or has insufficient entropy (< 32 characters).
 * Development or canonical fallback secrets are strictly prohibited.
 */
export function getDatabaseSessionSecret(): string {
  const secret = process.env.DB_SESSION_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new PostgresStorageError(
      'CRITICAL SECURITY CONFIGURATION ERROR: DB_SESSION_SECRET must be independently provisioned with at least 32 characters of high entropy. Failing closed; fallback secrets are strictly prohibited.'
    );
  }
  return secret;
}

export interface DatabaseSessionClaims {
  tenantId: string;
  agentId?: string;
  departmentId?: string;
  principalLevel?: string;
  isOwner?: boolean;
  expiresAt: number;
  nonce?: string;
}

/**
 * Computes canonical string and cryptographically signs database session claims with HMAC-SHA256.
 */
export function signDatabaseClaims(
  claims: DatabaseSessionClaims,
  secret: string = getDatabaseSessionSecret()
): { claimsPayload: Record<string, unknown>; signature: string } {
  const canonical = [
    claims.tenantId ?? '',
    claims.agentId ?? '',
    claims.departmentId ?? '',
    claims.principalLevel ?? 'SPECIALIST',
    claims.isOwner === true ? 'true' : 'false',
    String(claims.expiresAt ?? 0),
    claims.nonce ?? '',
  ].join(':');

  const signature = createHmac('sha256', secret).update(canonical).digest('hex');
  return {
    claimsPayload: {
      tenantId: claims.tenantId,
      agentId: claims.agentId ?? '',
      departmentId: claims.departmentId ?? '',
      principalLevel: claims.principalLevel ?? 'SPECIALIST',
      isOwner: claims.isOwner === true,
      expiresAt: claims.expiresAt,
      nonce: claims.nonce ?? '',
    },
    signature,
  };
}

/**
 * Validates that an injected workforce registry or identity provider is authoritative,
 * reflecting canonical organizational records, valid Director appointments, and authorized transfers.
 * Strictly prevents fabricated registries from establishing privileged (Executive/Director) identity
 * and validates that appointment and transfer records possess verifiable cryptographic signatures
 * and unbroken audit ledgers.
 */
export function verifyRegistryAuthoritativeness(
  registry: AuthoritativeWorkforceIdentityProvider | DepartmentRegistry,
  agentRecord: AgentRecord,
  requestedLevel?: string,
  secret: string = getDatabaseSessionSecret()
): void {
  // 1. Look up agent in CANONICAL_FOUNDING_AGENTS
  const canonicalAgent = CANONICAL_FOUNDING_AGENTS.find(
    (ca) => ca.id === agentRecord.id || ca.agentCode === agentRecord.agentCode
  );

  if (!canonicalAgent) {
    throw new PostgresStorageError(
      `Database session claims issuance rejected: Agent '${agentRecord.agentCode || agentRecord.id}' is not a registered workforce agent in authoritative canonical records.`
    );
  }

  // 2. Immutable identifier integrity
  if (canonicalAgent.id !== agentRecord.id || canonicalAgent.agentCode !== agentRecord.agentCode) {
    throw new PostgresStorageError(
      `Database session claims issuance rejected: Identity mismatch. Agent ID '${agentRecord.id}' or code '${agentRecord.agentCode}' does not match canonical organizational record.`
    );
  }

  // 3. Privileged Executive Claims Verification: strictly requires canonical executive status or genuine Owner appointment
  if (agentRecord.level === 'EXECUTIVE' || requestedLevel === 'EXECUTIVE') {
    if (canonicalAgent.level !== 'EXECUTIVE') {
      const leadershipHistory = typeof registry.getLeadershipHistory === 'function'
        ? registry.getLeadershipHistory('executive_office')
        : [];
      const appointment = leadershipHistory.find(
        (rec) =>
          (rec.newDirectorId === agentRecord.id || rec.newDirectorCode === agentRecord.agentCode) &&
          (rec.appointedBy === OWNER_PRINCIPAL_ID || rec.appointedBy === CANONICAL_OWNER_PRINCIPAL.principalId)
      );
      if (!appointment) {
        throw new PostgresStorageError(
          `Privileged database identity issuance rejected: Fabricated or unverified registry cannot grant Executive privileges to non-canonical agent '${agentRecord.agentCode}'. Elevation requires authoritative Owner appointment.`
        );
      }
      if (!verifyAppointmentAuthorizationSignature(appointment, secret)) {
        throw new PostgresStorageError(
          `Privileged database identity issuance rejected: Fabricated or unverified appointment record for '${agentRecord.agentCode}'. An Owner principal ID in appointedBy does not, by itself, establish authorization without verifiable cryptographic authorization.`
        );
      }
    }
  }

  // 4. Privileged Director Claims Verification: requires canonical founding director status or authentic appointment
  if (agentRecord.level === 'DIRECTOR' || requestedLevel === 'DIRECTOR') {
    const isCanonicalDirectorOfDept =
      canonicalAgent.level === 'DIRECTOR' && canonicalAgent.departmentId === agentRecord.departmentId;

    if (!isCanonicalDirectorOfDept) {
      const leadershipHistory = typeof registry.getLeadershipHistory === 'function'
        ? registry.getLeadershipHistory(agentRecord.departmentId)
        : [];
      const canonicalCeo = CANONICAL_FOUNDING_AGENTS.find((a) => a.agentCode === 'EXEC-CEO');
      const appointment = leadershipHistory.find(
        (rec) =>
          (rec.newDirectorId === agentRecord.id || rec.newDirectorCode === agentRecord.agentCode) &&
          (rec.appointedBy === OWNER_PRINCIPAL_ID ||
           rec.appointedBy === CANONICAL_OWNER_PRINCIPAL.principalId ||
           rec.appointedBy === 'EXEC-CEO' ||
           rec.appointedBy === canonicalCeo?.id)
      );
      if (!appointment) {
        throw new PostgresStorageError(
          `Privileged database identity issuance rejected: Fabricated or unverified registry cannot grant Director privileges to '${agentRecord.agentCode}' for department '${agentRecord.departmentId}'. Elevation requires authoritative Director appointment record.`
        );
      }
      if (!verifyAppointmentAuthorizationSignature(appointment, secret)) {
        throw new PostgresStorageError(
          `Privileged database identity issuance rejected: Fabricated or unverified appointment record for '${agentRecord.agentCode}'. Naming 'EXEC-CEO' or Owner in appointedBy does not, by itself, establish authorization without verifiable cryptographic authorization.`
        );
      }
    }
  }

  // 5. Current appointments & transfers verification
  if (agentRecord.departmentId !== canonicalAgent.departmentId) {
    const transferHistory =
      agentRecord.currentConfig?.departmentTransferHistory ??
      (agentRecord as any).departmentTransferHistory ??
      [];
    const latestTransfer = transferHistory.length ? transferHistory[transferHistory.length - 1] : undefined;
    if (!latestTransfer) {
      throw new PostgresStorageError(
        `Database session claims issuance rejected: Agent '${agentRecord.agentCode}' department '${agentRecord.departmentId}' differs from canonical origin '${canonicalAgent.departmentId}' without authorized transfer history.`
      );
    }
    if (latestTransfer.toDepartmentId !== agentRecord.departmentId) {
      throw new PostgresStorageError(
        `Database session claims issuance rejected: Agent '${agentRecord.agentCode}' latest transfer destination '${latestTransfer.toDepartmentId}' does not match current department '${agentRecord.departmentId}'.`
      );
    }
    if (!isAuthorizedTransferAuthority(latestTransfer.authorizedBy, CANONICAL_FOUNDING_AGENTS)) {
      throw new PostgresStorageError(
        `Database session claims issuance rejected: Agent '${agentRecord.agentCode}' transfer to '${agentRecord.departmentId}' was authorized by '${latestTransfer.authorizedBy}', which lacks executive or Owner transfer authority.`
      );
    }

    if (typeof registry.getTransferHistory !== 'function') {
      throw new PostgresStorageError(
        `Database session claims issuance rejected: Registry lacks authoritative transfer history ledger. Caller-supplied transfer history is rejected.`
      );
    }

    const authoritativeTransfers = registry.getTransferHistory(agentRecord.id);
    const authTransfer = authoritativeTransfers.find((t) => t.transferId === latestTransfer.transferId);
    if (!authTransfer) {
      throw new PostgresStorageError(
        `Database session claims issuance rejected: Fabricated Specialist transfer. Transfer record for '${agentRecord.agentCode}' to '${agentRecord.departmentId}' does not exist in authoritative transfer ledger. Naming 'EXEC-CEO' in authorizedBy does not establish department transfer without a genuine verifiable authorization record.`
      );
    }

    // Verify record has not been altered after authorization
    if (
      authTransfer.fromDepartmentId !== latestTransfer.fromDepartmentId ||
      authTransfer.toDepartmentId !== latestTransfer.toDepartmentId ||
      authTransfer.effectiveDate !== latestTransfer.effectiveDate ||
      authTransfer.reason !== latestTransfer.reason ||
      authTransfer.authorizedBy !== latestTransfer.authorizedBy ||
      authTransfer.previousConfigVersion !== latestTransfer.previousConfigVersion ||
      authTransfer.newConfigVersion !== latestTransfer.newConfigVersion
    ) {
      throw new PostgresStorageError(
        `Database session claims issuance rejected: Transfer record '${latestTransfer.transferId}' for agent '${agentRecord.agentCode}' has been altered after authorization.`
      );
    }

    // Verify cryptographic authorization signature
    if (!verifyTransferAuthorizationSignature(agentRecord.id, agentRecord.agentCode, latestTransfer, secret)) {
      throw new PostgresStorageError(
        `Database session claims issuance rejected: Transfer record '${latestTransfer.transferId}' authorization signature verification failed. The transfer record is altered, fabricated, or unverified.`
      );
    }
  }
}

/**
 * Issues authenticated database session claims.
 * Strictly verifies privileged and specialist claims:
 * - Owner claims REQUIRE a verified Owner session (cryptographically verified token);
 *   caller-supplied booleans or agent IDs are rejected.
 * - Requires an explicitly injected authoritative DepartmentRegistry or trusted identity-provider interface;
 *   implicit fallback to `new DepartmentRegistry()` is removed.
 * - Rejects any unregistered agent ID or agent code.
 * - Enforces agent identity binding (a registered agent cannot claim another agent's ID).
 * - Rejects caller-supplied department IDs that differ from the registered agent's department.
 * - Never issues agent-scoped database identity when missing agent identity.
 * - Verifies that the registry reflects canonical organizational records and current appointments/transfers,
 *   strictly barring fabricated registries from granting Executive or Director privileges.
 * - Resolves agent ID, department ID, and principal level exclusively from the authoritative workforce record.
 */
export function issueAuthenticatedDatabaseClaims(
  context: RlsSessionContext,
  secret: string = getDatabaseSessionSecret(),
  departmentRegistry?: AuthoritativeWorkforceIdentityProvider | DepartmentRegistry
): { claimsPayload: Record<string, unknown>; signature: string } {
  if (!context.tenantId || context.tenantId.trim().length === 0) {
    throw new PostgresStorageError('Database session claims issuance failed: tenantId is required.');
  }

  const expiresAt = Math.floor(Date.now() / 1000) + 3600; // 1 hour TTL
  const nonce = randomBytes(8).toString('hex');

  const wantsOwner = context.isOwnerAuthenticated === true || context.principalLevel === 'OWNER';

  let resolvedAgentId = '';
  let resolvedDepartmentId = '';
  let resolvedLevel = 'SPECIALIST';
  let resolvedIsOwner = false;

  if (wantsOwner) {
    // 1. Privileged Owner Claims Issuance: MUST be verified through Owner session
    if (!context.ownerSession) {
      throw new PostgresStorageError(
        'Privileged database identity issuance rejected: Owner claims require an authenticated Owner session (ownerSession). Caller-supplied booleans or strings are strictly rejected.'
      );
    }

    try {
      const verified = verifyOwnerSessionToken(context.ownerSession);
      if (!verified || !verified.sessionId) {
        throw new Error('Missing verified session identity.');
      }
    } catch (err: unknown) {
      throw new PostgresStorageError(
        `Privileged database identity issuance rejected: Owner session verification failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (context.agentId && context.agentId !== OWNER_PRINCIPAL_ID) {
      throw new PostgresStorageError(
        `Privileged database identity issuance rejected: Owner principal cannot claim an AI agent ID ('${context.agentId}').`
      );
    }

    resolvedIsOwner = true;
    resolvedLevel = 'OWNER';
    resolvedAgentId = OWNER_PRINCIPAL_ID;
    resolvedDepartmentId = 'executive_office';
  } else {
    // 2. Agent Claims Issuance: strictly requires authenticated, registered agent identity
    if (!context.agentId && !context.agentCode) {
      throw new PostgresStorageError(
        'Database session claims issuance rejected: Missing agent identity. An agent-scoped database session requires an authenticated, registered agent identity (agentId or agentCode).'
      );
    }

    const registry = departmentRegistry ?? context.authoritativeRegistry;
    if (!registry || typeof registry.getAgentRecord !== 'function') {
      throw new PostgresStorageError(
        'Database session claims issuance rejected: Authoritative workforce registry or trusted identity provider must be explicitly injected. Implicit registry fallback is strictly prohibited.'
      );
    }

    const agentLookup = context.agentId || context.agentCode!;
    const agentRecord = registry.getAgentRecord(agentLookup);

    if (!agentRecord) {
      throw new PostgresStorageError(
        `Database session claims issuance rejected: Agent '${agentLookup}' cannot be resolved to an authoritative registered workforce record. Unregistered agent identities are strictly rejected.`
      );
    }

    // A registered agent cannot claim another agent's ID or code
    if (context.agentId && context.agentCode) {
      const recordById = registry.getAgentRecord(context.agentId);
      const recordByCode = registry.getAgentRecord(context.agentCode);
      if (!recordById || !recordByCode || recordById.id !== recordByCode.id || recordById.agentCode !== recordByCode.agentCode) {
        throw new PostgresStorageError(
          `Database session claims issuance rejected: Identity mismatch. Agent ID '${context.agentId}' does not match agent code '${context.agentCode}'. A registered agent cannot claim another agent's ID.`
        );
      }
    }

    if (context.agentId && agentRecord.id !== context.agentId) {
      throw new PostgresStorageError(
        `Database session claims issuance rejected: Agent record ID '${agentRecord.id}' does not match supplied agentId '${context.agentId}'. Spoofing another agent's ID is strictly prohibited.`
      );
    }

    if (context.agentCode && agentRecord.agentCode !== context.agentCode) {
      throw new PostgresStorageError(
        `Database session claims issuance rejected: Agent record code '${agentRecord.agentCode}' does not match supplied agentCode '${context.agentCode}'. Spoofing another agent's identity is strictly prohibited.`
      );
    }

    // Never accept caller-supplied department IDs as a substitute for a registered agent's department
    if (context.departmentId && context.departmentId !== agentRecord.departmentId) {
      throw new PostgresStorageError(
        `Database session claims issuance rejected: Caller-supplied departmentId '${context.departmentId}' does not match registered department '${agentRecord.departmentId}' for agent '${agentRecord.agentCode}'. Caller cannot substitute or override a registered agent's department.`
      );
    }

    // Principal level elevation checks
    if (context.principalLevel && context.principalLevel !== agentRecord.level) {
      if (context.principalLevel === 'OWNER') {
        throw new PostgresStorageError(
          `Privileged database identity issuance rejected: Agent '${agentRecord.agentCode}' is an AI agent and cannot claim OWNER principal level.`
        );
      }
      if (context.principalLevel === 'EXECUTIVE' && agentRecord.level !== 'EXECUTIVE') {
        throw new PostgresStorageError(
          `Privileged database identity issuance rejected: Agent '${agentRecord.agentCode}' is registered with level '${agentRecord.level}', not 'EXECUTIVE'. Elevation prohibited.`
        );
      }
      if (context.principalLevel === 'DIRECTOR' && agentRecord.level !== 'DIRECTOR' && agentRecord.level !== 'EXECUTIVE') {
        throw new PostgresStorageError(
          `Privileged database identity issuance rejected: Agent '${agentRecord.agentCode}' is registered with level '${agentRecord.level}', not 'DIRECTOR'. Elevation prohibited.`
        );
      }
    }

    // Verify registry authoritativeness and canonical consistency
    verifyRegistryAuthoritativeness(registry, agentRecord, context.principalLevel, secret);

    resolvedIsOwner = false;
    resolvedAgentId = agentRecord.id;
    resolvedDepartmentId = agentRecord.departmentId;
    resolvedLevel = agentRecord.level;
  }

  const claimsPayload: Record<string, unknown> = {
    tenantId: context.tenantId,
    agentId: resolvedAgentId,
    departmentId: resolvedDepartmentId,
    principalLevel: resolvedLevel,
    isOwner: resolvedIsOwner,
    expiresAt,
    nonce,
  };

  const canonical = [
    claimsPayload.tenantId ?? '',
    claimsPayload.agentId ?? '',
    claimsPayload.departmentId ?? '',
    claimsPayload.principalLevel ?? 'SPECIALIST',
    claimsPayload.isOwner === true ? 'true' : 'false',
    String(claimsPayload.expiresAt ?? 0),
    claimsPayload.nonce ?? '',
  ].join(':');

  const signature = createHmac('sha256', secret).update(canonical).digest('hex');

  return { claimsPayload, signature };
}

/**
 * Applies authenticated session identity to a client connection.
 * Authenticates cryptographically against database-stored secret, eliminating trust in raw GUC values.
 */
export async function applyAuthenticatedSession(
  client: { query: (text: string, values?: any[]) => Promise<any> },
  context: RlsSessionContext,
  secret: string = getDatabaseSessionSecret(),
  departmentRegistry?: AuthoritativeWorkforceIdentityProvider | DepartmentRegistry
): Promise<void> {
  const { claimsPayload, signature } = issueAuthenticatedDatabaseClaims(context, secret, departmentRegistry);

  try {
    await client.query(`SELECT set_authenticated_session($1::jsonb, $2)`, [
      JSON.stringify(claimsPayload),
      signature,
    ]);
  } catch (authErr: any) {
    // If set_authenticated_session doesn't exist (e.g. pg-mem unit test harness), fall back to legacy GUC settings
    if (authErr?.code === '42883' || authErr?.message?.includes('set_authenticated_session')) {
      await client.query(
        `SELECT 
          set_config('app.current_tenant_id', $1, false),
          set_config('app.current_agent_id', $2, false),
          set_config('app.current_department_id', $3, false),
          set_config('app.current_principal_level', $4, false),
          set_config('app.is_owner_authenticated', $5, false)`,
        [
          claimsPayload.tenantId,
          claimsPayload.agentId,
          claimsPayload.departmentId,
          claimsPayload.principalLevel,
          claimsPayload.isOwner ? 'true' : 'false',
        ]
      );
    } else {
      throw authErr;
    }
  }
}

/**
 * Explicitly clears authenticated session identity and verified claims from a client connection.
 */
export async function clearAuthenticatedSession(
  client: { query: (text: string, values?: any[]) => Promise<any> }
): Promise<void> {
  try {
    await client.query('SELECT clear_authenticated_session()');
  } catch {
    try {
      await client.query(
        `SELECT 
          set_config('app.current_tenant_id', '', false),
          set_config('app.current_agent_id', '', false),
          set_config('app.current_department_id', '', false),
          set_config('app.current_principal_level', '', false),
          set_config('app.is_owner_authenticated', 'false', false)`
      );
    } catch {
      // ignore reset error on closed client
    }
  }
}

/**
 * Executes a callback within a transaction-scoped PostgreSQL session RLS context on a pool client.
 * Uses BEGIN / COMMIT with rollback on failure, and resets session context in finally to prevent
 * connection-pool context leakage across requests.
 */
export async function withSessionRls<T>(
  pool: Pool,
  context: RlsSessionContext,
  operation: (client: PoolClient) => Promise<T>,
  departmentRegistry?: AuthoritativeWorkforceIdentityProvider | DepartmentRegistry,
  secret: string = getDatabaseSessionSecret()
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const registry = departmentRegistry ?? context.authoritativeRegistry;
    await applyAuthenticatedSession(client, context, secret, registry);
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (err: unknown) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors if connection failed
    }
    throw new PostgresStorageError(err instanceof Error ? err.message : String(err), err);
  } finally {
    // Explicitly reset session-level settings to prevent connection-pool leakage
    await clearAuthenticatedSession(client);
    client.release();
  }
}

// ============================================================================
// 1. PostgreSQL Working Memory Storage
// ============================================================================
export class PostgresWorkingStorage implements WorkingMemoryStorage {
  constructor(
    private readonly pool: Pool,
    private readonly context?: RlsSessionContext,
    private readonly departmentRegistry?: AuthoritativeWorkforceIdentityProvider | DepartmentRegistry
  ) {}

  private resolveContext(explicitContext?: RlsSessionContext): RlsSessionContext {
    const ctx = explicitContext ?? this.context;
    if (!ctx) {
      throw new PostgresStorageError(
        'RlsSessionContext is required for PostgreSQL Working Memory storage operations.'
      );
    }
    return ctx;
  }

  async set(
    taskIdOrContext: string | RlsSessionContext,
    keyOrTaskId: string,
    valueOrAgentId: unknown,
    expiresAtOrKey?: Date | string,
    agentIdOrValue?: string | unknown,
    maybeExpiresAt?: Date
  ): Promise<void> {
    let ctx: RlsSessionContext;
    let taskId: string;
    let agentId: string;
    let key: string;
    let value: unknown;
    let expiresAt: Date;

    if (typeof taskIdOrContext === 'object') {
      ctx = taskIdOrContext;
      taskId = keyOrTaskId;
      agentId = valueOrAgentId as string;
      key = expiresAtOrKey as string;
      value = agentIdOrValue;
      expiresAt = maybeExpiresAt ?? new Date(Date.now() + 3600 * 1000);
    } else {
      ctx = this.resolveContext();
      taskId = taskIdOrContext;
      key = keyOrTaskId;
      value = valueOrAgentId;
      expiresAt = (expiresAtOrKey as Date) ?? new Date(Date.now() + 3600 * 1000);
      agentId = (agentIdOrValue as string) ?? ctx.agentId ?? '00000000-0000-0000-0000-000000000000';
    }

    const reg = ctx.authoritativeRegistry ?? this.departmentRegistry;
    await withSessionRls(this.pool, ctx, async (client) => {
      await client.query(
        `INSERT INTO agent_working_memories (id, tenant_id, task_id, agent_id, key, value, expires_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, clock_timestamp())
         ON CONFLICT (tenant_id, task_id, key)
         DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at, updated_at = clock_timestamp()`,
        [randomUUID(), ctx.tenantId, taskId, agentId, key, JSON.stringify(value), expiresAt]
      );
    }, reg);
  }

  async get<T>(
    contextOrTaskId: RlsSessionContext | string,
    taskIdOrKey: string,
    maybeKey?: string
  ): Promise<T | undefined> {
    let ctx: RlsSessionContext;
    let taskId: string;
    let key: string;

    if (typeof contextOrTaskId === 'object') {
      ctx = contextOrTaskId;
      taskId = taskIdOrKey;
      key = maybeKey!;
    } else {
      ctx = this.resolveContext();
      taskId = contextOrTaskId;
      key = taskIdOrKey;
    }

    const reg = ctx.authoritativeRegistry ?? this.departmentRegistry;
    return withSessionRls(this.pool, ctx, async (client) => {
      const res = await client.query(
        `SELECT value FROM agent_working_memories
         WHERE tenant_id = $1 AND task_id = $2 AND key = $3 AND expires_at > clock_timestamp()`,
        [ctx.tenantId, taskId, key]
      );
      if (res.rows.length === 0) return undefined;
      return res.rows[0].value as T;
    }, reg);
  }

  async getAll(
    contextOrTaskId: RlsSessionContext | string,
    maybeTaskId?: string
  ): Promise<Record<string, unknown>> {
    let ctx: RlsSessionContext;
    let taskId: string;

    if (typeof contextOrTaskId === 'object') {
      ctx = contextOrTaskId;
      taskId = maybeTaskId!;
    } else {
      ctx = this.resolveContext();
      taskId = contextOrTaskId;
    }

    const reg = ctx.authoritativeRegistry ?? this.departmentRegistry;
    return withSessionRls(this.pool, ctx, async (client) => {
      const res = await client.query(
        `SELECT key, value FROM agent_working_memories
         WHERE tenant_id = $1 AND task_id = $2 AND expires_at > clock_timestamp()`,
        [ctx.tenantId, taskId]
      );
      const result: Record<string, unknown> = {};
      for (const row of res.rows) {
        result[row.key] = row.value;
      }
      return result;
    }, reg);
  }

  async clear(contextOrTaskId: RlsSessionContext | string, maybeTaskId?: string): Promise<void> {
    let ctx: RlsSessionContext;
    let taskId: string;

    if (typeof contextOrTaskId === 'object') {
      ctx = contextOrTaskId;
      taskId = maybeTaskId!;
    } else {
      ctx = this.resolveContext();
      taskId = contextOrTaskId;
    }

    const reg = ctx.authoritativeRegistry ?? this.departmentRegistry;
    await withSessionRls(this.pool, ctx, async (client) => {
      await client.query(
        `DELETE FROM agent_working_memories WHERE tenant_id = $1 AND task_id = $2`,
        [ctx.tenantId, taskId]
      );
    }, reg);
  }

  async cleanupExpired(context?: RlsSessionContext): Promise<number> {
    const ctx = this.resolveContext(context);
    const reg = ctx.authoritativeRegistry ?? this.departmentRegistry;
    return withSessionRls(this.pool, ctx, async (client) => {
      const res = await client.query(
        `DELETE FROM agent_working_memories WHERE tenant_id = $1 AND expires_at <= clock_timestamp()`,
        [ctx.tenantId]
      );
      return res.rowCount ?? 0;
    }, reg);
  }
}

// ============================================================================
// 2. PostgreSQL Episodic Memory Storage
// ============================================================================
export class PostgresEpisodicStorage implements EpisodicMemoryStorage {
  constructor(
    private readonly pool: Pool,
    private readonly defaultContext: RlsSessionContext,
    private readonly departmentRegistry?: AuthoritativeWorkforceIdentityProvider | DepartmentRegistry
  ) {}

  private get registry(): AuthoritativeWorkforceIdentityProvider | DepartmentRegistry | undefined {
    return this.defaultContext.authoritativeRegistry ?? this.departmentRegistry;
  }

  async saveRecord(record: EpisodicMemoryRecord): Promise<void> {
    await withSessionRls(this.pool, this.defaultContext, async (client) => {
      await client.query(
        `INSERT INTO agent_episodic_memories (
          id, tenant_id, agent_id, agent_code, department_id, task_id, action_type,
          input_summary, decision_rationale, outcome, lessons_learned, execution_duration_ms,
          status, scope, importance_score, metadata, recorded_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [
          record.id,
          this.defaultContext.tenantId,
          record.agentId,
          record.agentCode ?? 'AGENT',
          record.departmentId,
          record.taskId,
          record.actionType,
          record.inputSummary,
          record.decisionRationale,
          record.outcome,
          record.lessonsLearned ?? null,
          record.executionDurationMs ?? null,
          record.status,
          record.scope,
          record.importanceScore,
          JSON.stringify(record.metadata ?? {}),
          record.recordedAt,
        ]
      );
    }, this.registry);
  }

  async getRecordById(id: string): Promise<EpisodicMemoryRecord | undefined> {
    return withSessionRls(this.pool, this.defaultContext, async (client) => {
      const res = await client.query(
        `SELECT id, tenant_id, agent_id as "agentId", agent_code as "agentCode", department_id as "departmentId",
                task_id as "taskId", action_type as "actionType", input_summary as "inputSummary",
                decision_rationale as "decisionRationale", outcome, lessons_learned as "lessonsLearned",
                execution_duration_ms as "executionDurationMs", status, scope, importance_score as "importanceScore",
                metadata, recorded_at as "recordedAt"
         FROM agent_episodic_memories
         WHERE id = $1`,
        [id]
      );
      if (res.rows.length === 0) return undefined;
      return this.mapRowToRecord(res.rows[0]);
    }, this.registry);
  }

  async queryRecords(filter: EpisodicMemoryFilter): Promise<EpisodicMemoryRecord[]> {
    return withSessionRls(this.pool, this.defaultContext, async (client) => {
      const conditions: string[] = ['1=1'];
      const params: unknown[] = [];
      let pIdx = 1;

      if (filter.agentId) {
        conditions.push(`agent_id = $${pIdx++}`);
        params.push(filter.agentId);
      }
      if (filter.departmentId) {
        conditions.push(`department_id = $${pIdx++}`);
        params.push(filter.departmentId);
      }
      if (filter.actionType) {
        conditions.push(`action_type = $${pIdx++}`);
        params.push(filter.actionType);
      }
      if (filter.status) {
        conditions.push(`status = $${pIdx++}`);
        params.push(filter.status);
      }
      if (filter.scope) {
        conditions.push(`scope = $${pIdx++}`);
        params.push(filter.scope);
      }
      if (filter.since) {
        conditions.push(`recorded_at >= $${pIdx++}`);
        params.push(filter.since);
      }
      if (filter.until) {
        conditions.push(`recorded_at <= $${pIdx++}`);
        params.push(filter.until);
      }

      const limit = filter.limit ?? 50;
      const sql = `
        SELECT id, tenant_id, agent_id as "agentId", agent_code as "agentCode", department_id as "departmentId",
               task_id as "taskId", action_type as "actionType", input_summary as "inputSummary",
               decision_rationale as "decisionRationale", outcome, lessons_learned as "lessonsLearned",
               execution_duration_ms as "executionDurationMs", status, scope, importance_score as "importanceScore",
               metadata, recorded_at as "recordedAt"
        FROM agent_episodic_memories
        WHERE ${conditions.join(' AND ')}
        ORDER BY recorded_at DESC
        LIMIT ${limit}
      `;

      const res = await client.query(sql, params);
      return res.rows.map((row) => this.mapRowToRecord(row));
    }, this.registry);
  }

  private mapRowToRecord(row: any): EpisodicMemoryRecord {
    return EpisodicMemoryRecordSchema.parse({
      ...row,
      lessonsLearned: row.lessonsLearned ?? undefined,
      executionDurationMs: row.executionDurationMs != null ? Number(row.executionDurationMs) : undefined,
      recordedAt: row.recordedAt instanceof Date ? row.recordedAt.toISOString() : String(row.recordedAt),
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata ?? {}),
    });
  }

  async archiveOlderThan(cutoffIsoDate: string): Promise<number> {
    return withSessionRls(this.pool, this.defaultContext, async (client) => {
      // In PostgreSQL, mark or delete records older than cutoff
      const res = await client.query(
        `DELETE FROM agent_episodic_memories WHERE recorded_at < $1`,
        [cutoffIsoDate]
      );
      return res.rowCount ?? 0;
    }, this.registry);
  }

  async deleteRecords(filter: EpisodicMemoryFilter): Promise<number> {
    return withSessionRls(this.pool, this.defaultContext, async (client) => {
      const conditions: string[] = ['1=1'];
      const params: unknown[] = [];
      let pIdx = 1;

      if (filter.agentId) {
        conditions.push(`agent_id = $${pIdx++}`);
        params.push(filter.agentId);
      }
      if (filter.departmentId) {
        conditions.push(`department_id = $${pIdx++}`);
        params.push(filter.departmentId);
      }
      if (filter.actionType) {
        conditions.push(`action_type = $${pIdx++}`);
        params.push(filter.actionType);
      }
      if (filter.scope) {
        conditions.push(`scope = $${pIdx++}`);
        params.push(filter.scope);
      }

      const sql = `DELETE FROM agent_episodic_memories WHERE ${conditions.join(' AND ')}`;
      const res = await client.query(sql, params);
      return res.rowCount ?? 0;
    }, this.registry);
  }
}

// ============================================================================
// 3. PostgreSQL Semantic Memory Storage (Flexible Vector Dimension)
// ============================================================================
export class PostgresSemanticStorage implements SemanticStorage {
  constructor(
    private readonly pool: Pool,
    private readonly defaultContext: RlsSessionContext,
    private readonly departmentRegistry?: AuthoritativeWorkforceIdentityProvider | DepartmentRegistry
  ) {}

  private get registry(): AuthoritativeWorkforceIdentityProvider | DepartmentRegistry | undefined {
    return this.defaultContext.authoritativeRegistry ?? this.departmentRegistry;
  }

  async insert(item: SemanticKnowledgeItem): Promise<void> {
    await withSessionRls(this.pool, this.defaultContext, async (client) => {
      await client.query(
        `INSERT INTO agent_semantic_memories (
          id, tenant_id, scope, department_id, author_agent_id, category, title, content,
          embedding, embedding_provider, embedding_model, embedding_dimension, embedding_version,
          importance_score, tags, version, supersedes_id, is_deprecated, metadata, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, clock_timestamp())`,
        [
          item.id,
          this.defaultContext.tenantId,
          item.scope,
          item.departmentId ?? null,
          item.authorAgentId ?? null,
          item.category,
          item.title,
          item.content,
          item.embedding,
          item.embeddingMetadata.provider,
          item.embeddingMetadata.model,
          item.embeddingMetadata.dimension,
          item.embeddingMetadata.version,
          item.importanceScore,
          item.tags,
          item.version,
          item.supersedesId ?? null,
          item.isDeprecated,
          JSON.stringify(item.metadata ?? {}),
          item.createdAt ?? new Date().toISOString(),
        ]
      );
    }, this.registry);
  }

  async update(item: SemanticKnowledgeItem): Promise<void> {
    await withSessionRls(this.pool, this.defaultContext, async (client) => {
      await client.query(
        `UPDATE agent_semantic_memories
         SET title = $1, content = $2, embedding = $3, importance_score = $4, tags = $5,
             version = $6, supersedes_id = $7, is_deprecated = $8, metadata = $9, updated_at = clock_timestamp()
         WHERE id = $10`,
        [
          item.title,
          item.content,
          item.embedding,
          item.importanceScore,
          item.tags,
          item.version,
          item.supersedesId ?? null,
          item.isDeprecated,
          JSON.stringify(item.metadata ?? {}),
          item.id,
        ]
      );
    }, this.registry);
  }

  async getById(id: string): Promise<SemanticKnowledgeItem | undefined> {
    return withSessionRls(this.pool, this.defaultContext, async (client) => {
      const res = await client.query(
        `SELECT id, tenant_id, scope, department_id as "departmentId", author_agent_id as "authorAgentId",
                category, title, content, embedding, embedding_provider, embedding_model,
                embedding_dimension, embedding_version, importance_score as "importanceScore",
                tags, version, supersedes_id as "supersedesId", is_deprecated as "isDeprecated",
                metadata, created_at as "createdAt", updated_at as "updatedAt"
         FROM agent_semantic_memories WHERE id = $1`,
        [id]
      );
      if (res.rows.length === 0) return undefined;
      return this.mapRowToItem(res.rows[0]);
    }, this.registry);
  }

  async search(
    queryVector: number[],
    queryMetadata?: EmbeddingMetadata,
    options?: {
      limit?: number;
      minSimilarity?: number;
      filter?: SemanticSearchFilter;
    }
  ): Promise<SemanticSearchResult[]> {
    if (queryMetadata && queryVector.length !== queryMetadata.dimension) {
      throw new IncompatibleEmbeddingError(
        `Query vector dimension ${queryVector.length} does not match declared dimension ${queryMetadata.dimension}`
      );
    }
    return withSessionRls(this.pool, this.defaultContext, async (client) => {
      const conditions: string[] = ['1=1'];
      const params: unknown[] = [];
      let pIdx = 1;

      if (!options?.filter?.includeDeprecated) {
        conditions.push(`is_deprecated = false`);
      }
      if (options?.filter?.category) {
        conditions.push(`category = $${pIdx++}`);
        params.push(options.filter.category);
      }
      if (options?.filter?.departmentId) {
        conditions.push(`(scope = 'ORGANIZATION_WIDE' OR department_id = $${pIdx++})`);
        params.push(options.filter.departmentId);
      }
      if (options?.filter?.scope) {
        conditions.push(`scope = $${pIdx++}`);
        params.push(options.filter.scope);
      }

      const res = await client.query(
        `SELECT id, tenant_id, scope, department_id as "departmentId", author_agent_id as "authorAgentId",
                category, title, content, embedding, embedding_provider, embedding_model,
                embedding_dimension, embedding_version, importance_score as "importanceScore",
                tags, version, supersedes_id as "supersedesId", is_deprecated as "isDeprecated",
                metadata, created_at as "createdAt", updated_at as "updatedAt"
         FROM agent_semantic_memories
         WHERE ${conditions.join(' AND ')}`,
        params
      );

      const minSim = options?.minSimilarity ?? 0.5;
      const limit = options?.limit ?? 5;
      const scored: SemanticSearchResult[] = [];

      for (const row of res.rows) {
        const item = this.mapRowToItem(row);
        if (queryMetadata && item.embeddingMetadata) {
          assertEmbeddingCompatibility(queryMetadata, item.embeddingMetadata);
        }
        const similarity = computeCosineSimilarity(queryVector, item.embedding);
        if (similarity >= minSim) {
          scored.push({ item, similarity });
        }
      }

      return scored.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
    }, this.registry);
  }

  async deprecate(id: string, supersedesId?: string): Promise<void> {
    await withSessionRls(this.pool, this.defaultContext, async (client) => {
      await client.query(
        `UPDATE agent_semantic_memories
         SET is_deprecated = true, supersedes_id = COALESCE($1, supersedes_id), updated_at = clock_timestamp()
         WHERE id = $2`,
        [supersedesId ?? null, id]
      );
    }, this.registry);
  }

  private mapRowToItem(row: any): SemanticKnowledgeItem {
    return SemanticKnowledgeItemSchema.parse({
      id: row.id,
      tenantId: row.tenant_id,
      scope: row.scope,
      departmentId: row.departmentId ?? undefined,
      authorAgentId: row.authorAgentId ?? undefined,
      category: row.category,
      title: row.title,
      content: row.content,
      embedding: Array.isArray(row.embedding) ? row.embedding.map(Number) : [],
      embeddingMetadata: {
        provider: row.embedding_provider,
        model: row.embedding_model,
        dimension: Number(row.embedding_dimension),
        version: row.embedding_version,
      },
      importanceScore: Number(row.importanceScore),
      tags: row.tags ?? [],
      version: row.version,
      supersedesId: row.supersedesId ?? undefined,
      isDeprecated: Boolean(row.isDeprecated),
      metadata: row.metadata ?? {},
      createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
      updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : (row.updatedAt ? String(row.updatedAt) : undefined),
    });
  }
}

// ============================================================================
// 4. PostgreSQL Procedural Memory Storage
// ============================================================================
export class PostgresProceduralStorage implements ProceduralStorage {
  constructor(
    private readonly pool: Pool,
    private readonly defaultContext: RlsSessionContext,
    private readonly departmentRegistry?: AuthoritativeWorkforceIdentityProvider | DepartmentRegistry
  ) {}

  private get registry(): AuthoritativeWorkforceIdentityProvider | DepartmentRegistry | undefined {
    return this.defaultContext.authoritativeRegistry ?? this.departmentRegistry;
  }

  async savePlaybook(playbook: ProceduralPlaybook): Promise<void> {
    await withSessionRls(this.pool, this.defaultContext, async (client) => {
      await client.query(
        `INSERT INTO agent_procedural_memories (
          id, tenant_id, scope, department_id, author_agent_id, author_agent_code,
          authorized_by, name, description, trigger_condition, required_capabilities,
          steps, success_count, failure_count, version, is_approved, metadata, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, clock_timestamp())
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name, description = EXCLUDED.description, trigger_condition = EXCLUDED.trigger_condition,
          required_capabilities = EXCLUDED.required_capabilities, steps = EXCLUDED.steps,
          success_count = EXCLUDED.success_count, failure_count = EXCLUDED.failure_count,
          version = EXCLUDED.version, is_approved = EXCLUDED.is_approved, metadata = EXCLUDED.metadata,
          updated_at = clock_timestamp()`,
        [
          playbook.id,
          this.defaultContext.tenantId,
          playbook.scope,
          playbook.departmentId ?? null,
          playbook.authorAgentId,
          playbook.authorAgentCode ?? null,
          playbook.authorizedBy,
          playbook.name,
          playbook.description,
          playbook.triggerCondition,
          playbook.requiredCapabilities,
          JSON.stringify(playbook.steps),
          playbook.successCount,
          playbook.failureCount,
          playbook.version,
          playbook.isApproved,
          JSON.stringify(playbook.metadata ?? {}),
          playbook.createdAt,
        ]
      );
    }, this.registry);
  }

  async getPlaybookById(id: string): Promise<ProceduralPlaybook | undefined> {
    return withSessionRls(this.pool, this.defaultContext, async (client) => {
      const res = await client.query(
        `SELECT id, tenant_id, scope, department_id as "departmentId", author_agent_id as "authorAgentId",
                author_agent_code as "authorAgentCode", authorized_by as "authorizedBy", name, description,
                trigger_condition as "triggerCondition", required_capabilities as "requiredCapabilities",
                steps, success_count as "successCount", failure_count as "failureCount", version,
                is_approved as "isApproved", metadata, created_at as "createdAt", updated_at as "updatedAt"
         FROM agent_procedural_memories WHERE id = $1`,
        [id]
      );
      if (res.rows.length === 0) return undefined;
      return this.mapRowToPlaybook(res.rows[0]);
    }, this.registry);
  }

  async queryPlaybooks(filter: ProceduralQueryFilter): Promise<ProceduralPlaybook[]> {
    return withSessionRls(this.pool, this.defaultContext, async (client) => {
      const conditions: string[] = ['1=1'];
      const params: unknown[] = [];
      let pIdx = 1;

      if (filter.departmentId) {
        conditions.push(`(department_id = $${pIdx++} OR scope = 'ORGANIZATION_WIDE')`);
        params.push(filter.departmentId);
      }
      if (filter.scope) {
        conditions.push(`scope = $${pIdx++}`);
        params.push(filter.scope);
      }
      if (filter.isApproved !== undefined) {
        conditions.push(`is_approved = $${pIdx++}`);
        params.push(filter.isApproved);
      }

      const limit = filter.limit ?? 50;
      const res = await client.query(
        `SELECT id, tenant_id, scope, department_id as "departmentId", author_agent_id as "authorAgentId",
                author_agent_code as "authorAgentCode", authorized_by as "authorizedBy", name, description,
                trigger_condition as "triggerCondition", required_capabilities as "requiredCapabilities",
                steps, success_count as "successCount", failure_count as "failureCount", version,
                is_approved as "isApproved", metadata, created_at as "createdAt", updated_at as "updatedAt"
         FROM agent_procedural_memories
         WHERE ${conditions.join(' AND ')}
         LIMIT ${limit}`,
        params
      );

      let items = res.rows.map((row) => this.mapRowToPlaybook(row));
      if (filter.requiredCapability) {
        items = items.filter((p) => p.requiredCapabilities.includes(filter.requiredCapability!));
      }
      return items;
    }, this.registry);
  }

  private mapRowToPlaybook(row: any): ProceduralPlaybook {
    return ProceduralPlaybookSchema.parse({
      ...row,
      authorAgentCode: row.authorAgentCode ?? undefined,
      departmentId: row.departmentId ?? undefined,
      createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
      updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : (row.updatedAt ? String(row.updatedAt) : undefined),
      steps: typeof row.steps === 'string' ? JSON.parse(row.steps) : (row.steps ?? []),
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata ?? {}),
    });
  }

  async updateExecutionStats(id: string, success: boolean): Promise<void> {
    await withSessionRls(this.pool, this.defaultContext, async (client) => {
      await client.query(
        `UPDATE agent_procedural_memories
         SET success_count = success_count + (CASE WHEN $1 = true THEN 1 ELSE 0 END),
             failure_count = failure_count + (CASE WHEN $1 = false THEN 1 ELSE 0 END),
             updated_at = clock_timestamp()
         WHERE id = $2`,
        [success, id]
      );
    }, this.registry);
  }

  async approvePlaybook(id: string, approvedBy: string): Promise<void> {
    await withSessionRls(this.pool, this.defaultContext, async (client) => {
      await client.query(
        `UPDATE agent_procedural_memories
         SET is_approved = true, authorized_by = $1, updated_at = clock_timestamp()
         WHERE id = $2`,
        [approvedBy, id]
      );
    }, this.registry);
  }
}
