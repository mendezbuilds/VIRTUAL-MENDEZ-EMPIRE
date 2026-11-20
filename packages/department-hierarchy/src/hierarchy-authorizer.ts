import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  OWNER_PRINCIPAL_ID,
  CANONICAL_OWNER_PRINCIPAL,
  CANONICAL_FOUNDING_AGENTS,
  type AgentRecord,
  type DepartmentId,
} from '@vme/shared-types';
import {
  OwnerAuthenticationService,
  type OwnerAuthenticatedSession,
  type OwnerSessionClaims,
} from '@vme/security-governance';
import { UnauthorizedHierarchyActionError } from './delegation-rules.js';

/**
 * Retrieves the securely provisioned DB_SESSION_SECRET from the environment.
 * Fails closed if the secret is missing or has insufficient entropy (< 32 characters).
 * Fallback or hardcoded secrets are strictly prohibited.
 */
export function getHierarchyAuthoritySecret(): string {
  const secret = process.env.DB_SESSION_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new UnauthorizedHierarchyActionError(
      'CRITICAL SECURITY CONFIGURATION ERROR: DB_SESSION_SECRET must be independently provisioned with at least 32 characters of high entropy. Failing closed; fallback secrets are strictly prohibited.'
    );
  }
  return secret;
}

export interface ExecutiveSessionClaims {
  agentId: string;
  agentCode: string;
  departmentId: DepartmentId;
  principalLevel: 'EXECUTIVE';
  sessionId: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

export interface ExecutiveAuthenticatedSession {
  agentId: string;
  agentCode: string;
  sessionId: string;
  token: string;
  expiresAt: number;
}

/**
 * Enterprise Executive Authentication & Session Management Service.
 * Produces and cryptographically verifies authenticated Executive sessions.
 * Anchored to the provisioned DB_SESSION_SECRET and workforce registry.
 */
export class ExecutiveAuthenticationService {
  private activeSessions = new Map<string, ExecutiveSessionClaims>();
  private revokedSessionIds = new Set<string>();

  createExecutiveSession(
    params: {
      agentIdOrCode: string;
      sessionDurationMs?: number;
    },
    agents: Map<string, AgentRecord> | AgentRecord[],
    secret: string = getHierarchyAuthoritySecret()
  ): ExecutiveAuthenticatedSession {
    const agentList = Array.isArray(agents) ? agents : Array.from(agents.values());
    const agent = agentList.find(
      (a) => a.id === params.agentIdOrCode || a.agentCode === params.agentIdOrCode
    );

    if (!agent) {
      throw new UnauthorizedHierarchyActionError(
        `Executive authentication failed: Agent '${params.agentIdOrCode}' not found in workforce registry`
      );
    }

    if (agent.level !== 'EXECUTIVE' || agent.departmentId !== 'executive_office') {
      throw new UnauthorizedHierarchyActionError(
        `Executive authentication failed: Agent '${agent.agentCode}' is registered with level '${agent.level}' in '${agent.departmentId}', not 'EXECUTIVE' in 'executive_office'`
      );
    }

    if (agent.operationalStatus !== 'ACTIVE') {
      throw new UnauthorizedHierarchyActionError(
        `Executive authentication failed: Agent '${agent.agentCode}' is inactive (${agent.operationalStatus})`
      );
    }

    const sessionId = randomUUID();
    const nonce = randomUUID();
    const issuedAt = Date.now();
    const duration = params.sessionDurationMs ?? 4 * 60 * 60 * 1000;
    const expiresAt = issuedAt + duration;

    const claims: ExecutiveSessionClaims = {
      agentId: agent.id,
      agentCode: agent.agentCode,
      departmentId: agent.departmentId,
      principalLevel: 'EXECUTIVE',
      sessionId,
      issuedAt,
      expiresAt,
      nonce,
    };

    const payloadB64 = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
    const signature = createHmac('sha256', secret).update(payloadB64).digest('hex');
    const token = `${payloadB64}.${signature}`;

    this.activeSessions.set(sessionId, claims);

    return {
      agentId: claims.agentId,
      agentCode: claims.agentCode,
      sessionId,
      token,
      expiresAt,
    };
  }

