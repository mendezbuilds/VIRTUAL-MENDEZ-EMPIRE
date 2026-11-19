import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  type EpisodicMemoryRecord,
  type SemanticKnowledgeItem,
  type ProceduralPlaybook,
  type EmbeddingMetadata,
  type DepartmentId,
  type MemoryScope,
  EpisodicMemoryRecordSchema,
  SemanticKnowledgeItemSchema,
  ProceduralPlaybookSchema,
} from '@vme/shared-types';
import type { EpisodicMemoryFilter, EpisodicMemoryStorage } from './episodic-memory.js';
import type { SemanticSearchFilter, SemanticSearchResult, SemanticStorage } from './semantic-memory.js';
import type { ProceduralQueryFilter, ProceduralStorage } from './procedural-memory.js';
import {
  computeCosineSimilarity,
  assertEmbeddingCompatibility,
  IncompatibleEmbeddingError,
} from './semantic-memory.js';
import type { WorkingMemoryStorage } from './working-memory.js';

export interface RlsSessionContext {
  tenantId: string;
  agentId?: string;
  departmentId?: string;
  principalLevel?: string;
  isOwnerAuthenticated?: boolean;
}

export class PostgresStorageError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(`POSTGRES STORAGE ERROR: ${message}`);
    this.name = 'PostgresStorageError';
  }
}

/**
 * Executes a callback within a transaction-scoped PostgreSQL session RLS context on a pool client.
 * Uses BEGIN / COMMIT with rollback on failure, and resets session context in finally to prevent
 * connection-pool context leakage across requests.
 */
