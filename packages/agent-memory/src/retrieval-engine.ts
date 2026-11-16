import {
  type EpisodicMemoryRecord,
  type SemanticKnowledgeItem,
  type ProceduralPlaybook,
  type MemoryAccessPrincipal,
  type EmbeddingMetadata,
  type DepartmentId,
} from '@vme/shared-types';
import { EpisodicMemory } from './episodic-memory.js';
import { SemanticMemory, computeCosineSimilarity } from './semantic-memory.js';
import { ProceduralMemory } from './procedural-memory.js';
import { WorkingMemory } from './working-memory.js';

export interface ContextRetrievalRequest {
  queryText?: string;
  queryVector?: number[];
  queryMetadata?: EmbeddingMetadata;
  taskId?: string;
  agentId: string;
  departmentId?: DepartmentId;
  principal: MemoryAccessPrincipal;
  maxTokens?: number;
  semanticWeight?: number;
  recencyWeight?: number;
  importanceWeight?: number;
  scopeWeight?: number;
}

export interface ScoredContextItem<T> {
  item: T;
  type: 'WORKING' | 'EPISODIC' | 'SEMANTIC' | 'PROCEDURAL';
  compositeScore: number;
  estimatedTokens: number;
}

export interface RetrievedContextBundle {
  workingMemory: Record<string, unknown>;
  episodicRecords: EpisodicMemoryRecord[];
  semanticKnowledge: SemanticKnowledgeItem[];
  proceduralPlaybooks: ProceduralPlaybook[];
  totalTokensEstimated: number;
}

export function estimateTokenCount(textOrObj: unknown): number {
  if (typeof textOrObj === 'string') {
    return Math.max(1, Math.ceil(textOrObj.length / 4));
  }
  const json = JSON.stringify(textOrObj);
  return Math.max(1, Math.ceil(json.length / 4));
}

export function calculateRecencyScore(isoDate: string, halfLifeDays = 14): number {
  const itemTime = new Date(isoDate).getTime();
  const now = Date.now();
  const diffDays = Math.max(0, (now - itemTime) / (1000 * 60 * 60 * 24));
  return Math.exp(-diffDays / halfLifeDays);
}

export function calculateScopeRelevance(
  scope: string,
  principalDepartment?: string,
  itemDepartment?: string
): number {
  if (scope === 'AGENT_PRIVATE') return 1.0;
  if (scope === 'DEPARTMENT_SCOPED') {
    return principalDepartment && itemDepartment && principalDepartment === itemDepartment
      ? 0.85
      : 0.65;
  }
  return 0.55; // ORGANIZATION_WIDE
}

export class MemoryContextRetriever {
  constructor(
    private readonly workingMemory: WorkingMemory,
    private readonly episodicMemory: EpisodicMemory,
    private readonly semanticMemory: SemanticMemory,
    private readonly proceduralMemory: ProceduralMemory
  ) {}