  verifyExecutiveSession(
    sessionOrToken: ExecutiveAuthenticatedSession | string | { claimsPayload?: Record<string, unknown>; signature?: string },
    agents: Map<string, AgentRecord> | AgentRecord[],
    secret: string = getHierarchyAuthoritySecret()
  ): ExecutiveSessionClaims {
    // Check if passed as database claims payload + signature
    if (
      sessionOrToken &&
      typeof sessionOrToken === 'object' &&
      'claimsPayload' in sessionOrToken &&
      sessionOrToken.claimsPayload &&
      typeof sessionOrToken.claimsPayload === 'object' &&
      typeof (sessionOrToken as any).signature === 'string'
    ) {
      const payload = sessionOrToken.claimsPayload as Record<string, unknown>;
      const signature = (sessionOrToken as any).signature as string;

      const canonical = [
        payload.tenantId ?? '',
        payload.agentId ?? '',
        payload.departmentId ?? '',
        payload.principalLevel ?? 'SPECIALIST',
        payload.isOwner === true ? 'true' : 'false',
        String(payload.expiresAt ?? 0),
        payload.nonce ?? '',
      ].join(':');

      const expectedSig = createHmac('sha256', secret).update(canonical).digest('hex');
      const sigBuf = Buffer.from(signature, 'hex');
      const expBuf = Buffer.from(expectedSig, 'hex');

      if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
        throw new UnauthorizedHierarchyActionError(
          'Executive authentication failed: Cryptographic signature verification failed for database session claims.'
        );
      }

      if (payload.principalLevel !== 'EXECUTIVE') {
        throw new UnauthorizedHierarchyActionError(
          `Executive authentication failed: Principal level '${payload.principalLevel}' is not EXECUTIVE.`
        );
      }

      const agentList = Array.isArray(agents) ? agents : Array.from(agents.values());
      const agent = agentList.find((a) => a.id === payload.agentId || a.agentCode === payload.agentCode);
      if (!agent || agent.level !== 'EXECUTIVE' || agent.operationalStatus !== 'ACTIVE' || agent.departmentId !== 'executive_office') {
        throw new UnauthorizedHierarchyActionError(
          `Executive authentication failed: Agent '${payload.agentId}' is not an active Executive in executive_office.`
        );
      }

      return {
        agentId: agent.id,
        agentCode: agent.agentCode,
        departmentId: agent.departmentId,
        principalLevel: 'EXECUTIVE',
        sessionId: String(payload.nonce ?? randomUUID()),
        issuedAt: Date.now() - 1000,
        expiresAt: Number(payload.expiresAt ?? Date.now() + 3600000),
        nonce: String(payload.nonce ?? ''),
      };
    }

    let token: string;
    if (typeof sessionOrToken === 'string') {
      token = sessionOrToken.trim();
    } else if (
      sessionOrToken &&
      typeof sessionOrToken === 'object' &&
      typeof (sessionOrToken as any).token === 'string'
    ) {
      token = (sessionOrToken as any).token.trim();
    } else {
      throw new UnauthorizedHierarchyActionError(
        'Executive authentication failed: Invalid session token provided.'
      );
    }

    if (!token.includes('.')) {
      throw new UnauthorizedHierarchyActionError(
        `Executive authentication failed: Identity string '${token}' is not a signed token. A cryptographically signed executive session is required.`
      );
    }

    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new UnauthorizedHierarchyActionError(
        'Executive authentication failed: Malformed executive session token format.'
      );
    }

