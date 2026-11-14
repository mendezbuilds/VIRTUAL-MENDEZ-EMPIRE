import type { SemanticKnowledgeItem } from '@vme/shared-types';

export interface SemanticSearchResult {
  item: SemanticKnowledgeItem;
  similarity: number;
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

export interface SemanticStorage {
  insert(item: SemanticKnowledgeItem): Promise<void>;
  search(queryVector: number[], limit: number, minSimilarity: number): Promise<SemanticSearchResult[]>;
}

export class InMemorySemanticStorage implements SemanticStorage {
  private items: SemanticKnowledgeItem[] = [];

  async insert(item: SemanticKnowledgeItem): Promise<void> {
    this.items.push({ ...item });
  }

  async search(
    queryVector: number[],
    limit = 5,
    minSimilarity = 0.5
  ): Promise<SemanticSearchResult[]> {
    const scored = this.items.map((item) => ({
      item,
      similarity: computeCosineSimilarity(queryVector, item.embedding),
    }));

    return scored
      .filter((s) => s.similarity >= minSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }
}

export class SemanticMemory {
  constructor(private readonly storage: SemanticStorage) {}

  async storeKnowledge(item: SemanticKnowledgeItem): Promise<void> {
    await this.storage.insert(item);
  }

  async searchKnowledge(
    queryVector: number[],
    limit = 5,
    minSimilarity = 0.5
  ): Promise<SemanticSearchResult[]> {
    return this.storage.search(queryVector, limit, minSimilarity);
  }
}