  async retrieveContext(request: ContextRetrievalRequest): Promise<RetrievedContextBundle> {
    const maxTokens = request.maxTokens ?? 2048;
    const wSemantic = request.semanticWeight ?? 0.5;
    const wRecency = request.recencyWeight ?? 0.2;
    const wImportance = request.importanceWeight ?? 0.15;
    const wScope = request.scopeWeight ?? 0.15;
    const totalWeight = wSemantic + wRecency + wImportance + wScope;

    const normalizedSemantic = wSemantic / totalWeight;
    const normalizedRecency = wRecency / totalWeight;
    const normalizedImportance = wImportance / totalWeight;
    const normalizedScope = wScope / totalWeight;

    // 1. Working memory scratchpad for active task
    const workingData = request.taskId ? this.workingMemory.getAll(request.taskId) : {};
    let usedTokens = estimateTokenCount(workingData);

    const scoredItems: ScoredContextItem<unknown>[] = [];

    // 2. Episodic memory retrieval
    const recentEpisodes = await this.episodicMemory.getRecentContext(
      {
        agentId: request.agentId,
        departmentId: request.departmentId,
        limit: 20,
      },
      request.principal
    );

    for (const ep of recentEpisodes) {
      const recency = calculateRecencyScore(ep.recordedAt);
      const importance = (ep.importanceScore ?? 5) / 10;
      const scopeScore = calculateScopeRelevance(ep.scope, request.departmentId, ep.departmentId);
      // Episodic semantic similarity (if queryVector available and embedding exists in metadata)
      const semanticSim = 0.5; // Baseline similarity for relevant episodic action logs

      const compositeScore =
        normalizedSemantic * semanticSim +
        normalizedRecency * recency +
        normalizedImportance * importance +
        normalizedScope * scopeScore;

      const tokens = estimateTokenCount(ep);
      scoredItems.push({
        item: ep,
        type: 'EPISODIC',
        compositeScore,
        estimatedTokens: tokens,
      });
    }

    // 3. Semantic memory search
    if (request.queryVector && request.queryVector.length > 0) {
      const semanticResults = await this.semanticMemory.searchKnowledge(
        request.queryVector,
        request.queryMetadata,
        {
          limit: 15,
          minSimilarity: 0.3,
          filter: {
            departmentId: request.departmentId,
          },
        },
        request.principal
      );

      for (const res of semanticResults) {
        const item = res.item;
        const cosine = res.similarity;
        const recency = calculateRecencyScore(item.createdAt);
        const importance = (item.importanceScore ?? 5) / 10;
        const scopeScore = calculateScopeRelevance(item.scope, request.departmentId, item.departmentId);

        const compositeScore =
          normalizedSemantic * cosine +
          normalizedRecency * recency +
          normalizedImportance * importance +
          normalizedScope * scopeScore;

        const tokens = estimateTokenCount(item);
        scoredItems.push({
          item,
          type: 'SEMANTIC',
          compositeScore,
          estimatedTokens: tokens,
        });
      }
    }

    // 4. Procedural memory playbooks
    const playbooks = await this.proceduralMemory.queryPlaybooks(
      {
        departmentId: request.departmentId,
        isApproved: true,
        limit: 10,
      },
      request.principal
    );

    for (const pb of playbooks) {
      const recency = calculateRecencyScore(pb.createdAt);
      const totalRuns = pb.successCount + pb.failureCount;
      const successRate = totalRuns > 0 ? pb.successCount / totalRuns : 0.8;
      const importance = Math.min(1.0, successRate);
      const scopeScore = calculateScopeRelevance(pb.scope, request.departmentId, pb.departmentId);
      const semanticSim = 0.6; // High procedural prior

      const compositeScore =
        normalizedSemantic * semanticSim +
        normalizedRecency * recency +
        normalizedImportance * importance +
        normalizedScope * scopeScore;

      const tokens = estimateTokenCount(pb);
      scoredItems.push({
        item: pb,
        type: 'PROCEDURAL',
        compositeScore,
        estimatedTokens: tokens,
      });
    }

    // 5. Deduplicate and sort descending by compositeScore
    const sorted = scoredItems.sort((a, b) => b.compositeScore - a.compositeScore);

    const episodicRecords: EpisodicMemoryRecord[] = [];
    const semanticKnowledge: SemanticKnowledgeItem[] = [];
    const proceduralPlaybooks: ProceduralPlaybook[] = [];

    const seenIds = new Set<string>();

    for (const scored of sorted) {
      const id = (scored.item as { id?: string }).id;
      if (id) {
        if (seenIds.has(id)) continue;
        seenIds.add(id);
      }

      if (usedTokens + scored.estimatedTokens > maxTokens) {
        continue; // Greedy packing
      }

      usedTokens += scored.estimatedTokens;

      if (scored.type === 'EPISODIC') {
        episodicRecords.push(scored.item as EpisodicMemoryRecord);
      } else if (scored.type === 'SEMANTIC') {
        semanticKnowledge.push(scored.item as SemanticKnowledgeItem);
      } else if (scored.type === 'PROCEDURAL') {
        proceduralPlaybooks.push(scored.item as ProceduralPlaybook);
      }
    }

    return {
      workingMemory: workingData,
      episodicRecords,
      semanticKnowledge,
      proceduralPlaybooks,
      totalTokensEstimated: usedTokens,
    };
  }
}
