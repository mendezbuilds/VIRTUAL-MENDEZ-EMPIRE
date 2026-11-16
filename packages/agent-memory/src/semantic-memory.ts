import {
  type SemanticKnowledgeItem,
  type EmbeddingMetadata,
  type MemoryScope,
  type DepartmentId,
  type MemoryAccessPrincipal,
  SemanticKnowledgeItemSchema,
} from '@vme/shared-types';
import { SecretRedactor } from './secret-redactor.js';
import { MemoryAccessController } from './memory-access-controller.js';

export class IncompatibleEmbeddingError extends Error {
  constructor(message: string) {
    super(`EMBEDDING COMPATIBILITY ERROR: ${message}`);
    this.name = 'IncompatibleEmbeddingError';
  }
}

export interface SemanticSearchResult {
  item: SemanticKnowledgeItem;
  similarity: number;
}

export interface SemanticSearchFilter {
  category?: string;
  departmentId?: DepartmentId;
  scope?: MemoryScope;
  includeDeprecated?: boolean;
  tags?: string[];
}

export function computeCosineSimilarity(vecA: number[], vecB: number[]): number {
  if (vecA.length !== vecB.length || vecA.length === 0) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i++) {
    const a = vecA[i]!;
    const b = vecB[i]!;
    dotProduct += a * b;
    normA += a * a;
    normB += b * b;
  }

  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function assertEmbeddingCompatibility(
  metaA: EmbeddingMetadata,
  metaB: EmbeddingMetadata
): void {
  if (metaA.dimension !== metaB.dimension) {
    throw new IncompatibleEmbeddingError(
      `Embedding dimension mismatch: query is ${metaA.dimension}-dim, record is ${metaB.dimension}-dim.`
    );
  }
  if (metaA.provider !== metaB.provider || metaA.model !== metaB.model) {
    throw new IncompatibleEmbeddingError(
      `Embedding model mismatch: cannot compare embeddings from ${metaA.provider}/${metaA.model} with ${metaB.provider}/${metaB.model}.`
    );
  }
}

export interface SemanticStorage {
  insert(item: SemanticKnowledgeItem): Promise<void>;
  update(item: SemanticKnowledgeItem): Promise<void>;
  getById(id: string): Promise<SemanticKnowledgeItem | undefined>;
  search(
    queryVector: number[],
    queryMetadata?: EmbeddingMetadata,
    options?: {
      limit?: number;
      minSimilarity?: number;
      filter?: SemanticSearchFilter;
    }
  ): Promise<SemanticSearchResult[]>;
  deprecate(id: string, supersedesId?: string): Promise<void>;
}

export class InMemorySemanticStorage implements SemanticStorage {
  private items: SemanticKnowledgeItem[] = [];

  async insert(item: SemanticKnowledgeItem): Promise<void> {
    this.items.push(structuredClone(item));
  }

  async update(item: SemanticKnowledgeItem): Promise<void> {
    const idx = this.items.findIndex((i) => i.id === item.id);
    if (idx !== -1) {
      this.items[idx] = structuredClone(item);
    } else {
      this.items.push(structuredClone(item));
    }
  }

  async getById(id: string): Promise<SemanticKnowledgeItem | undefined> {
    const found = this.items.find((i) => i.id === id);
    return found ? structuredClone(found) : undefined;
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
    const limit = options?.limit ?? 5;
    const minSimilarity = options?.minSimilarity ?? 0.5;
    const filter = options?.filter;

    const filtered = this.items.filter((item) => {
      if (!filter?.includeDeprecated && item.isDeprecated) return false;
      if (filter?.category && item.category !== filter.category) return false;
      if (
        filter?.departmentId &&
        item.scope !== 'ORGANIZATION_WIDE' &&
        item.departmentId !== filter.departmentId
      ) {
        return false;
      }
      if (filter?.scope && item.scope !== filter.scope) return false;
      if (filter?.tags && filter.tags.length > 0) {
        const hasTag = filter.tags.some((t) => item.tags?.includes(t));
        if (!hasTag) return false;
      }
      return true;
    });

    const scored: SemanticSearchResult[] = [];
    for (const item of filtered) {
      if (queryMetadata && item.embeddingMetadata) {
        assertEmbeddingCompatibility(queryMetadata, item.embeddingMetadata);
      }
      const similarity = computeCosineSimilarity(queryVector, item.embedding);
      if (similarity >= minSimilarity) {
        scored.push({
          item: structuredClone(item),
          similarity,
        });
      }
    }

    return scored
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }

  async deprecate(id: string, supersedesId?: string): Promise<void> {
    const item = this.items.find((i) => i.id === id);
    if (item) {
      item.isDeprecated = true;
      if (supersedesId) {
        item.supersedesId = supersedesId;
      }
      item.updatedAt = new Date().toISOString();
    }
  }
}

export class SemanticMemory {
  constructor(private readonly storage: SemanticStorage) {}

  async storeKnowledge(
    item: SemanticKnowledgeItem,
    principal?: MemoryAccessPrincipal
  ): Promise<void> {
    if (principal) {
      MemoryAccessController.assertAccess(
        principal,
        {
          scope: item.scope,
          authorAgentId: item.authorAgentId,
          departmentId: item.departmentId,
        },
        'WRITE'
      );
    }

    // Verify embedding dimension
    if (item.embedding.length !== item.embeddingMetadata.dimension) {
      throw new IncompatibleEmbeddingError(
        `Embedding vector length (${item.embedding.length}) does not match declared metadata dimension (${item.embeddingMetadata.dimension}).`
      );
    }

    const sanitized = SecretRedactor.sanitize(item, true);
    const parsed = SemanticKnowledgeItemSchema.parse(sanitized);

    await this.storage.insert(parsed);
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
    const results = await this.storage.search(queryVector, queryMetadata, options);

    if (!principal) {
      return results;
    }

    // Filter by principal read authorization
    return results.filter((res) => {
      try {
        MemoryAccessController.assertAccess(
          principal,
          {
            scope: res.item.scope,
            authorAgentId: res.item.authorAgentId,
            departmentId: res.item.departmentId,
          },
          'READ'
        );
        return true;
      } catch {
        return false;
      }
    });
  }

  async deprecate(
    id: string,
    supersedesId?: string,
    principal?: MemoryAccessPrincipal
  ): Promise<void> {
    const existing = await this.storage.getById(id);
    if (!existing) {
      throw new Error(`Semantic knowledge item with id '${id}' not found.`);
    }

    if (principal) {
      MemoryAccessController.assertAccess(
        principal,
        {
          scope: existing.scope,
          authorAgentId: existing.authorAgentId,
          departmentId: existing.departmentId,
        },
        'UPDATE'
      );
    }

    await this.storage.deprecate(id, supersedesId);
  }

  async getById(
    id: string,
    principal?: MemoryAccessPrincipal
  ): Promise<SemanticKnowledgeItem | undefined> {
    const item = await this.storage.getById(id);
    if (!item) return undefined;

    if (principal) {
      MemoryAccessController.assertAccess(
        principal,
        {
          scope: item.scope,
          authorAgentId: item.authorAgentId,
          departmentId: item.departmentId,
        },
        'READ'
      );
    }

    return item;
  }
}
