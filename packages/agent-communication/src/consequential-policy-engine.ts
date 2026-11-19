import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import {
  OWNER_PRINCIPAL_ID,
  CANONICAL_OWNER_PRINCIPAL,
  type DepartmentId,
} from '@vme/shared-types';

export type ConsequentialActionType =
  | 'LIVE_TRADING'
  | 'CAPITAL_TRANSFER'
  | 'EXTERNAL_OUTREACH'
  | 'BINDING_CONTRACT'
  | 'CREDENTIAL_ACCESS'
  | 'ACCOUNT_PERMISSION_CHANGE'
  | 'IRREVERSIBLE_OPERATION'
  | 'GOVERNANCE_OVERRIDE'
  | 'INFRASTRUCTURE_MUTATION';

export type ConsequentialAuthorizationStatus =
  | 'PENDING_OWNER_REVIEW'
  | 'APPROVED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'EXECUTED';

export interface ConsequentialPolicyRule {
  actionType: ConsequentialActionType;
  requiresOwnerApproval: boolean;
  maxValidityWindowMs: number;
  description: string;
}

export const CANONICAL_CONSEQUENTIAL_POLICIES: Record<ConsequentialActionType, ConsequentialPolicyRule> = {
  LIVE_TRADING: {
    actionType: 'LIVE_TRADING',
    requiresOwnerApproval: true,
    maxValidityWindowMs: 30 * 60 * 1000, // 30 minutes
    description: 'Execution of live financial market trades or orders deploying capital (FX, equities, crypto).',
  },
  CAPITAL_TRANSFER: {
    actionType: 'CAPITAL_TRANSFER',
    requiresOwnerApproval: true,
    maxValidityWindowMs: 15 * 60 * 1000, // 15 minutes
    description: 'Movement or allocation of real corporate funds or treasury assets.',
  },
  EXTERNAL_OUTREACH: {
    actionType: 'EXTERNAL_OUTREACH',
    requiresOwnerApproval: true,
    maxValidityWindowMs: 24 * 60 * 60 * 1000, // 24 hours
    description: 'Transmission of communications to external clients, counterparties, or public channels.',
  },
  BINDING_CONTRACT: {
    actionType: 'BINDING_CONTRACT',
    requiresOwnerApproval: true,
    maxValidityWindowMs: 48 * 60 * 60 * 1000, // 48 hours
    description: 'Execution or formal assent to legally binding agreements or contracts.',
  },
  CREDENTIAL_ACCESS: {
    actionType: 'CREDENTIAL_ACCESS',
    requiresOwnerApproval: true,
    maxValidityWindowMs: 15 * 60 * 1000, // 15 minutes
    description: 'Accessing, generating, or modifying sensitive cryptographic keys or production credentials.',
  },
  ACCOUNT_PERMISSION_CHANGE: {
    actionType: 'ACCOUNT_PERMISSION_CHANGE',
    requiresOwnerApproval: true,
    maxValidityWindowMs: 30 * 60 * 1000, // 30 minutes
    description: 'Modifying RBAC permissions, department assignments, or agent authorities.',
  },
  IRREVERSIBLE_OPERATION: {
    actionType: 'IRREVERSIBLE_OPERATION',
    requiresOwnerApproval: true,
    maxValidityWindowMs: 20 * 60 * 1000, // 20 minutes
    description: 'Destructive deletion of persistent storage, database truncations, or irreversible state changes.',
  },
  GOVERNANCE_OVERRIDE: {
    actionType: 'GOVERNANCE_OVERRIDE',
    requiresOwnerApproval: true,
    maxValidityWindowMs: 10 * 60 * 1000, // 10 minutes
    description: 'Overriding security, compliance, or hierarchical workforce invariants.',
  },
  INFRASTRUCTURE_MUTATION: {
    actionType: 'INFRASTRUCTURE_MUTATION',
    requiresOwnerApproval: true,
    maxValidityWindowMs: 60 * 60 * 1000, // 1 hour
    description: 'Production infrastructure modifications or irreversible data destruction.',
  },
};

