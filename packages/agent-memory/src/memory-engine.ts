import type { Pool } from 'pg';
import {
  type EpisodicMemoryRecord,
  type SemanticKnowledgeItem,
  type ProceduralPlaybook,
  type MemoryAccessPrincipal,
  type EmbeddingMetadata,
  type DepartmentId,
} from '@vme/shared-types';
import type { EmergencySupervisor } from '@vme/security-governance';
import { WorkingMemory } from './working-memory.js';
import { EpisodicMemory, InMemoryEpisodicStorage, type EpisodicMemoryFilter } from './episodic-memory.js';
import {
  SemanticMemory,
  InMemorySemanticStorage,
  type SemanticSearchFilter,
  type SemanticSearchResult,
} from './semantic-memory.js';
import {
  ProceduralMemory,
  InMemoryProceduralStorage,
  type ProceduralQueryFilter,
} from './procedural-memory.js';
import {
  MemoryContextRetriever,
  type ContextRetrievalRequest,
  type RetrievedContextBundle,
} from './retrieval-engine.js';
import {
  MemoryConsolidator,
  type SemanticPromotionRequest,
  type ProceduralPromotionRequest,
} from './consolidation-pipeline.js';
import {
  PostgresWorkingStorage,
  PostgresEpisodicStorage,
  PostgresSemanticStorage,
  PostgresProceduralStorage,
  PostgresStorageError,
  type RlsSessionContext,
} from './postgres-memory-storage.js';

export type MemoryEngineMode = 'PRODUCTION_POSTGRES' | 'TEST_IN_MEMORY';

export interface AgentMemoryEngineOptions {
  mode?: MemoryEngineMode;
  pool?: Pool;
  defaultTenantId?: string;
  workingMemory?: WorkingMemory;
  episodicMemory?: EpisodicMemory;
  semanticMemory?: SemanticMemory;
  proceduralMemory?: ProceduralMemory;
  emergencySupervisor?: EmergencySupervisor;
}

/**
 * Production-Grade Agent Memory Engine.
 * Supports real PostgreSQL-backed persistent storage with database-level RLS,
 * centralized ABAC access control, credential defense, and emergency halt freezing.
 * Does not silently fall back to in-memory when production PostgreSQL mode is configured.
 */
export class AgentMemoryEngine {
  public readonly mode: MemoryEngineMode;
  public readonly working: WorkingMemory;
  public readonly episodic: EpisodicMemory;
  public readonly semantic: SemanticMemory;
  public readonly procedural: ProceduralMemory;
  public readonly retriever: MemoryContextRetriever;
  public readonly consolidator: MemoryConsolidator;
  public readonly emergencySupervisor?: EmergencySupervisor;

  constructor(options?: AgentMemoryEngineOptions) {
    this.mode = options?.mode ?? (options?.pool ? 'PRODUCTION_POSTGRES' : 'TEST_IN_MEMORY');
    this.emergencySupervisor = options?.emergencySupervisor;

    if (this.mode === 'PRODUCTION_POSTGRES') {
      if (!options?.pool) {
        throw new PostgresStorageError(
          'Production memory engine initialization failed: PostgreSQL connection pool is required. In-memory fallback is disabled in production.'
        );
      }
      const pool = options.pool;
      const tenantId = options.defaultTenantId ?? '00000000-0000-0000-0000-000000000001';
      // Secure least-privilege default RlsSessionContext for standard agent operations (never defaults to OWNER)
      const rlsContext: RlsSessionContext = {
        tenantId,
        principalLevel: 'SPECIALIST',
        isOwnerAuthenticated: false,
      };

      const workingStorage = new PostgresWorkingStorage(pool, rlsContext);
      this.working = options.workingMemory ?? new WorkingMemory({ storage: workingStorage });
      this.episodic =
        options.episodicMemory ?? new EpisodicMemory(new PostgresEpisodicStorage(pool, rlsContext));
      this.semantic =
        options.semanticMemory ?? new SemanticMemory(new PostgresSemanticStorage(pool, rlsContext));
      this.procedural =
        options.proceduralMemory ?? new ProceduralMemory(new PostgresProceduralStorage(pool, rlsContext));
    } else {
      // Explicit test double mode
      this.working = options?.workingMemory ?? new WorkingMemory();
      this.episodic =
        options?.episodicMemory ?? new EpisodicMemory(new InMemoryEpisodicStorage());
      this.semantic =
        options?.semanticMemory ?? new SemanticMemory(new InMemorySemanticStorage());
      this.procedural =
        options?.proceduralMemory ?? new ProceduralMemory(new InMemoryProceduralStorage());
    }

    this.retriever = new MemoryContextRetriever(
      this.working,
      this.episodic,
      this.semantic,
      this.procedural
    );

    this.consolidator = new MemoryConsolidator(this.semantic, this.procedural);
  }

