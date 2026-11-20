import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  OWNER_PRINCIPAL_ID,
  CANONICAL_OWNER_PRINCIPAL,
} from '@vme/shared-types';

export interface OwnerSessionClaims {
  principalId: string;
  email: string;
  sessionId: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

export class UnauthorizedOwnerSessionError extends Error {
  constructor(message: string) {
    super(`UNAUTHORIZED OWNER SESSION: ${message}`);
    this.name = 'UnauthorizedOwnerSessionError';
  }
}

/**
 * Cryptographically verifies an Owner authenticated session token string.
 * Validates HMAC-SHA256 signature, expiry, canonical owner principal ID and email.
 * Fails closed if signing secret is missing.
 */
export function verifyOwnerSessionToken(
  sessionOrToken: unknown,
  secretKey: string = process.env.OWNER_AUTH_SECRET ?? ''
): OwnerSessionClaims {
  if (!secretKey || secretKey.trim().length === 0) {
    throw new UnauthorizedOwnerSessionError(
      'Owner authentication failed: HMAC signing secret is missing. System failed closed.'
    );
  }

  let token: string;
  if (typeof sessionOrToken === 'string') {
    token = sessionOrToken.trim();
  } else if (
    sessionOrToken &&
    typeof sessionOrToken === 'object' &&
    'token' in sessionOrToken &&
    typeof (sessionOrToken as any).token === 'string'
  ) {
    token = (sessionOrToken as any).token.trim();
  } else {
    throw new UnauthorizedOwnerSessionError('Invalid Owner session token provided.');
  }

  if (!token.includes('.')) {
    throw new UnauthorizedOwnerSessionError(
      `Owner authentication failed: identity string '${token}' is not a signed token. Cryptographically signed Owner session required.`
    );
  }

  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new UnauthorizedOwnerSessionError('Malformed Owner authorization token format.');
  }

  const [payloadB64, signature] = parts;
  const expectedSig = createHmac('sha256', secretKey).update(payloadB64).digest('hex');

  const sigBuf = Buffer.from(signature, 'hex');
  const expBuf = Buffer.from(expectedSig, 'hex');

  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    throw new UnauthorizedOwnerSessionError('Cryptographic signature verification failed for Owner authorization token.');
  }

  let claims: OwnerSessionClaims;
  try {
    claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as OwnerSessionClaims;
  } catch {
    throw new UnauthorizedOwnerSessionError('Corrupted Owner authorization token payload.');
  }

  if (!claims || typeof claims !== 'object' || !claims.sessionId || !claims.principalId || !claims.expiresAt) {
    throw new UnauthorizedOwnerSessionError('Corrupted Owner authorization token claims structure.');
  }

  if (Date.now() > claims.expiresAt) {
    throw new UnauthorizedOwnerSessionError(`Owner session '${claims.sessionId}' has expired.`);
  }

  if (claims.principalId !== OWNER_PRINCIPAL_ID && claims.principalId !== CANONICAL_OWNER_PRINCIPAL.principalId) {
    throw new UnauthorizedOwnerSessionError(`Principal '${claims.principalId}' is not the canonical Owner.`);
  }

  if (claims.email !== CANONICAL_OWNER_PRINCIPAL.email && claims.email !== 'stephenikeme@icloud.com') {
    throw new UnauthorizedOwnerSessionError(`Owner email '${claims.email}' does not match canonical Owner.`);
  }

  return claims;
}