    const [payloadB64, signature] = parts;
    const expectedSig = createHmac('sha256', secret).update(payloadB64).digest('hex');
    const sigBuf = Buffer.from(signature, 'hex');
    const expBuf = Buffer.from(expectedSig, 'hex');

    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      throw new UnauthorizedHierarchyActionError(
        'Executive authentication failed: Cryptographic signature verification failed for executive session token.'
      );
    }

    let claims: ExecutiveSessionClaims;
    try {
      claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as ExecutiveSessionClaims;
    } catch {
      throw new UnauthorizedHierarchyActionError(
        'Executive authentication failed: Corrupted executive session token payload.'
      );
    }

    if (this.revokedSessionIds.has(claims.sessionId)) {
      throw new UnauthorizedHierarchyActionError(
        `Executive authentication failed: Executive session '${claims.sessionId}' has been revoked.`
      );
    }

    if (!this.activeSessions.has(claims.sessionId)) {
      throw new UnauthorizedHierarchyActionError(
        `Executive authentication failed: Executive session '${claims.sessionId}' is not active or has been terminated.`
      );
    }

    if (Date.now() > claims.expiresAt) {
      throw new UnauthorizedHierarchyActionError(
        `Executive authentication failed: Executive session '${claims.sessionId}' has expired.`
      );
    }

    // Verify active appointment in workforce registry
    const agentList = Array.isArray(agents) ? agents : Array.from(agents.values());
    const agent = agentList.find((a) => a.id === claims.agentId && a.agentCode === claims.agentCode);
    if (!agent) {
      throw new UnauthorizedHierarchyActionError(
        `Executive authentication failed: Executive '${claims.agentCode}' is not registered in the active workforce.`
      );
    }

    if (agent.level !== 'EXECUTIVE' || agent.operationalStatus !== 'ACTIVE' || agent.departmentId !== 'executive_office') {
      throw new UnauthorizedHierarchyActionError(
        `Executive authentication failed: Agent '${agent.agentCode}' is not an active Executive in executive_office.`
      );
    }

    return claims;
  }

  revokeSession(sessionId: string, _reason?: string): void {
    this.revokedSessionIds.add(sessionId);
    this.activeSessions.delete(sessionId);
  }

  isSessionActive(sessionId: string): boolean {
    return this.activeSessions.has(sessionId) && !this.revokedSessionIds.has(sessionId);
  }
}

export interface HierarchyAuthorizationParams {
  authorizedBy?: unknown;
  authorizerSession?: unknown;
  ownerSession?: unknown;
  executiveSession?: unknown;
  ownerAuthService?: OwnerAuthenticationService;
  executiveAuthService?: ExecutiveAuthenticationService;
}

/**
 * Authenticates the authorizer and evaluates their operational authority BEFORE hierarchy mutation.
 * Rejects identity strings alone (Owner IDs or Executive codes/IDs without verified sessions).
 * Returns the verified authorizer identifier ('OWNER_PRINCIPAL_ID' or executive agentCode).
 */
