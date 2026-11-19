import { randomUUID } from 'node:crypto';
import {
  type EpisodicMemoryRecord,
  type SemanticKnowledgeItem,
  type ProceduralPlaybook,
  type MemoryAccessPrincipal,
  type MemoryScope,
} from '@vme/shared-types';
import { SemanticMemory } from './semantic-memory.js';
import { ProceduralMemory } from './procedural-memory.js';
import { UnauthorizedMemoryAccessError } from './memory-access-controller.js';

export class InsufficientEvidenceConsolidationError extends Error {
  constructor(message: string) {
    super(`CONSOLIDATION REJECTED: ${message}`);
    this.name = 'InsufficientEvidenceConsolidationError';
  }
}

export interface ConsolidationEvidencePolicy {
  minSourceRecordCount: number;
  minAverageImportanceScore: number;
  minConfidenceScore: number;
}

export const DEFAULT_EVIDENCE_POLICY: ConsolidationEvidencePolicy = {
  minSourceRecordCount: 3,
  minAverageImportanceScore: 6.0,
  minConfidenceScore: 0.75,
};

export interface SemanticPromotionRequest {
  sourceRecordIds: string[];
  records: EpisodicMemoryRecord[];
  targetScope: MemoryScope;
  category: string;
  title: string;
  synthesizedContent: string;
  embedding: number[];
  tags: string[];
  provenance: string;
  evidenceSummary: string;
  confidenceScore: number;
  principal: MemoryAccessPrincipal;
  approvingPrincipal?: MemoryAccessPrincipal;
  policy?: Partial<ConsolidationEvidencePolicy>;
}

export interface ProceduralPromotionRequest {
  sourceRecordIds: string[];
  records: EpisodicMemoryRecord[];
  targetScope: MemoryScope;
  name: string;
  description: string;
  triggerCondition: string;
  requiredCapabilities: string[];
  steps: Array<{
    stepNumber: number;
    name: string;
    instruction: string;
    requiredCapability: string;
    toolName?: string;
    timeoutMs?: number;
    retryLimit?: number;
  }>;
  provenance: string;
  evidenceSummary: string;
  confidenceScore: number;
  principal: MemoryAccessPrincipal;
  approvingPrincipal?: MemoryAccessPrincipal;
  policy?: Partial<ConsolidationEvidencePolicy>;
}

export class MemoryConsolidator {
  constructor(
    private readonly semanticMemory: SemanticMemory,
    private readonly proceduralMemory: ProceduralMemory
  ) {}

  /**
   * Promotes episodic learnings into persistent Semantic Knowledge with evidence validation and governance authorization.
   */
  async promoteToSemanticKnowledge(
    request: SemanticPromotionRequest
  ): Promise<SemanticKnowledgeItem> {
    const { principal, targetScope, records } = request;
    const policy: ConsolidationEvidencePolicy = {
      ...DEFAULT_EVIDENCE_POLICY,
      ...request.policy,
    };

    // 1. Minimum Evidence Verification
    if (!records || records.length === 0) {
      throw new InsufficientEvidenceConsolidationError(
        'Consolidation requires at least one source episodic record.'
      );
    }

    const avgImportance =
      records.reduce((acc, r) => acc + (r.importanceScore ?? 5), 0) / records.length;

    // A single episode must not automatically become trusted knowledge unless it has extraordinary importance
    if (records.length < policy.minSourceRecordCount) {
      const hasCriticalSignal = records.some((r) => r.importanceScore >= 8);
      if (!hasCriticalSignal) {
        throw new InsufficientEvidenceConsolidationError(
          `Insufficient evidence: ${records.length} records provided, minimum required is ${policy.minSourceRecordCount} (or single critical record with importance >= 8).`
        );
      }
    }

    if (avgImportance < policy.minAverageImportanceScore) {
      throw new InsufficientEvidenceConsolidationError(
        `Average importance score (${avgImportance.toFixed(1)}) is below policy threshold (${policy.minAverageImportanceScore}).`
      );
    }

    if (request.confidenceScore < policy.minConfidenceScore) {
      throw new InsufficientEvidenceConsolidationError(
        `Consolidation confidence (${request.confidenceScore}) is below quality threshold (${policy.minConfidenceScore}).`
      );
    }

    // 2. Governance Authorization Check for Scope Elevation
    if (targetScope === 'ORGANIZATION_WIDE') {
      if (
        principal.principalType !== 'OWNER_PRINCIPAL' &&
        principal.level !== 'EXECUTIVE'
      ) {
        throw new UnauthorizedMemoryAccessError(
          `Consolidation into ORGANIZATION_WIDE semantic knowledge requires Executive Office or Owner authorization. Principal '${principal.principalId}' is '${principal.level}'.`
        );
      }
    } else if (targetScope === 'DEPARTMENT_SCOPED') {
      if (
        principal.principalType !== 'OWNER_PRINCIPAL' &&
        principal.level !== 'EXECUTIVE' &&
        principal.level !== 'DIRECTOR'
      ) {
        throw new UnauthorizedMemoryAccessError(
          `Consolidation into DEPARTMENT_SCOPED semantic knowledge requires Director or Executive authorization. Principal '${principal.principalId}' is '${principal.level}'.`
        );
      }
    }

    const now = new Date().toISOString();
    const approving = request.approvingPrincipal ?? principal;

    const newItem: SemanticKnowledgeItem = {
      id: randomUUID(),
      scope: targetScope,
      departmentId: records[0]?.departmentId,
      authorAgentId: principal.principalType === 'AGENT' ? principal.principalId : undefined,
      category: request.category,
      title: request.title,
      content: request.synthesizedContent,
      embedding: request.embedding,
      embeddingMetadata: {
        provider: 'openai',
        model: 'text-embedding-3-small',
        dimension: request.embedding.length,
        version: '1.0.0',
      },
      importanceScore: Math.min(10, Math.max(1, Math.round(avgImportance))),
      tags: request.tags,
      version: '1.0.0',
      isDeprecated: false,
      metadata: {
        sourceRecordCount: records.length,
        sourceRecordIds: request.sourceRecordIds,
        provenance: request.provenance,
        evidenceSummary: request.evidenceSummary,
        confidenceScore: request.confidenceScore,
        promotedAt: now,
        promotedBy: principal.principalId,
        approvingPrincipal: approving.principalId,
        versionHistory: ['1.0.0'],
      },
      createdAt: now,
    };

    await this.semanticMemory.storeKnowledge(newItem, principal);
    return newItem;
  }