export interface OwnerSessionClaims {
  principalId: string;
  email: string;
  sessionId: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

export interface OwnerAuthenticatedSession {
  principalId: string;
  email: string;
  sessionId: string;
  token: string;
  expiresAt: number;
}

export interface OwnerAuthenticationServiceOptions {
  secretKey?: string;
  requiredCredentials?: string;
}

/**
 * PROCESS RESTART PERSISTENCE NOTICE:
 * In the current implementation of OwnerAuthenticationService, active sessions
 * (`this.activeSessions: Map<string, OwnerSessionClaims>`) and revoked session IDs
 * (`this.revokedSessionIds: Set<string>`) are maintained in process-local memory.
 * 
 * Durability Characteristics:
 * - Session revocation and active session tracking DO NOT survive process restarts.
 * - When the Node.js process terminates or restarts, all in-memory active sessions are lost.
 *   Because unregistered sessions are strictly rejected, previously issued tokens will fail
 *   verification after a restart (fail-closed behavior).
 * - Similarly, in-memory revocation lists are reset on restart.
 * - For multi-process or high-availability deployments requiring persistent revocation across
 *   restarts, a persistent backing store (e.g. PostgreSQL `owner_revoked_sessions` table or Redis)
 *   must be integrated.
 */
export class OwnerAuthenticationService {
  private activeSessions = new Map<string, OwnerSessionClaims>();
  private revokedSessionIds = new Set<string>();
  private readonly secretKey: string | undefined;
  private readonly requiredCredentials: string | undefined;

  constructor(options?: string | OwnerAuthenticationServiceOptions) {
    if (typeof options === 'string') {
      this.secretKey = options.trim().length > 0 ? options : undefined;
      this.requiredCredentials =
        process.env.OWNER_AUTH_CREDENTIALS?.trim().length
          ? process.env.OWNER_AUTH_CREDENTIALS
          : (process.env.OWNER_CREDENTIALS?.trim().length ? process.env.OWNER_CREDENTIALS : undefined);
    } else if (options && typeof options === 'object') {
      this.secretKey =
        options.secretKey && options.secretKey.trim().length > 0
          ? options.secretKey
          : (process.env.OWNER_AUTH_SECRET?.trim().length ? process.env.OWNER_AUTH_SECRET : undefined);
      this.requiredCredentials =
        options.requiredCredentials && options.requiredCredentials.trim().length > 0
          ? options.requiredCredentials
          : (process.env.OWNER_AUTH_CREDENTIALS?.trim().length
              ? process.env.OWNER_AUTH_CREDENTIALS
              : (process.env.OWNER_CREDENTIALS?.trim().length ? process.env.OWNER_CREDENTIALS : undefined));
    } else {
      this.secretKey = process.env.OWNER_AUTH_SECRET?.trim().length
        ? process.env.OWNER_AUTH_SECRET
        : undefined;
      this.requiredCredentials = process.env.OWNER_AUTH_CREDENTIALS?.trim().length
        ? process.env.OWNER_AUTH_CREDENTIALS
        : (process.env.OWNER_CREDENTIALS?.trim().length ? process.env.OWNER_CREDENTIALS : undefined);
    }
  }

  /**
   * Generates a cryptographically signed Owner session.
   * Requires authentic canonical Owner principalId, canonical email, and valid credentials.
   * Fails closed if signing secret or required credentials configuration is missing.
   * Prevents non-Owner agents from creating Owner sessions.
   */
  createOwnerSession(params: {
    principalId: string;
    email: string;
    credentials?: string;
    sessionDurationMs?: number;
  }): OwnerAuthenticatedSession {
    // 1. Fail closed if HMAC signing secret is missing
    if (!this.secretKey || this.secretKey.trim().length === 0) {
      throw new UnauthorizedOwnerDecisionError(
        'Owner authentication failed: HMAC signing secret is missing. System failed closed.'
      );
    }

    // 2. Prevent non-Owner agents from creating Owner sessions (principalId check)
    if (params.principalId !== OWNER_PRINCIPAL_ID && params.principalId !== CANONICAL_OWNER_PRINCIPAL.principalId) {
      throw new UnauthorizedOwnerDecisionError(
        `Owner authentication failed: '${params.principalId}' is not the canonical Owner principal.`
      );
    }

    // 3. Prevent non-Owner agents from creating Owner sessions (email check)
    if (params.email !== CANONICAL_OWNER_PRINCIPAL.email && params.email !== 'stephenikeme@icloud.com') {
      throw new UnauthorizedOwnerDecisionError(
        `Owner authentication failed: email '${params.email}' does not match canonical Owner.`
      );
    }

    // 4. Do not authenticate the Owner using only their public ID or email; require credentials
    if (!params.credentials || params.credentials.trim().length === 0) {
      throw new UnauthorizedOwnerDecisionError(
        'Owner authentication failed: required Owner credentials are missing. Identity-only authentication rejected.'
      );
    }

    // 5. Fail closed if expected credentials configuration is missing
    if (!this.requiredCredentials || this.requiredCredentials.trim().length === 0) {
      throw new UnauthorizedOwnerDecisionError(
        'Owner authentication failed: required Owner credentials configuration is missing. System failed closed.'
      );
    }

    // 6. Timing-safe verification of supplied credentials against configured credentials
    const credBuf = Buffer.from(params.credentials, 'utf8');
    const reqBuf = Buffer.from(this.requiredCredentials, 'utf8');
    if (credBuf.length !== reqBuf.length || !timingSafeEqual(credBuf, reqBuf)) {
      throw new UnauthorizedOwnerDecisionError(
        'Owner authentication failed: invalid Owner credentials. Non-owner agents cannot create Owner sessions.'
      );
    }

    const sessionId = randomUUID();
    const nonce = randomUUID();
    const issuedAt = Date.now();
    const duration = params.sessionDurationMs ?? 4 * 60 * 60 * 1000;
    const expiresAt = issuedAt + duration;

    const claims: OwnerSessionClaims = {
      principalId: OWNER_PRINCIPAL_ID,
      email: params.email,
      sessionId,
      issuedAt,
      expiresAt,
      nonce,
    };

    const token = this.signClaims(claims);
    this.activeSessions.set(sessionId, claims);

    return {
      principalId: claims.principalId,
      email: claims.email,
      sessionId,
      token,
      expiresAt,
    };
  }