export async function withSessionRls<T>(
  pool: Pool,
  context: RlsSessionContext,
  operation: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT 
        set_config('app.current_tenant_id', $1, true),
        set_config('app.current_agent_id', $2, true),
        set_config('app.current_department_id', $3, true),
        set_config('app.current_principal_level', $4, true),
        set_config('app.is_owner_authenticated', $5, true)`,
      [
        context.tenantId,
        context.agentId ?? '',
        context.departmentId ?? '',
        context.principalLevel ?? 'SPECIALIST',
        context.isOwnerAuthenticated === true ? 'true' : 'false',
      ]
    );
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (err: unknown) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors if connection failed
    }
    throw new PostgresStorageError(err instanceof Error ? err.message : String(err), err);
  } finally {
    // Explicitly reset session-level settings to prevent connection-pool leakage
    try {
      await client.query(
        `SELECT 
          set_config('app.current_tenant_id', '', false),
          set_config('app.current_agent_id', '', false),
          set_config('app.current_department_id', '', false),
          set_config('app.current_principal_level', '', false),
          set_config('app.is_owner_authenticated', 'false', false)`
      );
    } catch {
      // ignore reset error on closed client
    }
    client.release();
  }
}

// ============================================================================
// 1. PostgreSQL Working Memory Storage
// ============================================================================
export class PostgresWorkingStorage implements WorkingMemoryStorage {
  constructor(
    private readonly pool: Pool,
    private readonly context?: RlsSessionContext
  ) {}

  private resolveContext(explicitContext?: RlsSessionContext): RlsSessionContext {
    const ctx = explicitContext ?? this.context;
    if (!ctx) {
      throw new PostgresStorageError(
        'RlsSessionContext is required for PostgreSQL Working Memory storage operations.'
      );
    }
    return ctx;
  }

  async set(
    taskIdOrContext: string | RlsSessionContext,
    keyOrTaskId: string,
    valueOrAgentId: unknown,
    expiresAtOrKey?: Date | string,
    agentIdOrValue?: string | unknown,
    maybeExpiresAt?: Date
  ): Promise<void> {
    let ctx: RlsSessionContext;
    let taskId: string;
    let agentId: string;
    let key: string;
    let value: unknown;
    let expiresAt: Date;

    if (typeof taskIdOrContext === 'object') {
      ctx = taskIdOrContext;
      taskId = keyOrTaskId;
      agentId = valueOrAgentId as string;
      key = expiresAtOrKey as string;
      value = agentIdOrValue;
      expiresAt = maybeExpiresAt ?? new Date(Date.now() + 3600 * 1000);
    } else {
      ctx = this.resolveContext();
      taskId = taskIdOrContext;
      key = keyOrTaskId;
      value = valueOrAgentId;
      expiresAt = (expiresAtOrKey as Date) ?? new Date(Date.now() + 3600 * 1000);
      agentId = (agentIdOrValue as string) ?? ctx.agentId ?? '00000000-0000-0000-0000-000000000000';
    }

    await withSessionRls(this.pool, ctx, async (client) => {
      await client.query(
        `INSERT INTO agent_working_memories (id, tenant_id, task_id, agent_id, key, value, expires_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, clock_timestamp())
         ON CONFLICT (tenant_id, task_id, key)
         DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at, updated_at = clock_timestamp()`,
        [randomUUID(), ctx.tenantId, taskId, agentId, key, JSON.stringify(value), expiresAt]
      );
    });
  }

  async get<T>(
    contextOrTaskId: RlsSessionContext | string,
    taskIdOrKey: string,
    maybeKey?: string
  ): Promise<T | undefined> {
    let ctx: RlsSessionContext;
    let taskId: string;
    let key: string;

    if (typeof contextOrTaskId === 'object') {
      ctx = contextOrTaskId;
      taskId = taskIdOrKey;
      key = maybeKey!;
    } else {
      ctx = this.resolveContext();
      taskId = contextOrTaskId;
      key = taskIdOrKey;
    }

    return withSessionRls(this.pool, ctx, async (client) => {
      const res = await client.query(
        `SELECT value FROM agent_working_memories
         WHERE tenant_id = $1 AND task_id = $2 AND key = $3 AND expires_at > clock_timestamp()`,
        [ctx.tenantId, taskId, key]
      );
      if (res.rows.length === 0) return undefined;
      return res.rows[0].value as T;
    });
  }

  async getAll(
    contextOrTaskId: RlsSessionContext | string,
    maybeTaskId?: string
  ): Promise<Record<string, unknown>> {
    let ctx: RlsSessionContext;
    let taskId: string;

    if (typeof contextOrTaskId === 'object') {
      ctx = contextOrTaskId;
      taskId = maybeTaskId!;
    } else {
      ctx = this.resolveContext();
      taskId = contextOrTaskId;
    }

    return withSessionRls(this.pool, ctx, async (client) => {
      const res = await client.query(
        `SELECT key, value FROM agent_working_memories
         WHERE tenant_id = $1 AND task_id = $2 AND expires_at > clock_timestamp()`,
        [ctx.tenantId, taskId]
      );
      const result: Record<string, unknown> = {};
      for (const row of res.rows) {
        result[row.key] = row.value;
      }
      return result;
    });
  }

  async clear(contextOrTaskId: RlsSessionContext | string, maybeTaskId?: string): Promise<void> {
    let ctx: RlsSessionContext;
    let taskId: string;

    if (typeof contextOrTaskId === 'object') {
      ctx = contextOrTaskId;
      taskId = maybeTaskId!;
    } else {
      ctx = this.resolveContext();
      taskId = contextOrTaskId;
    }

    await withSessionRls(this.pool, ctx, async (client) => {
      await client.query(
        `DELETE FROM agent_working_memories WHERE tenant_id = $1 AND task_id = $2`,
        [ctx.tenantId, taskId]
      );
    });
  }

  async cleanupExpired(context?: RlsSessionContext): Promise<number> {
    const ctx = this.resolveContext(context);
    return withSessionRls(this.pool, ctx, async (client) => {
      const res = await client.query(
        `DELETE FROM agent_working_memories WHERE tenant_id = $1 AND expires_at <= clock_timestamp()`,
        [ctx.tenantId]
      );
      return res.rowCount ?? 0;
    });
  }
}

// ============================================================================
// 2. PostgreSQL Episodic Memory Storage
// ============================================================================
export class PostgresEpisodicStorage implements EpisodicMemoryStorage {
  constructor(
    private readonly pool: Pool,
    private readonly defaultContext: RlsSessionContext
  ) {}

  async saveRecord(record: EpisodicMemoryRecord): Promise<void> {
    await withSessionRls(this.pool, this.defaultContext, async (client) => {
      await client.query(
        `INSERT INTO agent_episodic_memories (
          id, tenant_id, agent_id, agent_code, department_id, task_id, action_type,
          input_summary, decision_rationale, outcome, lessons_learned, execution_duration_ms,
          status, scope, importance_score, metadata, recorded_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [
          record.id,
          this.defaultContext.tenantId,
          record.agentId,
          record.agentCode ?? 'AGENT',
          record.departmentId,
          record.taskId,
          record.actionType,
          record.inputSummary,
          record.decisionRationale,
          record.outcome,
          record.lessonsLearned ?? null,
          record.executionDurationMs ?? null,
          record.status,
          record.scope,
          record.importanceScore,
          JSON.stringify(record.metadata ?? {}),
          record.recordedAt,
        ]
      );
    });
  }

  async getRecordById(id: string): Promise<EpisodicMemoryRecord | undefined> {
    return withSessionRls(this.pool, this.defaultContext, async (client) => {
      const res = await client.query(
        `SELECT id, tenant_id, agent_id as "agentId", agent_code as "agentCode", department_id as "departmentId",
                task_id as "taskId", action_type as "actionType", input_summary as "inputSummary",
                decision_rationale as "decisionRationale", outcome, lessons_learned as "lessonsLearned",
                execution_duration_ms as "executionDurationMs", status, scope, importance_score as "importanceScore",
                metadata, recorded_at as "recordedAt"
         FROM agent_episodic_memories
         WHERE id = $1`,
        [id]
      );
      if (res.rows.length === 0) return undefined;
      return this.mapRowToRecord(res.rows[0]);
    });
  }

  async queryRecords(filter: EpisodicMemoryFilter): Promise<EpisodicMemoryRecord[]> {
    return withSessionRls(this.pool, this.defaultContext, async (client) => {
      const conditions: string[] = ['1=1'];
      const params: unknown[] = [];
      let pIdx = 1;

      if (filter.agentId) {
        conditions.push(`agent_id = $${pIdx++}`);
        params.push(filter.agentId);
      }
      if (filter.departmentId) {
        conditions.push(`department_id = $${pIdx++}`);
        params.push(filter.departmentId);
      }
      if (filter.actionType) {
        conditions.push(`action_type = $${pIdx++}`);
        params.push(filter.actionType);
      }
      if (filter.status) {
        conditions.push(`status = $${pIdx++}`);
        params.push(filter.status);
      }
      if (filter.scope) {
        conditions.push(`scope = $${pIdx++}`);
        params.push(filter.scope);
      }
      if (filter.since) {
        conditions.push(`recorded_at >= $${pIdx++}`);
        params.push(filter.since);
      }
      if (filter.until) {
        conditions.push(`recorded_at <= $${pIdx++}`);
        params.push(filter.until);
      }

      const limit = filter.limit ?? 50;
      const sql = `
        SELECT id, tenant_id, agent_id as "agentId", agent_code as "agentCode", department_id as "departmentId",
               task_id as "taskId", action_type as "actionType", input_summary as "inputSummary",
               decision_rationale as "decisionRationale", outcome, lessons_learned as "lessonsLearned",
               execution_duration_ms as "executionDurationMs", status, scope, importance_score as "importanceScore",
               metadata, recorded_at as "recordedAt"
        FROM agent_episodic_memories
        WHERE ${conditions.join(' AND ')}
        ORDER BY recorded_at DESC
        LIMIT ${limit}
      `;

      const res = await client.query(sql, params);
      return res.rows.map((row) => this.mapRowToRecord(row));
    });
  }

  private mapRowToRecord(row: any): EpisodicMemoryRecord {
    return EpisodicMemoryRecordSchema.parse({
      ...row,
      lessonsLearned: row.lessonsLearned ?? undefined,
      executionDurationMs: row.executionDurationMs != null ? Number(row.executionDurationMs) : undefined,
      recordedAt: row.recordedAt instanceof Date ? row.recordedAt.toISOString() : String(row.recordedAt),
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata ?? {}),
    });
  }

  async archiveOlderThan(cutoffIsoDate: string): Promise<number> {
    return withSessionRls(this.pool, this.defaultContext, async (client) => {
      // In PostgreSQL, mark or delete records older than cutoff
      const res = await client.query(
        `DELETE FROM agent_episodic_memories WHERE recorded_at < $1`,
        [cutoffIsoDate]
      );
      return res.rowCount ?? 0;
    });
  }

  async deleteRecords(filter: EpisodicMemoryFilter): Promise<number> {
    return withSessionRls(this.pool, this.defaultContext, async (client) => {
      const conditions: string[] = ['1=1'];
      const params: unknown[] = [];
      let pIdx = 1;

      if (filter.agentId) {
        conditions.push(`agent_id = $${pIdx++}`);
        params.push(filter.agentId);
      }
      if (filter.departmentId) {
        conditions.push(`department_id = $${pIdx++}`);
        params.push(filter.departmentId);
      }
      if (filter.actionType) {
        conditions.push(`action_type = $${pIdx++}`);
        params.push(filter.actionType);
      }
      if (filter.scope) {
        conditions.push(`scope = $${pIdx++}`);
        params.push(filter.scope);
      }

      const sql = `DELETE FROM agent_episodic_memories WHERE ${conditions.join(' AND ')}`;
      const res = await client.query(sql, params);
      return res.rowCount ?? 0;
    });
  }
}