  private assertNotHalted(): void {
    if (this.emergencySupervisor) {
      this.emergencySupervisor.assertOperational();
    }
  }

  // --- MUTATION METHODS (SUBJECT TO EMERGENCY HALT) ---

  setWorkingMemory(taskId: string, key: string, value: unknown, ttlSeconds?: number): void {
    this.assertNotHalted();
    this.working.set(taskId, key, value, ttlSeconds);
  }

  clearWorkingMemory(taskId: string): void {
    this.assertNotHalted();
    this.working.clear(taskId);
  }

  async recordEpisode(
    record: EpisodicMemoryRecord,
    principal?: MemoryAccessPrincipal
  ): Promise<void> {
    this.assertNotHalted();
    await this.episodic.recordExecution(record, principal);
  }

  async storeKnowledge(
    item: SemanticKnowledgeItem,
    principal?: MemoryAccessPrincipal
  ): Promise<void> {
    this.assertNotHalted();
    await this.semantic.storeKnowledge(item, principal);
  }

  async storePlaybook(
    playbook: ProceduralPlaybook,
    principal?: MemoryAccessPrincipal
  ): Promise<void> {
    this.assertNotHalted();
    await this.procedural.storePlaybook(playbook, principal);
  }

  async approvePlaybook(
    playbookId: string,
    principal: MemoryAccessPrincipal
  ): Promise<void> {
    this.assertNotHalted();
    await this.procedural.approvePlaybook(playbookId, principal);
  }

  async recordPlaybookExecution(playbookId: string, success: boolean): Promise<void> {
    this.assertNotHalted();
    await this.procedural.recordExecutionOutcome(playbookId, success);
  }

  async promoteToSemantic(request: SemanticPromotionRequest): Promise<SemanticKnowledgeItem> {
    this.assertNotHalted();
    return this.consolidator.promoteToSemanticKnowledge(request);
  }

  async promoteToPlaybook(request: ProceduralPromotionRequest): Promise<ProceduralPlaybook> {
    this.assertNotHalted();
    return this.consolidator.promoteToProceduralPlaybook(request);
  }

  async archiveEpisodicOlderThan(
    cutoffIsoDate: string,
    principal?: MemoryAccessPrincipal
  ): Promise<number> {
    this.assertNotHalted();
    return this.episodic.archiveOlderThan(cutoffIsoDate, principal);
  }

  async deleteEpisodicRecords(
    filter: EpisodicMemoryFilter,
    principal: MemoryAccessPrincipal
  ): Promise<number> {
    this.assertNotHalted();
    return this.episodic.deleteRecords(filter, principal);
  }

  // --- QUERY & RETRIEVAL METHODS (OPERATIONAL EVEN DURING HALT) ---

  getWorkingMemory<T>(taskId: string, key: string): T | undefined {
    return this.working.get<T>(taskId, key);
  }

  getAllWorkingMemory(taskId: string): Record<string, unknown> {
    return this.working.getAll(taskId);
  }

  async getRecentEpisodes(
    filter: EpisodicMemoryFilter,
    principal?: MemoryAccessPrincipal
  ): Promise<EpisodicMemoryRecord[]> {
    return this.episodic.getRecentContext(filter, principal);
  }

  async searchKnowledge(
    queryVector: number[],
    queryMetadata?: EmbeddingMetadata,
    options?: {
      limit?: number;
      minSimilarity?: number;
      filter?: SemanticSearchFilter;
    },
    principal?: MemoryAccessPrincipal
  ): Promise<SemanticSearchResult[]> {
    return this.semantic.searchKnowledge(queryVector, queryMetadata, options, principal);
  }

  async getPlaybook(
    id: string,
    principal?: MemoryAccessPrincipal
  ): Promise<ProceduralPlaybook | undefined> {
    return this.procedural.getPlaybook(id, principal);
  }

  async queryPlaybooks(
    filter: ProceduralQueryFilter,
    principal?: MemoryAccessPrincipal
  ): Promise<ProceduralPlaybook[]> {
    return this.procedural.queryPlaybooks(filter, principal);
  }

  async retrieveContext(request: ContextRetrievalRequest): Promise<RetrievedContextBundle> {
    return this.retriever.retrieveContext(request);
  }
}