  /**
   * Cryptographically verifies an Owner authenticated session or signed token string.
   * Validates token signature, expiration, revocation status, and session identity.
   * Fails closed if signing secret is missing.
   */
  verifyOwnerSession(sessionOrToken: OwnerAuthenticatedSession | string): OwnerSessionClaims {
    // Fail closed if HMAC signing secret is missing
    if (!this.secretKey || this.secretKey.trim().length === 0) {
      throw new UnauthorizedOwnerDecisionError(
        'Owner authentication failed: HMAC signing secret is missing. System failed closed.'
      );
    }

    let token: string;
    if (typeof sessionOrToken === 'string') {
      token = sessionOrToken.trim();
    } else if (sessionOrToken && typeof sessionOrToken === 'object' && typeof sessionOrToken.token === 'string') {
      token = sessionOrToken.token.trim();
    } else {
      throw new UnauthorizedOwnerDecisionError('Invalid Owner session token provided.');
    }

    // Reject identity strings that are not signed tokens
    if (!token.includes('.')) {
      throw new UnauthorizedOwnerDecisionError(
        `Owner authentication failed: identity string '${token}' is not a signed token. Cryptographically signed Owner session required.`
      );
    }

    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new UnauthorizedOwnerDecisionError('Malformed Owner authorization token format.');
    }

    const [payloadB64, signature] = parts;
    const expectedSig = createHmac('sha256', this.secretKey).update(payloadB64).digest('hex');

    const sigBuf = Buffer.from(signature, 'hex');
    const expBuf = Buffer.from(expectedSig, 'hex');

    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      throw new UnauthorizedOwnerDecisionError('Cryptographic signature verification failed for Owner authorization token.');
    }

    let claims: OwnerSessionClaims;
    try {
      claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as OwnerSessionClaims;
    } catch {
      throw new UnauthorizedOwnerDecisionError('Corrupted Owner authorization token payload.');
    }

    if (!claims || typeof claims !== 'object' || !claims.sessionId || !claims.principalId || !claims.expiresAt) {
      throw new UnauthorizedOwnerDecisionError('Corrupted Owner authorization token claims structure.');
    }

    // Ensure explicitly revoked sessions cannot be accepted
    if (this.revokedSessionIds.has(claims.sessionId)) {
      throw new UnauthorizedOwnerDecisionError(`Owner session '${claims.sessionId}' has been revoked.`);
    }

    // Ensure unregistered or terminated sessions cannot be accepted
    if (!this.activeSessions.has(claims.sessionId)) {
      throw new UnauthorizedOwnerDecisionError(
        `Owner session '${claims.sessionId}' is not registered or has been terminated.`
      );
    }

    if (Date.now() > claims.expiresAt) {
      throw new UnauthorizedOwnerDecisionError(`Owner session '${claims.sessionId}' has expired.`);
    }