// ============================================================================
// 3. PostgreSQL Semantic Memory Storage (Flexible Vector Dimension)
// ============================================================================
export class PostgresSemanticStorage implements SemanticStorage {
  constructor(
    private readonly pool: Pool,
    private readonly defaultContext: RlsSessionContext
  ) {}

  async insert(item: SemanticKnowledgeItem): Promise<void> {
    await withSessionRls(this.pool, this.defaultContext, async (client) => {
      await client.query(
        `INSERT INTO agent_semantic_memories (
          id, tenant_id, scope, department_id, author_agent_id, category, title, content,
          embedding, embedding_provider, embedding_model, embedding_dimension, embedding_version,
          importance_score, tags, version, supersedes_id, is_deprecated, metadata, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, clock_timestamp())`,
        [
          item.id,
          this.defaultContext.tenantId,
          item.scope,
          item.departmentId ?? null,
          item.authorAgentId ?? null,
          item.category,
          item.title,
          item.content,
          item.embedding,
          item.embeddingMetadata.provider,
          item.embeddingMetadata.model,
          item.embeddingMetadata.dimension,
          item.embeddingMetadata.version,
          item.importanceScore,
          item.tags,
          item.version,
          item.supersedesId ?? null,
          item.isDeprecated,
          JSON.stringify(item.metadata ?? {}),
          item.createdAt ?? new Date().toISOString(),
        ]
      );
    });
  }

