import { describe, it, expect, beforeEach } from 'vitest';
import { newDb, DataType } from 'pg-mem';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { DepartmentRegistry } from '@vme/department-hierarchy';
import {
  PerformanceEventStore,
  KPICalculator,
  PerformanceReviewEngine,
} from './index.js';

describe('M2.6 Evidence-Based Performance Management & Persistence', () => {
  let pool: Pool;
  let hierarchy: DepartmentRegistry;
  let eventStore: PerformanceEventStore;
  let kpiCalculator: KPICalculator;
  let reviewEngine: PerformanceReviewEngine;
  const tenantId = '00000000-0000-0000-0000-000000000001';

  beforeEach(() => {
    process.env.DB_SESSION_SECRET = 'test-secret-with-at-least-32-chars-entropy-abc123';
    hierarchy = new DepartmentRegistry();

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

    db.public.none(`
      CREATE TABLE performance_events (
        id text PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id text NOT NULL,
        agent_id text NOT NULL,
        department_id text NOT NULL,
        task_id text NOT NULL,
        event_type text NOT NULL,
        duration_ms int NOT NULL,
        tokens_used int NOT NULL DEFAULT 0,
        cost_usd numeric(12, 6) NOT NULL DEFAULT 0,
        task_complexity numeric(4, 2) NOT NULL DEFAULT 1.0,
        quality_score numeric(4, 2) NOT NULL DEFAULT 1.0,
        is_successful boolean NOT NULL,
        recorded_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE agent_performance_reviews (
        id text PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id text NOT NULL,
        agent_id text NOT NULL,
        agent_code text NOT NULL,
        department_id text NOT NULL,
        evaluation_period text NOT NULL,
        tasks_assigned int NOT NULL,
        tasks_completed int NOT NULL,
        tasks_failed int NOT NULL,
        performance_score int NOT NULL,
        overall_rating text NOT NULL,
        strengths text[] NOT NULL DEFAULT '{}',
        areas_for_improvement text[] NOT NULL DEFAULT '{}',
        recommendations jsonb NOT NULL,
        reviewed_by text NOT NULL,
        reviewed_at timestamptz NOT NULL DEFAULT now()
      );
    `);

    const { Pool: PgPool } = db.adapters.createPg();
    pool = new PgPool() as unknown as Pool;

    eventStore = new PerformanceEventStore(pool, tenantId);
    kpiCalculator = new KPICalculator();
    reviewEngine = new PerformanceReviewEngine(hierarchy, kpiCalculator, eventStore);
  });

  describe('PerformanceEventStore & Real Event Tracking', () => {
    it('persists real performance events with complexity and quality scores in PostgreSQL', async () => {
      const agent = hierarchy.getAgentRecord('TECH-ARCH')!;
      const taskId = randomUUID();

      const event = await eventStore.recordEvent({
        agentId: agent.id,
        departmentId: agent.departmentId,
        taskId,
        eventType: 'CODE_SYNTHESIS_EXECUTION',
        durationMs: 1450,
        tokensUsed: 820,
        costUsd: 0.0164,
        taskComplexity: 2.5, // High complexity architecture task
        qualityScore: 0.95, // Verified 95% quality score
        isSuccessful: true,
      });

      expect(event.id).toBeDefined();
      expect(event.taskComplexity).toBe(2.5);
      expect(event.qualityScore).toBe(0.95);

      // Verify PostgreSQL database query
      const retrieved = await eventStore.getAgentEvents(agent.id);
      expect(retrieved).toHaveLength(1);
      expect(retrieved[0]?.taskId).toBe(taskId);
      expect(retrieved[0]?.taskComplexity).toBe(2.5);
      expect(retrieved[0]?.qualityScore).toBe(0.95);
      expect(retrieved[0]?.durationMs).toBe(1450);
    });

    it('factors task complexity and verified quality score into KPI calculation', () => {
      const agent = hierarchy.getAgentRecord('TECH-ARCH')!;

      // 1. Routine task (complexity 1.0, quality 1.0)
      kpiCalculator.recordMetric({
        agentId: agent.id,
        agentName: agent.displayName,
        departmentId: agent.departmentId,
        durationMs: 800,
        tokensUsed: 300,
        costUsd: 0.005,
        taskComplexity: 1.0,
        qualityScore: 1.0,
        isSuccessful: true,
      });

      // 2. High-complexity architectural task (complexity 3.0, quality 0.9)
      kpiCalculator.recordMetric({
        agentId: agent.id,
        agentName: agent.displayName,
        departmentId: agent.departmentId,
        durationMs: 1200,
        tokensUsed: 600,
        costUsd: 0.012,
        taskComplexity: 3.0,
        qualityScore: 0.9,
        isSuccessful: true,
      });

      const kpi = kpiCalculator.computeAgentKPI(agent.id, agent.displayName, agent.departmentId);

      expect(kpi.tasksAssigned).toBe(2);
      expect(kpi.tasksCompleted).toBe(2);
      expect(kpi.performanceScore).toBeGreaterThanOrEqual(85);
    });
  });

  describe('Strict Non-Mutation Invariant Enforcement', () => {
    it('generates performance reviews with recommendations without mutating the canonical agent record', async () => {
      const agentBefore = hierarchy.getAgentRecord('TECH-ARCH')!;
      const originalDept = agentBefore.departmentId;
      const originalLevel = agentBefore.level;
      const originalSupervisor = agentBefore.supervisor;
      const originalStatus = agentBefore.operationalStatus;

      // Record a series of failed events leading to a CRITICAL_CONCERN review
      for (let i = 0; i < 5; i++) {
        await eventStore.recordEvent({
          agentId: agentBefore.id,
          departmentId: agentBefore.departmentId,
          taskId: randomUUID(),
          eventType: 'STRESS_TEST_FAILURE',
          durationMs: 8000,
          tokensUsed: 4000,
          costUsd: 0.08,
          taskComplexity: 1.0,
          qualityScore: 0.0,
          isSuccessful: false,
        });
      }

      // Generate review through review engine
      const review = await reviewEngine.generateEvidenceBasedReviewAsync(
        agentBefore.id,
        '2026-Q4',
        'EXEC-CEO'
      );

      // Review should reflect critical concern and produce actionable recommendations only
      expect(review.overallRating).toBe('CRITICAL_CONCERN');
      expect(review.recommendations.length).toBeGreaterThan(0);
      expect(review.recommendations[0]?.type).toBe('TOOL_TRAINING');

      // CRITICAL INVARIANT: The agent in DepartmentRegistry MUST NOT be mutated!
      const agentAfter = hierarchy.getAgentRecord('TECH-ARCH')!;
      expect(agentAfter.departmentId).toBe(originalDept);
      expect(agentAfter.level).toBe(originalLevel);
      expect(agentAfter.supervisor).toBe(originalSupervisor);
      expect(agentAfter.operationalStatus).toBe(originalStatus);
      expect(agentAfter.id).toBe(agentBefore.id);

      // Verify review record was persisted to PostgreSQL table agent_performance_reviews
      const client = await pool.connect();
      try {
        const res = await client.query(
          `SELECT overall_rating, reviewed_by FROM agent_performance_reviews WHERE id = $1`,
          [review.id]
        );
        expect(res.rows).toHaveLength(1);
        expect(res.rows[0].overall_rating).toBe('CRITICAL_CONCERN');
        expect(res.rows[0].reviewed_by).toBe('EXEC-CEO');
      } finally {
        client.release();
      }
    });
  });
});
