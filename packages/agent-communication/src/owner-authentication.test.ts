import { describe, it, expect, beforeEach } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import {
  OWNER_PRINCIPAL_ID,
  CANONICAL_OWNER_PRINCIPAL,
} from '@vme/shared-types';
import { DepartmentRegistry } from '@vme/department-hierarchy';
import { EmergencySupervisor } from '@vme/security-governance';
import { MessageRouter } from './message-router.js';
import { DelegationManager } from './delegation-manager.js';
import {
  OwnerAuthenticationService,
  ConsequentialPolicyEngine,
  UnauthorizedOwnerDecisionError,
  ConsequentialPolicyViolationError,
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

    it('rejects unregistered sessions that were not issued by the active service registry', () => {
      // Craft a signed token with valid format and signature, but a non-registered random sessionId
      const unregisteredClaims: OwnerSessionClaims = {
        principalId: OWNER_PRINCIPAL_ID,
        email: CANONICAL_OWNER_PRINCIPAL.email,
        sessionId: randomUUID(), // not in authService.activeSessions
        issuedAt: Date.now(),
        expiresAt: Date.now() + 3600000,
        nonce: randomUUID(),
      };
      const payloadB64 = Buffer.from(JSON.stringify(unregisteredClaims)).toString('base64url');
      const sig = createHmac('sha256', validSecretKey).update(payloadB64).digest('hex');
      const unregisteredToken = `${payloadB64}.${sig}`;

      expect(() => authService.verifyOwnerSession(unregisteredToken)).toThrow(
        UnauthorizedOwnerDecisionError
      );
      expect(() => authService.verifyOwnerSession(unregisteredToken)).toThrow(
        /not registered or has been terminated/
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

  describe('7. DelegationManager Owner Authorization Bypass Defenses', () => {
    let delegation: DelegationManager;

    beforeEach(() => {
      const hierarchy = new DepartmentRegistry();
      const supervisor = new EmergencySupervisor(undefined, false);
      const router = new MessageRouter(hierarchy, { emergencySupervisor: supervisor });
      delegation = new DelegationManager(hierarchy, router, policyEngine);
    });

    it('rejects OWNER_PRINCIPAL_ID string through DelegationManager and leaves request unchanged', async () => {
      const { request } = delegation.interceptConsequentialAction(
        'FIN-FXA',
        randomUUID(),
        'CAPITAL_TRANSFER',
        { amount: 50000 }
      );

      await expect(
        delegation.authorizeAction(request.id, 'APPROVED', OWNER_PRINCIPAL_ID)
      ).rejects.toThrow(UnauthorizedOwnerDecisionError);

      expect(delegation.getRequestById(request.id)?.status).toBe('PENDING_OWNER_REVIEW');
    });

    it('rejects arbitrary identity strings through DelegationManager and leaves request unchanged', async () => {
      const { request } = delegation.interceptConsequentialAction(
        'FIN-FXA',
        randomUUID(),
        'LIVE_TRADING',
        { symbol: 'AAPL', qty: 100 }
      );

      await expect(
        delegation.authorizeAction(request.id, 'APPROVED', 'EXEC-CEO')
      ).rejects.toThrow(UnauthorizedOwnerDecisionError);
      expect(delegation.getRequestById(request.id)?.status).toBe('PENDING_OWNER_REVIEW');

      await expect(
        delegation.authorizeAction(request.id, 'APPROVED', 'stephen@virtualmendezempire.internal')
      ).rejects.toThrow(UnauthorizedOwnerDecisionError);
      expect(delegation.getRequestById(request.id)?.status).toBe('PENDING_OWNER_REVIEW');
    });

    it('rejects forged, expired, and revoked tokens through DelegationManager and leaves request unchanged', async () => {
      const { request } = delegation.interceptConsequentialAction(
        'OPS-DIR',
        randomUUID(),
        'BINDING_CONTRACT',
        { vendor: 'AWS', commitment: 100000 }
      );

      // Forged token
      const session = authService.createOwnerSession({
        principalId: OWNER_PRINCIPAL_ID,
        email: CANONICAL_OWNER_PRINCIPAL.email,
        credentials: validCredentials,
      });
      const [payloadB64] = session.token.split('.');
      const forgedToken = `${payloadB64}.0000000000000000000000000000000000000000000000000000000000000000`;

      await expect(
        delegation.authorizeAction(request.id, 'APPROVED', forgedToken)
      ).rejects.toThrow(UnauthorizedOwnerDecisionError);
      expect(delegation.getRequestById(request.id)?.status).toBe('PENDING_OWNER_REVIEW');

      // Expired token
      const expiredSession = authService.createOwnerSession({
        principalId: OWNER_PRINCIPAL_ID,
        email: CANONICAL_OWNER_PRINCIPAL.email,
        credentials: validCredentials,
        sessionDurationMs: -1000,
      });
      await expect(
        delegation.authorizeAction(request.id, 'APPROVED', expiredSession)
      ).rejects.toThrow(UnauthorizedOwnerDecisionError);
      expect(delegation.getRequestById(request.id)?.status).toBe('PENDING_OWNER_REVIEW');

      // Revoked token
      authService.revokeSession(session.sessionId);
      await expect(
        delegation.authorizeAction(request.id, 'APPROVED', session)
      ).rejects.toThrow(UnauthorizedOwnerDecisionError);
      expect(delegation.getRequestById(request.id)?.status).toBe('PENDING_OWNER_REVIEW');
    });

    it('proves policy-resolution failures leave request pending and cannot pass revalidation', async () => {
      const payload = { amount: 75000, recipient: '0xabc' };
      const { request } = delegation.interceptConsequentialAction(
        'FIN-FXA',
        randomUUID(),
        'CAPITAL_TRANSFER',
        payload
      );

      // Forged token resolution fails
      const forgedToken = 'fakeHeader.fakeSignature';
      await expect(
        delegation.authorizeAction(request.id, 'APPROVED', forgedToken)
      ).rejects.toThrow(UnauthorizedOwnerDecisionError);

      // Request must remain strictly PENDING_OWNER_REVIEW
      expect(delegation.getRequestById(request.id)?.status).toBe('PENDING_OWNER_REVIEW');

      // Revalidation MUST fail because request was not approved by policy engine
      await expect(
        delegation.revalidateConsequentialAction(request.id, payload)
      ).rejects.toThrow(ConsequentialPolicyViolationError);
      await expect(
        delegation.revalidateConsequentialAction(request.id, payload)
      ).rejects.toThrow(/status is 'PENDING_OWNER_REVIEW'/);
    });

    it('proves policy resolution failure on expired validity window leaves request pending and fails revalidation', async () => {
      const payload = { symbol: 'TSLA', amount: 1000 };
      const shortEngine = new ConsequentialPolicyEngine({
        authService,
        policies: {
          LIVE_TRADING: {
            actionType: 'LIVE_TRADING',
            requiresOwnerApproval: true,
            maxValidityWindowMs: -1000, // already expired
            description: 'Expired test policy',
          },
        },
      });

      const hierarchy = new DepartmentRegistry();
      const supervisor = new EmergencySupervisor(undefined, false);
      const router = new MessageRouter(hierarchy, { emergencySupervisor: supervisor });
      const shortDelegation = new DelegationManager(hierarchy, router, shortEngine);

      const { request } = shortDelegation.interceptConsequentialAction(
        'FIN-FXA',
        randomUUID(),
        'LIVE_TRADING',
        payload
      );

      const ownerSession = authService.createOwnerSession({
        principalId: OWNER_PRINCIPAL_ID,
        email: CANONICAL_OWNER_PRINCIPAL.email,
        credentials: validCredentials,
      });

      // Attempting to authorize expired request fails in policy engine
      await expect(
        shortDelegation.authorizeAction(request.id, 'APPROVED', ownerSession)
      ).rejects.toThrow(ConsequentialPolicyViolationError);

      // Local request remains PENDING_OWNER_REVIEW (not APPROVED)
      expect(shortDelegation.getRequestById(request.id)?.status).toBe('PENDING_OWNER_REVIEW');

      // Revalidation must fail
      await expect(
        shortDelegation.revalidateConsequentialAction(request.id, payload)
      ).rejects.toThrow(ConsequentialPolicyViolationError);
    });

    it('ensures revalidateConsequentialAction cannot authorize execution based solely on local status when engine has not confirmed', async () => {
      const payload = { amount: 100000 };
      const { request } = delegation.interceptConsequentialAction(
        'FIN-FXA',
        randomUUID(),
        'CAPITAL_TRANSFER',
        payload
      );

      // Simulate unauthorized local state tampering (e.g. bypassing authorizeAction)
      request.status = 'APPROVED';

      // revalidateConsequentialAction MUST detect that policy engine has not confirmed approval
      await expect(
        delegation.revalidateConsequentialAction(request.id, payload)
      ).rejects.toThrow(ConsequentialPolicyViolationError);
      await expect(
        delegation.revalidateConsequentialAction(request.id, payload)
      ).rejects.toThrow(/status is 'PENDING_OWNER_REVIEW'/);
    });

    it('rejects revalidation when an approved request is marked executed through the policy engine rather than accepting stale cached approval', async () => {
      const payload = { amount: 80000, recipient: 'vendor-123' };
      const { request } = delegation.interceptConsequentialAction(
        'FIN-FXA',
        randomUUID(),
        'CAPITAL_TRANSFER',
        payload
      );

      const ownerSession = authService.createOwnerSession({
        principalId: OWNER_PRINCIPAL_ID,
        email: CANONICAL_OWNER_PRINCIPAL.email,
        credentials: validCredentials,
      });

      // Step 1: Approve request legitimately through DelegationManager
      await delegation.authorizeAction(request.id, 'APPROVED', ownerSession, 'Initial approval');
      expect(delegation.getRequestById(request.id)?.status).toBe('APPROVED');

      // First revalidation succeeds
      const firstRevalidation = await delegation.revalidateConsequentialAction(request.id, payload);
      expect(firstRevalidation.status).toBe('APPROVED');

      // Step 2: Mark request executed through the policy engine
      await policyEngine.recordExecutionOutcome(request.id, 'SUCCESS', { txId: 'tx-executed-123' });
      const currentPolicyRecord = await policyEngine.getRequestById(request.id);
      expect(currentPolicyRecord?.status).toBe('EXECUTED');

      // Step 3: Prove DelegationManager revalidation rejects it rather than accepting stale cached approval
      await expect(
        delegation.revalidateConsequentialAction(request.id, payload)
      ).rejects.toThrow(ConsequentialPolicyViolationError);
      await expect(
        delegation.revalidateConsequentialAction(request.id, payload)
      ).rejects.toThrow(/already been executed/);
    });

    it('successfully authorizes consequential action through DelegationManager with valid Owner session and passes revalidation', async () => {
      const payload = { amount: 25000 };
      const { request } = delegation.interceptConsequentialAction(
        'FIN-FXA',
        randomUUID(),
        'CAPITAL_TRANSFER',
        payload
      );

      const ownerSession = authService.createOwnerSession({
        principalId: OWNER_PRINCIPAL_ID,
        email: CANONICAL_OWNER_PRINCIPAL.email,
        credentials: validCredentials,
      });

      const approved = await delegation.authorizeAction(
        request.id,
        'APPROVED',
        ownerSession,
        'Owner approved transfer'
      );

      expect(approved.status).toBe('APPROVED');
      expect(approved.decidedBy).toBe(OWNER_PRINCIPAL_ID);
      expect(delegation.getRequestById(request.id)?.status).toBe('APPROVED');

      // Revalidation succeeds with confirmed engine approval
      const revalidated = await delegation.revalidateConsequentialAction(request.id, payload);
      expect(revalidated.status).toBe('APPROVED');
    });

    it('successfully authorizes consequential action through DelegationManager with raw signed token string', async () => {
      const payload = { amount: 15000 };
      const { request } = delegation.interceptConsequentialAction(
        'FIN-FXA',
        randomUUID(),
        'CAPITAL_TRANSFER',
        payload
      );

      const ownerSession = authService.createOwnerSession({
        principalId: OWNER_PRINCIPAL_ID,
        email: CANONICAL_OWNER_PRINCIPAL.email,
        credentials: validCredentials,
      });

      const approved = await delegation.authorizeAction(
        request.id,
        'APPROVED',
        ownerSession.token,
        'Owner approved with raw token'
      );

      expect(approved.status).toBe('APPROVED');
      expect(approved.decidedBy).toBe(OWNER_PRINCIPAL_ID);
      expect(delegation.getRequestById(request.id)?.status).toBe('APPROVED');
    });
  });
});