  async update(item: SemanticKnowledgeItem): Promise<void> {
    await withSessionRls(this.pool, this.defaultContext, async (client) => {
      await client.query(
        `UPDATE agent_semantic_memories
         SET title = $1, content = $2, embedding = $3, importance_score = $4, tags = $5,
             version = $6, supersedes_id = $7, is_deprecated = $8, metadata = $9, updated_at = clock_timestamp()
         WHERE id = $10`,
        [
          item.title,
          item.content,
          item.embedding,
          item.importanceScore,
          item.tags,
          item.version,
          item.supersedesId ?? null,
          item.isDeprecated,
          JSON.stringify(item.metadata ?? {}),
          item.id,
        ]
      );
    });
  }

  async getById(id: string): Promise<SemanticKnowledgeItem | undefined> {
    return withSessionRls(this.pool, this.defaultContext, async (client) => {
      const res = await client.query(
        `SELECT id, tenant_id, scope, department_id as "departmentId", author_agent_id as "authorAgentId",
                category, title, content, embedding, embedding_provider, embedding_model,
                embedding_dimension, embedding_version, importance_score as "importanceScore",
                tags, version, supersedes_id as "supersedesId", is_deprecated as "isDeprecated",
                metadata, created_at as "createdAt", updated_at as "updatedAt"
         FROM agent_semantic_memories WHERE id = $1`,
        [id]
      );
      if (res.rows.length === 0) return undefined;
      return this.mapRowToItem(res.rows[0]);
    });
  }

