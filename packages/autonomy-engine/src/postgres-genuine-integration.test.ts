import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID, randomBytes, createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  OWNER_PRINCIPAL_ID,
  CANONICAL_OWNER_PRINCIPAL,
} from '@vme/shared-types';
import { DepartmentRegistry, UnauthorizedHierarchyActionError } from '@vme/department-hierarchy';
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
import { TaskExecutionRecorder } from './real-execution-adapters.js';
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
  let canonicalRegistry: DepartmentRegistry;

  const tenantId = '00000000-0000-0000-0000-000000000001';
  const tenant2Id = '00000000-0000-0000-0000-000000000002';
  const ownerHmacSecret = 'vme-canonical-owner-hmac-secret-test-32b-length';
  const ownerMasterKey = 'vme-owner-secure-cryptographic-master-key-2026';

  beforeAll(async () => {
    const dynamicDbSecret = randomBytes(32).toString('hex');
    process.env.DB_SESSION_SECRET = dynamicDbSecret;
    process.env.OWNER_AUTH_SECRET = ownerHmacSecret;
    process.env.OWNER_AUTH_CREDENTIALS = ownerMasterKey;
    canonicalRegistry = new DepartmentRegistry();
    testSandboxDir = mkdtempSync(join(tmpdir(), 'vme-pg-genuine-test-'));

    // Initialize admin pool and assert genuine PostgreSQL is reachable
    adminPool = createAdminPool();
    const envInfo = await assertGenuinePostgresAvailable(adminPool);
    console.log(`[Integration Test] Connected to genuine engine: ${envInfo.version}`);

    // Execute real migrations against PostgreSQL
    const migrations = await executeRealMigrations(adminPool);
    console.log(`[Integration Test] Executed migrations: ${migrations.join(', ')}`);

    // Ensure session signing secret is explicitly set in system_auth_secrets via administrative function
    const setupClient = await adminPool.connect();
    try {
      await setupClient.query(`SELECT provision_session_signing_secret($1)`, [dynamicDbSecret]);
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
      const workingStorage = new PostgresWorkingStorage(appPool, undefined, canonicalRegistry);

      const agentId = '00000000-0000-0000-0000-000000000010'; // TECH-DEVOPS
      const taskId = randomUUID();

      // Set working memory for Tenant 1: set(ctx, taskId, agentId, key, value)
      await workingStorage.set(
        { tenantId, agentId, principalLevel: 'SPECIALIST', authoritativeRegistry: canonicalRegistry },
        taskId,
        agentId,
        'state_data',
        'alpha_value'
      );

      // Verify Tenant 1 can read its value: get(ctx, taskId, key)
      const t1Val = await workingStorage.get(
        { tenantId, agentId, principalLevel: 'SPECIALIST', authoritativeRegistry: canonicalRegistry },
        taskId,
        'state_data'
      );
      expect(t1Val).toBe('alpha_value');

      // Tenant 2 with same taskId and agentId CANNOT see Tenant 1 data
      const t2Val = await workingStorage.get(
        { tenantId: tenant2Id, agentId, principalLevel: 'SPECIALIST', authoritativeRegistry: canonicalRegistry },
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
      const workingStorage = new PostgresWorkingStorage(appPool, undefined, canonicalRegistry);
      const agentA = '00000000-0000-0000-0000-000000000008'; // TECH-DEV-01
      const agentB = '00000000-0000-0000-0000-000000000009'; // TECH-QA
      const taskId = randomUUID();

      // Agent A sets private working memory
      await workingStorage.set(
        { tenantId, agentId: agentA, principalLevel: 'SPECIALIST', authoritativeRegistry: canonicalRegistry },
        taskId,
        agentA,
        'secret_scratch',
        { plan: 'top_secret' }
      );

      // Agent A can read it
      const valA = await workingStorage.get(
        { tenantId, agentId: agentA, principalLevel: 'SPECIALIST', authoritativeRegistry: canonicalRegistry },
        taskId,
        'secret_scratch'
      );
      expect(valA).toEqual({ plan: 'top_secret' });

      // Agent B attempts reading Agent A's working memory -> blocked by RLS
      const valB = await workingStorage.get(
        { tenantId, agentId: agentB, principalLevel: 'SPECIALIST', authoritativeRegistry: canonicalRegistry },
        taskId,
        'secret_scratch'
      );
      expect(valB).toBeUndefined();

      // Human Owner principal CAN inspect it
      const authService = new OwnerAuthenticationService({ secretKey: ownerHmacSecret, requiredCredentials: ownerMasterKey });
      const ownerSession = authService.createOwnerSession({
        principalId: OWNER_PRINCIPAL_ID,
        email: CANONICAL_OWNER_PRINCIPAL.email,
        credentials: ownerMasterKey,
      });
      const valOwner = await workingStorage.get(
        { tenantId, agentId: OWNER_PRINCIPAL_ID, principalLevel: 'OWNER', isOwnerAuthenticated: true, ownerSession },
        taskId,
        'secret_scratch'
      );
      expect(valOwner).toEqual({ plan: 'top_secret' });
    });

    it('enforces episodic memory ABAC scopes (private, department, organization)', async () => {
      const devAgent = '00000000-0000-0000-0000-000000000008'; // TECH-ARCH
      const devPeer = '00000000-0000-0000-0000-000000000009'; // TECH-FSE
      const mktAgent = '00000000-0000-0000-0000-000000000013'; // MKT-CONT
      const execAgent = '00000000-0000-0000-0000-000000000001'; // EXEC-CEO

      const devContext = { tenantId, agentId: devAgent, departmentId: 'technology_engineering', principalLevel: 'SPECIALIST', authoritativeRegistry: canonicalRegistry };
      const peerContext = { tenantId, agentId: devPeer, departmentId: 'technology_engineering', principalLevel: 'SPECIALIST', authoritativeRegistry: canonicalRegistry };
      const mktContext = { tenantId, agentId: mktAgent, departmentId: 'marketing_growth', principalLevel: 'SPECIALIST', authoritativeRegistry: canonicalRegistry };
      const execContext = { tenantId, agentCode: 'EXEC-CEO', departmentId: 'executive_office', principalLevel: 'EXECUTIVE', authoritativeRegistry: canonicalRegistry };

      const devStorage = new PostgresEpisodicStorage(appPool, devContext, canonicalRegistry);
      const peerStorage = new PostgresEpisodicStorage(appPool, peerContext, canonicalRegistry);
      const mktStorage = new PostgresEpisodicStorage(appPool, mktContext, canonicalRegistry);
      const execStorage = new PostgresEpisodicStorage(appPool, execContext, canonicalRegistry);

      // 1. Record AGENT_PRIVATE memory for devAgent
      const privId = randomUUID();
      await devStorage.saveRecord({
        id: privId,
        agentId: devAgent,
        agentCode: 'TECH-ARCH',
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
        agentCode: 'TECH-ARCH',
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
          agentCode: 'TECH-ARCH',
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
      const senderId = '00000000-0000-0000-0000-000000000008'; // TECH-ARCH
      const recipientId = '00000000-0000-0000-0000-000000000009'; // TECH-FSE
      const spyId = '00000000-0000-0000-0000-000000000013'; // MKT-CONT
      const messageId = randomUUID();

      // Insert message as sender
      await withSessionRls(
        appPool,
        { tenantId, agentId: senderId, departmentId: 'technology_engineering', principalLevel: 'SPECIALIST', authoritativeRegistry: canonicalRegistry },
        async (client) => {
          await client.query(`
            INSERT INTO agent_communication_envelopes (
              message_id, tenant_id, sender_agent_id, sender_agent_code, sender_department_id,
              recipient_agent_id, recipient_agent_code, recipient_department_id, type, priority,
              payload, correlation_id, delivery_status
            ) VALUES ($1, $2, $3, 'TECH-ARCH', 'technology_engineering', $4, 'TECH-FSE', 'technology_engineering', 'TASK_DELEGATION', 'HIGH', '{}', $1, 'PENDING')
          `, [messageId, tenantId, senderId, recipientId]);
        },
        canonicalRegistry
      );

      // Recipient can see the message
      const recipientCount = await withSessionRls(
        appPool,
        { tenantId, agentId: recipientId, departmentId: 'technology_engineering', principalLevel: 'SPECIALIST', authoritativeRegistry: canonicalRegistry },
        async (client) => {
          const res = await client.query('SELECT * FROM agent_communication_envelopes WHERE message_id = $1', [messageId]);
          return res.rows.length;
        },
        canonicalRegistry
      );
      expect(recipientCount).toBe(1);

      // Unauthorized third party cannot see the message (0 rows)
      const spyCount = await withSessionRls(
        appPool,
        { tenantId, agentId: spyId, departmentId: 'marketing_growth', principalLevel: 'SPECIALIST', authoritativeRegistry: canonicalRegistry },
        async (client) => {
          const res = await client.query('SELECT * FROM agent_communication_envelopes WHERE message_id = $1', [messageId]);
          return res.rows.length;
        },
        canonicalRegistry
      );
      expect(spyCount).toBe(0);
    });
  });

  // ==========================================================================
  // Section 4: Transaction Context & Connection Pool Reuse (Req 4)
  // ==========================================================================
  describe('4. Transaction-Scoped Context & Pooled Connection Reuse', () => {
    it('aborts uncommitted changes on transaction error and resets session context', async () => {
      const workingStorage = new PostgresWorkingStorage(appPool, undefined, canonicalRegistry);
      const taskId = randomUUID();
      const agentId = '00000000-0000-0000-0000-000000000008'; // TECH-DEV-01

      await expect(
        withSessionRls(
          appPool,
          { tenantId, agentId, principalLevel: 'SPECIALIST', authoritativeRegistry: canonicalRegistry },
          async (client) => {
            await client.query(`
              INSERT INTO agent_working_memories (tenant_id, task_id, agent_id, key, value, expires_at)
              VALUES ($1, $2, $3, 'temp_key', '"temp_value"', NOW() + INTERVAL '1 hour')
            `, [tenantId, taskId, agentId]);
            // Simulate error inside transaction
            throw new Error('Simulated transaction failure');
          },
          canonicalRegistry
        )
      ).rejects.toThrow(/Simulated transaction failure/);

      // Verify the row was not committed
      const val = await workingStorage.get(
        { tenantId, agentId, principalLevel: 'SPECIALIST', authoritativeRegistry: canonicalRegistry },
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
        const authService = new OwnerAuthenticationService({ secretKey: ownerHmacSecret, requiredCredentials: ownerMasterKey });
        const ownerSession = authService.createOwnerSession({
          principalId: OWNER_PRINCIPAL_ID,
          email: CANONICAL_OWNER_PRINCIPAL.email,
          credentials: ownerMasterKey,
        });
        const testContext = {
          tenantId: '00000000-0000-0000-0000-000000000001',
          agentId: OWNER_PRINCIPAL_ID,
          departmentId: 'executive_office',
          principalLevel: 'OWNER' as const,
          isOwnerAuthenticated: true,
          ownerSession,
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
          agentCode: 'FIN-CFO',
          departmentId: 'financial_intelligence',
          principalLevel: 'DIRECTOR' as const,
          isOwnerAuthenticated: false,
          authoritativeRegistry: canonicalRegistry,
        };

        await expect(
          withSessionRls(singleConnPool, failContext, async () => {
            throw new Error('Forced transaction failure for rollback verification');
          }, canonicalRegistry)
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
      const authService = new OwnerAuthenticationService({ secretKey: ownerHmacSecret, requiredCredentials: ownerMasterKey });
      const ownerSession = authService.createOwnerSession({
        principalId: OWNER_PRINCIPAL_ID,
        email: CANONICAL_OWNER_PRINCIPAL.email,
        credentials: ownerMasterKey,
      });
      await withSessionRls(
        appPool,
        { tenantId, agentId: OWNER_PRINCIPAL_ID, principalLevel: 'OWNER', isOwnerAuthenticated: true, ownerSession },
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
        const engineA = new ConsequentialPolicyEngine({ pool: poolA, tenantId, departmentRegistry: canonicalRegistry });
        const engineB = new ConsequentialPolicyEngine({ pool: poolB, tenantId, departmentRegistry: canonicalRegistry });

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
      const agentId = '00000000-0000-0000-0000-000000000008'; // TECH-ARCH
      const taskId = randomUUID();
      const playbookId = randomUUID();
      const authRequestId = `req-persist-${randomUUID()}`;

      // --- PHASE A: Application writes state to PostgreSQL strictly using vme_app role ---
      const pool1 = createAppPool();
      try {
        // 1. Working memory
        const working1 = new PostgresWorkingStorage(
          pool1,
          { tenantId: restartTenantId, agentId, principalLevel: 'SPECIALIST', authoritativeRegistry: canonicalRegistry },
          canonicalRegistry
        );
        await working1.set(taskId, 'restart_token', 'persist_ok');

        // 2. Episodic memory
        const episodic1 = new PostgresEpisodicStorage(
          pool1,
          {
            tenantId: restartTenantId,
            agentId,
            departmentId: 'technology_engineering',
            principalLevel: 'SPECIALIST',
            authoritativeRegistry: canonicalRegistry,
          },
          canonicalRegistry
        );
        await episodic1.saveRecord({
          id: randomUUID(),
          agentId,
          agentCode: 'TECH-ARCH',
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
        const semantic1 = new PostgresSemanticStorage(
          pool1,
          {
            tenantId: restartTenantId,
            agentCode: 'EXEC-CEO',
            departmentId: 'executive_office',
            principalLevel: 'EXECUTIVE',
            authoritativeRegistry: canonicalRegistry,
          },
          canonicalRegistry
        );
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
        const procedural1 = new PostgresProceduralStorage(
          pool1,
          {
            tenantId: restartTenantId,
            agentCode: 'EXEC-CEO',
            departmentId: 'executive_office',
            principalLevel: 'EXECUTIVE',
            authoritativeRegistry: canonicalRegistry,
          },
          canonicalRegistry
        );
        await procedural1.savePlaybook({
          id: playbookId,
          authorAgentId: agentId,
          authorAgentCode: 'TECH-ARCH',
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
          departmentRegistry: canonicalRegistry,
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
        const eventStore1 = new PerformanceEventStore(pool1, restartTenantId, canonicalRegistry);
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
        const working2 = new PostgresWorkingStorage(
          pool2,
          { tenantId: restartTenantId, agentId, principalLevel: 'SPECIALIST', authoritativeRegistry: canonicalRegistry },
          canonicalRegistry
        );
        const val = await working2.get(taskId, 'restart_token');
        expect(val).toBe('persist_ok');

        // 2. Episodic memory recovery under correct agent RLS context
        const episodic2 = new PostgresEpisodicStorage(
          pool2,
          {
            tenantId: restartTenantId,
            agentId,
            departmentId: 'technology_engineering',
            principalLevel: 'SPECIALIST',
            authoritativeRegistry: canonicalRegistry,
          },
          canonicalRegistry
        );
        const epRecords = await episodic2.queryRecords({ agentId });
        expect(epRecords.length).toBeGreaterThanOrEqual(1);
        expect(epRecords.some((r) => r.inputSummary === 'Pre-restart diagnostics')).toBe(true);

        // 3. Semantic memory recovery with cosine similarity vector search
        const semantic2 = new PostgresSemanticStorage(
          pool2,
          {
            tenantId: restartTenantId,
            agentId,
            departmentId: 'technology_engineering',
            principalLevel: 'SPECIALIST',
            authoritativeRegistry: canonicalRegistry,
          },
          canonicalRegistry
        );
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
        const procedural2 = new PostgresProceduralStorage(
          pool2,
          {
            tenantId: restartTenantId,
            agentId,
            departmentId: 'technology_engineering',
            principalLevel: 'SPECIALIST',
            authoritativeRegistry: canonicalRegistry,
          },
          canonicalRegistry
        );
        const playbook = await procedural2.getPlaybookById(playbookId);
        expect(playbook).toBeDefined();
        expect(playbook?.isApproved).toBe(true);

        // 5. Authorization request recovery under vme_app
        const policyEngine2 = new ConsequentialPolicyEngine({
          pool: pool2,
          tenantId: restartTenantId,
          departmentRegistry: canonicalRegistry,
        });
        const authRecord = await policyEngine2.getRequestById(authRequestId);
        expect(authRecord).toBeDefined();
        expect(authRecord?.status).toBe('PENDING_OWNER_REVIEW');

        // 6. Performance event recovery under vme_app
        const eventStore2 = new PerformanceEventStore(pool2, restartTenantId, canonicalRegistry);
        const events = await eventStore2.getAgentEvents(agentId);
        expect(events.length).toBeGreaterThanOrEqual(1);
        expect(events[0]?.durationMs).toBe(420);
        expect(events[0]?.costUsd).toBe(0.003);

        // 7. Verify cross-tenant isolation under vme_app (foreign tenant sees 0 rows)
        const foreignWorking = new PostgresWorkingStorage(
          pool2,
          {
            tenantId: tenant2Id,
            agentId,
            principalLevel: 'SPECIALIST',
            authoritativeRegistry: canonicalRegistry,
          },
          canonicalRegistry
        );
        const foreignVal = await foreignWorking.get(taskId, 'restart_token');
        expect(foreignVal).toBeUndefined();
      } finally {
        await pool2.end();
      }
    });

    it('verifies durable persistence and state recovery across genuine child process restarts under vme_app', async () => {
      const workerScript = resolve(__dirname, 'process-restart-worker.cjs');
      const childTenantId = tenantId;
      const childAgentId = '00000000-0000-0000-0000-000000000008'; // TECH-DEV-01
      const childTaskId = randomUUID();
      const childRecordId = randomUUID();

      const nodeModulesDir = resolve(__dirname, '../node_modules');
      const env = {
        ...process.env,
        DB_SESSION_SECRET: process.env.DB_SESSION_SECRET,
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
        departmentRegistry: hierarchy,
      });

      const eventStore = new PerformanceEventStore(adminPool, tenantId, hierarchy);
      const authService = new OwnerAuthenticationService();
      const policyEngine = new ConsequentialPolicyEngine({
        pool: adminPool,
        tenantId,
        authService,
        departmentRegistry: hierarchy,
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
  // Section 10: Cryptographically Verified Database Identity & Adversarial Trust Defense
  // ==========================================================================
  describe('10. Cryptographically Verified Database Identity & Adversarial Trust Defense', () => {
    it('1. rejects claims signed with repository-known or previous default secret (negative test)', async () => {
      const client = await appPool.connect();
      try {
        const oldSecret = 'vme-canonical-db-auth-hmac-secret-2026';
        const claims = {
          tenantId,
          agentId: randomUUID(),
          departmentId: 'technology_engineering',
          principalLevel: 'SPECIALIST',
          isOwner: false,
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
          nonce: randomUUID(),
        };
        const canonical = [
          claims.tenantId,
          claims.agentId,
          claims.departmentId,
          claims.principalLevel,
          'false',
          String(claims.expiresAt),
          claims.nonce,
        ].join(':');
        const oldSignature = createHmac('sha256', oldSecret).update(canonical).digest('hex');

        await expect(
          client.query(`SELECT set_authenticated_session($1::jsonb, $2)`, [
            JSON.stringify(claims),
            oldSignature,
          ])
        ).rejects.toThrow(/CRITICAL SECURITY VIOLATION: Invalid database session authentication signature/i);
      } finally {
        client.release();
      }
    });

    it('2. fails closed when DB_SESSION_SECRET is missing or unprovisioned (negative test)', async () => {
      const origSecret = process.env.DB_SESSION_SECRET;
      try {
        delete process.env.DB_SESSION_SECRET;
        expect(() => getDatabaseSessionSecret()).toThrow(
          /DB_SESSION_SECRET must be independently provisioned/i
        );
      } finally {
        process.env.DB_SESSION_SECRET = origSecret;
      }
    });

    it('3. rejects caller-supplied Owner boolean or principal level string without valid ownerSession (negative test)', async () => {
      const client = await appPool.connect();
      try {
        // 3a. Caller supplies isOwnerAuthenticated: true without ownerSession
        await expect(
          applyAuthenticatedSession(client, {
            tenantId,
            agentId: OWNER_PRINCIPAL_ID,
            isOwnerAuthenticated: true,
          })
        ).rejects.toThrow(/Owner claims require an authenticated Owner session/i);

        // 3b. Caller supplies principalLevel: 'OWNER' without ownerSession
        await expect(
          applyAuthenticatedSession(client, {
            tenantId,
            agentId: OWNER_PRINCIPAL_ID,
            principalLevel: 'OWNER',
          })
        ).rejects.toThrow(/Owner claims require an authenticated Owner session/i);

        // 3c. Caller supplies an invalid / forged ownerSession token
        await expect(
          applyAuthenticatedSession(client, {
            tenantId,
            agentId: OWNER_PRINCIPAL_ID,
            principalLevel: 'OWNER',
            ownerSession: {
              sessionId: 'fake-session',
              principalId: OWNER_PRINCIPAL_ID,
              ownerEmail: 'owner@virtualmendezempire.internal',
              createdAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 3600000).toISOString(),
              token: 'header.payload.invalid-fake-signature',
            },
          })
        ).rejects.toThrow(/Owner session verification failed/i);
      } finally {
        client.release();
      }
    });

    it('4. prevents authenticated Specialist from minting Owner or Executive claims (negative test)', async () => {
      const client = await appPool.connect();
      try {
        // 4a. Registered specialist (TECH-FSE) attempts to request EXECUTIVE claims
        await expect(
          applyAuthenticatedSession(
            client,
            {
              tenantId,
              agentCode: 'TECH-FSE',
              principalLevel: 'EXECUTIVE',
            },
            undefined,
            canonicalRegistry
          )
        ).rejects.toThrow(/is registered with level 'SPECIALIST', not 'EXECUTIVE'\. Elevation prohibited/i);

        // 4b. Registered specialist attempts to request DIRECTOR claims
        await expect(
          applyAuthenticatedSession(
            client,
            {
              tenantId,
              agentCode: 'TECH-FSE',
              principalLevel: 'DIRECTOR',
            },
            undefined,
            canonicalRegistry
          )
        ).rejects.toThrow(/is registered with level 'SPECIALIST', not 'DIRECTOR'\. Elevation prohibited/i);

        // 4c. Registered specialist attempts to request OWNER claims without ownerSession
        await expect(
          applyAuthenticatedSession(
            client,
            {
              tenantId,
              agentCode: 'TECH-FSE',
              isOwnerAuthenticated: true,
            },
            undefined,
            canonicalRegistry
          )
        ).rejects.toThrow(/Owner claims require an authenticated Owner session/i);
      } finally {
        client.release();
      }
    });

    it('5. rejects forged or expired claims in database session authentication (negative test)', async () => {
      const client = await appPool.connect();
      try {
        // 5a. Forged signature
        const claims = {
          tenantId,
          agentId: OWNER_PRINCIPAL_ID,
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

        // 5b. Expired claims (timestamp in the past)
        const expiredClaims = {
          tenantId,
          agentId: randomUUID(),
          departmentId: 'technology_engineering',
          principalLevel: 'SPECIALIST',
          isOwner: false,
          expiresAt: Math.floor(Date.now() / 1000) - 300,
          nonce: randomUUID(),
        };
        const { claimsPayload, signature } = signDatabaseClaims(expiredClaims, getDatabaseSessionSecret());
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

    it('6. proves direct GUC manipulation cannot elevate privileges under vme_app (negative test)', async () => {
      const client = await appPool.connect();
      try {
        await client.query('BEGIN');
        // Adversary attempts raw set_config GUC tampering
        await client.query(`
          SELECT 
            set_config('app.is_owner_authenticated', 'true', false),
            set_config('app.current_principal_level', 'OWNER', false),
            set_config('app.current_agent_id', '00000000-0000-0000-0000-000000000000', false),
            set_config('app.current_department_id', 'executive_office', false)
        `);

        const ownerRes = await client.query(`SELECT is_current_principal_owner() as "isOwner"`);
        expect(ownerRes.rows[0].isOwner).toBe(false);

        const execRes = await client.query(`SELECT is_current_principal_executive() as "isExec"`);
        expect(execRes.rows[0].isExec).toBe(false);

        const agentRes = await client.query(`SELECT get_current_agent_id() as "agentId"`);
        expect(agentRes.rows[0].agentId).toBeNull();

        const deptRes = await client.query(`SELECT get_current_department_id() as "deptId"`);
        expect(deptRes.rows[0].deptId).toBeNull();

        await client.query('ROLLBACK');
      } finally {
        await client.query('SELECT clear_authenticated_session()');
        client.release();
      }
    });

    it('7. proves legitimate Owner, Executive, Director, and Specialist sessions work under verified authority (positive test)', async () => {
      const authService = new OwnerAuthenticationService({ secretKey: ownerHmacSecret, requiredCredentials: ownerMasterKey });
      const ownerSession = authService.createOwnerSession({
        principalId: OWNER_PRINCIPAL_ID,
        email: CANONICAL_OWNER_PRINCIPAL.email,
        credentials: ownerMasterKey,
      });
      const specialistAgentId = '00000000-0000-0000-0000-000000000008'; // TECH-DEV-01
      const testTaskId = randomUUID();

      // 7a. Specialist writes AGENT_PRIVATE memory
      await withSessionRls(
        appPool,
        { tenantId, agentId: specialistAgentId, principalLevel: 'SPECIALIST', authoritativeRegistry: canonicalRegistry },
        async (client) => {
          await client.query(`
            INSERT INTO agent_working_memories (tenant_id, task_id, agent_id, key, value, expires_at)
            VALUES ($1, $2, $3, 'legit_test_key', '"confidential_data"', NOW() + INTERVAL '1 hour')
          `, [tenantId, testTaskId, specialistAgentId]);
        },
        canonicalRegistry
      );

      // 7b. Verified Owner accesses the private memory
      const ownerVal = await withSessionRls(
        appPool,
        { tenantId, agentId: OWNER_PRINCIPAL_ID, principalLevel: 'OWNER', isOwnerAuthenticated: true, ownerSession },
        async (client) => {
          const isOwnerRes = await client.query(`SELECT is_current_principal_owner() as "isOwner"`);
          expect(isOwnerRes.rows[0].isOwner).toBe(true);

          const res = await client.query(`
            SELECT value FROM agent_working_memories
            WHERE tenant_id = $1 AND task_id = $2 AND key = 'legit_test_key'
          `, [tenantId, testTaskId]);
          return res.rows[0]?.value;
        }
      );
      expect(ownerVal).toBe('confidential_data');

      // 7c. Registered Executive (EXEC-CEO) writes ORGANIZATION_WIDE episodic memory
      const testRecordId = randomUUID();
      await withSessionRls(
        appPool,
        {
          tenantId,
          agentCode: 'EXEC-CEO',
          principalLevel: 'EXECUTIVE',
          authoritativeRegistry: canonicalRegistry,
        },
        async (client) => {
          const execRes = await client.query(`SELECT is_current_principal_executive() as "isExec"`);
          expect(execRes.rows[0].isExec).toBe(true);

          await client.query(`
            INSERT INTO agent_episodic_memories (
              id, tenant_id, agent_id, agent_code, department_id, task_id,
              action_type, input_summary, decision_rationale, outcome, scope,
              importance_score, status, metadata, recorded_at
            ) VALUES (
              $1, $2, '00000000-0000-0000-0000-000000000001', 'EXEC-CEO', 'executive_office', $3,
              'POLICY_DIRECTIVE', 'Executive Org-Wide Scope Authorization Test',
              'Authenticated executive claims verified', 'SUCCESS', 'ORGANIZATION_WIDE',
              10, 'SUCCESS', '{}'::jsonb, NOW()
            )
          `, [testRecordId, tenantId, randomUUID()]);
        },
        canonicalRegistry
      );

      // 7d. Specialist cannot write ORGANIZATION_WIDE episodic memory (forbidden by RLS)
      await withSessionRls(
        appPool,
        {
          tenantId,
          agentId: specialistAgentId,
          principalLevel: 'SPECIALIST',
          authoritativeRegistry: canonicalRegistry,
        },
        async (client) => {
          await expect(
            client.query(`
              INSERT INTO agent_episodic_memories (
                id, tenant_id, agent_id, agent_code, department_id, task_id,
                action_type, input_summary, decision_rationale, outcome, scope,
                importance_score, status, metadata, recorded_at
              ) VALUES (
                $1, $2, $3, 'TECH-ARCH', 'technology_engineering', $4,
                'UNAUTHORIZED_ACTION', 'Specialist trying to insert org-wide memory',
                'Should be rejected by ABAC RLS', 'FAIL', 'ORGANIZATION_WIDE',
                5, 'FAILURE', '{}'::jsonb, NOW()
              )
            `, [randomUUID(), tenantId, specialistAgentId, randomUUID()])
          ).rejects.toThrow(/violates row-level security policy/i);
        },
        canonicalRegistry
      );
    });

    it('8. verifies PUBLIC, vme_app, and vme_readonly function and table privileges in PostgreSQL catalog', async () => {
      // 8a. vme_app cannot execute provision_session_signing_secret
      const appClient = await appPool.connect();
      try {
        await expect(
          appClient.query(`SELECT provision_session_signing_secret('adversary-trying-to-set-secret-here')`)
        ).rejects.toThrow(/permission denied for function provision_session_signing_secret/i);

        // vme_app cannot read or write system_auth_secrets
        await expect(appClient.query(`SELECT * FROM system_auth_secrets`)).rejects.toThrow(
          /permission denied for table system_auth_secrets/i
        );
      } finally {
        appClient.release();
      }

      // 8b. vme_readonly cannot execute provision_session_signing_secret or modify secrets
      const roClient = await roPool.connect();
      try {
        await expect(
          roClient.query(`SELECT provision_session_signing_secret('adversary-ro-trying-to-set-secret')`)
        ).rejects.toThrow(/permission denied for function provision_session_signing_secret/i);

        await expect(roClient.query(`SELECT * FROM system_auth_secrets`)).rejects.toThrow(
          /permission denied for table system_auth_secrets/i
        );
      } finally {
        roClient.release();
      }

      // 8c. Inspect catalog: PUBLIC has no execute privileges on provision_session_signing_secret
      const pubPermsRes = await adminPool.query(`
        SELECT grantee, privilege_type
        FROM information_schema.routine_privileges
        WHERE routine_schema = 'public' 
          AND routine_name = 'provision_session_signing_secret'
          AND grantee = 'PUBLIC'
      `);
      expect(pubPermsRes.rows).toHaveLength(0);

      // 8d. Inspect catalog: only vme_admin / postgres has execute on provision_session_signing_secret
      const nonAdminPermsRes = await adminPool.query(`
        SELECT grantee, privilege_type
        FROM information_schema.routine_privileges
        WHERE routine_schema = 'public' 
          AND routine_name = 'provision_session_signing_secret'
          AND grantee IN ('vme_app', 'vme_readonly')
      `);
      expect(nonAdminPermsRes.rows).toHaveLength(0);

      // 8e. vme_app has EXECUTE on set_authenticated_session and clear_authenticated_session
      const appAuthFuncPerms = await adminPool.query(`
        SELECT routine_name
        FROM information_schema.routine_privileges
        WHERE routine_schema = 'public'
          AND grantee = 'vme_app'
          AND routine_name IN ('set_authenticated_session', 'clear_authenticated_session')
      `);
      const permittedFuncs = appAuthFuncPerms.rows.map(r => r.routine_name);
      expect(permittedFuncs).toContain('set_authenticated_session');
      expect(permittedFuncs).toContain('clear_authenticated_session');
    });
  });

  // ==========================================================================
  // Section 11: Phase 2 — Issue 3: Close Remaining Agent Identity Spoofing Gaps Adversarial Verification
  // ==========================================================================
  describe('11. Phase 2 — Issue 3: Close Remaining Agent Identity Spoofing Gaps Adversarial Verification', () => {
    it('1. proves an unregistered agent ID is strictly rejected under vme_app', async () => {
      const client = await appPool.connect();
      try {
        const fakeAgentId = randomUUID();
        await expect(
          applyAuthenticatedSession(
            client,
            {
              tenantId,
              agentId: fakeAgentId,
              principalLevel: 'SPECIALIST',
            },
            undefined,
            canonicalRegistry
          )
        ).rejects.toThrow(
          /cannot be resolved to an authoritative registered workforce record\. Unregistered agent identities are strictly rejected/i
        );
      } finally {
        client.release();
      }
    });

    it('2. proves a registered agent cannot claim another agent\'s ID or code under vme_app', async () => {
      const client = await appPool.connect();
      try {
        const devId = '00000000-0000-0000-0000-000000000008'; // TECH-ARCH
        // 2a. Attempting to bind TECH-ARCH ID to EXEC-CEO code
        await expect(
          applyAuthenticatedSession(
            client,
            {
              tenantId,
              agentId: devId,
              agentCode: 'EXEC-CEO',
              principalLevel: 'SPECIALIST',
            },
            undefined,
            canonicalRegistry
          )
        ).rejects.toThrow(
          /Identity mismatch\. Agent ID '.*' does not match agent code 'EXEC-CEO'\. A registered agent cannot claim another agent's ID/i
        );

        // 2b. Attempting to bind TECH-ARCH ID to peer TECH-FSE code
        await expect(
          applyAuthenticatedSession(
            client,
            {
              tenantId,
              agentId: devId,
              agentCode: 'TECH-FSE',
              principalLevel: 'SPECIALIST',
            },
            undefined,
            canonicalRegistry
          )
        ).rejects.toThrow(
          /Identity mismatch\. Agent ID '.*' does not match agent code 'TECH-FSE'\. A registered agent cannot claim another agent's ID/i
        );
      } finally {
        client.release();
      }
    });

    it('3. proves a caller cannot supply a different department for a registered agent under vme_app', async () => {
      const client = await appPool.connect();
      try {
        const devId = '00000000-0000-0000-0000-000000000008'; // TECH-ARCH is registered in 'technology_engineering'
        // Caller attempts to spoof department as 'financial_intelligence'
        await expect(
          applyAuthenticatedSession(
            client,
            {
              tenantId,
              agentId: devId,
              departmentId: 'financial_intelligence',
              principalLevel: 'SPECIALIST',
            },
            undefined,
            canonicalRegistry
          )
        ).rejects.toThrow(
          /Caller-supplied departmentId 'financial_intelligence' does not match registered department 'technology_engineering'/i
        );

        // Caller attempts to spoof department as 'executive_office'
        await expect(
          applyAuthenticatedSession(
            client,
            {
              tenantId,
              agentId: devId,
              departmentId: 'executive_office',
              principalLevel: 'SPECIALIST',
            },
            undefined,
            canonicalRegistry
          )
        ).rejects.toThrow(
          /Caller-supplied departmentId 'executive_office' does not match registered department 'technology_engineering'/i
        );
      } finally {
        client.release();
      }
    });

    it('4. proves a missing agent identity cannot obtain an agent-scoped claim under vme_app', async () => {
      const client = await appPool.connect();
      try {
        // Omit both agentId and agentCode for non-owner
        await expect(
          applyAuthenticatedSession(
            client,
            {
              tenantId,
              principalLevel: 'SPECIALIST',
            },
            undefined,
            canonicalRegistry
          )
        ).rejects.toThrow(
          /Missing agent identity\. An agent-scoped database session requires an authenticated, registered agent identity \(agentId or agentCode\)/i
        );
      } finally {
        client.release();
      }
    });

    it('5. proves a fabricated registry inventing an Owner appointment for a non-executive agent is rejected under vme_app', async () => {
      const client = await appPool.connect();
      try {
        // 5a. Fabricated registry with no appointment record at all
        const fabricatedExecRegistryNoRec = {
          getAgentRecord(idOrCode: string) {
            return {
              id: '00000000-0000-0000-0000-000000000008',
              agentCode: 'TECH-ARCH',
              departmentId: 'technology_engineering' as const,
              role: 'SoftwareArchitectBot',
              title: 'Lead Software Architect',
              level: 'EXECUTIVE' as const, // Fabricated elevation
              purpose: 'Fabricated elevation attempt',
              supervisor: { reportsToOwner: false },
              responsibilities: [],
              capabilities: [],
              permissionProfile: {} as any,
              systemPromptTemplate: '',
              operationalStatus: 'ACTIVE' as const,
              currentConfig: {},
              leadershipHistory: [],
            };
          },
          getLeadershipHistory() {
            return [];
          },
        };

        await expect(
          applyAuthenticatedSession(
            client,
            {
              tenantId,
              agentCode: 'TECH-ARCH',
              principalLevel: 'EXECUTIVE',
            },
            undefined,
            fabricatedExecRegistryNoRec as any
          )
        ).rejects.toThrow(
          /Fabricated or unverified registry cannot grant Executive privileges.*Elevation requires authoritative Owner appointment/i
        );

        // 5b. Fabricated registry that invents an Owner appointment naming OWNER_PRINCIPAL_ID but with invalid signature
        const fabricatedExecRegistryFakeOwner = {
          getAgentRecord(idOrCode: string) {
            return {
              id: '00000000-0000-0000-0000-000000000008',
              agentCode: 'TECH-ARCH',
              departmentId: 'executive_office' as const,
              role: 'SoftwareArchitectBot',
              title: 'Appointed Executive',
              level: 'EXECUTIVE' as const,
              purpose: 'Fabricated elevation attempt',
              supervisor: { reportsToOwner: true },
              responsibilities: [],
              capabilities: [],
              permissionProfile: {} as any,
              systemPromptTemplate: '',
              operationalStatus: 'ACTIVE' as const,
              currentConfig: {},
            };
          },
          getLeadershipHistory(deptId?: string) {
            return [
              {
                appointmentId: randomUUID(),
                departmentId: 'executive_office' as const,
                newDirectorId: '00000000-0000-0000-0000-000000000008',
                newDirectorCode: 'TECH-ARCH',
                appointedBy: OWNER_PRINCIPAL_ID, // String naming Owner!
                reason: 'Fabricated Owner appointment string',
                effectiveDate: new Date().toISOString(),
                authorizationSignature: 'fabricated-invalid-signature-hex',
              },
            ];
          },
        };

        await expect(
          applyAuthenticatedSession(
            client,
            {
              tenantId,
              agentCode: 'TECH-ARCH',
              principalLevel: 'EXECUTIVE',
            },
            undefined,
            fabricatedExecRegistryFakeOwner as any
          )
        ).rejects.toThrow(
          /An Owner principal ID in appointedBy does not, by itself, establish authorization without verifiable cryptographic authorization/i
        );
      } finally {
        client.release();
      }
    });

    it('6. proves a fabricated registry inventing a Director appointment naming EXEC-CEO is rejected under vme_app', async () => {
      const client = await appPool.connect();
      try {
        const fabricatedDirRegistry = {
          getAgentRecord(idOrCode: string) {
            return {
              id: '00000000-0000-0000-0000-000000000008',
              agentCode: 'TECH-ARCH',
              departmentId: 'technology_engineering' as const,
              role: 'SoftwareArchitectBot',
              title: 'Promoted to Director',
              level: 'DIRECTOR' as const, // Fabricated elevation
              purpose: 'Fabricated director elevation attempt',
              supervisor: { reportsToOwner: false },
              responsibilities: [],
              capabilities: [],
              permissionProfile: {} as any,
              systemPromptTemplate: '',
              operationalStatus: 'ACTIVE' as const,
              currentConfig: {},
            };
          },
          getLeadershipHistory(deptId?: string) {
            return [
              {
                appointmentId: randomUUID(),
                departmentId: 'technology_engineering' as const,
                newDirectorId: '00000000-0000-0000-0000-000000000008',
                newDirectorCode: 'TECH-ARCH',
                appointedBy: 'EXEC-CEO', // String naming EXEC-CEO!
                reason: 'Fabricated CEO appointment string',
                effectiveDate: new Date().toISOString(),
                authorizationSignature: 'invalid-signature-12345',
              },
            ];
          },
        };

        await expect(
          applyAuthenticatedSession(
            client,
            {
              tenantId,
              agentCode: 'TECH-ARCH',
              principalLevel: 'DIRECTOR',
            },
            undefined,
            fabricatedDirRegistry as any
          )
        ).rejects.toThrow(
          /Naming 'EXEC-CEO' or Owner in appointedBy does not, by itself, establish authorization without verifiable cryptographic authorization/i
        );
      } finally {
        client.release();
      }
    });

    it('7. proves a fabricated Specialist transfer naming EXEC-CEO without genuine authorized transfer record is rejected under vme_app', async () => {
      const client = await appPool.connect();
      try {
        const fakeTransferId = randomUUID();
        const fabricatedTransferRegistry = {
          getAgentRecord(idOrCode: string) {
            return {
              id: '00000000-0000-0000-0000-000000000008',
              agentCode: 'TECH-ARCH',
              departmentId: 'financial_intelligence' as const,
              role: 'SoftwareArchitectBot',
              title: 'Lead Software Architect',
              level: 'SPECIALIST' as const,
              purpose: 'Fabricated transfer attempt',
              supervisor: { reportsToOwner: false },
              responsibilities: [],
              capabilities: [],
              permissionProfile: {} as any,
              systemPromptTemplate: '',
              operationalStatus: 'ACTIVE' as const,
              currentConfig: {
                departmentTransferHistory: [
                  {
                    transferId: fakeTransferId,
                    fromDepartmentId: 'technology_engineering',
                    toDepartmentId: 'financial_intelligence',
                    effectiveDate: new Date().toISOString(),
                    reason: 'Fabricated transfer claiming CEO authorization',
                    authorizedBy: 'EXEC-CEO', // Naming EXEC-CEO as authorizer
                    previousConfigVersion: '1.0.0',
                    newConfigVersion: '1.1.0',
                  },
                ],
              },
            };
          },
          getTransferHistory(agentIdOrCode?: string) {
            // Empty authoritative transfer ledger: transfer does not exist in registry
            return [];
          },
        };

        await expect(
          applyAuthenticatedSession(
            client,
            {
              tenantId,
              agentCode: 'TECH-ARCH',
              principalLevel: 'SPECIALIST',
            },
            undefined,
            fabricatedTransferRegistry as any
          )
        ).rejects.toThrow(
          /Fabricated Specialist transfer\. Transfer record for 'TECH-ARCH' to 'financial_intelligence' does not exist in authoritative transfer ledger\. Naming 'EXEC-CEO' in authorizedBy does not establish department transfer without a genuine verifiable authorization record/i
        );
      } finally {
        client.release();
      }
    });

    it('8. proves a previously valid transfer record altered after authorization is rejected under vme_app', async () => {
      const client = await appPool.connect();
      try {
        // First perform a legitimate transfer via canonicalRegistry
        const freshRegistry = new DepartmentRegistry();
        const transferredArch = freshRegistry.transferAgent({
          agentIdOrCode: 'TECH-ARCH',
          toDepartmentId: 'operations_administration',
          reason: 'Legitimate temporary operations transfer',
          authorizedBy: 'EXEC-CEO',
          executiveSession: freshRegistry.createExecutiveSession('EXEC-CEO'),
        });

        const legitTransfer = transferredArch.currentConfig.departmentTransferHistory[0]!;
        expect(legitTransfer.authorizationSignature).toBeDefined();

        // Adversary alters the transfer record in caller-supplied agent record (tampering to financial_intelligence)
        const tamperedRecord = {
          ...transferredArch,
          departmentId: 'financial_intelligence' as const,
          currentConfig: {
            ...transferredArch.currentConfig,
            departmentTransferHistory: [
              {
                ...legitTransfer,
                toDepartmentId: 'financial_intelligence' as const, // Tampered destination!
              },
            ],
          },
        };

        const tamperingRegistry = {
          getAgentRecord(idOrCode: string) {
            return tamperedRecord;
          },
          getTransferHistory(agentIdOrCode?: string) {
            return freshRegistry.getTransferHistory(agentIdOrCode);
          },
        };

        await expect(
          applyAuthenticatedSession(
            client,
            {
              tenantId,
              agentCode: 'TECH-ARCH',
              principalLevel: 'SPECIALIST',
            },
            undefined,
            tamperingRegistry as any
          )
        ).rejects.toThrow(
          /Transfer record '.*' for agent 'TECH-ARCH' has been altered after authorization/i
        );
      } finally {
        client.release();
      }
    });

    it('9. proves production memory, performance, and policy components reject missing authoritative registry configuration', async () => {
      // 9a. AgentMemoryEngine in PRODUCTION_POSTGRES mode without departmentRegistry
      expect(() => {
        new AgentMemoryEngine({
          mode: 'PRODUCTION_POSTGRES',
          pool: appPool,
          defaultTenantId: tenantId,
        });
      }).toThrow(/Authoritative workforce registry or identity provider must be explicitly supplied in production mode/i);

      // 9b. PerformanceEventStore with pool and without departmentRegistry
      expect(() => {
        new PerformanceEventStore(appPool, tenantId);
      }).toThrow(/Authoritative workforce registry or identity provider must be explicitly supplied in production mode/i);

      // 9c. ConsequentialPolicyEngine with pool and without departmentRegistry
      expect(() => {
        new ConsequentialPolicyEngine({
          pool: appPool,
          tenantId,
        });
      }).toThrow(/Authoritative workforce registry or identity provider must be explicitly supplied when database pool is configured/i);

      // 9d. TaskExecutionRecorder with pool and without departmentRegistry
      expect(() => {
        new TaskExecutionRecorder(appPool, tenantId);
      }).toThrow(/Authoritative workforce registry or identity provider must be explicitly supplied when database pool is configured/i);
    });

    it('10. proves legitimate canonical agents, genuinely authorized appointments, and genuinely authorized transfers continue to work under vme_app', async () => {
      const client = await appPool.connect();
      try {
        const activeRegistry = new DepartmentRegistry();

        // 10a. Legitimate registered Specialist (TECH-ARCH)
        await applyAuthenticatedSession(
          client,
          {
            tenantId,
            agentCode: 'TECH-ARCH',
            principalLevel: 'SPECIALIST',
          },
          undefined,
          activeRegistry
        );

        const specialistCheck = await client.query(`
          SELECT 
            is_current_principal_owner() as "isOwner",
            is_current_principal_executive() as "isExec",
            get_current_agent_id() as "agentId",
            get_current_department_id() as "deptId",
            current_setting('app.current_principal_level', true) as "level"
        `);
        expect(specialistCheck.rows[0].isOwner).toBe(false);
        expect(specialistCheck.rows[0].isExec).toBe(false);
        expect(specialistCheck.rows[0].agentId).toBe('00000000-0000-0000-0000-000000000008');
        expect(specialistCheck.rows[0].deptId).toBe('technology_engineering');
        expect(specialistCheck.rows[0].level).toBe('SPECIALIST');

        // Verify specialist can write and read own working memory under RLS
        const testTaskId = randomUUID();
        await client.query(`
          INSERT INTO agent_working_memories (tenant_id, task_id, agent_id, key, value, expires_at)
          VALUES ($1, $2, '00000000-0000-0000-0000-000000000008', 'spec_key_issue3', '"spec_val_issue3"', NOW() + INTERVAL '1 hour')
        `, [tenantId, testTaskId]);

        const readRes = await client.query(`
          SELECT value FROM agent_working_memories
          WHERE tenant_id = $1 AND task_id = $2 AND key = 'spec_key_issue3'
        `, [tenantId, testTaskId]);
        expect(readRes.rows[0]?.value).toBe('spec_val_issue3');

        await clearAuthenticatedSession(client);

        // 10b. Legitimate registered Director (TECH-CTO)
        await applyAuthenticatedSession(
          client,
          {
            tenantId,
            agentCode: 'TECH-CTO',
            principalLevel: 'DIRECTOR',
          },
          undefined,
          activeRegistry
        );

        const dirCheck = await client.query(`
          SELECT 
            is_current_principal_owner() as "isOwner",
            is_current_principal_executive() as "isExec",
            get_current_agent_id() as "agentId",
            get_current_department_id() as "deptId",
            current_setting('app.current_principal_level', true) as "level"
        `);
        expect(dirCheck.rows[0].isOwner).toBe(false);
        expect(dirCheck.rows[0].isExec).toBe(false);
        expect(dirCheck.rows[0].agentId).toBe('00000000-0000-0000-0000-000000000007');
        expect(dirCheck.rows[0].deptId).toBe('technology_engineering');
        expect(dirCheck.rows[0].level).toBe('DIRECTOR');

        await clearAuthenticatedSession(client);

        // 10c. Legitimate registered Executive (EXEC-CEO)
        await applyAuthenticatedSession(
          client,
          {
            tenantId,
            agentCode: 'EXEC-CEO',
            principalLevel: 'EXECUTIVE',
          },
          undefined,
          activeRegistry
        );

        const execCheck = await client.query(`
          SELECT 
            is_current_principal_owner() as "isOwner",
            is_current_principal_executive() as "isExec",
            get_current_agent_id() as "agentId",
            get_current_department_id() as "deptId",
            current_setting('app.current_principal_level', true) as "level"
        `);
        expect(execCheck.rows[0].isOwner).toBe(false);
        expect(execCheck.rows[0].isExec).toBe(true);
        expect(execCheck.rows[0].agentId).toBe('00000000-0000-0000-0000-000000000001');
        expect(execCheck.rows[0].deptId).toBe('executive_office');
        expect(execCheck.rows[0].level).toBe('EXECUTIVE');

        await clearAuthenticatedSession(client);

        // 10d. Authenticated Human Owner
        const authService = new OwnerAuthenticationService({ secretKey: ownerHmacSecret, requiredCredentials: ownerMasterKey });
        const ownerSession = authService.createOwnerSession({
          principalId: OWNER_PRINCIPAL_ID,
          email: CANONICAL_OWNER_PRINCIPAL.email,
          credentials: ownerMasterKey,
        });

        await applyAuthenticatedSession(
          client,
          {
            tenantId,
            agentId: OWNER_PRINCIPAL_ID,
            principalLevel: 'OWNER',
            isOwnerAuthenticated: true,
            ownerSession,
          },
          undefined,
          activeRegistry
        );

        const ownerCheck = await client.query(`
          SELECT 
            is_current_principal_owner() as "isOwner",
            is_current_principal_executive() as "isExec",
            get_current_agent_id() as "agentId",
            get_current_department_id() as "deptId",
            current_setting('app.current_principal_level', true) as "level"
        `);
        expect(ownerCheck.rows[0].isOwner).toBe(true);
        expect(ownerCheck.rows[0].isExec).toBe(true);
        expect(ownerCheck.rows[0].agentId).toBe(OWNER_PRINCIPAL_ID);
        expect(ownerCheck.rows[0].deptId).toBe('executive_office');
        expect(ownerCheck.rows[0].level).toBe('OWNER');

        await clearAuthenticatedSession(client);

        // 10e. Genuinely authorized Director appointment via activeRegistry.appointDirector
        const dirRegistry = new DepartmentRegistry();
        const appt = dirRegistry.appointDirector({
          departmentId: 'operations_administration',
          newDirectorIdOrCode: 'OPS-DIR',
          authorizedBy: 'EXEC-CEO',
          executiveSession: dirRegistry.createExecutiveSession('EXEC-CEO'),
          reason: 'Authorized CEO confirmation of Director',
        });
        expect(appt.authorizationSignature).toBeDefined();

        await applyAuthenticatedSession(
          client,
          {
            tenantId,
            agentCode: 'OPS-DIR',
            principalLevel: 'DIRECTOR',
          },
          undefined,
          dirRegistry
        );

        const apptCheck = await client.query(`
          SELECT 
            get_current_agent_id() as "agentId",
            get_current_department_id() as "deptId",
            current_setting('app.current_principal_level', true) as "level"
        `);
        expect(apptCheck.rows[0].agentId).toBe('00000000-0000-0000-0000-000000000014');
        expect(apptCheck.rows[0].deptId).toBe('operations_administration');
        expect(apptCheck.rows[0].level).toBe('DIRECTOR');

        await clearAuthenticatedSession(client);

        // 10f. Genuinely authorized Specialist transfer via activeRegistry.transferAgent
        const transferRegistry = new DepartmentRegistry();
        const transferredFse = transferRegistry.transferAgent({
          agentIdOrCode: 'TECH-FSE',
          toDepartmentId: 'operations_administration',
          authorizedBy: 'EXEC-CEO',
          executiveSession: transferRegistry.createExecutiveSession('EXEC-CEO'),
          reason: 'Authorized CEO transfer to Operations',
        });
        expect(transferredFse.departmentId).toBe('operations_administration');
        const transferRec = transferredFse.currentConfig.departmentTransferHistory[0]!;
        expect(transferRec.authorizationSignature).toBeDefined();

        await applyAuthenticatedSession(
          client,
          {
            tenantId,
            agentCode: 'TECH-FSE',
            principalLevel: 'SPECIALIST',
          },
          undefined,
          transferRegistry
        );

        const transferCheck = await client.query(`
          SELECT 
            get_current_agent_id() as "agentId",
            get_current_department_id() as "deptId",
            current_setting('app.current_principal_level', true) as "level"
        `);
        expect(transferCheck.rows[0].agentId).toBe('00000000-0000-0000-0000-000000000009');
        expect(transferCheck.rows[0].deptId).toBe('operations_administration');
        expect(transferCheck.rows[0].level).toBe('SPECIALIST');

        await clearAuthenticatedSession(client);
      } finally {
        client.release();
      }
    });

    // =========================================================================
    // 11. Authenticated Hierarchy Authorization & Secret Enforcement under vme_app
    // =========================================================================
    it('11a. proves supplying only Owner ID or EXEC-CEO string cannot authorize hierarchy mutations', async () => {
      const client = await appPool.connect();
      try {
        const testRegistry = new DepartmentRegistry();

        // 1. Attempt appointDirector with only OWNER_PRINCIPAL_ID string
        expect(() =>
          testRegistry.appointDirector({
            departmentId: 'marketing_growth',
            newDirectorIdOrCode: 'BIZ-DIR',
            authorizedBy: OWNER_PRINCIPAL_ID,
            reason: 'Adversary string-only Owner appointment attempt',
          })
        ).toThrow(/cannot authorize an appointment or transfer|verified.*authentication/i);

        // 2. Attempt transferAgent with only OWNER_PRINCIPAL_ID string
        expect(() =>
          testRegistry.transferAgent({
            agentIdOrCode: 'TECH-FSE',
            toDepartmentId: 'marketing_growth',
            authorizedBy: OWNER_PRINCIPAL_ID,
            reason: 'Adversary string-only Owner transfer attempt',
          })
        ).toThrow(/cannot authorize an appointment or transfer|verified.*authentication/i);

        // 3. Attempt appointDirector with only EXEC-CEO string
        expect(() =>
          testRegistry.appointDirector({
            departmentId: 'marketing_growth',
            newDirectorIdOrCode: 'BIZ-DIR',
            authorizedBy: 'EXEC-CEO',
            reason: 'Adversary string-only EXEC-CEO appointment attempt',
          })
        ).toThrow(/cannot authorize an appointment or transfer|verified.*authentication/i);

        // 4. Attempt transferAgent with only EXEC-CEO string
        expect(() =>
          testRegistry.transferAgent({
            agentIdOrCode: 'TECH-FSE',
            toDepartmentId: 'marketing_growth',
            authorizedBy: 'EXEC-CEO',
            reason: 'Adversary string-only EXEC-CEO transfer attempt',
          })
        ).toThrow(/cannot authorize an appointment or transfer|verified.*authentication/i);
      } finally {
        client.release();
      }
    });

    it('11b. proves missing, invalid, expired, or revoked authentication sessions are rejected under vme_app', async () => {
      const client = await appPool.connect();
      try {
        const testRegistry = new DepartmentRegistry();

        // 1. Tampered executive session token
        const legitSession = testRegistry.createExecutiveSession('EXEC-CEO');
        const tamperedSession = {
          ...legitSession,
          token: legitSession.token.slice(0, -6) + 'badbad',
        };

        expect(() =>
          testRegistry.appointDirector({
            departmentId: 'marketing_growth',
            newDirectorIdOrCode: 'BIZ-DIR',
            authorizedBy: 'EXEC-CEO',
            executiveSession: tamperedSession,
            reason: 'Tampered token appointment attempt',
          })
        ).toThrow(/signature verification failed/i);

        // 2. Revoked executive session
        testRegistry.revokeExecutiveSession(legitSession.sessionId, 'Adversarial revocation check');
        expect(() =>
          testRegistry.appointDirector({
            departmentId: 'marketing_growth',
            newDirectorIdOrCode: 'BIZ-DIR',
            authorizedBy: 'EXEC-CEO',
            executiveSession: legitSession,
            reason: 'Revoked executive appointment attempt',
          })
        ).toThrow(/has been revoked/i);

        // 3. Revoked Owner session
        const ownerSession = testRegistry.createOwnerSession({
          principalId: OWNER_PRINCIPAL_ID,
          email: 'stephenikeme@icloud.com',
        });
        testRegistry.revokeOwnerSession(ownerSession.sessionId, 'Adversarial owner revocation check');
        expect(() =>
          testRegistry.transferAgent({
            agentIdOrCode: 'TECH-FSE',
            toDepartmentId: 'marketing_growth',
            authorizedBy: OWNER_PRINCIPAL_ID,
            ownerSession,
            reason: 'Revoked owner transfer attempt',
          })
        ).toThrow(/has been revoked/i);
      } finally {
        client.release();
      }
    });

    it('11c. proves valid authenticated Owner can perform permitted operations and establish PostgreSQL identity', async () => {
      const client = await appPool.connect();
      try {
        const testRegistry = new DepartmentRegistry();
        const ownerSession = testRegistry.createOwnerSession({
          principalId: OWNER_PRINCIPAL_ID,
          email: 'stephenikeme@icloud.com',
        });

        // 1. Legitimate Owner appoints Director
        const appt = testRegistry.appointDirector({
          departmentId: 'marketing_growth',
          newDirectorIdOrCode: 'BIZ-DIR',
          authorizedBy: OWNER_PRINCIPAL_ID,
          ownerSession,
          reason: 'Authorized Owner appointment of Marketing Director',
        });
        expect(appt.authorizationSignature).toBeDefined();
        expect(testRegistry.getDepartmentDirectorRecord('marketing_growth')?.agentCode).toBe('BIZ-DIR');

        // 2. Legitimate Owner transfers Specialist
        const transfer = testRegistry.transferAgent({
          agentIdOrCode: 'TECH-FSE',
          toDepartmentId: 'operations_administration',
          authorizedBy: OWNER_PRINCIPAL_ID,
          ownerSession,
          reason: 'Authorized Owner transfer to Operations',
        });
        expect(transfer.departmentId).toBe('operations_administration');
        expect(transfer.currentConfig.departmentTransferHistory[0]?.authorizationSignature).toBeDefined();

        // 3. Verify PostgreSQL database session with transferred agent under vme_app
        await applyAuthenticatedSession(
          client,
          {
            tenantId,
            agentCode: 'TECH-FSE',
            principalLevel: 'SPECIALIST',
          },
          undefined,
          testRegistry
        );

        const checkRes = await client.query(`
          SELECT 
            get_current_agent_id() as "agentId",
            get_current_department_id() as "deptId",
            current_setting('app.current_principal_level', true) as "level"
        `);
        expect(checkRes.rows[0].agentId).toBe('00000000-0000-0000-0000-000000000009');
        expect(checkRes.rows[0].deptId).toBe('operations_administration');
        expect(checkRes.rows[0].level).toBe('SPECIALIST');

        await clearAuthenticatedSession(client);
      } finally {
        client.release();
      }
    });

    it('11d. proves valid authenticated executive can perform only operations within their authority', async () => {
      const client = await appPool.connect();
      try {
        const testRegistry = new DepartmentRegistry();
        const ceoSession = testRegistry.createExecutiveSession('EXEC-CEO');
        const cooSession = testRegistry.createExecutiveSession('EXEC-COO');

        // 1. CEO is authorized to appoint non-executive department director
        const dirAppt = testRegistry.appointDirector({
          departmentId: 'operations_administration',
          newDirectorIdOrCode: 'OPS-DIR',
          authorizedBy: 'EXEC-CEO',
          executiveSession: ceoSession,
          reason: 'Authorized CEO confirmation of Director',
        });
        expect(dirAppt.authorizationSignature).toBeDefined();

        // 2. CEO cannot appoint leadership for executive_office (Owner only)
        expect(() =>
          testRegistry.appointDirector({
            departmentId: 'executive_office',
            newDirectorIdOrCode: 'EXEC-COO',
            authorizedBy: 'EXEC-CEO',
            executiveSession: ceoSession,
            reason: 'CEO attempting to appoint executive office director',
          })
        ).toThrow(/strictly require human Owner authorization/i);

        // 3. COO cannot appoint department directors (lacks authority)
        expect(() =>
          testRegistry.appointDirector({
            departmentId: 'marketing_growth',
            newDirectorIdOrCode: 'BIZ-DIR',
            authorizedBy: 'EXEC-COO',
            executiveSession: cooSession,
            reason: 'COO unauthorized director appointment attempt',
          })
        ).toThrow(/Executive 'EXEC-COO' lacks authority to appoint Directors/i);

        // 4. COO cannot authorize department transfers (lacks authority)
        expect(() =>
          testRegistry.transferAgent({
            agentIdOrCode: 'TECH-FSE',
            toDepartmentId: 'operations_administration',
            authorizedBy: 'EXEC-COO',
            executiveSession: cooSession,
            reason: 'COO unauthorized transfer attempt',
          })
        ).toThrow(/Executive 'EXEC-COO' lacks authority to authorize department transfers/i);
      } finally {
        client.release();
      }
    });

    it('11e. proves rejected requests leave hierarchy records and signed ledgers completely unmutated', async () => {
      const client = await appPool.connect();
      try {
        const testRegistry = new DepartmentRegistry();
        const initialMarketingDir = testRegistry.getDepartmentDirectorRecord('marketing_growth')?.agentCode;
        const initialLeadershipLen = testRegistry.getLeadershipHistory().length;
        const initialAgentDept = testRegistry.getAgentRecord('TECH-FSE')?.departmentId;
        const initialTransferLen = testRegistry.getTransferHistory().length;

        // Rejected appointment attempt: string only
        expect(() =>
          testRegistry.appointDirector({
            departmentId: 'marketing_growth',
            newDirectorIdOrCode: 'BIZ-DIR',
            authorizedBy: 'EXEC-CEO',
            reason: 'Unauthenticated attempt',
          })
        ).toThrow(UnauthorizedHierarchyActionError);

        // Rejected transfer attempt: unauthorized executive
        const cooSession = testRegistry.createExecutiveSession('EXEC-COO');
        expect(() =>
          testRegistry.transferAgent({
            agentIdOrCode: 'TECH-FSE',
            toDepartmentId: 'marketing_growth',
            authorizedBy: 'EXEC-COO',
            executiveSession: cooSession,
            reason: 'COO unauthorized transfer attempt',
          })
        ).toThrow(UnauthorizedHierarchyActionError);

        // Assert zero mutation to leadership state and ledger
        expect(testRegistry.getDepartmentDirectorRecord('marketing_growth')?.agentCode).toBe(initialMarketingDir);
        expect(testRegistry.getLeadershipHistory().length).toBe(initialLeadershipLen);

        // Assert zero mutation to workforce state and transfer ledger
        expect(testRegistry.getAgentRecord('TECH-FSE')?.departmentId).toBe(initialAgentDept);
        expect(testRegistry.getTransferHistory().length).toBe(initialTransferLen);
      } finally {
        client.release();
      }
    });

    it('11f. proves missing DB_SESSION_SECRET prevents signing and fails closed', async () => {
      const originalSecret = process.env.DB_SESSION_SECRET;
      try {
        delete process.env.DB_SESSION_SECRET;

        const testRegistry = new DepartmentRegistry();
        expect(() => {
          testRegistry.createExecutiveSession('EXEC-CEO');
        }).toThrow(/DB_SESSION_SECRET.*must be independently provisioned/i);

        expect(() => {
          testRegistry.appointDirector({
            departmentId: 'marketing_growth',
            newDirectorIdOrCode: 'BIZ-DIR',
            authorizedBy: 'EXEC-CEO',
            reason: 'Signing attempt without secret',
          });
        }).toThrow(/DB_SESSION_SECRET.*must be independently provisioned/i);
      } finally {
        process.env.DB_SESSION_SECRET = originalSecret;
      }
    });
  });
});
