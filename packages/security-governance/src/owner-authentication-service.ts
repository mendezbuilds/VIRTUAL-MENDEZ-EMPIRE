import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  OWNER_PRINCIPAL_ID,
  CANONICAL_OWNER_PRINCIPAL,
} from '@vme/shared-types';
import {
  type OwnerSessionClaims,
  UnauthorizedOwnerSessionError,
} from './owner-session-verifier.js';

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

export class UnauthorizedOwnerDecisionError extends Error {
  constructor(message: string) {
    super(`UNAUTHORIZED OWNER DECISION: ${message}`);
    this.name = 'UnauthorizedOwnerDecisionError';
  }
}

/**
 * Enterprise Owner Authentication & Session Management Service.
 * Produces and cryptographically verifies authenticated Owner sessions.
 * Fails closed if signing secret or required credentials configuration is missing.
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
   */
  createOwnerSession(params: {
    principalId: string;
    email: string;
    credentials?: string;
    reason?: string;
    sessionDurationMs?: number;
  }): OwnerAuthenticatedSession {
    if (!this.secretKey || this.secretKey.trim().length === 0) {
      throw new UnauthorizedOwnerDecisionError(
        'Owner authentication failed: HMAC signing secret is missing. System failed closed.'
      );
    }

    if (params.principalId !== OWNER_PRINCIPAL_ID && params.principalId !== CANONICAL_OWNER_PRINCIPAL.principalId) {
      throw new UnauthorizedOwnerDecisionError(
        `Owner authentication failed: '${params.principalId}' is not the canonical Owner principal.`
      );
    }

    if (params.email !== CANONICAL_OWNER_PRINCIPAL.email && params.email !== 'stephenikeme@icloud.com') {
      throw new UnauthorizedOwnerDecisionError(
        `Owner authentication failed: email '${params.email}' does not match canonical Owner.`
      );
    }

    if (!params.credentials || params.credentials.trim().length === 0) {
      throw new UnauthorizedOwnerDecisionError(
        'Owner authentication failed: required Owner credentials are missing. Identity-only authentication rejected.'
      );
    }

    if (!this.requiredCredentials || this.requiredCredentials.trim().length === 0) {
      throw new UnauthorizedOwnerDecisionError(
        'Owner authentication failed: required Owner credentials configuration is missing. System failed closed.'
      );
    }

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
    if (!this.secretKey || this.secretKey.trim().length === 0) {
      throw new UnauthorizedOwnerDecisionError(
        'Owner authentication failed: HMAC signing secret is missing. System failed closed.'
      );
    }

    let token: string;
    if (typeof sessionOrToken === 'string') {
      token = sessionOrToken.trim();
    } else if (sessionOrToken && typeof sessionOrToken === 'object' && typeof (sessionOrToken as any).token === 'string') {
      token = (sessionOrToken as any).token.trim();
    } else {
      throw new UnauthorizedOwnerDecisionError('Invalid Owner session token provided.');
    }

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

    if (this.revokedSessionIds.has(claims.sessionId)) {
      throw new UnauthorizedOwnerDecisionError(`Owner session '${claims.sessionId}' has been revoked.`);
    }

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

  revokeSession(sessionId: string, _reason?: string): void {
    this.revokedSessionIds.add(sessionId);
    this.activeSessions.delete(sessionId);
  }

  isSessionActive(sessionId: string): boolean {
    return this.activeSessions.has(sessionId) && !this.revokedSessionIds.has(sessionId);
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