  /**
   * Promotes repeated episodic procedures into a validated SOP Playbook.
   * Playbooks remain stored guidance until authorized.
   */
  async promoteToProceduralPlaybook(
    request: ProceduralPromotionRequest
  ): Promise<ProceduralPlaybook> {
    const { principal, targetScope, records } = request;
    const policy: ConsolidationEvidencePolicy = {
      ...DEFAULT_EVIDENCE_POLICY,
      ...request.policy,
    };

    if (!records || records.length === 0) {
      throw new InsufficientEvidenceConsolidationError(
        'Procedural promotion requires source episodic records.'
      );
    }

    if (records.length < policy.minSourceRecordCount) {
      const hasHighRelevance = records.some((r) => r.importanceScore >= 8);
      if (!hasHighRelevance) {
        throw new InsufficientEvidenceConsolidationError(
          `Insufficient procedural evidence: ${records.length} records provided, minimum required is ${policy.minSourceRecordCount}.`
        );
      }
    }

    if (targetScope === 'ORGANIZATION_WIDE') {
      if (
        principal.principalType !== 'OWNER_PRINCIPAL' &&
        principal.level !== 'EXECUTIVE'
      ) {
        throw new UnauthorizedMemoryAccessError(
          `Promoting playbooks to ORGANIZATION_WIDE requires Executive Office or Owner authorization.`
        );
      }
    } else if (targetScope === 'DEPARTMENT_SCOPED') {
      if (
        principal.principalType !== 'OWNER_PRINCIPAL' &&
        principal.level !== 'EXECUTIVE' &&
        principal.level !== 'DIRECTOR'
      ) {
        throw new UnauthorizedMemoryAccessError(
          `Promoting playbooks to DEPARTMENT_SCOPED requires Director or Executive authorization.`
        );
      }
    }

    const now = new Date().toISOString();
    const approving = request.approvingPrincipal ?? principal;
    const isLeadership =
      principal.principalType === 'OWNER_PRINCIPAL' ||
      principal.level === 'EXECUTIVE' ||
      principal.level === 'DIRECTOR';

    const playbook: ProceduralPlaybook = {
      id: randomUUID(),
      scope: targetScope,
      departmentId: records[0]?.departmentId,
      authorAgentId: principal.principalId,
      authorAgentCode: principal.agentCode,
      authorizedBy: isLeadership ? approving.principalId : 'PENDING_APPROVAL',
      name: request.name,
      description: request.description,
      triggerCondition: request.triggerCondition,
      requiredCapabilities: request.requiredCapabilities,
      steps: request.steps.map((s) => ({
        stepNumber: s.stepNumber,
        name: s.name,
        instruction: s.instruction,
        requiredCapability: s.requiredCapability,
        toolName: s.toolName,
        timeoutMs: s.timeoutMs ?? 30000,
        retryLimit: s.retryLimit ?? 2,
      })),
      successCount: records.filter((r) => r.status === 'SUCCESS').length,
      failureCount: records.filter((r) => r.status === 'FAILURE').length,
      version: '1.0.0',
      isApproved: isLeadership, // Only approved if author/approver is leadership; otherwise remains guidance
      metadata: {
        sourceRecordIds: request.sourceRecordIds,
        provenance: request.provenance,
        evidenceSummary: request.evidenceSummary,
        confidenceScore: request.confidenceScore,
        consolidatedAt: now,
        versionHistory: ['1.0.0'],
      },
      createdAt: now,
    };

    await this.proceduralMemory.storePlaybook(playbook, principal);
    return playbook;
  }
}
