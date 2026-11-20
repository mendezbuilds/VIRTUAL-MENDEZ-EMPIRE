import { describe, it, expect, beforeEach } from 'vitest';
import { newDb, DataType } from 'pg-mem';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import {
  PostgresWorkingStorage,
  PostgresEpisodicStorage,
  PostgresSemanticStorage,
  PostgresProceduralStorage,
  PostgresStorageError,
  withSessionRls,
} from './postgres-memory-storage.js';
import { AgentMemoryEngine } from './memory-engine.js';
import { IncompatibleEmbeddingError } from './semantic-memory.js';

describe('Postgres Memory Storage & Adversarial RLS / Isolation Tests', () => {
  let pool: Pool;
  const tenant1 = '11111111-1111-1111-1111-111111111111';
  const tenant2 = '22222222-2222-2222-2222-222222222222';
  const agentA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const agentB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

  beforeEach(() => {
    process.env.DB_SESSION_SECRET = 'test-secret-with-at-least-32-chars-entropy-abc123';
    const db = newDb();

    db.public.registerEquivalentType({
      name: 'float8',
      equivalentTo: DataType.float,
      isValid: () => true,
    });
    db.public.registerEquivalentType({
      name: 'float8[]',
      equivalentTo: DataType.text,
      isValid: () => true,
    });

    const sessionVars = new Map<string, string>();
    db.public.registerFunction({
      name: 'set_config',
      args: [DataType.text, DataType.text, DataType.bool],
      returns: DataType.text,
      implementation: (setting: string, val: string) => {
        sessionVars.set(setting, val);
        return val;
      },
    });

    db.public.registerFunction({
      name: 'current_setting',
      args: [DataType.text, DataType.bool],
      returns: DataType.text,
      implementation: (setting: string) => {
        return sessionVars.get(setting) ?? '';
      },
    });

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
      CREATE TABLE agent_working_memories (
        id text PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id text NOT NULL,
        task_id text NOT NULL,
        agent_id text NOT NULL,
        key text NOT NULL,
        value jsonb NOT NULL,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, task_id, key)
      );

      CREATE TABLE agent_episodic_memories (
        id text PRIMARY KEY,
        tenant_id text NOT NULL,
        agent_id text NOT NULL,
        agent_code text NOT NULL,
        department_id text NOT NULL,
        task_id text NOT NULL,
        action_type text NOT NULL,
        input_summary text NOT NULL,
        decision_rationale text NOT NULL,
        outcome text NOT NULL,
        lessons_learned text,
        execution_duration_ms int,
        status text NOT NULL DEFAULT 'SUCCESS',
        scope text NOT NULL DEFAULT 'AGENT_PRIVATE',
        importance_score int NOT NULL DEFAULT 5,
        metadata jsonb NOT NULL DEFAULT '{}',
        recorded_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE agent_semantic_memories (
        id text PRIMARY KEY,
        tenant_id text NOT NULL,
        scope text NOT NULL DEFAULT 'ORGANIZATION_WIDE',
        department_id text,
        author_agent_id text,
        category text NOT NULL,
        title text NOT NULL,
        content text NOT NULL,
        embedding float8[] NOT NULL,
        embedding_provider text NOT NULL DEFAULT 'openai',
        embedding_model text NOT NULL DEFAULT 'text-embedding-3-small',
        embedding_dimension int NOT NULL,
        embedding_version text NOT NULL DEFAULT '1.0.0',
        importance_score int NOT NULL DEFAULT 5,
        tags text[] NOT NULL DEFAULT '{}',
        version text NOT NULL DEFAULT '1.0.0',
        supersedes_id text,
        is_deprecated boolean NOT NULL DEFAULT false,
        metadata jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE agent_procedural_memories (
        id text PRIMARY KEY,
        tenant_id text NOT NULL,
        scope text NOT NULL DEFAULT 'DEPARTMENT_SCOPED',
        department_id text,
        author_agent_id text NOT NULL,
        author_agent_code text,
        authorized_by text NOT NULL,
        name text NOT NULL,
        description text NOT NULL,
        trigger_condition text NOT NULL,
        required_capabilities text[] NOT NULL,
        steps jsonb NOT NULL,
        success_count int NOT NULL DEFAULT 0,
        failure_count int NOT NULL DEFAULT 0,
        version text NOT NULL DEFAULT '1.0.0',
        is_approved boolean NOT NULL DEFAULT false,
        metadata jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);

    const { Pool: PgPool } = db.adapters.createPg();
    pool = new PgPool() as unknown as Pool;
  });

  describe('PostgresWorkingStorage', () => {
    it('sets, gets, and respects TTL expiration', async () => {
      const storage = new PostgresWorkingStorage(pool);
      const ctx = { tenantId: tenant1, agentId: agentA };
      const expiresAtFuture = new Date(Date.now() + 3600 * 1000);

      await storage.set(ctx, 'task-101', agentA, 'plan', { step: 1, action: 'research' }, expiresAtFuture);

      const retrieved = await storage.get<{ step: number; action: string }>(ctx, 'task-101', 'plan');
      expect(retrieved).toEqual({ step: 1, action: 'research' });

      // Expired key returns undefined
      const expiresAtPast = new Date(Date.now() - 1000);
      await storage.set(ctx, 'task-101', agentA, 'expired_key', 'old_data', expiresAtPast);
      const expired = await storage.get(ctx, 'task-101', 'expired_key');
      expect(expired).toBeUndefined();
    });

    it('enforces tenant boundary isolation', async () => {
      const storage = new PostgresWorkingStorage(pool);
      const ctx1 = { tenantId: tenant1, agentId: agentA };
      const ctx2 = { tenantId: tenant2, agentId: agentA };
      const expiresAt = new Date(Date.now() + 3600 * 1000);

      await storage.set(ctx1, 'task-isolation', agentA, 'secret_key', 'agentA_val', expiresAt);

      // Same key in different tenant returns undefined
      const t2Read = await storage.get(ctx2, 'task-isolation', 'secret_key');
      expect(t2Read).toBeUndefined();
    });
  });

  describe('PostgresEpisodicStorage', () => {
    it('records episodic records and queries by filter', async () => {
      const storage = new PostgresEpisodicStorage(pool, { tenantId: tenant1 });
      const record = {
        id: randomUUID(),
        agentId: agentA,
        agentCode: 'SPEC-01',
        departmentId: 'technology_engineering' as const,
        taskId: randomUUID(),
        actionType: 'CODE_REFACTOR',
        inputSummary: 'Refactor memory module',
        decisionRationale: 'Clean separation of storage tiers',
        outcome: 'Module refactored with 100% tests passing',
        lessonsLearned: 'Always validate dimension bounds',
        executionDurationMs: 420,
        status: 'SUCCESS' as const,
        scope: 'DEPARTMENT_SCOPED' as const,
        importanceScore: 8,
        metadata: { commit: 'abc123' },
        recordedAt: new Date().toISOString(),
      };

      await storage.saveRecord(record);

      const queried = await storage.queryRecords({
        departmentId: 'technology_engineering',
        actionType: 'CODE_REFACTOR',
      });

      expect(queried).toHaveLength(1);
      expect(queried[0]?.agentCode).toBe('SPEC-01');
      expect(queried[0]?.outcome).toContain('100% tests passing');
    });

    it('archives records older than cutoff timestamp', async () => {
      const storage = new PostgresEpisodicStorage(pool, { tenantId: tenant1 });
      const oldTime = new Date(Date.now() - 100000).toISOString();
      await storage.saveRecord({
        id: randomUUID(),
        agentId: agentA,
        agentCode: 'SPEC-01',
        departmentId: 'technology_engineering' as const,
        taskId: randomUUID(),
        actionType: 'OLD_ACTION',
        inputSummary: 'Old input',
        decisionRationale: 'Old rationale',
        outcome: 'Old outcome',
        status: 'SUCCESS' as const,
        scope: 'AGENT_PRIVATE' as const,
        importanceScore: 4,
        metadata: {},
        recordedAt: oldTime,
      });

      const deleted = await storage.archiveOlderThan(new Date().toISOString());
      expect(deleted).toBeGreaterThanOrEqual(1);
    });
  });

  describe('PostgresSemanticStorage', () => {
    it('stores semantic knowledge and performs cosine similarity ranking', async () => {
      const storage = new PostgresSemanticStorage(pool, { tenantId: tenant1 });
      const itemId = randomUUID();
      await storage.insert({
        id: itemId,
        scope: 'ORGANIZATION_WIDE',
        category: 'architecture',
        title: 'PostgreSQL ABAC Guidelines',
        content: 'Guidelines on database-level RLS and session context propagation.',
        embedding: [0.9, 0.1, 0.0],
        embeddingMetadata: {
          provider: 'openai',
          model: 'text-embedding-3-small',
          dimension: 3,
          version: '1.0.0',
        },
        importanceScore: 9,
        tags: ['postgres', 'security'],
        version: '1.0.0',
        isDeprecated: false,
        metadata: {},
        createdAt: new Date().toISOString(),
      });

      const results = await storage.search(
        [0.85, 0.15, 0.0],
        {
          provider: 'openai',
          model: 'text-embedding-3-small',
          dimension: 3,
          version: '1.0.0',
        },
        {
          minSimilarity: 0.8,
          limit: 5,
          filter: { category: 'architecture' },
        }
      );

      expect(results).toHaveLength(1);
      expect(results[0]?.similarity).toBeGreaterThan(0.95);
      expect(results[0]?.item.title).toBe('PostgreSQL ABAC Guidelines');
    });

    it('rejects dimension mismatch during search', async () => {
      const storage = new PostgresSemanticStorage(pool, { tenantId: tenant1 });
      await expect(
        storage.search(
          [0.5, 0.5], // 2 dims
          {
            provider: 'openai',
            model: 'text-embedding-3-small',
            dimension: 3, // declares 3 dims
            version: '1.0.0',
          }
        )
      ).rejects.toThrow(IncompatibleEmbeddingError);
    });
  });

  describe('PostgresProceduralStorage', () => {
    it('stores, queries, and updates execution metrics', async () => {
      const storage = new PostgresProceduralStorage(pool, { tenantId: tenant1 });
      const playbookId = randomUUID();
      await storage.savePlaybook({
        id: playbookId,
        scope: 'DEPARTMENT_SCOPED',
        departmentId: 'technology_engineering',
        authorAgentId: agentA,
        authorizedBy: 'OWNER',
        name: 'Safe Schema Migration SOP',
        description: 'Standard procedure for rolling out non-destructive DDL migrations.',
        triggerCondition: 'ON_MIGRATION_DEPLOYMENT',
        requiredCapabilities: ['DATABASE_ADMIN'],
        steps: [
          {
            stepNumber: 1,
            name: 'Validate DDL',
            instruction: 'Dry-run migration against staging replica',
            requiredCapability: 'DATABASE_ADMIN',
            timeoutMs: 30000,
            retryLimit: 0,
          },
        ],
        successCount: 0,
        failureCount: 0,
        version: '1.0.0',
        isApproved: true,
        metadata: {},
        createdAt: new Date().toISOString(),
      });

      await storage.updateExecutionStats(playbookId, true);
      await storage.updateExecutionStats(playbookId, true);
      await storage.updateExecutionStats(playbookId, false);

      const retrieved = await storage.getPlaybookById(playbookId);
      expect(retrieved).toBeDefined();
      expect(retrieved?.successCount).toBe(2);
      expect(retrieved?.failureCount).toBe(1);
    });
  });

  describe('Fail-Safe Production Mode', () => {
    it('AgentMemoryEngine fails safely in PRODUCTION_POSTGRES mode without fallback when pool is missing', () => {
      expect(() => {
        new AgentMemoryEngine({
          mode: 'PRODUCTION_POSTGRES',
          // pool intentionally omitted
        });
      }).toThrow(PostgresStorageError);
    });

    it('AgentMemoryEngine initializes successfully when postgres pool and tenantId are supplied', () => {
      const engine = new AgentMemoryEngine({
        mode: 'PRODUCTION_POSTGRES',
        pool: pool,
        defaultTenantId: tenant1,
      });

      expect(engine.mode).toBe('PRODUCTION_POSTGRES');
    });
  });
});