  async search(
    queryVector: number[],
    queryMetadata?: EmbeddingMetadata,
    options?: {
      limit?: number;
      minSimilarity?: number;
      filter?: SemanticSearchFilter;
    }
  ): Promise<SemanticSearchResult[]> {
    if (queryMetadata && queryVector.length !== queryMetadata.dimension) {
      throw new IncompatibleEmbeddingError(
        `Query vector dimension ${queryVector.length} does not match declared dimension ${queryMetadata.dimension}`
      );
    }
    return withSessionRls(this.pool, this.defaultContext, async (client) => {
      const conditions: string[] = ['1=1'];
      const params: unknown[] = [];
      let pIdx = 1;

      if (!options?.filter?.includeDeprecated) {
        conditions.push(`is_deprecated = false`);
      }
      if (options?.filter?.category) {
        conditions.push(`category = $${pIdx++}`);
        params.push(options.filter.category);
      }
      if (options?.filter?.departmentId) {
        conditions.push(`(scope = 'ORGANIZATION_WIDE' OR department_id = $${pIdx++})`);
        params.push(options.filter.departmentId);
      }
      if (options?.filter?.scope) {
        conditions.push(`scope = $${pIdx++}`);
        params.push(options.filter.scope);
      }

      const res = await client.query(
        `SELECT id, tenant_id, scope, department_id as "departmentId", author_agent_id as "authorAgentId",
                category, title, content, embedding, embedding_provider, embedding_model,
                embedding_dimension, embedding_version, importance_score as "importanceScore",
                tags, version, supersedes_id as "supersedesId", is_deprecated as "isDeprecated",
                metadata, created_at as "createdAt", updated_at as "updatedAt"
         FROM agent_semantic_memories
         WHERE ${conditions.join(' AND ')}`,
        params
      );

      const minSim = options?.minSimilarity ?? 0.5;
      const limit = options?.limit ?? 5;
      const scored: SemanticSearchResult[] = [];

      for (const row of res.rows) {
        const item = this.mapRowToItem(row);
        if (queryMetadata && item.embeddingMetadata) {
          assertEmbeddingCompatibility(queryMetadata, item.embeddingMetadata);
        }
        const similarity = computeCosineSimilarity(queryVector, item.embedding);
        if (similarity >= minSim) {
          scored.push({ item, similarity });
        }
      }

      return scored.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
    });
  }

  async deprecate(id: string, supersedesId?: string): Promise<void> {
    await withSessionRls(this.pool, this.defaultContext, async (client) => {
      await client.query(
        `UPDATE agent_semantic_memories
         SET is_deprecated = true, supersedes_id = COALESCE($1, supersedes_id), updated_at = clock_timestamp()
         WHERE id = $2`,
        [supersedesId ?? null, id]
      );
    });
  }

  private mapRowToItem(row: any): SemanticKnowledgeItem {
    return SemanticKnowledgeItemSchema.parse({
      id: row.id,
      tenantId: row.tenant_id,
      scope: row.scope,
      departmentId: row.departmentId ?? undefined,
      authorAgentId: row.authorAgentId ?? undefined,
      category: row.category,
      title: row.title,
      content: row.content,
      embedding: Array.isArray(row.embedding) ? row.embedding.map(Number) : [],
      embeddingMetadata: {
        provider: row.embedding_provider,
        model: row.embedding_model,
        dimension: Number(row.embedding_dimension),
        version: row.embedding_version,
      },
      importanceScore: Number(row.importanceScore),
      tags: row.tags ?? [],
      version: row.version,
      supersedesId: row.supersedesId ?? undefined,
      isDeprecated: Boolean(row.isDeprecated),
      metadata: row.metadata ?? {},
      createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
      updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : (row.updatedAt ? String(row.updatedAt) : undefined),
    });
  }
}

// ============================================================================
// 4. PostgreSQL Procedural Memory Storage
// ============================================================================
export class PostgresProceduralStorage implements ProceduralStorage {
  constructor(
    private readonly pool: Pool,
    private readonly defaultContext: RlsSessionContext
  ) {}

  async savePlaybook(playbook: ProceduralPlaybook): Promise<void> {
    await withSessionRls(this.pool, this.defaultContext, async (client) => {
      await client.query(
        `INSERT INTO agent_procedural_memories (
          id, tenant_id, scope, department_id, author_agent_id, author_agent_code,
          authorized_by, name, description, trigger_condition, required_capabilities,
          steps, success_count, failure_count, version, is_approved, metadata, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, clock_timestamp())
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name, description = EXCLUDED.description, trigger_condition = EXCLUDED.trigger_condition,
          required_capabilities = EXCLUDED.required_capabilities, steps = EXCLUDED.steps,
          success_count = EXCLUDED.success_count, failure_count = EXCLUDED.failure_count,
          version = EXCLUDED.version, is_approved = EXCLUDED.is_approved, metadata = EXCLUDED.metadata,
          updated_at = clock_timestamp()`,
        [
          playbook.id,
          this.defaultContext.tenantId,
          playbook.scope,
          playbook.departmentId ?? null,
          playbook.authorAgentId,
          playbook.authorAgentCode ?? null,
          playbook.authorizedBy,
          playbook.name,
          playbook.description,
          playbook.triggerCondition,
          playbook.requiredCapabilities,
          JSON.stringify(playbook.steps),
          playbook.successCount,
          playbook.failureCount,
          playbook.version,
          playbook.isApproved,
          JSON.stringify(playbook.metadata ?? {}),
          playbook.createdAt,
        ]
      );
    });
  }

