import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  OWNER_PRINCIPAL_ID,
  CANONICAL_OWNER_PRINCIPAL,
} from '@vme/shared-types';
import { DepartmentRegistry } from '@vme/department-hierarchy';
import {
  MessageRouter,
  PostgresMessageStorage,
  ConsequentialPolicyEngine,
  OwnerAuthenticationService,
  DelegationManager,
  computeParameterHash,
  type ConsequentialAuthorizationRecord,
} from '@vme/agent-communication';
import {
  AgentMemoryEngine,
  PostgresWorkingStorage,
  PostgresEpisodicStorage,
  PostgresSemanticStorage,
  PostgresProceduralStorage,
  withSessionRls,
  signDatabaseClaims,
  getDatabaseSessionSecret,
  applyAuthenticatedSession,
  clearAuthenticatedSession,
  CANONICAL_DB_SESSION_SECRET,
} from '@vme/agent-memory';
import {
  PerformanceEventStore,
  KPICalculator,
  BudgetTracker,
  PerformanceReviewEngine,
  DepartmentAnalyticsEngine,
} from '@vme/performance-management';
import { EmergencySupervisor } from '@vme/security-governance';
import { AgentRegistry, ModelGateway, MockLLMProvider } from '@vme/orchestrator';
import {
  ToolExecutionRuntime,
} from './tool-runtime.js';
import { AutonomyCoordinator } from './autonomy-coordinator.js';
import { CEOOrchestrator } from './ceo-orchestrator.js';
import { ExecutiveReporter } from './executive-reporter.js';
import {
  createAdminPool,
  createAppPool,
  createReadOnlyPool,
  assertGenuinePostgresAvailable,
  executeRealMigrations,
  DEFAULT_PG_CONFIG,
} from './postgres-test-helper.js';

