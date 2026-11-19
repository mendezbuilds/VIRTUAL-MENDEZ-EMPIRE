import { randomUUID } from 'node:crypto';
import type { AgentKPI, DepartmentId } from '@vme/shared-types';
import type { KPICalculator } from './kpi-calculator.js';
import type { DepartmentRegistry } from '@vme/department-hierarchy';
import type { PerformanceEventStore } from './performance-event-store.js';

export type PerformanceRating =
  | 'EXCEEDS_EXPECTATIONS'
  | 'MEETS_EXPECTATIONS'
  | 'NEEDS_IMPROVEMENT'
  | 'CRITICAL_CONCERN';

export type ImprovementActionType =
  | 'PROMPT_TUNING'
  | 'WORKLOAD_REBALANCING'
  | 'TOOL_TRAINING'
  | 'SUPERVISOR_COACHING';

export interface PerformanceRecommendation {
  type: ImprovementActionType;
  description: string;
  suggestedPriority: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface PerformanceReviewRecord {
  id: string;
  agentId: string;
  agentCode: string;
  departmentId: DepartmentId;
  evaluationPeriod: string;
  kpiSummary: AgentKPI;
  overallRating: PerformanceRating;
  strengths: string[];
  areasForImprovement: string[];
  recommendations: PerformanceRecommendation[];
  reviewedBy: string;
  reviewedAt: string;
}

export class PerformanceReviewEngine {
  private reviews = new Map<string, PerformanceReviewRecord[]>(); // agentId -> reviews
  public readonly eventStore?: PerformanceEventStore;

  constructor(
    private readonly hierarchy: DepartmentRegistry,
    private readonly kpiCalculator: KPICalculator,
    eventStore?: PerformanceEventStore
  ) {
    this.eventStore = eventStore;
  }

  /**
   * Generates an evidence-based performance review for an agent.
   * Derives ratings directly from tracked execution metrics and KPIs.
   * AI evaluations produce recommendations only; they cannot perform unilateral agent terminations or transfers.
   */
  generateAgentReview(
    agentIdOrCode: string,
    evaluationPeriod: string,
    reviewedBy: string
  ): PerformanceReviewRecord {
    const agent = this.hierarchy.getAgentRecord(agentIdOrCode);
    if (!agent) {
      throw new Error(`Agent '${agentIdOrCode}' not found in corporate hierarchy.`);
    }

    const kpi = this.kpiCalculator.computeAgentKPI(agent.id, agent.displayName, agent.departmentId);

    let overallRating: PerformanceRating;
    const strengths: string[] = [];
    const areasForImprovement: string[] = [];
    const recommendations: PerformanceRecommendation[] = [];

    if (kpi.performanceScore >= 85) {
      overallRating = 'EXCEEDS_EXPECTATIONS';
      strengths.push('High execution reliability and consistency');
      strengths.push('Optimal token consumption and cost efficiency');
      recommendations.push({
        type: 'TOOL_TRAINING',
        description: 'Explore advanced capability authorization and procedural pattern consolidation.',
        suggestedPriority: 'LOW',
      });
    } else if (kpi.performanceScore >= 70) {
      overallRating = 'MEETS_EXPECTATIONS';
      strengths.push('Solid task completion rates');
      areasForImprovement.push('Opportunities to reduce cycle latency and token waste');
      recommendations.push({
        type: 'PROMPT_TUNING',
        description: 'Refine system prompt instructions to reduce response verbosity.',
        suggestedPriority: 'LOW',
      });
    } else if (kpi.performanceScore >= 50) {
      overallRating = 'NEEDS_IMPROVEMENT';
      areasForImprovement.push('Elevated failure rate or significant execution latency');
      recommendations.push({
        type: 'WORKLOAD_REBALANCING',
        description: 'Temporarily reduce parallel task load and rebalance routine queue.',
        suggestedPriority: 'MEDIUM',
      });
      recommendations.push({
        type: 'SUPERVISOR_COACHING',
        description: 'Direct supervisor oversight for task decomposition validation.',
        suggestedPriority: 'HIGH',
      });
    } else {
      overallRating = 'CRITICAL_CONCERN';
      areasForImprovement.push('Unacceptable task failure rate (>50%) or severe timeouts');
      recommendations.push({
        type: 'TOOL_TRAINING',
        description: 'Verify tool configurations, API connectivity, and sandbox permissions.',
        suggestedPriority: 'HIGH',
      });
      recommendations.push({
        type: 'WORKLOAD_REBALANCING',
        description: 'Route critical tasks away from agent until root-cause resolution.',
        suggestedPriority: 'HIGH',
      });
    }

    const review: PerformanceReviewRecord = {
      id: randomUUID(),
      agentId: agent.id,
      agentCode: agent.agentCode,
      departmentId: agent.departmentId,
      evaluationPeriod,
      kpiSummary: kpi,
      overallRating,
      strengths,
      areasForImprovement,
      recommendations,
      reviewedBy,
      reviewedAt: new Date().toISOString(),
    };

    let agentReviews = this.reviews.get(agent.id);
    if (!agentReviews) {
      agentReviews = [];
      this.reviews.set(agent.id, agentReviews);
    }
    agentReviews.push(review);

    if (this.eventStore) {
      this.eventStore.persistReview(review).catch(() => {});
    }

    return review;
  }

