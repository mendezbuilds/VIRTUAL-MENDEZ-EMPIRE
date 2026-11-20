import { describe, it, expect, beforeEach } from 'vitest';
import { newDb, DataType } from 'pg-mem';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { DepartmentRegistry } from '@vme/department-hierarchy';
import { EmergencySupervisor } from '@vme/security-governance';
import { OWNER_PRINCIPAL_ID, CANONICAL_OWNER_PRINCIPAL } from '@vme/shared-types';
import {
  PostgresMessageStorage,
  PostgresMessageStorageError,
} from './postgres-message-storage.js';
import { MessageRouter } from './message-router.js';
import {
  ConsequentialPolicyEngine,
  ConsequentialPolicyViolationError,
  UnauthorizedOwnerDecisionError,
  OwnerAuthenticationService,
  computeParameterHash,
} from './consequential-policy-engine.js';
import { DelegationManager } from './delegation-manager.js';

describe('Durable Agent Communication & Consequential Policy Lifecycle', () => {
  let pool: Pool;
  let hierarchy: DepartmentRegistry;
  let supervisor: EmergencySupervisor;
  const tenantId = '00000000-0000-0000-0000-000000000001';

  beforeEach(() => {
    process.env.DB_SESSION_SECRET = 'test-secret-with-at-least-32-chars-entropy-abc123';
    hierarchy = new DepartmentRegistry();
    supervisor = new EmergencySupervisor(undefined, false);

    const db = newDb();

    db.public.registerFunction({
      name: 'clock_timestamp',
      args: [],
      returns: DataType.timestamptz,
      implementation: () => new Date(),
    });

    db.public.registerFunction({
      name: 'gen_random_uuid',
      args: [],
      returns: DataType.text,
      implementation: () => randomUUID(),
    });

    // Create DDL tables
    db.public.none(`
      CREATE TABLE agent_communication_envelopes (
        id text PRIMARY KEY DEFAULT gen_random_uuid(),
        message_id text NOT NULL UNIQUE,
        tenant_id text NOT NULL,
        sender_agent_id text NOT NULL,
        sender_agent_code text NOT NULL,
        sender_department_id text NOT NULL,
        recipient_agent_id text NOT NULL,
        recipient_agent_code text NOT NULL,
        recipient_department_id text NOT NULL,
        type text NOT NULL,
        priority text NOT NULL DEFAULT 'MEDIUM',
        task_id text,
        payload jsonb NOT NULL,
        correlation_id text NOT NULL,
        causation_id text,
        delivery_status text NOT NULL DEFAULT 'PENDING',
        retry_count int NOT NULL DEFAULT 0,
        next_retry_at timestamptz,
        expires_at timestamptz,
        requires_response boolean NOT NULL DEFAULT false,
        sent_at timestamptz NOT NULL DEFAULT now(),
        acknowledged_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE message_delivery_acknowledgments (
        id text PRIMARY KEY DEFAULT gen_random_uuid(),
        acknowledgment_id text NOT NULL UNIQUE,
        message_id text NOT NULL,
        recipient_agent_id text NOT NULL,
        status text NOT NULL,
        rejection_reason text,
        received_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE message_dead_letter_queue (
        id text PRIMARY KEY DEFAULT gen_random_uuid(),
        message_id text NOT NULL,
        tenant_id text NOT NULL,
        sender_agent_id text NOT NULL,
        recipient_agent_id text NOT NULL,
        type text NOT NULL,
        payload jsonb NOT NULL,
        failure_reason text NOT NULL,
        retry_attempts int NOT NULL,
        failed_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE consequential_authorization_requests (
        id text PRIMARY KEY,
        tenant_id text NOT NULL,
        task_id text NOT NULL,
        action_type text NOT NULL,
        agent_id text NOT NULL,
        department_id text NOT NULL,
        counterparty text,
        parameter_hash text NOT NULL,
        payload jsonb NOT NULL,
        status text NOT NULL DEFAULT 'PENDING_OWNER_REVIEW',
        requested_at timestamptz NOT NULL DEFAULT now(),
        valid_until timestamptz NOT NULL,
        decided_by text,
        decided_at timestamptz,
        decision_notes text,
        executed_at timestamptz,
        execution_status text,
        execution_result jsonb
      );
    `);

    const { Pool: PgPool } = db.adapters.createPg();
    pool = new PgPool() as unknown as Pool;
  });

  describe('Durable Message Broker & Worker Recovery', () => {
    it('persists dispatched messages and recovers them after simulated worker restart', async () => {
      const storage = new PostgresMessageStorage(pool, { tenantId });
      const router1 = new MessageRouter(hierarchy, {
        mode: 'PRODUCTION_POSTGRES',
        postgresStorage: storage,
        emergencySupervisor: supervisor,
      });

      const director = hierarchy.getAgentRecord('OPP-DIR')!;
      const scout = hierarchy.getAgentRecord('OPP-SCOUT')!;
      const taskId = randomUUID();

      // Dispatch message using router1
      const dispatched = await router1.dispatch({
        senderAgentId: director.id,
        recipientAgentId: scout.id,
        type: 'TASK_DELEGATION',
        taskId,
        payload: {
          taskTitle: 'Scrape Web3 Leads',
          description: 'Search for Rust openings',
        },
      });

      expect(dispatched.deliveryStatus).toBe('DELIVERED');

      // Worker Crashes / Restarts: simulate by creating brand new router instance router2
      const router2 = new MessageRouter(hierarchy, {
        mode: 'PRODUCTION_POSTGRES',
        postgresStorage: storage,
        emergencySupervisor: supervisor,
      });

      // Before recovery, in-memory inbox of router2 is empty
      expect(router2.getInbox(scout.id)).toHaveLength(0);

      // Query database storage directly
      const dbInbox = await storage.getInbox(scout.id);
      expect(dbInbox).toHaveLength(1);
      expect(dbInbox[0]?.messageId).toBe(dispatched.messageId);
      expect(dbInbox[0]?.payload['taskTitle']).toBe('Scrape Web3 Leads');
    });

    it('handles transactional message acknowledgments and state transitions', async () => {
      const storage = new PostgresMessageStorage(pool, { tenantId });
      const router = new MessageRouter(hierarchy, {
        mode: 'PRODUCTION_POSTGRES',
        postgresStorage: storage,
      });

      const director = hierarchy.getAgentRecord('OPP-DIR')!;
      const scout = hierarchy.getAgentRecord('OPP-SCOUT')!;

      const msg = await router.dispatch({
        senderAgentId: director.id,
        recipientAgentId: scout.id,
        type: 'INFORMATION_REQUEST',
        payload: { query: 'Status update', context: {} },
      });

      // Acknowledge delivery
      const ack = await router.acknowledgeMessageAsync(msg.messageId, scout.id, 'ACCEPTED');
      expect(ack.status).toBe('ACCEPTED');
      expect(router.getMessageStatus(msg.messageId)).toBe('ACKNOWLEDGED');

      // Check database reflects acknowledgment
      const client = await pool.connect();
      try {
        const res = await client.query(
          `SELECT delivery_status, acknowledged_at FROM agent_communication_envelopes WHERE message_id = $1`,
          [msg.messageId]
        );
        expect(res.rows[0].delivery_status).toBe('ACKNOWLEDGED');
        expect(res.rows[0].acknowledged_at).not.toBeNull();
      } finally {
        client.release();
      }
    });

    it('routes failed/rejected messages to dead-letter queue and computes exponential backoff retry', async () => {
      const storage = new PostgresMessageStorage(pool, { tenantId });

      const envelope = {
        messageId: randomUUID(),
        senderAgentId: randomUUID(),
        senderAgentCode: 'OPP-DIR',
        senderDepartmentId: 'opportunity_acquisition' as const,
        recipientAgentId: randomUUID(),
        recipientAgentCode: 'OPP-SCOUT',
        recipientDepartmentId: 'opportunity_acquisition' as const,
        type: 'TASK_DELEGATION' as const,
        priority: 'HIGH' as const,
        payload: { test: true },
        correlationId: randomUUID(),
        sentAt: new Date().toISOString(),
        deliveryStatus: 'PENDING' as const,
        requiresResponse: false,
      };

      await storage.persistEnvelope(envelope);

      // Route to Dead Letter Queue
      await storage.routeToDeadLetter(envelope, 'Connection timed out', 1);

      // Verify DLQ entry in database
      const client = await pool.connect();
      try {
        const dlqRes = await client.query(
          `SELECT message_id, failure_reason, retry_attempts FROM message_dead_letter_queue WHERE message_id = $1`,
          [envelope.messageId]
        );
        expect(dlqRes.rows).toHaveLength(1);
        expect(dlqRes.rows[0].failure_reason).toBe('Connection timed out');
      } finally {
        client.release();
      }

      // Compute exponential backoff retry: attempt 1 -> delay = 1000 * 2^0 = 1000ms
      const retry1 = await storage.calculateBackoffAndScheduleRetry(envelope.messageId, 0, 1000, 3);
      expect(retry1.shouldRetry).toBe(true);
      expect(retry1.retryCount).toBe(1);
      expect(retry1.nextRetryAt).toBeDefined();

      // Exceeded max retries -> no more retries
      const retryExceeded = await storage.calculateBackoffAndScheduleRetry(envelope.messageId, 3, 1000, 3);
      expect(retryExceeded.shouldRetry).toBe(false);
    });

    it('fails safely in PRODUCTION_POSTGRES mode when storage is missing', () => {
      expect(() => {
        new MessageRouter(hierarchy, {
          mode: 'PRODUCTION_POSTGRES',
          // postgresStorage intentionally omitted
        });
      }).toThrow(PostgresMessageStorageError);
    });
  });

  describe('Consequential Action Policy Engine (10-Step Lifecycle)', () => {
    let engine: ConsequentialPolicyEngine;
    let delegation: DelegationManager;
    let authService: OwnerAuthenticationService;
    const testSigningSecret = 'vme-test-consequential-owner-hmac-secret-key-32b';
    const testOwnerCredentials = 'vme-test-owner-master-cryptographic-credentials-2026';

    beforeEach(() => {
      authService = new OwnerAuthenticationService({
        secretKey: testSigningSecret,
        requiredCredentials: testOwnerCredentials,
      });
      engine = new ConsequentialPolicyEngine({ pool, tenantId, authService, departmentRegistry: hierarchy });
      const router = new MessageRouter(hierarchy);
      delegation = new DelegationManager(hierarchy, router, engine);
    });

    it('enforces the complete 10-step lifecycle and rejects parameter tampering via SHA-256 hash', async () => {
      const trader = hierarchy.getAgentRecord('FIN-FXA')!;
      const taskId = randomUUID();

      const tradePayload = {
        action: 'BUY',
        pair: 'EUR/USD',
        lotSize: 2.5,
        stopLoss: 1.082,
        takeProfit: 1.095,
      };

      // Step 1, 2, 3, 4: Quarantine action and generate parameter hash
      const request = await engine.quarantineAction({
        taskId,
        actionType: 'LIVE_TRADING',
        agentId: trader.id,
        departmentId: trader.departmentId,
        payload: tradePayload,
        counterparty: 'InteractiveBrokers',
      });

      expect(request.status).toBe('PENDING_OWNER_REVIEW');
      expect(request.parameterHash).toBe(computeParameterHash(tradePayload));
      expect(new Date(request.validUntil).getTime()).toBeGreaterThan(Date.now());

      // Step 5: AI agent (e.g. EXEC-CEO) attempts to self-approve -> strictly rejected
      const ceo = hierarchy.getAgentRecord('EXEC-CEO')!;
      await expect(
        engine.resolveAuthorization(request.id, 'APPROVED', ceo.id, 'CEO auto-approval')
      ).rejects.toThrow(UnauthorizedOwnerDecisionError);

      // Step 5: Identity-only authentication (passing public ID string) is strictly rejected
      await expect(
        engine.resolveAuthorization(request.id, 'APPROVED', OWNER_PRINCIPAL_ID)
      ).rejects.toThrow(UnauthorizedOwnerDecisionError);

      // Step 5: Authentic Owner authenticates with cryptographic session and approves
      const ownerSession = authService.createOwnerSession({
        principalId: OWNER_PRINCIPAL_ID,
        email: CANONICAL_OWNER_PRINCIPAL.email,
        credentials: testOwnerCredentials,
      });

      const approved = await engine.resolveAuthorization(
        request.id,
        'APPROVED',
        ownerSession,
        'Authorized by Stephen Mendez after risk review'
      );
      expect(approved.status).toBe('APPROVED');
      expect(approved.decidedBy).toBe(OWNER_PRINCIPAL_ID);

      // Step 6: Parameter Tampering Detection:
      // If someone modifies the lot size from 2.5 to 25.0 during execution
      const tamperedPayload = { ...tradePayload, lotSize: 25.0 };
      await expect(
        engine.revalidateForExecution(request.id, tamperedPayload)
      ).rejects.toThrow(ConsequentialPolicyViolationError);

      // Step 6: Valid revalidation with unaltered parameters
      const revalidated = await engine.revalidateForExecution(request.id, tradePayload);
      expect(revalidated.status).toBe('APPROVED');

      // Step 7 & 8: Record execution outcome and evidence
      await engine.recordExecutionOutcome(request.id, 'SUCCESS', {
        orderId: 'IB-998811',
        executedPrice: 1.0854,
        timestamp: new Date().toISOString(),
      });

      // Verify persistent record in PostgreSQL
      const persisted = await engine.getRequestById(request.id);
      expect(persisted?.status).toBe('EXECUTED');
      expect(persisted?.executionStatus).toBe('SUCCESS');
      expect(persisted?.executionResult?.['orderId']).toBe('IB-998811');
    });

    it('rejects execution of expired authorizations', async () => {
      const trader = hierarchy.getAgentRecord('FIN-FXA')!;
      const taskId = randomUUID();
      const payload = { amount: 1000 };

      // Quarantine with 0ms validity window to immediately expire
      const shortEngine = new ConsequentialPolicyEngine({
        pool,
        tenantId,
        authService,
        departmentRegistry: hierarchy,
        policies: {
          CAPITAL_TRANSFER: {
            actionType: 'CAPITAL_TRANSFER',
            requiresOwnerApproval: true,
            maxValidityWindowMs: -1000, // already expired
            description: 'Immediate expiry test',
          },
        },
      });

      const request = await shortEngine.quarantineAction({
        taskId,
        actionType: 'CAPITAL_TRANSFER',
        agentId: trader.id,
        departmentId: trader.departmentId,
        payload,
      });

      const ownerSession = authService.createOwnerSession({
        principalId: OWNER_PRINCIPAL_ID,
        email: CANONICAL_OWNER_PRINCIPAL.email,
        credentials: testOwnerCredentials,
      });

      // Resolving expired request throws
      await expect(
        shortEngine.resolveAuthorization(request.id, 'APPROVED', ownerSession)
      ).rejects.toThrow(ConsequentialPolicyViolationError);
    });

    it('DelegationManager revalidateConsequentialAction detects parameter tampering', async () => {
      const scout = hierarchy.getAgentRecord('OPP-OUTR')!;
      const taskId = randomUUID();
      const payload = {
        recipient: 'investor@sequoia.com',
        content: 'Empire Q4 Pitch Deck',
      };

      const { request } = delegation.interceptConsequentialAction(
        scout.id,
        taskId,
        'EXTERNAL_OUTREACH',
        payload
      );

      // Approve legitimately using cryptographically signed Owner session
      const ownerSession = authService.createOwnerSession({
        principalId: OWNER_PRINCIPAL_ID,
        email: CANONICAL_OWNER_PRINCIPAL.email,
        credentials: testOwnerCredentials,
      });
      await delegation.authorizeAction(request.id, 'APPROVED', ownerSession);

      // Altered recipient should be detected
      const alteredPayload = {
        recipient: 'attacker@leak.com',
        content: 'Empire Q4 Pitch Deck',
      };

      await expect(
        delegation.revalidateConsequentialAction(request.id, alteredPayload)
      ).rejects.toThrow(ConsequentialPolicyViolationError);

      // Original payload validates cleanly
      const valid = await delegation.revalidateConsequentialAction(request.id, payload);
      expect(valid.status).toBe('APPROVED');
    });
  });
});
