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

export interface SemanticPromotionRequest {
  sourceRecordIds: string[];
  records: EpisodicMemoryRecord[];
  targetScope: MemoryScope;
  category: string;
  title: string;
  synthesizedContent: string;
  embedding: number[];
  tags: string[];
  principal: MemoryAccessPrincipal;
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
  principal: MemoryAccessPrincipal;
}

export class MemoryConsolidator {
  constructor(
    private readonly semanticMemory: SemanticMemory,
    private readonly proceduralMemory: ProceduralMemory
  ) {}

  /**
   * Promotes episodic learnings into persistent Semantic Knowledge with governance authorization checks.
   */
  async promoteToSemanticKnowledge(
    request: SemanticPromotionRequest
  ): Promise<SemanticKnowledgeItem> {
    const { principal, targetScope, records } = request;

    // Minimum evidence validation
    if (!records || records.length === 0) {
      throw new Error('Consolidation requires at least one source episodic record.');
    }

    // Governance checks for scope escalation
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

    const avgImportance =
      records.reduce((acc, r) => acc + (r.importanceScore ?? 5), 0) / records.length;

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
        provider: 'mock',
        model: 'mock-embedding-v1',
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
        consolidatedAt: new Date().toISOString(),
      },
      createdAt: new Date().toISOString(),
    };

    await this.semanticMemory.storeKnowledge(newItem, principal);
    return newItem;
  }

  /**
   * Promotes repeated episodic procedures into a validated SOP Playbook.
   */
  async promoteToProceduralPlaybook(
    request: ProceduralPromotionRequest
  ): Promise<ProceduralPlaybook> {
    const { principal, targetScope, records } = request;

    if (!records || records.length === 0) {
      throw new Error('Procedural promotion requires source episodic records.');
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

    const playbook: ProceduralPlaybook = {
      id: randomUUID(),
      scope: targetScope,
      departmentId: records[0]?.departmentId,
      authorAgentId: principal.principalId,
      authorAgentCode: principal.agentCode,
      authorizedBy: principal.principalId,
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
      isApproved: true,
      metadata: {
        sourceRecordIds: request.sourceRecordIds,
        consolidatedAt: new Date().toISOString(),
      },
      createdAt: new Date().toISOString(),
    };

    await this.proceduralMemory.storePlaybook(playbook, principal);
    return playbook;
  }
}