  async getPlaybookById(id: string): Promise<ProceduralPlaybook | undefined> {
    return withSessionRls(this.pool, this.defaultContext, async (client) => {
      const res = await client.query(
        `SELECT id, tenant_id, scope, department_id as "departmentId", author_agent_id as "authorAgentId",
                author_agent_code as "authorAgentCode", authorized_by as "authorizedBy", name, description,
                trigger_condition as "triggerCondition", required_capabilities as "requiredCapabilities",
                steps, success_count as "successCount", failure_count as "failureCount", version,
                is_approved as "isApproved", metadata, created_at as "createdAt", updated_at as "updatedAt"
         FROM agent_procedural_memories WHERE id = $1`,
        [id]
      );
      if (res.rows.length === 0) return undefined;
      return this.mapRowToPlaybook(res.rows[0]);
    });
  }

  async queryPlaybooks(filter: ProceduralQueryFilter): Promise<ProceduralPlaybook[]> {
    return withSessionRls(this.pool, this.defaultContext, async (client) => {
      const conditions: string[] = ['1=1'];
      const params: unknown[] = [];
      let pIdx = 1;

      if (filter.departmentId) {
        conditions.push(`(department_id = $${pIdx++} OR scope = 'ORGANIZATION_WIDE')`);
        params.push(filter.departmentId);
      }
      if (filter.scope) {
        conditions.push(`scope = $${pIdx++}`);
        params.push(filter.scope);
      }
      if (filter.isApproved !== undefined) {
        conditions.push(`is_approved = $${pIdx++}`);
        params.push(filter.isApproved);
      }

      const limit = filter.limit ?? 50;
      const res = await client.query(
        `SELECT id, tenant_id, scope, department_id as "departmentId", author_agent_id as "authorAgentId",
                author_agent_code as "authorAgentCode", authorized_by as "authorizedBy", name, description,
                trigger_condition as "triggerCondition", required_capabilities as "requiredCapabilities",
                steps, success_count as "successCount", failure_count as "failureCount", version,
                is_approved as "isApproved", metadata, created_at as "createdAt", updated_at as "updatedAt"
         FROM agent_procedural_memories
         WHERE ${conditions.join(' AND ')}
         LIMIT ${limit}`,
        params
      );

      let items = res.rows.map((row) => this.mapRowToPlaybook(row));
      if (filter.requiredCapability) {
        items = items.filter((p) => p.requiredCapabilities.includes(filter.requiredCapability!));
      }
      return items;
    });
  }

  private mapRowToPlaybook(row: any): ProceduralPlaybook {
    return ProceduralPlaybookSchema.parse({
      ...row,
      authorAgentCode: row.authorAgentCode ?? undefined,
      departmentId: row.departmentId ?? undefined,
      createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
      updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : (row.updatedAt ? String(row.updatedAt) : undefined),
      steps: typeof row.steps === 'string' ? JSON.parse(row.steps) : (row.steps ?? []),
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata ?? {}),
    });
  }

  async updateExecutionStats(id: string, success: boolean): Promise<void> {
    await withSessionRls(this.pool, this.defaultContext, async (client) => {
      await client.query(
        `UPDATE agent_procedural_memories
         SET success_count = success_count + (CASE WHEN $1 = true THEN 1 ELSE 0 END),
             failure_count = failure_count + (CASE WHEN $1 = false THEN 1 ELSE 0 END),
             updated_at = clock_timestamp()
         WHERE id = $2`,
        [success, id]
      );
    });
  }

  async approvePlaybook(id: string, approvedBy: string): Promise<void> {
    await withSessionRls(this.pool, this.defaultContext, async (client) => {
      await client.query(
        `UPDATE agent_procedural_memories
         SET is_approved = true, authorized_by = $1, updated_at = clock_timestamp()
         WHERE id = $2`,
        [approvedBy, id]
      );
    });
  }
}