  async generateEvidenceBasedReviewAsync(
    agentIdOrCode: string,
    evaluationPeriod: string,
    reviewedBy: string
  ): Promise<PerformanceReviewRecord> {
    const agent = this.hierarchy.getAgentRecord(agentIdOrCode);
    if (!agent) {
      throw new Error(`Agent '${agentIdOrCode}' not found in corporate hierarchy.`);
    }

    let kpi: AgentKPI;
    if (this.eventStore) {
      const events = await this.eventStore.getAgentEvents(agent.id);
      if (events.length > 0) {
        kpi = this.kpiCalculator.computeAgentKPIFromEvents(
          agent.id,
          agent.displayName,
          agent.departmentId,
          events
        );
      } else {
        kpi = this.kpiCalculator.computeAgentKPI(agent.id, agent.displayName, agent.departmentId);
      }
    } else {
      kpi = this.kpiCalculator.computeAgentKPI(agent.id, agent.displayName, agent.departmentId);
    }

    let overallRating: PerformanceRating;
    const strengths: string[] = [];
    const areasForImprovement: string[] = [];
    const recommendations: PerformanceRecommendation[] = [];

    if (kpi.performanceScore >= 85) {
      overallRating = 'EXCEEDS_EXPECTATIONS';
      strengths.push('High execution reliability and consistency');
      strengths.push('Optimal token consumption and cost efficiency');
      recommendations.push({
        type: 'TOOL_TRAINING',
        description: 'Explore advanced capability authorization and procedural pattern consolidation.',
        suggestedPriority: 'LOW',
      });
    } else if (kpi.performanceScore >= 70) {
      overallRating = 'MEETS_EXPECTATIONS';
      strengths.push('Solid task completion rates');
      areasForImprovement.push('Opportunities to reduce cycle latency and token waste');
      recommendations.push({
        type: 'PROMPT_TUNING',
        description: 'Refine system prompt instructions to reduce response verbosity.',
        suggestedPriority: 'LOW',
      });
    } else if (kpi.performanceScore >= 50) {
      overallRating = 'NEEDS_IMPROVEMENT';
      areasForImprovement.push('Elevated failure rate or significant execution latency');
      recommendations.push({
        type: 'WORKLOAD_REBALANCING',
        description: 'Temporarily reduce parallel task load and rebalance routine queue.',
        suggestedPriority: 'MEDIUM',
      });
      recommendations.push({
        type: 'SUPERVISOR_COACHING',
        description: 'Direct supervisor oversight for task decomposition validation.',
        suggestedPriority: 'HIGH',
      });
    } else {
      overallRating = 'CRITICAL_CONCERN';
      areasForImprovement.push('Unacceptable task failure rate (>50%) or severe timeouts');
      recommendations.push({
        type: 'TOOL_TRAINING',
        description: 'Verify tool configurations, API connectivity, and sandbox permissions.',
        suggestedPriority: 'HIGH',
      });
      recommendations.push({
        type: 'WORKLOAD_REBALANCING',
        description: 'Route critical tasks away from agent until root-cause resolution.',
        suggestedPriority: 'HIGH',
      });
    }

    const review: PerformanceReviewRecord = {
      id: randomUUID(),
      agentId: agent.id,
      agentCode: agent.agentCode,
      departmentId: agent.departmentId,
      evaluationPeriod,
      kpiSummary: kpi,
      overallRating,
      strengths,
      areasForImprovement,
      recommendations,
      reviewedBy,
      reviewedAt: new Date().toISOString(),
    };

    let agentReviews = this.reviews.get(agent.id);
    if (!agentReviews) {
      agentReviews = [];
      this.reviews.set(agent.id, agentReviews);
    }
    agentReviews.push(review);

    if (this.eventStore) {
      await this.eventStore.persistReview(review);
    }

    return review;
  }

  getAgentReviews(agentId: string): PerformanceReviewRecord[] {
    return this.reviews.get(agentId) ?? [];
  }
}
