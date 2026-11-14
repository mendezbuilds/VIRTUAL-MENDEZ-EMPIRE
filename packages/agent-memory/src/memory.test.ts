import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  WorkingMemory,
  EpisodicMemory,
  InMemoryEpisodicStorage,
  SemanticMemory,
  InMemorySemanticStorage,
  computeCosineSimilarity,
} from './index.js';
import type { EpisodicMemoryRecord, SemanticKnowledgeItem } from '@vme/shared-types';

describe('@vme/agent-memory Tri-Tier Persistent Memory Engine', () => {
  it('working memory handles task-scoped scratchpads and intermediate values', () => {
    const wm = new WorkingMemory();
    const taskId = randomUUID();

    wm.set(taskId, 'step', 1);
    wm.set(taskId, 'interim_result', { leadsFound: 15 });

    expect(wm.get<number>(taskId, 'step')).toBe(1);
    expect(wm.get<{ leadsFound: number }>(taskId, 'interim_result')?.leadsFound).toBe(15);
    expect(wm.getAll(taskId)).toEqual({ step: 1, interim_result: { leadsFound: 15 } });

    wm.clear(taskId);
    expect(wm.get(taskId, 'step')).toBeUndefined();
  });

  it('episodic memory records execution history and queries by department/agent', async () => {
    const storage = new InMemoryEpisodicStorage();
    const em = new EpisodicMemory(storage);

    const agentA = randomUUID();
    const agentB = randomUUID();

    const recordA: EpisodicMemoryRecord = {
      id: randomUUID(),
      agentId: agentA,
      departmentId: 'opportunity_acquisition',
      taskId: randomUUID(),
      actionType: 'JOB_SCRAPE',
      inputSummary: 'Query: Senior Rust Engineer',
      decisionRationale: 'Filtered by >$150k salary and remote status',
      outcome: 'Discovered 4 viable contracts',
      recordedAt: new Date().toISOString(),
    };

    const recordB: EpisodicMemoryRecord = {
      id: randomUUID(),
      agentId: agentB,
      departmentId: 'financial_intelligence',
      taskId: randomUUID(),
      actionType: 'FX_BACKTEST',
      inputSummary: 'EUR/USD mean-reversion strategy',
      decisionRationale: 'Sharpe ratio 1.8 over 90-day window',
      outcome: 'Paper trading strategy approved',
      recordedAt: new Date().toISOString(),
    };

    await em.recordExecution(recordA);
    await em.recordExecution(recordB);

    const agentAHistory = await em.getRecentContext({ agentId: agentA });
    expect(agentAHistory).toHaveLength(1);
    expect(agentAHistory[0]?.actionType).toBe('JOB_SCRAPE');

    const financeHistory = await em.getRecentContext({ departmentId: 'financial_intelligence' });
    expect(financeHistory).toHaveLength(1);
    expect(financeHistory[0]?.actionType).toBe('FX_BACKTEST');
  });

  it('semantic memory computes cosine similarity and ranks vector embeddings accurately', async () => {
    const storage = new InMemorySemanticStorage();
    const sm = new SemanticMemory(storage);

    // Normalized 3D embeddings for testing
    const docDeFi: SemanticKnowledgeItem = {
      id: randomUUID(),
      category: 'finance',
      title: 'DeFi Liquidity Pools Guide',
      content: 'Automated market makers and impermanent loss formulas.',
      embedding: [0.9, 0.1, 0.0],
      metadata: {},
      createdAt: new Date().toISOString(),
    };

    const docRust: SemanticKnowledgeItem = {
      id: randomUUID(),
      category: 'technology',
      title: 'Advanced Rust Memory Safety',
      content: 'Borrow checker, lifetimes, and zero-cost abstractions.',
      embedding: [0.0, 0.9, 0.2],
      metadata: {},
      createdAt: new Date().toISOString(),
    };

    await sm.storeKnowledge(docDeFi);
    await sm.storeKnowledge(docRust);

    // Query close to Rust doc
    const queryVector = [0.05, 0.95, 0.1];
    const results = await sm.searchKnowledge(queryVector, 2, 0.1);

    expect(results).toHaveLength(2);
    expect(results[0]?.item.title).toBe('Advanced Rust Memory Safety');
    expect(results[0]?.similarity).toBeGreaterThan(0.9);
    expect(results[1]?.similarity).toBeLessThan(0.3);
  });
});