export function verifyHierarchyAuthorization(
  params: HierarchyAuthorizationParams,
  action: 'APPOINT_DIRECTOR' | 'TRANSFER_AGENT',
  departmentId: DepartmentId,
  targetAgent: AgentRecord | null,
  agents: Map<string, AgentRecord> | AgentRecord[],
  secret: string = getHierarchyAuthoritySecret(),
  ownerAuthService?: OwnerAuthenticationService,
  executiveAuthService?: ExecutiveAuthenticationService
): string {
  // 1. Identify supplied credentials / sessions
  const ownerCandidate =
    params.ownerSession ??
    (params.authorizerSession && typeof params.authorizerSession === 'object' && 'principalId' in params.authorizerSession
      ? params.authorizerSession
      : undefined) ??
    (params.authorizedBy && typeof params.authorizedBy === 'object' && 'principalId' in (params.authorizedBy as any)
      ? params.authorizedBy
      : undefined);

  const execCandidate =
    params.executiveSession ??
    (params.authorizerSession && typeof params.authorizerSession === 'object' && 'agentCode' in params.authorizerSession
      ? params.authorizerSession
      : undefined) ??
    (params.authorizedBy && typeof params.authorizedBy === 'object' && ('agentCode' in (params.authorizedBy as any) || 'claimsPayload' in (params.authorizedBy as any))
      ? params.authorizedBy
      : undefined) ??
    (typeof params.authorizerSession === 'string' && params.authorizerSession.includes('.') && !params.ownerSession
      ? params.authorizerSession
      : undefined);

  // 2. Reject identity strings passed alone without authentic sessions
  if (!ownerCandidate && !execCandidate) {
    if (typeof params.authorizedBy === 'string' && params.authorizedBy.trim().length > 0) {
      const authStr = params.authorizedBy.trim();
      if (authStr === OWNER_PRINCIPAL_ID || authStr === CANONICAL_OWNER_PRINCIPAL.principalId) {
        throw new UnauthorizedHierarchyActionError(
          'Hierarchy authorization rejected: Supplying only the Owner ID cannot authorize an appointment or transfer. A verified Owner session from OwnerAuthenticationService is required.'
        );
      }
      if (authStr === 'EXEC-CEO') {
        throw new UnauthorizedHierarchyActionError(
          "Hierarchy authorization rejected: Supplying only 'EXEC-CEO' cannot authorize an appointment or transfer. A verified executive authentication session is required."
        );
      }
      throw new UnauthorizedHierarchyActionError(
        `Hierarchy authorization rejected: Supplying identity string '${authStr}' alone cannot authorize an appointment or transfer. A verified authentication credential or session from the authorizing principal is required.`
      );
    }
    throw new UnauthorizedHierarchyActionError(
      'Hierarchy authorization rejected: Missing authorizer authentication credential or session.'
    );
  }

  // 3. Process Owner Authentication
  if (ownerCandidate) {
    const authService = ownerAuthService ?? new OwnerAuthenticationService();
    try {
      const claims = authService.verifyOwnerSession(ownerCandidate as any);
      if (claims.principalId !== OWNER_PRINCIPAL_ID && claims.principalId !== CANONICAL_OWNER_PRINCIPAL.principalId) {
        throw new UnauthorizedHierarchyActionError('Principal in Owner session is not the canonical Owner.');
      }
      // Owner possesses unrestricted authority across all departments and executive offices
      return OWNER_PRINCIPAL_ID;
    } catch (err: unknown) {
      if (err instanceof UnauthorizedHierarchyActionError) throw err;
      throw new UnauthorizedHierarchyActionError(
        `Owner session verification failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // 4. Process Executive Authentication
  if (execCandidate) {
    const execService = executiveAuthService ?? new ExecutiveAuthenticationService();
    const claims = execService.verifyExecutiveSession(execCandidate as any, agents, secret);

    // Validate executive authority scope:
    if (action === 'APPOINT_DIRECTOR') {
      if (departmentId === 'executive_office') {
        throw new UnauthorizedHierarchyActionError(
          `Executive Office leadership appointments strictly require human Owner authorization. Executive '${claims.agentCode}' lacks authority.`
        );
      }
      if (claims.agentCode !== 'EXEC-CEO') {
        throw new UnauthorizedHierarchyActionError(
          `Executive '${claims.agentCode}' lacks authority to appoint directors. Functional department leadership appointments require CEO or Owner authorization.`
        );
      }
    } else if (action === 'TRANSFER_AGENT') {
      if (departmentId === 'executive_office') {
        throw new UnauthorizedHierarchyActionError(
          `Transfers involving Executive Office strictly require human Owner authorization. Executive '${claims.agentCode}' lacks authority.`
        );
      }
      if (targetAgent && (targetAgent.level === 'EXECUTIVE' || targetAgent.departmentId === 'executive_office')) {
        throw new UnauthorizedHierarchyActionError(
          `Transfers involving Executive Office strictly require human Owner authorization. Executive '${claims.agentCode}' lacks authority.`
        );
      }
      if (claims.agentCode !== 'EXEC-CEO') {
        throw new UnauthorizedHierarchyActionError(
          `Executive '${claims.agentCode}' lacks authority to authorize department transfers. Transfers require CEO or Owner authorization.`
        );
      }
    }

    return claims.agentCode;
  }

  throw new UnauthorizedHierarchyActionError(
    'Hierarchy authorization rejected: No valid authorizer session could be authenticated.'
  );
}