describe('VME Phase 2 — Genuine PostgreSQL Integration Verification (Issue 3)', () => {
  let adminPool: Pool;
  let appPool: Pool;
  let roPool: Pool;
  let testSandboxDir: string;

  const tenantId = '00000000-0000-0000-0000-000000000001';
  const tenant2Id = '00000000-0000-0000-0000-000000000002';
  const ownerHmacSecret = 'vme-canonical-owner-hmac-secret-test-32b-length';
  const ownerMasterKey = 'vme-owner-secure-cryptographic-master-key-2026';

  beforeAll(async () => {
    process.env.DB_SESSION_SECRET = CANONICAL_DB_SESSION_SECRET;
    process.env.OWNER_AUTH_SECRET = ownerHmacSecret;
    process.env.OWNER_AUTH_CREDENTIALS = ownerMasterKey;
    testSandboxDir = mkdtempSync(join(tmpdir(), 'vme-pg-genuine-test-'));

    // Initialize admin pool and assert genuine PostgreSQL is reachable
    adminPool = createAdminPool();
    const envInfo = await assertGenuinePostgresAvailable(adminPool);
    console.log(`[Integration Test] Connected to genuine engine: ${envInfo.version}`);

    // Execute real migrations against PostgreSQL
    const migrations = await executeRealMigrations(adminPool);
    console.log(`[Integration Test] Executed migrations: ${migrations.join(', ')}`);

    // Ensure session signing secret is explicitly set in system_auth_secrets
    const setupClient = await adminPool.connect();
    try {
      await setupClient.query(`
        INSERT INTO system_auth_secrets (key_name, secret_value)
        VALUES ('session_signing_secret', $1)
        ON CONFLICT (key_name) DO UPDATE SET secret_value = EXCLUDED.secret_value
      `, [CANONICAL_DB_SESSION_SECRET]);
    } finally {
      setupClient.release();
    }

    // Initialize application pool (vme_app role: NOSUPERUSER, NOBYPASSRLS)
    appPool = createAppPool();

    // Initialize read-only pool (vme_readonly role: SELECT only)
    roPool = createReadOnlyPool();

    // Ensure test tenants exist in PostgreSQL and purge test communication envelopes
    const client = await adminPool.connect();
    try {
      await client.query(`
        INSERT INTO tenants (id, name, slug)
        VALUES 
          ($1, 'Tenant Alpha Corp', 'tenant-alpha'),
          ($2, 'Tenant Beta LLC', 'tenant-beta')
        ON CONFLICT (id) DO NOTHING
      `, [tenantId, tenant2Id]);
      await client.query(`
        DELETE FROM agent_communication_envelopes 
        WHERE tenant_id IN ($1, $2)
      `, [tenantId, tenant2Id]);
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    try {
      if (adminPool) await adminPool.end();
      if (appPool) await appPool.end();
      if (roPool) await roPool.end();
    } catch {
      // ignore teardown errors
    }
    try {
      rmSync(testSandboxDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  // ==========================================================================
  // Section 1: Test Environment Details & Unavailability Guard (Req 1 & 9)
  // ==========================================================================
  describe('1. Environment Details & Fail-Closed Guard', () => {
    it('verifies connection to genuine PostgreSQL 16+ engine (not pg-mem or mocks)', async () => {
      const res = await adminPool.query('SELECT version(), current_user, current_database()');
      const row = res.rows[0];

      expect(row.version).toMatch(/PostgreSQL (16|17)/i);
      expect(row.current_user).toBe(DEFAULT_PG_CONFIG.adminUser);
      expect(row.current_database).toBe(DEFAULT_PG_CONFIG.database);
    });

    it('fails closed immediately when PostgreSQL is unavailable (does not substitute mocks)', async () => {
      const deadPool = new Pool({
        host: 'localhost',
        port: 59999, // Dead port
        user: 'vme_admin',
        password: 'any',
        database: 'virtual_mendez_empire',
        connectionTimeoutMillis: 1000,
      });

      try {
        await expect(assertGenuinePostgresAvailable(deadPool)).rejects.toThrow(
          /GENUINE POSTGRESQL UNAVAILABLE/i
        );
      } finally {
        await deadPool.end().catch(() => {});
      }
    });
  });

  // ==========================================================================
  // Section 2: Real Migration Execution & Catalog Verification (Req 2)
  // ==========================================================================
  describe('2. Real Migrations Execution & Database Catalog Verification', () => {
    it('confirms all Phase 2 tables exist in PostgreSQL information_schema', async () => {
      const res = await adminPool.query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public'
      `);
      const tables = new Set(res.rows.map((r) => r.table_name));

      const expectedTables = [
        'tenants',
        'departments',
        'ledger_accounts',
        'financial_journal_entries',
        'financial_ledger_postings',
        'idempotency_records',
        'system_outbox_events',
        'system_controls',
        'agent_working_memories',
        'agent_episodic_memories',
        'agent_semantic_memories',
        'agent_procedural_memories',
        'agent_communication_envelopes',
        'message_delivery_acknowledgments',
        'message_dead_letter_queue',
        'consequential_authorization_requests',
        'task_execution_records',
        'performance_events',
        'agent_performance_reviews',
      ];

      for (const t of expectedTables) {
        expect(tables.has(t), `Missing expected table: ${t}`).toBe(true);
      }
    });

    it('confirms security definer functions and triggers are registered', async () => {
      const funcRes = await adminPool.query(`
        SELECT proname 
        FROM pg_proc p 
        JOIN pg_namespace n ON p.pronamespace = n.oid 
        WHERE n.nspname = 'public'
      `);
      const functions = new Set(funcRes.rows.map((r) => r.proname));

      expect(functions.has('get_current_tenant_id')).toBe(true);
      expect(functions.has('get_current_agent_id')).toBe(true);
      expect(functions.has('get_current_department_id')).toBe(true);
      expect(functions.has('get_current_principal_level')).toBe(true);
      expect(functions.has('is_current_principal_owner')).toBe(true);
      expect(functions.has('is_current_principal_executive')).toBe(true);
      expect(functions.has('is_current_principal_director')).toBe(true);
      expect(functions.has('cosine_similarity_array')).toBe(true);
      expect(functions.has('prevent_ledger_modification')).toBe(true);
    });
  });

  // ==========================================================================
  // Section 3: Genuine Row-Level Security (RLS) Enforcement (Req 3)
  // ==========================================================================
  describe('3. Actual Row-Level Security Enforcement & Tenant Isolation', () => {
    it('enforces strict tenant isolation on working memory under vme_app role', async () => {
      const workingStorage = new PostgresWorkingStorage(appPool);

      const agentId = '00000000-0000-0000-0000-000000000010';
      const taskId = randomUUID();

      // Set working memory for Tenant 1: set(ctx, taskId, agentId, key, value)
      await workingStorage.set(
        { tenantId, agentId, principalLevel: 'SPECIALIST' },
        taskId,
        agentId,
        'state_data',
        'alpha_value'
      );

      // Verify Tenant 1 can read its value: get(ctx, taskId, key)
      const t1Val = await workingStorage.get(
        { tenantId, agentId, principalLevel: 'SPECIALIST' },
        taskId,
        'state_data'
      );
      expect(t1Val).toBe('alpha_value');

      // Tenant 2 with same taskId and agentId CANNOT see Tenant 1 data
      const t2Val = await workingStorage.get(
        { tenantId: tenant2Id, agentId, principalLevel: 'SPECIALIST' },
        taskId,
        'state_data'
      );
      expect(t2Val).toBeUndefined();
    });

    it('rejects insertion when tenant context is missing (fail-closed RLS)', async () => {
      const client = await appPool.connect();
      try {
        await expect(
          client.query(`
            INSERT INTO agent_working_memories (tenant_id, task_id, agent_id, key, value, expires_at)
            VALUES ($1, $2, $3, 'unauthed_key', '"val"', NOW() + INTERVAL '1 hour')
          `, [tenantId, randomUUID(), randomUUID()])
        ).rejects.toThrow(/violates row-level security policy/i);
      } finally {
        client.release();
      }
    });

    it('enforces agent-specific access boundaries on working memory (cross-agent isolation)', async () => {
      const workingStorage = new PostgresWorkingStorage(appPool);
      const agentA = '00000000-0000-0000-0000-000000000021';
      const agentB = '00000000-0000-0000-0000-000000000022';
      const taskId = randomUUID();

      // Agent A sets private working memory
      await workingStorage.set(
        { tenantId, agentId: agentA, principalLevel: 'SPECIALIST' },
        taskId,
        agentA,
        'secret_scratch',
        { plan: 'top_secret' }
      );

      // Agent A can read it
      const valA = await workingStorage.get(
        { tenantId, agentId: agentA, principalLevel: 'SPECIALIST' },
        taskId,
        'secret_scratch'
      );
      expect(valA).toEqual({ plan: 'top_secret' });

      // Agent B attempts reading Agent A's working memory -> blocked by RLS
      const valB = await workingStorage.get(
        { tenantId, agentId: agentB, principalLevel: 'SPECIALIST' },
        taskId,
        'secret_scratch'
      );
      expect(valB).toBeUndefined();

      // Human Owner principal CAN inspect it
      const valOwner = await workingStorage.get(
        { tenantId, agentId: OWNER_PRINCIPAL_ID, principalLevel: 'OWNER', isOwnerAuthenticated: true },
        taskId,
        'secret_scratch'
      );
      expect(valOwner).toEqual({ plan: 'top_secret' });
    });

    it('enforces episodic memory ABAC scopes (private, department, organization)', async () => {
      const devAgent = '00000000-0000-0000-0000-000000000031';
      const devPeer = '00000000-0000-0000-0000-000000000032';
      const mktAgent = '00000000-0000-0000-0000-000000000033';
      const execAgent = '00000000-0000-0000-0000-000000000034';

      const devContext = { tenantId, agentId: devAgent, departmentId: 'technology_engineering', principalLevel: 'SPECIALIST' };
      const peerContext = { tenantId, agentId: devPeer, departmentId: 'technology_engineering', principalLevel: 'SPECIALIST' };
      const mktContext = { tenantId, agentId: mktAgent, departmentId: 'marketing_growth', principalLevel: 'SPECIALIST' };
      const execContext = { tenantId, agentId: execAgent, departmentId: 'executive_office', principalLevel: 'EXECUTIVE' };

      const devStorage = new PostgresEpisodicStorage(appPool, devContext);
      const peerStorage = new PostgresEpisodicStorage(appPool, peerContext);
      const mktStorage = new PostgresEpisodicStorage(appPool, mktContext);
      const execStorage = new PostgresEpisodicStorage(appPool, execContext);

      // 1. Record AGENT_PRIVATE memory for devAgent
      const privId = randomUUID();
      await devStorage.saveRecord({
        id: privId,
        agentId: devAgent,
        agentCode: 'TECH-DEV1',
        departmentId: 'technology_engineering',
        taskId: randomUUID(),
        actionType: 'CODE_AUDIT',
        inputSummary: 'Audit auth module',
        decisionRationale: 'Found vulnerability',
        outcome: 'Patched',
        scope: 'AGENT_PRIVATE',
        importanceScore: 8,
        status: 'SUCCESS',
        metadata: {},
        recordedAt: new Date().toISOString(),
      });

      // devAgent can read it
      const devRes = await devStorage.getRecordById(privId);
      expect(devRes?.id).toBe(privId);

      // mktAgent cannot read it
      const mktRes = await mktStorage.getRecordById(privId);
      expect(mktRes).toBeUndefined();

      // 2. Record DEPARTMENT_SCOPED memory for technology_engineering
      const deptId = randomUUID();
      await devStorage.saveRecord({
        id: deptId,
        agentId: devAgent,
        agentCode: 'TECH-DEV1',
        departmentId: 'technology_engineering',
        taskId: randomUUID(),
        actionType: 'INFRA_UPGRADE',
        inputSummary: 'Upgrade PostgreSQL 16',
        decisionRationale: 'Performance boost',
        outcome: 'Complete',
        scope: 'DEPARTMENT_SCOPED',
        importanceScore: 7,
        status: 'SUCCESS',
        metadata: {},
        recordedAt: new Date().toISOString(),
      });

      // Peer in same department can read it
      const peerRes = await peerStorage.getRecordById(deptId);
      expect(peerRes?.id).toBe(deptId);

      // Agent in different department cannot read it
      const crossDeptRes = await mktStorage.getRecordById(deptId);
      expect(crossDeptRes).toBeUndefined();

      // Executive Office agent CAN read it across departments
      const execRes = await execStorage.getRecordById(deptId);
      expect(execRes?.id).toBe(deptId);

      // 3. Non-executive agent attempting to insert ORGANIZATION_WIDE memory is rejected by RLS
      await expect(
        devStorage.saveRecord({
          id: randomUUID(),
          agentId: devAgent,
          agentCode: 'TECH-DEV1',
          departmentId: 'technology_engineering',
          taskId: randomUUID(),
          actionType: 'GLOBAL_POLICY',
          inputSummary: 'Illegal org wide broadcast',
          decisionRationale: 'Self elevation',
          outcome: 'Rejected',
          scope: 'ORGANIZATION_WIDE',
          importanceScore: 5,
          status: 'SUCCESS',
          metadata: {},
          recordedAt: new Date().toISOString(),
        })
      ).rejects.toThrow(/violates row-level security policy/i);
    });

    it('enforces communication envelopes ABAC policy on real PostgreSQL', async () => {
      const senderId = '00000000-0000-0000-0000-000000000041';
      const recipientId = '00000000-0000-0000-0000-000000000042';
      const spyId = '00000000-0000-0000-0000-000000000043';
      const messageId = randomUUID();

      // Insert message as sender
      await withSessionRls(
        appPool,
        { tenantId, agentId: senderId, departmentId: 'executive_office', principalLevel: 'SPECIALIST' },
        async (client) => {
          await client.query(`
            INSERT INTO agent_communication_envelopes (
              message_id, tenant_id, sender_agent_id, sender_agent_code, sender_department_id,
              recipient_agent_id, recipient_agent_code, recipient_department_id, type, priority,
              payload, correlation_id, delivery_status
            ) VALUES ($1, $2, $3, 'SENDER', 'executive_office', $4, 'RECIPIENT', 'executive_office', 'TASK_DELEGATION', 'HIGH', '{}', $1, 'PENDING')
          `, [messageId, tenantId, senderId, recipientId]);
        }
      );

      // Recipient can see the message
      const recipientCount = await withSessionRls(
        appPool,
        { tenantId, agentId: recipientId, departmentId: 'executive_office', principalLevel: 'SPECIALIST' },
        async (client) => {
          const res = await client.query('SELECT * FROM agent_communication_envelopes WHERE message_id = $1', [messageId]);
          return res.rows.length;
        }
      );
      expect(recipientCount).toBe(1);

      // Unauthorized third party cannot see the message (0 rows)
      const spyCount = await withSessionRls(
        appPool,
        { tenantId, agentId: spyId, departmentId: 'marketing_growth', principalLevel: 'SPECIALIST' },
        async (client) => {
          const res = await client.query('SELECT * FROM agent_communication_envelopes WHERE message_id = $1', [messageId]);
          return res.rows.length;
        }
      );
      expect(spyCount).toBe(0);
    });
  });

  // ==========================================================================
  // Section 4: Transaction Context & Connection Pool Reuse (Req 4)
  // ==========================================================================
  describe('4. Transaction-Scoped Context & Pooled Connection Reuse', () => {
    it('aborts uncommitted changes on transaction error and resets session context', async () => {
      const workingStorage = new PostgresWorkingStorage(appPool);
      const taskId = randomUUID();
      const agentId = randomUUID();

      await expect(
        withSessionRls(
          appPool,
          { tenantId, agentId, principalLevel: 'SPECIALIST' },
          async (client) => {
            await client.query(`
              INSERT INTO agent_working_memories (tenant_id, task_id, agent_id, key, value, expires_at)
              VALUES ($1, $2, $3, 'temp_key', '"temp_value"', NOW() + INTERVAL '1 hour')
            `, [tenantId, taskId, agentId]);
            // Simulate error inside transaction
            throw new Error('Simulated transaction failure');
          }
        )
      ).rejects.toThrow(/Simulated transaction failure/);

      // Verify the row was not committed
      const val = await workingStorage.get(
        { tenantId, agentId, principalLevel: 'SPECIALIST' },
        taskId,
        'temp_key'
      );
      expect(val).toBeUndefined();
    });

    it('verifies withSessionRls() resets pooled connection context on both success and error rollback', async () => {
      // Create a 1-connection pool to guarantee connection reuse
      const singleConnPool = createAppPool(DEFAULT_PG_CONFIG, 1);

      try {
        // 1. Successful transaction using actual withSessionRls() implementation
        const testContext = {
          tenantId: '00000000-0000-0000-0000-000000000001',
          agentId: '00000000-0000-0000-0000-000000000099',
          departmentId: 'technology_engineering',
          principalLevel: 'OWNER',
          isOwnerAuthenticated: true,
        };

        await withSessionRls(singleConnPool, testContext, async (client) => {
          const res = await client.query(`
            SELECT 
              current_setting('app.current_tenant_id', true) as tenant,
              current_setting('app.current_agent_id', true) as agent,
              current_setting('app.current_department_id', true) as dept,
              current_setting('app.current_principal_level', true) as level,
              current_setting('app.is_owner_authenticated', true) as owner
          `);
          expect(res.rows[0].tenant).toBe(testContext.tenantId);
          expect(res.rows[0].agent).toBe(testContext.agentId);
          expect(res.rows[0].dept).toBe(testContext.departmentId);
          expect(res.rows[0].level).toBe('OWNER');
          expect(res.rows[0].owner).toBe('true');
          return true;
        });

        // Reacquire that exact same physical connection from the single-connection pool
        const checkClient1 = await singleConnPool.connect();
        try {
          const res = await checkClient1.query(`
            SELECT 
              current_setting('app.current_tenant_id', true) as tenant,
              current_setting('app.current_agent_id', true) as agent,
              current_setting('app.current_department_id', true) as dept,
              current_setting('app.current_principal_level', true) as level,
              current_setting('app.is_owner_authenticated', true) as owner
          `);
          expect(res.rows[0].tenant).toBe('');
          expect(res.rows[0].agent).toBe('');
          expect(res.rows[0].dept).toBe('');
          expect(res.rows[0].level).toBe('');
          expect(res.rows[0].owner).toBe('false');
        } finally {
          checkClient1.release();
        }

        // 2. Failed transaction using actual withSessionRls() implementation
        const failContext = {
          tenantId: '00000000-0000-0000-0000-000000000002',
          agentId: '00000000-0000-0000-0000-000000000088',
          departmentId: 'financial_intelligence',
          principalLevel: 'DIRECTOR',
          isOwnerAuthenticated: false,
        };

        await expect(
          withSessionRls(singleConnPool, failContext, async () => {
            throw new Error('Forced transaction failure for rollback verification');
          })
        ).rejects.toThrow(/Forced transaction failure for rollback verification/);

        // Reacquire the same physical connection again; prove no context leaked after error
        const checkClient2 = await singleConnPool.connect();
        try {
          const res = await checkClient2.query(`
            SELECT 
              current_setting('app.current_tenant_id', true) as tenant,
              current_setting('app.current_agent_id', true) as agent,
              current_setting('app.current_department_id', true) as dept,
              current_setting('app.current_principal_level', true) as level,
              current_setting('app.is_owner_authenticated', true) as owner
          `);
          expect(res.rows[0].tenant).toBe('');
          expect(res.rows[0].agent).toBe('');
          expect(res.rows[0].dept).toBe('');
          expect(res.rows[0].level).toBe('');
          expect(res.rows[0].owner).toBe('false');
        } finally {
          checkClient2.release();
        }
      } finally {
        await singleConnPool.end();
      }
    });
  });

  // ==========================================================================
  // Section 5: Database Role Permissions & Least-Privilege (Req 5)
  // ==========================================================================
  describe('5. Database Role Permissions & Least-Privilege Restrictions', () => {
    it('verifies vme_app is a non-superuser and non-bypassrls role', async () => {
      const res = await adminPool.query(`
        SELECT rolname, rolsuper, rolbypassrls, rolcanlogin 
        FROM pg_roles 
        WHERE rolname = 'vme_app'
      `);
      const row = res.rows[0];

      expect(row.rolsuper).toBe(false);
      expect(row.rolbypassrls).toBe(false);
      expect(row.rolcanlogin).toBe(true);
    });

    it('verifies vme_readonly role can SELECT but fails closed on INSERT/UPDATE/DELETE', async () => {
      // 1. SELECT succeeds
      const selectRes = await roPool.query('SELECT count(*) FROM departments');
      expect(Number(selectRes.rows[0].count)).toBeGreaterThanOrEqual(9);

      // 2. INSERT fails closed with permission denied
      await expect(
        roPool.query(`
          INSERT INTO system_controls (control_key, is_active, reason)
          VALUES ('TEST_CONTROL', false, 'Test')
        `)
      ).rejects.toThrow(/permission denied for table system_controls/i);

      // 3. UPDATE fails closed
      await expect(
        roPool.query(`
          UPDATE system_controls SET is_active = true WHERE control_key = 'EMERGENCY_HALT'
        `)
      ).rejects.toThrow(/permission denied for table system_controls/i);

      // 4. DELETE fails closed
      await expect(
        roPool.query(`DELETE FROM departments WHERE id = 'executive_office'`)
      ).rejects.toThrow(/permission denied for table departments/i);
    });

    it('enforces database-level immutability triggers on financial ledger tables', async () => {
      const entryId = randomUUID();
      const uniqueEntryNumber = Date.now() + Math.floor(Math.random() * 100000);

      // Seed a posted financial journal entry first
      await adminPool.query(`
        INSERT INTO financial_journal_entries (
          id, tenant_id, entry_number, description, reference_type, reference_id,
          status, previous_hash, payload_hash, entry_hash, tx_id, committed_at
        ) VALUES (
          $1, $2, $3, 'Audited Capital Infusion', 'CAPITAL_SEED', 'audit-001',
          'POSTED', '0000000000000000000000000000000000000000000000000000000000000000',
          '0000000000000000000000000000000000000000000000000000000000000000',
          '0000000000000000000000000000000000000000000000000000000000000000',
          'tx-init-001', NOW()
        ) ON CONFLICT (id) DO NOTHING
      `, [entryId, tenantId, uniqueEntryNumber]);

      // 1. Attempt UPDATE on financial_journal_entries -> trigger fires
      await expect(
        adminPool.query(`
          UPDATE financial_journal_entries 
          SET description = 'Illegal mutation'
          WHERE id = $1
        `, [entryId])
      ).rejects.toThrow(/CRITICAL SECURITY VIOLATION: Operation UPDATE is strictly prohibited on immutable financial ledger table/i);

      // 2. Attempt DELETE on financial_journal_entries -> trigger fires
      await expect(
        adminPool.query(`
          DELETE FROM financial_journal_entries
          WHERE id = $1
        `, [entryId])
      ).rejects.toThrow(/CRITICAL SECURITY VIOLATION: Operation DELETE is strictly prohibited on immutable financial ledger table/i);
    });
  });

  // ==========================================================================
  // Section 6: Concurrent Approval Claims Using Separate Connections (Req 6)
  // ==========================================================================
  describe('6. Concurrent Approval Claims Using Separate Database Connections', () => {
    it('exercises ConsequentialPolicyEngine.claimApprovalForExecution() under vme_app with separate physical connections', async () => {
      const requestId = `req-pg-concurrency-${randomUUID()}`;
      const taskId = randomUUID();
      const agentId = randomUUID();
      const payload = { amount: 1000, recipient: 'vendor-ops' };
      const paramHash = computeParameterHash(payload);

      // 1. Seed an APPROVED request into consequential_authorization_requests via withSessionRls under appPool (vme_app role)
      await withSessionRls(
        appPool,
        { tenantId, agentId, principalLevel: 'OWNER', isOwnerAuthenticated: true },
        async (client) => {
          await client.query(`
            INSERT INTO consequential_authorization_requests (
              id, tenant_id, task_id, action_type, agent_id, department_id,
              parameter_hash, payload, status, requested_at, valid_until
            ) VALUES (
              $1, $2, $3, 'CAPITAL_TRANSFER', $4, 'financial_intelligence',
              $5, $6, 'APPROVED', NOW(), NOW() + INTERVAL '1 hour'
            )
          `, [requestId, tenantId, taskId, agentId, paramHash, JSON.stringify(payload)]);
        }
      );

      // 2. Instantiate 2 separate 1-connection pools for vme_app to guarantee separate physical connections
      const poolA = createAppPool(DEFAULT_PG_CONFIG, 1);
      const poolB = createAppPool(DEFAULT_PG_CONFIG, 1);

      try {
        const engineA = new ConsequentialPolicyEngine({ pool: poolA, tenantId });
        const engineB = new ConsequentialPolicyEngine({ pool: poolB, tenantId });

        // 3. Concurrently claim approval using ConsequentialPolicyEngine across separate physical connections
        const [resA, resB] = await Promise.allSettled([
          engineA.claimApprovalForExecution(requestId, payload),
          engineB.claimApprovalForExecution(requestId, payload),
        ]);

        const fulfilled = [resA, resB].filter((r): r is PromiseFulfilledResult<ConsequentialAuthorizationRecord> => r.status === 'fulfilled');
        const rejected = [resA, resB].filter((r): r is PromiseRejectedResult => r.status === 'rejected');

        // Exactly one concurrent claimant must succeed
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);

        const winnerRecord = fulfilled[0]!.value;
        expect(winnerRecord.status).toBe('EXECUTED');
        expect(winnerRecord.executionStatus).toBe('PENDING_COMPLETION');
        expect(winnerRecord.executedAt).toBeDefined();

        const loserError = rejected[0]!.reason;
        expect(loserError.message).toMatch(/Concurrent execution detected/i);

        // 4. Verify persisted authorization record and execution state in PostgreSQL using vme_app
        const persistedRecord = await engineA.getRequestById(requestId);
        expect(persistedRecord).toBeDefined();
        expect(persistedRecord?.status).toBe('EXECUTED');
        expect(persistedRecord?.executionStatus).toBe('PENDING_COMPLETION');
        expect(persistedRecord?.executedAt).toBeDefined();
      } finally {
        await poolA.end();
        await poolB.end();
      }
    });
  });

  // ==========================================================================
  // Section 7: Durable Persistence & Process Restart Recovery (Req 7)
  // ==========================================================================
  describe('7. Durable Persistence & Process Restart Recovery Across Connections', () => {
    it('persists and recovers quad-tier memory, authorization requests, and performance events across pool destruction using vme_app', async () => {
      const restartTenantId = tenantId;
      const agentId = randomUUID();
      const taskId = randomUUID();
      const playbookId = randomUUID();
      const authRequestId = `req-persist-${randomUUID()}`;

      // --- PHASE A: Application writes state to PostgreSQL strictly using vme_app role ---
      const pool1 = createAppPool();
      try {
        // 1. Working memory
        const working1 = new PostgresWorkingStorage(pool1, { tenantId: restartTenantId, agentId, principalLevel: 'SPECIALIST' });
        await working1.set(taskId, 'restart_token', 'persist_ok');

        // 2. Episodic memory
        const episodic1 = new PostgresEpisodicStorage(pool1, {
          tenantId: restartTenantId,
          agentId,
          departmentId: 'technology_engineering',
          principalLevel: 'SPECIALIST',
        });
        await episodic1.saveRecord({
          id: randomUUID(),
          agentId,
          agentCode: 'TECH-1',
          departmentId: 'technology_engineering',
          taskId,
          actionType: 'SYSTEM_CHECK',
          inputSummary: 'Pre-restart diagnostics',
          decisionRationale: 'Persist state',
          outcome: 'Nominal',
          scope: 'AGENT_PRIVATE',
          importanceScore: 9,
          status: 'SUCCESS',
          metadata: {},
          recordedAt: new Date().toISOString(),
        });

        // 3. Semantic memory
        const semantic1 = new PostgresSemanticStorage(pool1, {
          tenantId: restartTenantId,
          agentId,
          departmentId: 'technology_engineering',
          principalLevel: 'EXECUTIVE',
        });
        await semantic1.insert({
          id: randomUUID(),
          category: 'ARCHITECTURE',
          title: 'Durable Recovery Architecture',
          content: 'PostgreSQL provides ACID transactional safety.',
          embedding: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
          embeddingMetadata: {
            provider: 'openai',
            model: 'text-embedding-3-small',
            dimension: 8,
            version: '1.0.0',
          },
          importanceScore: 9,
          tags: ['architecture', 'durability'],
          version: '1.0.0',
          scope: 'ORGANIZATION_WIDE',
          isDeprecated: false,
          metadata: {},
          createdAt: new Date().toISOString(),
        });

        // 4. Procedural memory
        const procedural1 = new PostgresProceduralStorage(pool1, {
          tenantId: restartTenantId,
          agentId,
          departmentId: 'technology_engineering',
          principalLevel: 'EXECUTIVE',
        });
        await procedural1.savePlaybook({
          id: playbookId,
          authorAgentId: agentId,
          authorAgentCode: 'TECH-1',
          authorizedBy: 'TECH-CTO',
          name: 'Disaster Recovery Playbook',
          description: 'Step-by-step restoration procedures',
          triggerCondition: 'On node failure',
          requiredCapabilities: ['software_architecture'],
          steps: [
            {
              stepNumber: 1,
              name: 'reconnect',
              instruction: 'reconnect to node',
              requiredCapability: 'software_architecture',
              timeoutMs: 5000,
              retryLimit: 1,
            },
          ],
          scope: 'ORGANIZATION_WIDE',
          isApproved: true,
          successCount: 0,
          failureCount: 0,
          version: '1.0.0',
          metadata: {},
          createdAt: new Date().toISOString(),
        });

        // 5. Authorization record via ConsequentialPolicyEngine
        const policyEngine1 = new ConsequentialPolicyEngine({
          pool: pool1,
          tenantId: restartTenantId,
        });
        const reqPayload = { action: 'NODE_RECOVERY', target: 'cluster-01' };
        await policyEngine1.quarantineAction({
          id: authRequestId,
          actionType: 'EXTERNAL_OUTREACH',
          agentId,
          departmentId: 'technology_engineering',
          taskId,
          payload: reqPayload,
        });

        // 6. Performance event via PerformanceEventStore
        const eventStore1 = new PerformanceEventStore(pool1, restartTenantId);
        await eventStore1.recordEvent({
          agentId,
          departmentId: 'technology_engineering',
          taskId,
          eventType: 'DIAGNOSTIC_RUN',
          durationMs: 420,
          tokensUsed: 1500,
          costUsd: 0.003,
          isSuccessful: true,
        });
      } finally {
        // Destroy Process 1 pool and all physical connections completely
        await pool1.end();
      }

      // --- PHASE B: Application Process 2 starts up fresh with new pool and recovers state under vme_app ---
      const pool2 = createAppPool();
      try {
        // 1. Working memory recovery
        const working2 = new PostgresWorkingStorage(pool2, { tenantId: restartTenantId, agentId, principalLevel: 'SPECIALIST' });
        const val = await working2.get(taskId, 'restart_token');
        expect(val).toBe('persist_ok');

        // 2. Episodic memory recovery under correct agent RLS context
        const episodic2 = new PostgresEpisodicStorage(pool2, {
          tenantId: restartTenantId,
          agentId,
          departmentId: 'technology_engineering',
          principalLevel: 'SPECIALIST',
        });
        const epRecords = await episodic2.queryRecords({ agentId });
        expect(epRecords.length).toBeGreaterThanOrEqual(1);
        expect(epRecords.some((r) => r.inputSummary === 'Pre-restart diagnostics')).toBe(true);

        // 3. Semantic memory recovery with cosine similarity vector search
        const semantic2 = new PostgresSemanticStorage(pool2, {
          tenantId: restartTenantId,
          agentId,
          departmentId: 'technology_engineering',
          principalLevel: 'SPECIALIST',
        });
        const semSearch = await semantic2.search(
          [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
          {
            provider: 'openai',
            model: 'text-embedding-3-small',
            dimension: 8,
            version: '1.0.0',
          },
          { limit: 1 }
        );
        expect(semSearch.length).toBeGreaterThanOrEqual(1);
        expect(semSearch[0]?.item.title).toBe('Durable Recovery Architecture');
        expect(semSearch[0]?.similarity).toBeGreaterThan(0.99);

        // 4. Procedural memory recovery
        const procedural2 = new PostgresProceduralStorage(pool2, {
          tenantId: restartTenantId,
          agentId,
          departmentId: 'technology_engineering',
          principalLevel: 'SPECIALIST',
        });
        const playbook = await procedural2.getPlaybookById(playbookId);
        expect(playbook).toBeDefined();
        expect(playbook?.isApproved).toBe(true);

        // 5. Authorization request recovery under vme_app
        const policyEngine2 = new ConsequentialPolicyEngine({
          pool: pool2,
          tenantId: restartTenantId,
        });
        const authRecord = await policyEngine2.getRequestById(authRequestId);
        expect(authRecord).toBeDefined();
        expect(authRecord?.status).toBe('PENDING_OWNER_REVIEW');

        // 6. Performance event recovery under vme_app
        const eventStore2 = new PerformanceEventStore(pool2, restartTenantId);
        const events = await eventStore2.getAgentEvents(agentId);
        expect(events.length).toBeGreaterThanOrEqual(1);
        expect(events[0]?.durationMs).toBe(420);
        expect(events[0]?.costUsd).toBe(0.003);

        // 7. Verify cross-tenant isolation under vme_app (foreign tenant sees 0 rows)
        const foreignWorking = new PostgresWorkingStorage(pool2, {
          tenantId: tenant2Id,
          agentId,
          principalLevel: 'SPECIALIST',
        });
        const foreignVal = await foreignWorking.get(taskId, 'restart_token');
        expect(foreignVal).toBeUndefined();
      } finally {
        await pool2.end();
      }
    });

    it('verifies durable persistence and state recovery across genuine child process restarts under vme_app', async () => {
      const workerScript = resolve(__dirname, 'process-restart-worker.cjs');
      const childTenantId = tenantId;
      const childAgentId = randomUUID();
      const childTaskId = randomUUID();
      const childRecordId = randomUUID();

      const nodeModulesDir = resolve(__dirname, '../node_modules');
      const env = {
        ...process.env,
        DB_SESSION_SECRET: CANONICAL_DB_SESSION_SECRET,
        NODE_PATH: nodeModulesDir,
        VME_POSTGRES_HOST: DEFAULT_PG_CONFIG.host,
        VME_POSTGRES_PORT: String(DEFAULT_PG_CONFIG.port),
        VME_POSTGRES_APP_USER: DEFAULT_PG_CONFIG.appUser,
        VME_POSTGRES_APP_PASSWORD: DEFAULT_PG_CONFIG.appPassword,
        VME_POSTGRES_DB: DEFAULT_PG_CONFIG.database,
      };

      // Process 0: Adversarial attempt - child process tries to elevate/write merely by setting GUC values
      const proc0 = spawnSync(
        process.execPath,
        [workerScript, 'tamper', childTenantId, childAgentId, childTaskId, childRecordId],
        { env, encoding: 'utf8' }
      );
      if (proc0.status !== 0) {
        throw new Error(`Child Process 0 (tamper) failed: ${proc0.stderr || proc0.stdout}`);
      }
      expect(proc0.status).toBe(0);
      expect(proc0.stdout).toContain('TAMPER_BLOCKED_SUCCESSFULLY');

      // Process 1: Starts as independent OS process, connects as vme_app, writes state, and terminates
      const proc1 = spawnSync(
        process.execPath,
        [workerScript, 'write', childTenantId, childAgentId, childTaskId, childRecordId],
        { env, encoding: 'utf8' }
      );
      if (proc1.status !== 0) {
        throw new Error(`Child Process 1 failed: ${proc1.stderr || proc1.stdout}`);
      }
      expect(proc1.status).toBe(0);
      expect(proc1.stdout).toContain('WRITE_COMPLETE');

      // Process 2: Starts independently in a fresh OS process, reconnects as vme_app, and recovers state
      const proc2 = spawnSync(
        process.execPath,
        [workerScript, 'read', childTenantId, childAgentId, childTaskId, childRecordId],
        { env, encoding: 'utf8' }
      );
      if (proc2.status !== 0) {
        throw new Error(`Child Process 2 failed: ${proc2.stderr || proc2.stdout}`);
      }
      expect(proc2.status).toBe(0);
      expect(proc2.stdout).toContain('READ_COMPLETE');
    });
  });

  // ==========================================================================
  // Section 8: Messaging Recovery & Dead-Letter Queue (Req 8)
  // ==========================================================================
  describe('8. Messaging Recovery, Unacknowledged Messages & Dead-Letter Queue', () => {
    it('recovers delivered-but-unacknowledged messages after router process restart', async () => {
      const hierarchy = new DepartmentRegistry();
      const messageStorage = new PostgresMessageStorage(adminPool, { tenantId });
      const router1 = new MessageRouter(hierarchy, {
        mode: 'PRODUCTION_POSTGRES',
        postgresStorage: messageStorage,
      });

      const cto = hierarchy.getAgentRecord('TECH-CTO')!;
      const arch = hierarchy.getAgentRecord('TECH-ARCH')!;

      // 1. Dispatch message (transitions to DELIVERED)
      const envelope = await router1.dispatch({
        senderAgentId: cto.id,
        recipientAgentId: arch.id,
        type: 'TASK_DELEGATION',
        priority: 'HIGH',
        payload: { instruction: 'Durable message recovery audit' },
      });

      expect(envelope.deliveryStatus).toBe('DELIVERED');

      // 2. Simulate process crash by clearing in-memory routing tables
      router1.clearInbox(arch.id);
      expect(router1.getInbox(arch.id)).toHaveLength(0);

      // 3. New router instance restarts and recovers unacknowledged messages
      const router2 = new MessageRouter(hierarchy, {
        mode: 'PRODUCTION_POSTGRES',
        postgresStorage: messageStorage,
      });

      const recovered = await router2.recoverPendingMessages();
      expect(recovered.length).toBeGreaterThanOrEqual(1);
      const target = recovered.find((m) => m.messageId === envelope.messageId);
      expect(target).toBeDefined();
      expect(target?.deliveryStatus).toBe('DELIVERED');

      // 4. Acknowledge the message and verify updated delivery state in PostgreSQL
      const ack = await router2.acknowledgeMessageAsync(envelope.messageId, arch.id, 'ACCEPTED');
      expect(ack.status).toBe('ACCEPTED');

      const savedAck = await messageStorage.getAcknowledgment(envelope.messageId);
      expect(savedAck?.status).toBe('ACCEPTED');

      const updatedEnvelope = await messageStorage.getEnvelopeById(envelope.messageId);
      expect(updatedEnvelope?.deliveryStatus).toBe('ACKNOWLEDGED');
    });

    it('exercises retry scheduling, exponential backoff, and dead-letter queue routing', async () => {
      const messageStorage = new PostgresMessageStorage(adminPool, { tenantId });
      const hierarchy = new DepartmentRegistry();
      const cto = hierarchy.getAgentRecord('TECH-CTO')!;
      const arch = hierarchy.getAgentRecord('TECH-ARCH')!;
      const msgId = randomUUID();

      // Persist envelope
      await messageStorage.persistEnvelope({
        messageId: msgId,
        senderAgentId: cto.id,
        senderAgentCode: cto.agentCode,
        senderDepartmentId: cto.departmentId,
        recipientAgentId: arch.id,
        recipientAgentCode: arch.agentCode,
        recipientDepartmentId: arch.departmentId,
        type: 'TASK_DELEGATION',
        priority: 'MEDIUM',
        payload: { task: 'Unreachable service integration' },
        correlationId: msgId,
        deliveryStatus: 'PENDING',
        requiresResponse: false,
        sentAt: new Date().toISOString(),
      });

      // Retry 1: Backoff scheduled
      const retry1 = await messageStorage.calculateBackoffAndScheduleRetry(msgId, 0, 500, 3);
      expect(retry1.shouldRetry).toBe(true);
      expect(retry1.retryCount).toBe(1);
      expect(retry1.nextRetryAt).toBeDefined();

      // Retry 2: Next backoff
      const retry2 = await messageStorage.calculateBackoffAndScheduleRetry(msgId, 1, 500, 3);
      expect(retry2.shouldRetry).toBe(true);
      expect(retry2.retryCount).toBe(2);

      // Retry 3: Max reached
      const retry3 = await messageStorage.calculateBackoffAndScheduleRetry(msgId, 3, 500, 3);
      expect(retry3.shouldRetry).toBe(false);

      // Route to Dead-Letter Queue
      const failedEnv = (await messageStorage.getEnvelopeById(msgId))!;
      await messageStorage.routeToDeadLetter(failedEnv, 'Max retries exhausted (PostgreSQL integration test)', 3);

      // Verify dead letters in PostgreSQL
      const deadLetters = await messageStorage.getDeadLetters();
      const dlqRecord = deadLetters.find((d) => d.messageId === msgId);
      expect(dlqRecord).toBeDefined();
      expect(dlqRecord.failureReason).toContain('Max retries exhausted');
      expect(dlqRecord.retryAttempts).toBe(3);
    });
  });

  // ==========================================================================
  // Section 9: Complete Corporate Lifecycle on Genuine PostgreSQL
  // ==========================================================================
  describe('9. Complete Corporate Lifecycle Execution Against Real PostgreSQL', () => {
    it('executes full autonomous corporate lifecycle with real PostgreSQL persistence and Owner authorization', async () => {
      const hierarchy = new DepartmentRegistry();
      const supervisor = new EmergencySupervisor(undefined, false);

      const messageStorage = new PostgresMessageStorage(adminPool, { tenantId });
      const router = new MessageRouter(hierarchy, {
        mode: 'PRODUCTION_POSTGRES',
        postgresStorage: messageStorage,
        emergencySupervisor: supervisor,
      });

      const memoryEngine = new AgentMemoryEngine({
        mode: 'PRODUCTION_POSTGRES',
        pool: adminPool,
        defaultTenantId: tenantId,
        emergencySupervisor: supervisor,
      });

      const eventStore = new PerformanceEventStore(adminPool, tenantId);
      const authService = new OwnerAuthenticationService();
      const policyEngine = new ConsequentialPolicyEngine({
        pool: adminPool,
        tenantId,
        authService,
      });

      const delegationManager = new DelegationManager(hierarchy, router, policyEngine);

      const mockLLM = new MockLLMProvider();
      mockLLM.registerCannedResponse('Rust', 'Discovered 4 Senior Remote Rust Contracts');
      mockLLM.registerCannedResponse('Mean Reversion', 'Strategy validated. 90-day Sharpe: 2.1');
      const modelGateway = new ModelGateway();
      modelGateway.registerAdapter(mockLLM);

      const orchestratorRegistry = new AgentRegistry(modelGateway, supervisor);
      for (const agent of hierarchy.getAllAgents()) {
        orchestratorRegistry.registerAgent(agent);
      }

      const toolRuntime = new ToolExecutionRuntime(hierarchy, {
        emergencySupervisor: supervisor,
        pool: adminPool,
        tenantId,
        workspaceRoot: testSandboxDir,
        policyEngine,
        eventStore,
      });

      const coordinator = new AutonomyCoordinator(
        hierarchy,
        orchestratorRegistry,
        memoryEngine.episodic,
        delegationManager,
        {
          workingMemory: memoryEngine.working,
          toolRuntime,
          emergencySupervisor: supervisor,
        }
      );

      const reporter = new ExecutiveReporter(hierarchy, delegationManager);
      const ceoOrchestrator = new CEOOrchestrator(
        hierarchy,
        coordinator,
        delegationManager,
        reporter,
        supervisor
      );

      // 1. Ingest Owner Strategic Directive
      const directiveExecution = await ceoOrchestrator.ingestOwnerDirective({
        directive: {
          title: 'Q4 Autonomous Expansion on Genuine PostgreSQL Engine',
          description: 'Discover remote Rust contracts, conduct forex paper trading backtests in USD, and prepare client outreach dossier.',
          targetQuarter: '2026-Q4',
          departmentFocus: ['opportunity_acquisition', 'financial_intelligence'],
        },
        tenantId,
        submittedBy: OWNER_PRINCIPAL_ID,
      });

      expect(directiveExecution.objective.id).toBeDefined();

      // 2. Specialist Routine Tool Execution with Real PostgreSQL Task Execution Logging
      const techArch = hierarchy.getAgentRecord('TECH-ARCH')!;
      const routineWrite = (await toolRuntime.executeTool(
        'real_filesystem',
        {
          action: 'write',
          relativePath: 'reports/routine_analysis.txt',
          content: '# VME Architecture Spec\nValidated on real PostgreSQL 16 engine.',
        },
        {
          agentId: techArch.id,
          agentCode: techArch.agentCode,
          departmentId: techArch.departmentId,
          taskId: randomUUID(),
        }
      )) as { verified: boolean; bytesWritten: number };

      expect(routineWrite.verified).toBe(true);
      expect(routineWrite.bytesWritten).toBeGreaterThan(0);

      // 3. Consequential Action Quarantine & Cryptographic Owner Approval
      toolRuntime.registerTool({
        name: 'dispatch_outreach_dossier',
        description: 'Dispatches finalized outreach dossiers to external prospective clients',
        requiredCapability: 'software_architecture',
        departmentScope: 'technology_engineering',
        consequentialType: 'EXTERNAL_OUTREACH',
        execute: async (input: Record<string, unknown>) => {
          return { delivered: true, recipientCount: 3, input };
        },
      });

      // Obtain the quarantined consequential task from CEO decomposition
      expect(directiveExecution.quarantinedForOwner.length).toBeGreaterThanOrEqual(1);
      const quarantinedTask = directiveExecution.quarantinedForOwner[0]!;
      expect(quarantinedTask.status).toBe('WAITING_FEEDBACK');

      const pendingRequests = await policyEngine.getPendingRequests();
      expect(pendingRequests.length).toBeGreaterThanOrEqual(1);
      const approvalReq = pendingRequests.find((r) => r.taskId === quarantinedTask.id) ?? pendingRequests[pendingRequests.length - 1]!;
      expect(approvalReq.status).toBe('PENDING_OWNER_REVIEW');

      // Owner issues cryptographically signed session token
      const ownerSession = authService.createOwnerSession({
        principalId: OWNER_PRINCIPAL_ID,
        email: CANONICAL_OWNER_PRINCIPAL.email,
        credentials: ownerMasterKey,
      });

      // Owner approves consequential action through DelegationManager
      const approval = await delegationManager.authorizeAction(
        approvalReq.id,
        'APPROVED',
        ownerSession.token,
        'Authorized: Real PostgreSQL verification passed'
      );
      expect(approval.status).toBe('APPROVED');

      // 4. Specialist executes the approved consequential tool with approval token
      const executedConsequential = (await toolRuntime.executeTool(
        'dispatch_outreach_dossier',
        quarantinedTask.inputData,
        {
          agentId: techArch.id,
          agentCode: techArch.agentCode,
          departmentId: techArch.departmentId,
          taskId: quarantinedTask.id,
        },
        { approvalRequestId: approvalReq.id }
      )) as any;

      expect(executedConsequential.delivered).toBe(true);

      // Verify final status in PostgreSQL is EXECUTED
      const executedRecord = await policyEngine.getRequestById(approvalReq.id);
      expect(executedRecord?.status).toBe('EXECUTED');

      // 5. Generate Executive Board Report
      const boardReport = ceoOrchestrator.generateBoardReport();
      expect(boardReport.companyName).toBe('VIRTUAL MENDEZ EMPIRE');
      expect(boardReport.departments).toHaveLength(9);
    });
  });

  // ==========================================================================
  // Section 10: Cryptographically Verified Database Identity & Adversarial GUC Tampering Defense
  // ==========================================================================
  describe('10. Cryptographically Verified Database Identity & Adversarial GUC Tampering Defense', () => {
    it('rejects caller-supplied Owner authentication booleans via raw GUC set_config (negative test)', async () => {
      const client = await appPool.connect();
      try {
        await client.query('BEGIN');
        // Adversary running as vme_app tries to claim Owner identity by tampering with GUC settings
        await client.query(`
          SELECT 
            set_config('app.is_owner_authenticated', 'true', false),
            set_config('app.current_principal_level', 'OWNER', false),
            set_config('app.current_agent_id', '00000000-0000-0000-0000-000000000000', false)
        `);

        // Database engine MUST NOT trust unverified GUC values
        const res = await client.query(`SELECT is_current_principal_owner() as "isOwner"`);
        expect(res.rows[0].isOwner).toBe(false);

        await client.query('ROLLBACK');
      } finally {
        await client.query('SELECT clear_authenticated_session()');
        client.release();
      }
    });

    it('rejects caller-supplied Executive level via raw GUC set_config (negative test)', async () => {
      const client = await appPool.connect();
      try {
        await client.query('BEGIN');
        // Adversary running as vme_app tries to claim Executive privileges
        await client.query(`
          SELECT 
            set_config('app.current_principal_level', 'EXECUTIVE', false),
            set_config('app.current_department_id', 'executive_office', false)
        `);

        // Database engine MUST NOT trust unverified GUC values
        const res = await client.query(`SELECT is_current_principal_executive() as "isExec"`);
        expect(res.rows[0].isExec).toBe(false);

        await client.query('ROLLBACK');
      } finally {
        await client.query('SELECT clear_authenticated_session()');
        client.release();
      }
    });

    it('rejects caller-supplied Agent impersonation via raw GUC set_config (negative test)', async () => {
      const client = await appPool.connect();
      try {
        await client.query('BEGIN');
        const victimAgentId = randomUUID();
        // Adversary running as vme_app tries to impersonate another agent
        await client.query(`SELECT set_config('app.current_agent_id', $1, false)`, [victimAgentId]);

        // get_current_agent_id() MUST fail closed and return NULL
        const res = await client.query(`SELECT get_current_agent_id() as "agentId"`);
        expect(res.rows[0].agentId).toBeNull();

        await client.query('ROLLBACK');
      } finally {
        await client.query('SELECT clear_authenticated_session()');
        client.release();
      }
    });

    it('rejects forged or invalid signatures passed to set_authenticated_session() (negative test)', async () => {
      const client = await appPool.connect();
      try {
        const claims = {
          tenantId,
          agentId: randomUUID(),
          principalLevel: 'OWNER',
          isOwner: true,
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
          nonce: randomUUID(),
        };
        const forgedSignature = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

        await expect(
          client.query(`SELECT set_authenticated_session($1::jsonb, $2)`, [
            JSON.stringify(claims),
            forgedSignature,
          ])
        ).rejects.toThrow(/CRITICAL SECURITY VIOLATION: Invalid database session authentication signature/i);
      } finally {
        client.release();
      }
    });

    it('rejects expired claims passed to set_authenticated_session() (negative test)', async () => {
      const client = await appPool.connect();
      try {
        const secret = getDatabaseSessionSecret();
        const expiredClaims = {
          tenantId,
          agentId: randomUUID(),
          principalLevel: 'SPECIALIST',
          isOwner: false,
          expiresAt: Math.floor(Date.now() / 1000) - 300, // 5 minutes in the past
          nonce: randomUUID(),
        };
        const { claimsPayload, signature } = signDatabaseClaims(expiredClaims, secret);

        await expect(
          client.query(`SELECT set_authenticated_session($1::jsonb, $2)`, [
            JSON.stringify(claimsPayload),
            signature,
          ])
        ).rejects.toThrow(/CRITICAL SECURITY VIOLATION: Database session claims expired or invalid timestamp/i);
      } finally {
        client.release();
      }
    });

    it('denies vme_app direct read/write access to system_auth_secrets table (negative test)', async () => {
      const client = await appPool.connect();
      try {
        await expect(
          client.query(`SELECT * FROM system_auth_secrets`)
        ).rejects.toThrow(/permission denied for table system_auth_secrets/i);

        await expect(
          client.query(`INSERT INTO system_auth_secrets (key_name, secret_value) VALUES ('hacked', 'pwned')`)
        ).rejects.toThrow(/permission denied for table system_auth_secrets/i);
      } finally {
        client.release();
      }
    });

    it('proves legitimately signed Owner session succeeds and enforces Owner RLS privileges (positive test)', async () => {
      const ownerAgentId = '00000000-0000-0000-0000-000000000000';
      const specialistAgentId = randomUUID();
      const testTaskId = randomUUID();

      // 1. Specialist writes AGENT_PRIVATE memory
      await withSessionRls(
        appPool,
        { tenantId, agentId: specialistAgentId, principalLevel: 'SPECIALIST' },
        async (client) => {
          await client.query(`
            INSERT INTO agent_working_memories (tenant_id, task_id, agent_id, key, value, expires_at)
            VALUES ($1, $2, $3, 'private_owner_check', '"confidential_data"', NOW() + INTERVAL '1 hour')
          `, [tenantId, testTaskId, specialistAgentId]);
        }
      );

      // 2. Verified Owner session accesses the private memory
      const ownerVal = await withSessionRls(
        appPool,
        { tenantId, agentId: ownerAgentId, principalLevel: 'OWNER', isOwnerAuthenticated: true },
        async (client) => {
          const res = await client.query(`
            SELECT value FROM agent_working_memories
            WHERE tenant_id = $1 AND task_id = $2 AND key = 'private_owner_check'
          `, [tenantId, testTaskId]);
          return res.rows[0]?.value;
        }
      );

      expect(ownerVal).toBe('confidential_data');
    });

    it('proves legitimately signed Executive session succeeds and enforces Executive RLS privileges (positive test)', async () => {
      const execAgentId = randomUUID();
      const testRecordId = randomUUID();

      // Executive writes ORGANIZATION_WIDE episodic memory (which requires is_current_principal_executive() = true)
      await withSessionRls(
        appPool,
        {
          tenantId,
          agentId: execAgentId,
          departmentId: 'executive_office',
          principalLevel: 'EXECUTIVE',
        },
        async (client) => {
          const checkRes = await client.query(`SELECT is_current_principal_executive() as "isExec"`);
          expect(checkRes.rows[0].isExec).toBe(true);

          await client.query(`
            INSERT INTO agent_episodic_memories (
              id, tenant_id, agent_id, agent_code, department_id, task_id,
              action_type, input_summary, decision_rationale, outcome, scope,
              importance_score, status, metadata, recorded_at
            ) VALUES (
              $1, $2, $3, 'EXEC-1', 'executive_office', $4,
              'POLICY_DIRECTIVE', 'Executive Org-Wide Scope Authorization Test',
              'Authenticated executive claims verified', 'SUCCESS', 'ORGANIZATION_WIDE',
              10, 'SUCCESS', '{}'::jsonb, NOW()
            )
          `, [testRecordId, tenantId, execAgentId, randomUUID()]);
        }
      );

      // Verify the record was successfully written
      const client = await appPool.connect();
      try {
        await applyAuthenticatedSession(client, {
          tenantId,
          agentId: execAgentId,
          departmentId: 'executive_office',
          principalLevel: 'EXECUTIVE',
        });
        const res = await client.query(`
          SELECT id, scope FROM agent_episodic_memories WHERE id = $1
        `, [testRecordId]);
        expect(res.rows[0]?.scope).toBe('ORGANIZATION_WIDE');
      } finally {
        await clearAuthenticatedSession(client);
        client.release();
      }
    });

    it('proves legitimately signed Specialist session cannot escalate to Executive or Owner (positive boundary test)', async () => {
      const specialistId = randomUUID();

      await withSessionRls(
        appPool,
        {
          tenantId,
          agentId: specialistId,
          departmentId: 'technology_engineering',
          principalLevel: 'SPECIALIST',
        },
        async (client) => {
          const res = await client.query(`
            SELECT 
              get_current_agent_id() as "agentId",
              get_current_department_id() as "deptId",
              get_current_principal_level() as "level",
              is_current_principal_owner() as "isOwner",
              is_current_principal_executive() as "isExec"
          `);
          const row = res.rows[0];
          expect(row.agentId).toBe(specialistId);
          expect(row.deptId).toBe('technology_engineering');
          expect(row.level).toBe('SPECIALIST');
          expect(row.isOwner).toBe(false);
          expect(row.isExec).toBe(false);

          // Specialist cannot write ORGANIZATION_WIDE episodic memory (forbidden by RLS)
          await expect(
            client.query(`
              INSERT INTO agent_episodic_memories (
                id, tenant_id, agent_id, agent_code, department_id, task_id,
                action_type, input_summary, decision_rationale, outcome, scope,
                importance_score, status, metadata, recorded_at
              ) VALUES (
                $1, $2, $3, 'DEV-1', 'technology_engineering', $4,
                'UNAUTHORIZED_ACTION', 'Specialist trying to insert org-wide memory',
                'Should be rejected by ABAC RLS', 'FAIL', 'ORGANIZATION_WIDE',
                5, 'FAILURE', '{}'::jsonb, NOW()
              )
            `, [randomUUID(), tenantId, specialistId, randomUUID()])
          ).rejects.toThrow(/violates row-level security policy/i);
        }
      );
    });
  });
});