    if (claims.principalId !== OWNER_PRINCIPAL_ID && claims.principalId !== CANONICAL_OWNER_PRINCIPAL.principalId) {
      throw new UnauthorizedOwnerDecisionError(`Principal '${claims.principalId}' is not the canonical Owner.`);
    }

    if (claims.email !== CANONICAL_OWNER_PRINCIPAL.email && claims.email !== 'stephenikeme@icloud.com') {
      throw new UnauthorizedOwnerDecisionError(`Owner email '${claims.email}' does not match canonical Owner.`);
    }

    return claims;
  }

  revokeSession(sessionId: string): void {
    this.revokedSessionIds.add(sessionId);
    this.activeSessions.delete(sessionId);
  }

  private signClaims(claims: OwnerSessionClaims): string {
    if (!this.secretKey) {
      throw new UnauthorizedOwnerDecisionError(
        'Owner authentication failed: HMAC signing secret is missing. System failed closed.'
      );
    }
    const payloadB64 = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
    const signature = createHmac('sha256', this.secretKey).update(payloadB64).digest('hex');
    return `${payloadB64}.${signature}`;
  }
}

export interface ConsequentialAuthorizationRecord {
  id: string;
  tenantId: string;
  taskId: string;
  actionType: ConsequentialActionType;
  agentId: string;
  departmentId: DepartmentId;
  counterparty?: string;
  payload: Record<string, unknown>;
  parameterHash: string;
  status: ConsequentialAuthorizationStatus;
  requestedAt: string;
  validUntil: string;
  decidedBy?: string;
  decisionNotes?: string;
  decidedAt?: string;
  executedAt?: string;
  executionStatus?: string;
  executionResult?: Record<string, unknown>;
}

export class ConsequentialPolicyViolationError extends Error {
  constructor(message: string) {
    super(`CONSEQUENTIAL POLICY VIOLATION: ${message}`);
    this.name = 'ConsequentialPolicyViolationError';
  }
}

export class UnauthorizedOwnerDecisionError extends Error {
  constructor(message: string) {
    super(`OWNER GOVERNANCE VIOLATION: ${message}`);
    this.name = 'UnauthorizedOwnerDecisionError';
  }
}

/**
 * Computes a deterministic SHA-256 hash of normalized parameters.
 */
