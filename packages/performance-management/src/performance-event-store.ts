import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { applyAuthenticatedSession, clearAuthenticatedSession, type AuthoritativeWorkforceIdentityProvider } from '@vme/agent-memory';
import { DepartmentRegistry } from '@vme/department-hierarchy';
import type { DepartmentId } from '@vme/shared-types';
import type { PerformanceReviewRecord } from './performance-review-engine.js';

export interface PerformanceEvent {
  id?: string;
  tenantId?: string;
  agentId: string;
  departmentId: DepartmentId;
  taskId: string;
  eventType: string;
  durationMs: number;
  tokensUsed: number;
  costUsd: number;
  taskComplexity?: number;
  qualityScore?: number;
  isSuccessful: boolean;
  recordedAt?: string;
}

export class PerformanceEventStore {
  private inMemoryEvents: PerformanceEvent[] = [];
  private inMemoryReviews = new Map<string, PerformanceReviewRecord[]>();
  private readonly departmentRegistry: DepartmentRegistry | AuthoritativeWorkforceIdentityProvider;

  constructor(
    private readonly pool?: Pool,
    private readonly tenantId: string = '00000000-0000-0000-0000-000000000001',
    departmentRegistry?: DepartmentRegistry | AuthoritativeWorkforceIdentityProvider
  ) {
    this.departmentRegistry = departmentRegistry ?? new DepartmentRegistry();
  }

  async recordEvent(event: PerformanceEvent): Promise<PerformanceEvent> {
    const id = event.id ?? randomUUID();
    const recordedAt = event.recordedAt ?? new Date().toISOString();
    const complexity = event.taskComplexity ?? 1.0;
    const quality = event.qualityScore ?? (event.isSuccessful ? 1.0 : 0.0);

    const enrichedEvent: PerformanceEvent = {
      ...event,
      id,
      tenantId: this.tenantId,
      taskComplexity: complexity,
      qualityScore: quality,
      recordedAt,
    };

    this.inMemoryEvents.push(enrichedEvent);

    if (this.pool) {
      const client = await this.pool.connect();
      try {
        await applyAuthenticatedSession(
          client,
          {
            tenantId: this.tenantId,
            agentId: enrichedEvent.agentId,
            departmentId: enrichedEvent.departmentId,
            principalLevel: 'SPECIALIST',
          },
          undefined,
          this.departmentRegistry
        );

        await client.query(
          `INSERT INTO performance_events (
            id, tenant_id, agent_id, department_id, task_id, event_type,
            duration_ms, tokens_used, cost_usd, task_complexity, quality_score,
            is_successful, recorded_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            enrichedEvent.id,
            this.tenantId,
            enrichedEvent.agentId,
            enrichedEvent.departmentId,
            enrichedEvent.taskId,
            enrichedEvent.eventType,
            enrichedEvent.durationMs,
            enrichedEvent.tokensUsed,
            enrichedEvent.costUsd,
            enrichedEvent.taskComplexity,
            enrichedEvent.qualityScore,
            enrichedEvent.isSuccessful,
            enrichedEvent.recordedAt,
          ]
        );
      } finally {
        await clearAuthenticatedSession(client);
        client.release();
      }
    }

    return enrichedEvent;
  }

  async getAgentEvents(
    agentId: string,
    since?: string,
    until?: string
  ): Promise<PerformanceEvent[]> {
    if (this.pool) {
      const client = await this.pool.connect();
      try {
        await applyAuthenticatedSession(
          client,
          {
            tenantId: this.tenantId,
            agentId,
            principalLevel: 'SPECIALIST',
          },
          undefined,
          this.departmentRegistry
        );

        const conditions = ['agent_id = $1', 'tenant_id = $2'];
        const params: unknown[] = [agentId, this.tenantId];
        let pIdx = 3;

        if (since) {
          conditions.push(`recorded_at >= $${pIdx++}`);
          params.push(since);
        }
        if (until) {
          conditions.push(`recorded_at <= $${pIdx++}`);
          params.push(until);
        }

        const res = await client.query(
          `SELECT id, tenant_id as "tenantId", agent_id as "agentId", department_id as "departmentId",
                  task_id as "taskId", event_type as "eventType", duration_ms as "durationMs",
                  tokens_used as "tokensUsed", cost_usd as "costUsd", task_complexity as "taskComplexity",
                  quality_score as "qualityScore", is_successful as "isSuccessful", recorded_at as "recordedAt"
           FROM performance_events
           WHERE ${conditions.join(' AND ')}
           ORDER BY recorded_at DESC`,
          params
        );
        return res.rows.map((row) => ({
          ...row,
          durationMs: Number(row.durationMs),
          tokensUsed: Number(row.tokensUsed),
          costUsd: Number(row.costUsd),
          taskComplexity: Number(row.taskComplexity),
          qualityScore: Number(row.qualityScore),
          isSuccessful: Boolean(row.isSuccessful),
          recordedAt: row.recordedAt instanceof Date ? row.recordedAt.toISOString() : String(row.recordedAt),
        }));
      } finally {
        await clearAuthenticatedSession(client);
        client.release();
      }
    }

    return this.inMemoryEvents.filter((e) => {
      if (e.agentId !== agentId) return false;
      if (since && e.recordedAt && e.recordedAt < since) return false;
      if (until && e.recordedAt && e.recordedAt > until) return false;
      return true;
    });
  }

  async persistReview(review: PerformanceReviewRecord): Promise<void> {
    let list = this.inMemoryReviews.get(review.agentId);
    if (!list) {
      list = [];
      this.inMemoryReviews.set(review.agentId, list);
    }
    list.push(review);

    if (this.pool) {
      const client = await this.pool.connect();
      try {
        await applyAuthenticatedSession(
          client,
          {
            tenantId: this.tenantId,
            agentCode: 'EXEC-CEO',
            principalLevel: 'EXECUTIVE',
          },
          undefined,
          this.departmentRegistry
        );

        await client.query(
          `INSERT INTO agent_performance_reviews (
            id, tenant_id, agent_id, agent_code, department_id, evaluation_period,
            tasks_assigned, tasks_completed, tasks_failed, performance_score,
            overall_rating, strengths, areas_for_improvement, recommendations,
            reviewed_by, reviewed_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
          ON CONFLICT (id) DO NOTHING`,
          [
            review.id,
            this.tenantId,
            review.agentId,
            review.agentCode,
            review.departmentId,
            review.evaluationPeriod,
            review.kpiSummary.tasksAssigned,
            review.kpiSummary.tasksCompleted,
            review.kpiSummary.tasksFailed,
            review.kpiSummary.performanceScore,
            review.overallRating,
            review.strengths,
            review.areasForImprovement,
            JSON.stringify(review.recommendations),
            review.reviewedBy,
            review.reviewedAt,
          ]
        );
      } finally {
        await clearAuthenticatedSession(client);
        client.release();
      }
    }
  }

  getReviews(agentId: string): PerformanceReviewRecord[] {
    return this.inMemoryReviews.get(agentId) ?? [];
  }
}
