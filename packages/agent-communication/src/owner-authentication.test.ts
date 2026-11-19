import { describe, it, expect, beforeEach } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import {
  OWNER_PRINCIPAL_ID,
  CANONICAL_OWNER_PRINCIPAL,
} from '@vme/shared-types';
import {
  OwnerAuthenticationService,
  ConsequentialPolicyEngine,
  UnauthorizedOwnerDecisionError,
  type OwnerAuthenticatedSession,
  type OwnerSessionClaims,
} from './consequential-policy-engine.js';

describe('Owner Cryptographic Authentication & Governance Verification', () => {
  const validSecretKey = 'vme-canonical-owner-hmac-secret-test-32b-length';
  const validCredentials = 'vme-owner-secure-cryptographic-master-key-2026';
  let authService: OwnerAuthenticationService;
  let policyEngine: ConsequentialPolicyEngine;

  beforeEach(() => {
    delete process.env.OWNER_AUTH_SECRET;
    delete process.env.OWNER_AUTH_CREDENTIALS;
    delete process.env.OWNER_CREDENTIALS;

    authService = new OwnerAuthenticationService({
      secretKey: validSecretKey,
      requiredCredentials: validCredentials,
    });

    policyEngine = new ConsequentialPolicyEngine({
      authService,
    });
  });

  describe('1. Cryptographic Signature Validation & Forgery Rejection', () => {
    it('rejects tokens with forged or tampered signatures', () => {
      const session = authService.createOwnerSession({
        principalId: OWNER_PRINCIPAL_ID,
        email: CANONICAL_OWNER_PRINCIPAL.email,
        credentials: validCredentials,
      });

      const [payloadB64, signature] = session.token.split('.');
      // Tamper signature by changing trailing hex character
      const forgedSig = signature!.slice(0, -1) + (signature!.endsWith('0') ? '1' : '0');
      const forgedToken = `${payloadB64}.${forgedSig}`;

      expect(() => authService.verifyOwnerSession(forgedToken)).toThrow(
        UnauthorizedOwnerDecisionError
      );
      expect(() => authService.verifyOwnerSession(forgedToken)).toThrow(
        /Cryptographic signature verification failed/
      );
    });

    it('rejects tokens signed with an unauthorized or mismatched secret key', () => {
      const attackerSecret = 'attacker-unauthorized-hmac-secret-key-32b';
      const attackerService = new OwnerAuthenticationService({
        secretKey: attackerSecret,
        requiredCredentials: validCredentials,
      });

      const attackerSession = attackerService.createOwnerSession({
        principalId: OWNER_PRINCIPAL_ID,
        email: CANONICAL_OWNER_PRINCIPAL.email,
        credentials: validCredentials,
      });

      // Legitimate authService must reject token signed with different key
      expect(() => authService.verifyOwnerSession(attackerSession)).toThrow(
        UnauthorizedOwnerDecisionError
      );
      expect(() => authService.verifyOwnerSession(attackerSession)).toThrow(
        /Cryptographic signature verification failed/
      );
    });

    it('rejects tokens with tampered claims payload', () => {
      const session = authService.createOwnerSession({
        principalId: OWNER_PRINCIPAL_ID,
        email: CANONICAL_OWNER_PRINCIPAL.email,
        credentials: validCredentials,
      });

      const [, signature] = session.token.split('.');
      // Forge altered claims with different principal
      const tamperedClaims: OwnerSessionClaims = {
        principalId: 'EXEC-CEO',
        email: CANONICAL_OWNER_PRINCIPAL.email,
        sessionId: session.sessionId,
        issuedAt: Date.now(),
        expiresAt: Date.now() + 3600000,
        nonce: randomUUID(),
      };
      const tamperedB64 = Buffer.from(JSON.stringify(tamperedClaims)).toString('base64url');
      const tamperedToken = `${tamperedB64}.${signature}`;

      expect(() => authService.verifyOwnerSession(tamperedToken)).toThrow(
        UnauthorizedOwnerDecisionError
      );
    });

    it('rejects malformed token strings and corrupted payload structures', () => {
      expect(() => authService.verifyOwnerSession('malformed-token-without-dot')).toThrow(
        UnauthorizedOwnerDecisionError
      );
      expect(() => authService.verifyOwnerSession('part1.part2.part3')).toThrow(
        UnauthorizedOwnerDecisionError
      );
      expect(() => authService.verifyOwnerSession('.')).toThrow(
        UnauthorizedOwnerDecisionError
      );

      // Corrupted non-JSON base64
      const invalidJsonB64 = Buffer.from('NOT_VALID_JSON').toString('base64url');
      const sig = createHmac('sha256', validSecretKey).update(invalidJsonB64).digest('hex');
      expect(() => authService.verifyOwnerSession(`${invalidJsonB64}.${sig}`)).toThrow(
        /Corrupted Owner authorization token payload/
      );
    });
  });

  describe('2. Session Expiration & Revocation Validation', () => {
    it('rejects expired session tokens', () => {
      // Create session with negative duration so it is immediately expired
      const expiredSession = authService.createOwnerSession({
        principalId: OWNER_PRINCIPAL_ID,
        email: CANONICAL_OWNER_PRINCIPAL.email,
        credentials: validCredentials,
        sessionDurationMs: -1000,
      });

      expect(() => authService.verifyOwnerSession(expiredSession)).toThrow(
        UnauthorizedOwnerDecisionError
      );
      expect(() => authService.verifyOwnerSession(expiredSession)).toThrow(
        /has expired/
      );
    });

    it('rejects explicitly revoked sessions', () => {
      const session = authService.createOwnerSession({
        principalId: OWNER_PRINCIPAL_ID,
        email: CANONICAL_OWNER_PRINCIPAL.email,
        credentials: validCredentials,
      });

      // Verify active session succeeds first
      expect(authService.verifyOwnerSession(session).sessionId).toBe(session.sessionId);

      // Revoke session
      authService.revokeSession(session.sessionId);

      // Verification must now fail
      expect(() => authService.verifyOwnerSession(session)).toThrow(
        UnauthorizedOwnerDecisionError
      );
      expect(() => authService.verifyOwnerSession(session)).toThrow(
        /has been revoked/
      );
    });
  });

  describe('3. Identity-Only Authentication Rejection & Bypass Removal', () => {
    it('rejects consequential action approval when using only public ID string (OWNER_PRINCIPAL_ID)', async () => {
      const record = await policyEngine.quarantineAction({
        taskId: randomUUID(),
        actionType: 'CAPITAL_TRANSFER',
        agentId: 'FIN-FXA',
        departmentId: 'financial_intelligence',
        payload: { amountUsd: 10000 },
      });

      // Passing public ID string without cryptographic proof must fail
      await expect(
        policyEngine.resolveAuthorization(record.id, 'APPROVED', OWNER_PRINCIPAL_ID)
      ).rejects.toThrow(UnauthorizedOwnerDecisionError);

      await expect(
        policyEngine.resolveAuthorization(record.id, 'APPROVED', CANONICAL_OWNER_PRINCIPAL.principalId)
      ).rejects.toThrow(UnauthorizedOwnerDecisionError);
    });

    it('rejects consequential action approval when using Owner email or arbitrary identity string', async () => {
      const record = await policyEngine.quarantineAction({
        taskId: randomUUID(),
        actionType: 'LIVE_TRADING',
        agentId: 'FIN-FXA',
        departmentId: 'financial_intelligence',
        payload: { order: 'BUY' },
      });

      await expect(
        policyEngine.resolveAuthorization(record.id, 'APPROVED', CANONICAL_OWNER_PRINCIPAL.email)
      ).rejects.toThrow(UnauthorizedOwnerDecisionError);

      await expect(
        policyEngine.resolveAuthorization(record.id, 'APPROVED', 'Stephen Mendez')
      ).rejects.toThrow(UnauthorizedOwnerDecisionError);
    });

    it('rejects creating Owner sessions when credentials are missing (identity-only creation attempt)', () => {
      // Caller provides only public ID and email without credentials
      expect(() =>
        authService.createOwnerSession({
          principalId: OWNER_PRINCIPAL_ID,
          email: CANONICAL_OWNER_PRINCIPAL.email,
        })
      ).toThrow(UnauthorizedOwnerDecisionError);
      expect(() =>
        authService.createOwnerSession({
          principalId: OWNER_PRINCIPAL_ID,
          email: CANONICAL_OWNER_PRINCIPAL.email,
        })
      ).toThrow(/required Owner credentials are missing/);
    });
  });

  describe('4. Fail Closed Invariants: Missing Secrets & Credentials', () => {
    it('fails closed when the signing secret is missing or empty', () => {
      delete process.env.OWNER_AUTH_SECRET;

      // Construct service with no secretKey and no env var
      const unconfiguredService = new OwnerAuthenticationService();

      expect(() =>
        unconfiguredService.createOwnerSession({
          principalId: OWNER_PRINCIPAL_ID,
          email: CANONICAL_OWNER_PRINCIPAL.email,
          credentials: validCredentials,
        })
      ).toThrow(UnauthorizedOwnerDecisionError);
      expect(() =>
        unconfiguredService.createOwnerSession({
          principalId: OWNER_PRINCIPAL_ID,
          email: CANONICAL_OWNER_PRINCIPAL.email,
          credentials: validCredentials,
        })
      ).toThrow(/HMAC signing secret is missing/);

      expect(() => unconfiguredService.verifyOwnerSession('dummy.token')).toThrow(
        UnauthorizedOwnerDecisionError
      );
    });

    it('fails closed when required Owner credentials configuration is missing', () => {
      // Service has signing secret, but no credentials configured
      const serviceNoCreds = new OwnerAuthenticationService({
        secretKey: validSecretKey,
      });

      expect(() =>
        serviceNoCreds.createOwnerSession({
          principalId: OWNER_PRINCIPAL_ID,
          email: CANONICAL_OWNER_PRINCIPAL.email,
          credentials: 'any-caller-password',
        })
      ).toThrow(UnauthorizedOwnerDecisionError);
      expect(() =>
        serviceNoCreds.createOwnerSession({
          principalId: OWNER_PRINCIPAL_ID,
          email: CANONICAL_OWNER_PRINCIPAL.email,
          credentials: 'any-caller-password',
        })
      ).toThrow(/required Owner credentials configuration is missing/);
    });
  });

  describe('5. Prevention of Non-Owner Agent Session Creation', () => {
    it('rejects AI agent principal IDs attempting to create Owner sessions', () => {
      expect(() =>
        authService.createOwnerSession({
          principalId: 'EXEC-CEO',
          email: CANONICAL_OWNER_PRINCIPAL.email,
          credentials: validCredentials,
        })
      ).toThrow(/is not the canonical Owner principal/);

      expect(() =>
        authService.createOwnerSession({
          principalId: 'FIN-DIR',
          email: CANONICAL_OWNER_PRINCIPAL.email,
          credentials: validCredentials,
        })
      ).toThrow(/is not the canonical Owner principal/);
    });

    it('rejects non-owner emails attempting to create Owner sessions', () => {
      expect(() =>
        authService.createOwnerSession({
          principalId: OWNER_PRINCIPAL_ID,
          email: 'agent-impersonator@evil.corp',
          credentials: validCredentials,
        })
      ).toThrow(/does not match canonical Owner/);
    });

    it('rejects invalid or forged credentials attempting to create Owner sessions', () => {
      expect(() =>
        authService.createOwnerSession({
          principalId: OWNER_PRINCIPAL_ID,
          email: CANONICAL_OWNER_PRINCIPAL.email,
          credentials: 'wrong-or-guessed-password',
        })
      ).toThrow(/invalid Owner credentials/);
    });
  });

  describe('6. Valid Owner Authentication & Resolution Lifecycle', () => {
    it('successfully authorizes consequential action with valid Owner session object', async () => {
      const record = await policyEngine.quarantineAction({
        taskId: randomUUID(),
        actionType: 'BINDING_CONTRACT',
        agentId: 'OPS-DIR',
        departmentId: 'operations_administration',
        payload: { contractId: 'AGREEMENT-2026-001', vendor: 'Datadog' },
      });

      const ownerSession = authService.createOwnerSession({
        principalId: OWNER_PRINCIPAL_ID,
        email: CANONICAL_OWNER_PRINCIPAL.email,
        credentials: validCredentials,
      });

      const resolved = await policyEngine.resolveAuthorization(
        record.id,
        'APPROVED',
        ownerSession,
        'Owner Stephen Mendez formally assents to Datadog enterprise contract'
      );

      expect(resolved.status).toBe('APPROVED');
      expect(resolved.decidedBy).toBe(OWNER_PRINCIPAL_ID);
      expect(resolved.decidedAt).toBeDefined();
      expect(resolved.decisionNotes).toContain('Stephen Mendez');
    });

    it('successfully authorizes consequential action with raw signed token string', async () => {
      const record = await policyEngine.quarantineAction({
        taskId: randomUUID(),
        actionType: 'CREDENTIAL_ACCESS',
        agentId: 'SEC-DIR',
        departmentId: 'security_governance',
        payload: { secretRef: 'PROD_DB_ROTATION_KEY' },
      });

      const ownerSession = authService.createOwnerSession({
        principalId: OWNER_PRINCIPAL_ID,
        email: CANONICAL_OWNER_PRINCIPAL.email,
        credentials: validCredentials,
      });

      const resolved = await policyEngine.resolveAuthorization(
        record.id,
        'APPROVED',
        ownerSession.token,
        'Owner credential rotation approval'
      );

      expect(resolved.status).toBe('APPROVED');
      expect(resolved.decidedBy).toBe(OWNER_PRINCIPAL_ID);
    });
  });
});