export function computeParameterHash(payload: Record<string, unknown>): string {
  const sortedKeys = Object.keys(payload).sort();
  const normalized: Record<string, unknown> = {};
  for (const k of sortedKeys) {
    normalized[k] = payload[k];
  }
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

export interface ConsequentialPolicyEngineOptions {
  pool?: Pool;
  tenantId?: string;
  policies?: Partial<Record<ConsequentialActionType, ConsequentialPolicyRule>>;
  authService?: OwnerAuthenticationService;
}

/**
 * Production-Grade Consequential Action Policy Engine.
 * Enforces the complete 10-step Owner Authorization & Execution Lifecycle.
 */
export class ConsequentialPolicyEngine {
  private inMemoryRecords = new Map<string, ConsequentialAuthorizationRecord>();
  private readonly pool?: Pool;
  private readonly tenantId: string;
  private readonly policies: Record<ConsequentialActionType, ConsequentialPolicyRule>;
  public readonly authService: OwnerAuthenticationService;

  constructor(options?: ConsequentialPolicyEngineOptions) {
    this.pool = options?.pool;
    this.tenantId = options?.tenantId ?? '00000000-0000-0000-0000-000000000001';
    this.policies = { ...CANONICAL_CONSEQUENTIAL_POLICIES, ...(options?.policies ?? {}) };
    this.authService = options?.authService ?? new OwnerAuthenticationService();
  }

  /**
   * Step 1 & 2 & 3 & 4: Ingest proposed action, classify against policy,
   * quarantine, compute SHA-256 parameter hash, and generate bound authorization request.
   */
  async quarantineAction(params: {
    id?: string;
    taskId: string;
    actionType: ConsequentialActionType;
    agentId: string;
    departmentId: DepartmentId;
    payload: Record<string, unknown>;
    counterparty?: string;
  }): Promise<ConsequentialAuthorizationRecord> {
    const policy = this.policies[params.actionType];
    if (!policy) {
      throw new ConsequentialPolicyViolationError(
        `Unknown consequential action classification: ${params.actionType}`
      );
    }

    const parameterHash = computeParameterHash(params.payload);
    const requestedAt = new Date().toISOString();
    const validUntil = new Date(Date.now() + policy.maxValidityWindowMs).toISOString();
    const id = params.id ?? `auth-${Date.now()}-${randomUUID().slice(0, 8)}`;

    const record: ConsequentialAuthorizationRecord = {
      id,
      tenantId: this.tenantId,
      taskId: params.taskId,
      actionType: params.actionType,
      agentId: params.agentId,
      departmentId: params.departmentId,
      counterparty: params.counterparty,
      payload: params.payload,
      parameterHash,
      status: 'PENDING_OWNER_REVIEW',
      requestedAt,
      validUntil,
    };

    if (this.pool) {
      const client = await this.pool.connect();
      try {
        await client.query(
          `INSERT INTO consequential_authorization_requests (
            id, tenant_id, task_id, action_type, agent_id, department_id,
            counterparty, parameter_hash, payload, status, requested_at, valid_until
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            record.id,
            record.tenantId,
            record.taskId,
            record.actionType,
            record.agentId,
            record.departmentId,
            record.counterparty ?? null,
            record.parameterHash,
            JSON.stringify(record.payload),
            record.status,
            record.requestedAt,
            record.validUntil,
          ]
        );
      } finally {
        client.release();
      }
    } else {
      this.inMemoryRecords.set(record.id, record);
    }

    return record;
  }

  /**
   * Step 5: Owner Authorization & Sign-off.
   * Strictly enforces that ONLY authentic Owner principal can approve or reject consequential actions.
   * Exclusively requires a verified OwnerAuthenticatedSession or cryptographically signed token string.
   * Authenticating the Owner using only public ID, email, or caller-supplied identity strings is barred.
   */
  async resolveAuthorization(
    requestId: string,
    decision: 'APPROVED' | 'REJECTED',
    auth: OwnerAuthenticatedSession | string,
    decisionNotes?: string
  ): Promise<ConsequentialAuthorizationRecord> {
    let verifiedPrincipal: string;

    if (typeof auth === 'object' && auth !== null && 'token' in auth && typeof auth.token === 'string') {
      const claims = this.authService.verifyOwnerSession(auth);
      verifiedPrincipal = claims.principalId;
    } else if (typeof auth === 'string' && auth.includes('.')) {
      const claims = this.authService.verifyOwnerSession(auth);
      verifiedPrincipal = claims.principalId;
    } else {
      throw new UnauthorizedOwnerDecisionError(
        `Owner authorization strictly requires a valid cryptographically signed Owner session. Unverified identity or caller string '${typeof auth === 'object' ? JSON.stringify(auth) : auth}' is prohibited.`
      );
    }

    const record = await this.getRequestById(requestId);
    if (!record) {
      throw new ConsequentialPolicyViolationError(
        `Authorization request not found: ${requestId}`
      );
    }

    if (record.status !== 'PENDING_OWNER_REVIEW') {
      throw new ConsequentialPolicyViolationError(
        `Cannot resolve request ${requestId}: current status is '${record.status}'.`
      );
    }

    // Check expiration
    if (new Date(record.validUntil).getTime() < Date.now()) {
      record.status = 'EXPIRED';
      await this.updateRecordStatus(record);
      throw new ConsequentialPolicyViolationError(
        `Authorization request ${requestId} has expired (valid until ${record.validUntil}).`
      );
    }

    record.status = decision;
    record.decidedBy = verifiedPrincipal;
    record.decidedAt = new Date().toISOString();
    record.decisionNotes = decisionNotes;

    await this.updateRecordStatus(record);
    return record;
  }

  /**
   * Step 6: Pre-Execution Revalidation.
   * Verifies that the approval is valid, not expired, not replayed, and that the payload has NOT been altered
   * by verifying the cryptographic parameter hash.
   */
  async revalidateForExecution(
    requestId: string,
    payloadToExecute: Record<string, unknown>
  ): Promise<ConsequentialAuthorizationRecord> {
    const record = await this.getRequestById(requestId);
    if (!record) {
      throw new ConsequentialPolicyViolationError(
        `Authorization request not found for revalidation: ${requestId}`
      );
    }

    if (record.status === 'EXECUTED') {
      throw new ConsequentialPolicyViolationError(
        `Replay attack prevented: Consequential action ${requestId} has already been executed.`
      );
    }

    if (record.status !== 'APPROVED') {
      throw new ConsequentialPolicyViolationError(
        `Cannot execute consequential action ${requestId}: status is '${record.status}'. Owner approval is required.`
      );
    }

    // Check validity window
    if (new Date(record.validUntil).getTime() < Date.now()) {
      record.status = 'EXPIRED';
      await this.updateRecordStatus(record);
      throw new ConsequentialPolicyViolationError(
        `Cannot execute consequential action ${requestId}: approval has expired.`
      );
    }

    // Cryptographic Parameter Hash Verification
    const currentHash = computeParameterHash(payloadToExecute);
    if (currentHash !== record.parameterHash) {
      throw new ConsequentialPolicyViolationError(
        `Cryptographic parameter hash mismatch! Authorized hash '${record.parameterHash}' does not match execution payload hash '${currentHash}'. Parameter tampering detected.`
      );
    }

    return record;
  }

  /**
   * Step 7 & 8: Record Execution Outcome and Evidence.
   */
  async recordExecutionOutcome(
    requestId: string,
    executionStatus: 'SUCCESS' | 'FAILED',
    executionResult: Record<string, unknown>
  ): Promise<void> {
    const record = await this.getRequestById(requestId);
    if (!record) return;

    record.status = 'EXECUTED';
    record.executedAt = new Date().toISOString();
    record.executionStatus = executionStatus;
    record.executionResult = executionResult;

    await this.updateRecordStatus(record);
  }

  async getRequestById(id: string): Promise<ConsequentialAuthorizationRecord | undefined> {
    if (this.pool) {
      const client = await this.pool.connect();
      try {
        const res = await client.query(
          `SELECT id, tenant_id as "tenantId", task_id as "taskId", action_type as "actionType",
                  agent_id as "agentId", department_id as "departmentId", counterparty,
                  parameter_hash as "parameterHash", payload, status, requested_at as "requestedAt",
                  valid_until as "validUntil", decided_by as "decidedBy", decided_at as "decidedAt",
                  decision_notes as "decisionNotes", executed_at as "executedAt",
                  execution_status as "executionStatus", execution_result as "executionResult"
           FROM consequential_authorization_requests
           WHERE id = $1 AND tenant_id = $2`,
          [id, this.tenantId]
        );
        if (res.rows.length === 0) return undefined;
        const row = res.rows[0];
        return {
          ...row,
          payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload ?? {}),
          executionResult: typeof row.executionResult === 'string' ? JSON.parse(row.executionResult) : (row.executionResult ?? undefined),
        };
      } finally {
        client.release();
      }
    } else {
      return this.inMemoryRecords.get(id);
    }
  }

  async getPendingRequests(): Promise<ConsequentialAuthorizationRecord[]> {
    if (this.pool) {
      const client = await this.pool.connect();
      try {
        const res = await client.query(
          `SELECT id, tenant_id as "tenantId", task_id as "taskId", action_type as "actionType",
                  agent_id as "agentId", department_id as "departmentId", counterparty,
                  parameter_hash as "parameterHash", payload, status, requested_at as "requestedAt",
                  valid_until as "validUntil", decided_by as "decidedBy", decided_at as "decidedAt",
                  decision_notes as "decisionNotes", executed_at as "executedAt",
                  execution_status as "executionStatus", execution_result as "executionResult"
           FROM consequential_authorization_requests
           WHERE tenant_id = $1 AND status = 'PENDING_OWNER_REVIEW'
           ORDER BY requested_at ASC`,
          [this.tenantId]
        );
        return res.rows.map((row) => ({
          ...row,
          payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload ?? {}),
        }));
      } finally {
        client.release();
      }
    } else {
      return Array.from(this.inMemoryRecords.values()).filter(
        (r) => r.status === 'PENDING_OWNER_REVIEW'
      );
    }
  }

  private async updateRecordStatus(record: ConsequentialAuthorizationRecord): Promise<void> {
    if (this.pool) {
      const client = await this.pool.connect();
      try {
        await client.query(
          `UPDATE consequential_authorization_requests
           SET status = $1, decided_by = $2, decided_at = $3, decision_notes = $4,
               executed_at = $5, execution_status = $6, execution_result = $7
           WHERE id = $8 AND tenant_id = $9`,
          [
            record.status,
            record.decidedBy ?? null,
            record.decidedAt ?? null,
            record.decisionNotes ?? null,
            record.executedAt ?? null,
            record.executionStatus ?? null,
            record.executionResult ? JSON.stringify(record.executionResult) : null,
            record.id,
            this.tenantId,
          ]
        );
      } finally {
        client.release();
      }
    } else {
      this.inMemoryRecords.set(record.id, record);
    }
  }
}
