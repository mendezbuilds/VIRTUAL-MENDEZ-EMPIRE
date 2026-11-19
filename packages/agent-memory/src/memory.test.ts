import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  WorkingMemory,
  EpisodicMemory,
  InMemoryEpisodicStorage,
  SemanticMemory,
  InMemorySemanticStorage,
  ProceduralMemory,
  InMemoryProceduralStorage,
  SecretRedactor,
  SecretRedactionError,
  MemoryAccessController,
  UnauthorizedMemoryAccessError,
  MemoryContextRetriever,
  MemoryConsolidator,
  AgentMemoryEngine,
  computeCosineSimilarity,
  IncompatibleEmbeddingError,
} from './index.js';
import { EmergencySupervisor, EmergencyHaltError } from '@vme/security-governance';
import { OWNER_PRINCIPAL_ID, type MemoryAccessPrincipal } from '@vme/shared-types';

describe('@vme/agent-memory Quad-Tier Persistent Memory Engine', () => {
  const activeSpecialist: MemoryAccessPrincipal = {
    principalId: randomUUID(),
    principalType: 'AGENT',
    agentCode: 'OA-SCRAPER-01',
    departmentId: 'opportunity_acquisition',
    level: 'SPECIALIST',
    isActive: true,
  };

  const peerSpecialist: MemoryAccessPrincipal = {
    principalId: randomUUID(),
    principalType: 'AGENT',
    agentCode: 'OA-MATCHER-01',
    departmentId: 'opportunity_acquisition',
    level: 'SPECIALIST',
    isActive: true,
  };

  const financeSpecialist: MemoryAccessPrincipal = {
    principalId: randomUUID(),
    principalType: 'AGENT',
    agentCode: 'FIN-ANALYST-01',
    departmentId: 'financial_intelligence',
    level: 'SPECIALIST',
    isActive: true,
  };

  const oaDirector: MemoryAccessPrincipal = {
    principalId: randomUUID(),
    principalType: 'AGENT',
    agentCode: 'OA-DIR',
    departmentId: 'opportunity_acquisition',
    level: 'DIRECTOR',
    isActive: true,
  };

  const ceoPrincipal: MemoryAccessPrincipal = {
    principalId: randomUUID(),
    principalType: 'AGENT',
    agentCode: 'EXEC-CEO',
    departmentId: 'executive_office',
    level: 'EXECUTIVE',
    isActive: true,
  };

  const ownerPrincipal: MemoryAccessPrincipal = {
    principalId: OWNER_PRINCIPAL_ID,
    principalType: 'OWNER_PRINCIPAL',
    level: 'OWNER',
    isActive: true,
  };

  const inactiveSpecialist: MemoryAccessPrincipal = {
    principalId: randomUUID(),
    principalType: 'AGENT',
    agentCode: 'OA-INACTIVE',
    departmentId: 'opportunity_acquisition',
    level: 'SPECIALIST',
    isActive: false,
  };

  describe('Tier 1: Working Memory', () => {
    it('handles task-scoped scratchpads, intermediate values, and TTL expiration', async () => {
      const wm = new WorkingMemory();
      const taskId = randomUUID();

      wm.set(taskId, 'step', 1);
      wm.set(taskId, 'interim_result', { leadsFound: 15 });
      wm.set(taskId, 'short_lived', 'temp_value', 0.05); // 50ms TTL

      expect(wm.get<number>(taskId, 'step')).toBe(1);
      expect(wm.get<{ leadsFound: number }>(taskId, 'interim_result')?.leadsFound).toBe(15);
      expect(wm.get<string>(taskId, 'short_lived')).toBe('temp_value');

      // Wait for expiration
      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(wm.get<string>(taskId, 'short_lived')).toBeUndefined();
      expect(wm.get<number>(taskId, 'step')).toBe(1);

      const cleaned = wm.cleanupExpired();
      expect(cleaned).toBeGreaterThanOrEqual(0);

      wm.clear(taskId);
      expect(wm.get(taskId, 'step')).toBeUndefined();
    });

    it('sanitizes credentials written to working memory scratchpads', () => {
      const wm = new WorkingMemory();
      const taskId = randomUUID();

      wm.set(taskId, 'context', {
        agentNotes: 'Found auth token',
        apiKey: 'sk-ant-api03-abcdef12345678901234567890abcdef',
      });

      const retrieved = wm.get<Record<string, unknown>>(taskId, 'context');
      expect(retrieved?.apiKey).toBe('[REDACTED_SENSITIVE_FIELD]');
    });
  });

  describe('Tier 2: Episodic Memory', () => {
    it('records execution history, filters by department and agent, and enforces ABAC', async () => {
      const storage = new InMemoryEpisodicStorage();
      const em = new EpisodicMemory(storage);

      const recordA = {
        id: randomUUID(),
        agentId: activeSpecialist.principalId,
        departmentId: 'opportunity_acquisition' as const,
        taskId: randomUUID(),
        actionType: 'JOB_SCRAPE',
        inputSummary: 'Query: Senior Rust Engineer',
        decisionRationale: 'Filtered by >$150k salary and remote status',
        outcome: 'Discovered 4 viable contracts',
        status: 'SUCCESS' as const,
        scope: 'DEPARTMENT_SCOPED' as const,
        importanceScore: 8,
        metadata: {},
        recordedAt: new Date().toISOString(),
      };

      const recordPrivate = {
        id: randomUUID(),
        agentId: activeSpecialist.principalId,
        departmentId: 'opportunity_acquisition' as const,
        taskId: randomUUID(),
        actionType: 'INTERNAL_EVAL',
        inputSummary: 'Self check',
        decisionRationale: 'Confidence assessment',
        outcome: 'Self-assessment score 0.94',
        status: 'SUCCESS' as const,
        scope: 'AGENT_PRIVATE' as const,
        importanceScore: 6,
        metadata: {},
        recordedAt: new Date().toISOString(),
      };

      await em.recordExecution(recordA, activeSpecialist);
      await em.recordExecution(recordPrivate, activeSpecialist);

      // Active specialist can read both
      const activeResults = await em.getRecentContext({}, activeSpecialist);
      expect(activeResults).toHaveLength(2);

      // Peer in same department can read departmental record, but NOT agent-private record
      const peerResults = await em.getRecentContext({}, peerSpecialist);
      expect(peerResults).toHaveLength(1);
      expect(peerResults[0]?.scope).toBe('DEPARTMENT_SCOPED');

      // Finance specialist cannot read OA departmental record
      const financeResults = await em.getRecentContext({}, financeSpecialist);
      expect(financeResults).toHaveLength(0);

      // CEO can read departmental record across departments
      const ceoResults = await em.getRecentContext({}, ceoPrincipal);
      expect(ceoResults).toHaveLength(1);
      expect(ceoResults[0]?.scope).toBe('DEPARTMENT_SCOPED');
    });

    it('rejects recording episodic memory containing raw credentials in strict mode', async () => {
      const storage = new InMemoryEpisodicStorage();
      const em = new EpisodicMemory(storage);

      const taintedRecord = {
        id: randomUUID(),
        agentId: activeSpecialist.principalId,
        departmentId: 'opportunity_acquisition' as const,
        taskId: randomUUID(),
        actionType: 'API_FETCH',
        inputSummary: 'Request with Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.secret',
        decisionRationale: 'Execute external API call',
        outcome: 'Executed successfully',
        status: 'SUCCESS' as const,
        scope: 'AGENT_PRIVATE' as const,
        importanceScore: 5,
        metadata: {},
        recordedAt: new Date().toISOString(),
      };

      await expect(em.recordExecution(taintedRecord, activeSpecialist)).rejects.toThrow(
        SecretRedactionError
      );
    });

    it('archives older episodic records and restricts deletion to authorized leadership', async () => {
      const storage = new InMemoryEpisodicStorage();
      const em = new EpisodicMemory(storage);

      const oldRecord = {
        id: randomUUID(),
        agentId: activeSpecialist.principalId,
        departmentId: 'opportunity_acquisition' as const,
        taskId: randomUUID(),
        actionType: 'OLD_TASK',
        inputSummary: 'Historical task',
        decisionRationale: 'Historical rationale',
        outcome: 'Completed 100 days ago',
        status: 'SUCCESS' as const,
        scope: 'DEPARTMENT_SCOPED' as const,
        importanceScore: 5,
        metadata: {},
        recordedAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString(),
      };

      const newRecord = {
        id: randomUUID(),
        agentId: activeSpecialist.principalId,
        departmentId: 'opportunity_acquisition' as const,
        taskId: randomUUID(),
        actionType: 'NEW_TASK',
        inputSummary: 'Recent task',
        decisionRationale: 'Recent rationale',
        outcome: 'Completed today',
        status: 'SUCCESS' as const,
        scope: 'DEPARTMENT_SCOPED' as const,
        importanceScore: 7,
        metadata: {},
        recordedAt: new Date().toISOString(),
      };

      await em.recordExecution(oldRecord, activeSpecialist);
      await em.recordExecution(newRecord, activeSpecialist);

      // Specialist cannot trigger archive
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      await expect(em.archiveOlderThan(cutoff, activeSpecialist)).rejects.toThrow();

      // Director can trigger archive
      const archivedCount = await em.archiveOlderThan(cutoff, oaDirector);
      expect(archivedCount).toBe(1);

      // Specialist cannot delete records
      await expect(
        em.deleteRecords({ departmentId: 'opportunity_acquisition' }, activeSpecialist)
      ).rejects.toThrow(UnauthorizedMemoryAccessError);

      // Director can delete department records
      const deletedCount = await em.deleteRecords(
        { departmentId: 'opportunity_acquisition' },
        oaDirector
      );
      expect(deletedCount).toBe(1);
    });
  });

  describe('Tier 3: Semantic Memory', () => {
    it('indexes semantic items, computes cosine similarity, and rejects dimension mismatch', async () => {
      const storage = new InMemorySemanticStorage();
      const sm = new SemanticMemory(storage);

      const item1 = {
        id: randomUUID(),
        scope: 'ORGANIZATION_WIDE' as const,
        category: 'finance',
        title: 'Capital Allocation Strategy',
        content: 'Risk-adjusted hurdle rates for high-frequency algorithmic liquidity.',
        embedding: [0.95, 0.05, 0.0],
        embeddingMetadata: {
          provider: 'mock',
          model: 'mock-embedding-v1',
          dimension: 3,
          version: '1.0.0',
        },
        importanceScore: 9,
        tags: ['finance', 'capital'],
        version: '1.0.0',
        isDeprecated: false,
        metadata: {},
        createdAt: new Date().toISOString(),
      };

      const item2 = {
        id: randomUUID(),
        scope: 'ORGANIZATION_WIDE' as const,
        category: 'technology',
        title: 'Rust Architecture Standards',
        content: 'Zero-cost concurrency patterns and memory layout guarantees.',
        embedding: [0.05, 0.95, 0.1],
        embeddingMetadata: {
          provider: 'mock',
          model: 'mock-embedding-v1',
          dimension: 3,
          version: '1.0.0',
        },
        importanceScore: 8,
        tags: ['rust', 'tech'],
        version: '1.0.0',
        isDeprecated: false,
        metadata: {},
        createdAt: new Date().toISOString(),
      };

      await sm.storeKnowledge(item1, ceoPrincipal);
      await sm.storeKnowledge(item2, ceoPrincipal);

      const queryMeta = {
        provider: 'mock',
        model: 'mock-embedding-v1',
        dimension: 3,
        version: '1.0.0',
      };

      const results = await sm.searchKnowledge(
        [0.0, 0.9, 0.15],
        queryMeta,
        { limit: 2, minSimilarity: 0.5 },
        activeSpecialist
      );

      expect(results).toHaveLength(1);
      expect(results[0]?.item.title).toBe('Rust Architecture Standards');
      expect(results[0]?.similarity).toBeGreaterThan(0.9);

      // Incompatible query dimension throws IncompatibleEmbeddingError
      const badQueryMeta = {
        provider: 'mock',
        model: 'mock-embedding-v1',
        dimension: 4,
        version: '1.0.0',
      };
      await expect(
        sm.searchKnowledge([0.1, 0.2, 0.3, 0.4], badQueryMeta, {}, activeSpecialist)
      ).rejects.toThrow(IncompatibleEmbeddingError);
    });

    it('enforces scope authorization and handles item deprecation', async () => {
      const storage = new InMemorySemanticStorage();
      const sm = new SemanticMemory(storage);

      const deptKnowledge = {
        id: randomUUID(),
        scope: 'DEPARTMENT_SCOPED' as const,
        departmentId: 'opportunity_acquisition' as const,
        category: 'playbook',
        title: 'OA Scraping Guidelines',
        content: 'Rate limiting rules for public board scrapers.',
        embedding: [0.5, 0.5, 0.5],
        embeddingMetadata: {
          provider: 'mock',
          model: 'mock-embedding-v1',
          dimension: 3,
          version: '1.0.0',
        },
        importanceScore: 7,
        tags: ['oa', 'scraping'],
        version: '1.0.0',
        isDeprecated: false,
        metadata: {},
        createdAt: new Date().toISOString(),
      };

      await sm.storeKnowledge(deptKnowledge, oaDirector);

      // Finance specialist cannot search or read OA departmental knowledge
      const queryMeta = {
        provider: 'mock',
        model: 'mock-embedding-v1',
        dimension: 3,
        version: '1.0.0',
      };
      const financeResults = await sm.searchKnowledge(
        [0.5, 0.5, 0.5],
        queryMeta,
        {},
        financeSpecialist
      );
      expect(financeResults).toHaveLength(0);

      // Deprecate item
      await sm.deprecate(deptKnowledge.id, undefined, oaDirector);
      const afterDeprecate = await sm.searchKnowledge(
        [0.5, 0.5, 0.5],
        queryMeta,
        { filter: { includeDeprecated: false } },
        activeSpecialist
      );
      expect(afterDeprecate).toHaveLength(0);
    });
  });

  describe('Tier 4: Procedural Memory', () => {
    it('manages playbooks, requires director approval for activation, and tracks metrics', async () => {
      const storage = new InMemoryProceduralStorage();
      const pm = new ProceduralMemory(storage);

      const playbookId = randomUUID();
      const playbook = {
        id: playbookId,
        scope: 'DEPARTMENT_SCOPED' as const,
        departmentId: 'opportunity_acquisition' as const,
        authorAgentId: activeSpecialist.principalId,
        authorAgentCode: activeSpecialist.agentCode,
        authorizedBy: 'PENDING_APPROVAL',
        name: 'Lead Triage Workflow',
        description: 'Standard operating procedure for triaging raw leads',
        triggerCondition: 'INCOMING_LEAD_BATCH',
        requiredCapabilities: ['LEAD_ANALYSIS', 'CRM_SYNC'],
        steps: [
          {
            stepNumber: 1,
            name: 'Validate Schema',
            instruction: 'Check required lead attributes',
            requiredCapability: 'LEAD_ANALYSIS',
            timeoutMs: 5000,
            retryLimit: 1,
          },
        ],
        successCount: 0,
        failureCount: 0,
        version: '1.0.0',
        isApproved: false,
        metadata: {},
        createdAt: new Date().toISOString(),
      };

      await pm.storePlaybook(playbook, activeSpecialist);

      // Non-approved query returns 0 approved
      const approvedQuery = await pm.queryPlaybooks(
        { departmentId: 'opportunity_acquisition', isApproved: true },
        activeSpecialist
      );
      expect(approvedQuery).toHaveLength(0);

      // Specialist cannot approve playbook
      await expect(pm.approvePlaybook(playbookId, activeSpecialist)).rejects.toThrow(
        UnauthorizedMemoryAccessError
      );

      // OA Director can approve
      await pm.approvePlaybook(playbookId, oaDirector);

      const afterApproval = await pm.queryPlaybooks(
        { departmentId: 'opportunity_acquisition', isApproved: true },
        activeSpecialist
      );
      expect(afterApproval).toHaveLength(1);
      expect(afterApproval[0]?.isApproved).toBe(true);

      // Record execution outcomes
      await pm.recordExecutionOutcome(playbookId, true);
      await pm.recordExecutionOutcome(playbookId, true);
      await pm.recordExecutionOutcome(playbookId, false);

      const updated = await pm.getPlaybook(playbookId, activeSpecialist);
      expect(updated?.successCount).toBe(2);
      expect(updated?.failureCount).toBe(1);
    });
  });

  describe('Context Retrieval Engine', () => {
    it('executes multi-tier retrieval with composite relevance scoring and token packing', async () => {
      const wm = new WorkingMemory();
      const es = new InMemoryEpisodicStorage();
      const ss = new InMemorySemanticStorage();
      const ps = new InMemoryProceduralStorage();

      const em = new EpisodicMemory(es);
      const sm = new SemanticMemory(ss);
      const pm = new ProceduralMemory(ps);

      const taskId = randomUUID();
      wm.set(taskId, 'current_query', 'Rust Systems Engineer');

      // Populate episodic
      await em.recordExecution(
        {
          id: randomUUID(),
          agentId: activeSpecialist.principalId,
          departmentId: 'opportunity_acquisition',
          taskId: randomUUID(),
          actionType: 'PREVIOUS_SCRAPE',
          inputSummary: 'Scraped 10 leads',
          decisionRationale: 'Applied standard filters',
          outcome: 'Matched 8 leads',
          status: 'SUCCESS',
          scope: 'AGENT_PRIVATE',
          importanceScore: 8,
          metadata: {},
          recordedAt: new Date().toISOString(),
        },
        activeSpecialist
      );

      // Populate semantic
      await sm.storeKnowledge(
        {
          id: randomUUID(),
          scope: 'ORGANIZATION_WIDE',
          category: 'talent',
          title: 'Talent Acquisition Heuristics',
          content: 'Heuristics for evaluating remote compensation tiers.',
          embedding: [0.8, 0.2],
          embeddingMetadata: {
            provider: 'mock',
            model: 'mock-embedding-v1',
            dimension: 2,
            version: '1.0.0',
          },
          importanceScore: 9,
          tags: ['talent'],
          version: '1.0.0',
          isDeprecated: false,
          metadata: {},
          createdAt: new Date().toISOString(),
        },
        ceoPrincipal
      );

      // Populate procedural
      await pm.storePlaybook(
        {
          id: randomUUID(),
          scope: 'DEPARTMENT_SCOPED',
          departmentId: 'opportunity_acquisition',
          authorAgentId: oaDirector.principalId,
          authorizedBy: oaDirector.principalId,
          name: 'Talent Verification SOP',
          description: 'Verification SOP',
          triggerCondition: 'ON_TALENT_SCRAPE',
          requiredCapabilities: ['VERIFY'],
          steps: [
            {
              stepNumber: 1,
              name: 'Verify credentials',
              instruction: 'Confirm public git commits',
              requiredCapability: 'VERIFY',
              timeoutMs: 10000,
              retryLimit: 1,
            },
          ],
          successCount: 10,
          failureCount: 1,
          version: '1.0.0',
          isApproved: true,
          metadata: {},
          createdAt: new Date().toISOString(),
        },
        oaDirector
      );

      const retriever = new MemoryContextRetriever(wm, em, sm, pm);

      const bundle = await retriever.retrieveContext({
        taskId,
        agentId: activeSpecialist.principalId,
        departmentId: 'opportunity_acquisition',
        principal: activeSpecialist,
        queryVector: [0.8, 0.2],
        queryMetadata: {
          provider: 'mock',
          model: 'mock-embedding-v1',
          dimension: 2,
          version: '1.0.0',
        },
        maxTokens: 1000,
      });

      expect(bundle.workingMemory.current_query).toBe('Rust Systems Engineer');
      expect(bundle.episodicRecords).toHaveLength(1);
      expect(bundle.semanticKnowledge).toHaveLength(1);
      expect(bundle.proceduralPlaybooks).toHaveLength(1);
      expect(bundle.totalTokensEstimated).toBeGreaterThan(0);
    });
  });

  describe('Consolidation Pipeline & Governance', () => {
    it('promotes episodic learnings to semantic knowledge with governance controls', async () => {
      const ss = new InMemorySemanticStorage();
      const ps = new InMemoryProceduralStorage();
      const sm = new SemanticMemory(ss);
      const pm = new ProceduralMemory(ps);
      const consolidator = new MemoryConsolidator(sm, pm);

      const sampleEpisodes = [
        {
          id: randomUUID(),
          agentId: activeSpecialist.principalId,
          departmentId: 'opportunity_acquisition' as const,
          taskId: randomUUID(),
          actionType: 'CONTRACT_REVIEW',
          inputSummary: 'Review contract A',
          decisionRationale: 'Strict liability clause flagged',
          outcome: 'Term renegotiated successfully',
          status: 'SUCCESS' as const,
          scope: 'DEPARTMENT_SCOPED' as const,
          importanceScore: 9,
          metadata: {},
          recordedAt: new Date().toISOString(),
        },
      ];

      // Specialist cannot promote to ORGANIZATION_WIDE
      await expect(
        consolidator.promoteToSemanticKnowledge({
          sourceRecordIds: [sampleEpisodes[0]!.id],
          records: sampleEpisodes,
          targetScope: 'ORGANIZATION_WIDE',
          category: 'legal',
          title: 'Strict Liability Negotiation Guide',
          synthesizedContent: 'Always modify indemnity clause in cross-border software contracts.',
          embedding: [0.7, 0.3],
          tags: ['legal', 'contracts'],
          provenance: 'Consolidated from contract renegotiation task executions',
          evidenceSummary: 'High value contract terms successfully negotiated',
          confidenceScore: 0.95,
          policy: { minSourceRecordCount: 1 },
          principal: activeSpecialist,
        })
      ).rejects.toThrow(UnauthorizedMemoryAccessError);

      // CEO can promote to ORGANIZATION_WIDE
      const promoted = await consolidator.promoteToSemanticKnowledge({
        sourceRecordIds: [sampleEpisodes[0]!.id],
        records: sampleEpisodes,
        targetScope: 'ORGANIZATION_WIDE',
        category: 'legal',
        title: 'Strict Liability Negotiation Guide',
        synthesizedContent: 'Always modify indemnity clause in cross-border software contracts.',
        embedding: [0.7, 0.3],
        tags: ['legal', 'contracts'],
        provenance: 'Consolidated from contract renegotiation task executions',
        evidenceSummary: 'High value contract terms successfully negotiated',
        confidenceScore: 0.95,
        policy: { minSourceRecordCount: 1 },
        principal: ceoPrincipal,
      });

      expect(promoted.scope).toBe('ORGANIZATION_WIDE');
      expect(promoted.title).toBe('Strict Liability Negotiation Guide');
    });
  });

  describe('EmergencySupervisor Integration & Mutation Freeze', () => {
    it('freezes memory mutations during emergency halt while preserving read operations', async () => {
      const supervisor = new EmergencySupervisor(undefined, false);
      const engine = new AgentMemoryEngine({ emergencySupervisor: supervisor });

      const taskId = randomUUID();

      // Normal operations work
      engine.setWorkingMemory(taskId, 'status', 'INITIALIZING');
      expect(engine.getWorkingMemory(taskId, 'status')).toBe('INITIALIZING');

      // Trigger Tier 1 Emergency Halt
      supervisor.triggerHalt('Security containment drill', 'EXEC-CISO');

      // Writes must throw EmergencyHaltError
      expect(() => {
        engine.setWorkingMemory(taskId, 'status', 'HALTED_MUTATION');
      }).toThrow(EmergencyHaltError);

      const dummyEpisode = {
        id: randomUUID(),
        agentId: activeSpecialist.principalId,
        departmentId: 'opportunity_acquisition' as const,
        taskId: randomUUID(),
        actionType: 'HALT_TEST',
        inputSummary: 'Testing halt',
        decisionRationale: 'Halt enforcement',
        outcome: 'Blocked',
        status: 'SUCCESS' as const,
        scope: 'AGENT_PRIVATE' as const,
        importanceScore: 5,
        metadata: {},
        recordedAt: new Date().toISOString(),
      };

      await expect(engine.recordEpisode(dummyEpisode, activeSpecialist)).rejects.toThrow(
        EmergencyHaltError
      );

      // Reads continue to work cleanly
      const readResult = engine.getWorkingMemory(taskId, 'status');
      expect(readResult).toBe('INITIALIZING');

      // Resume operations
      supervisor.resumeOperations(OWNER_PRINCIPAL_ID);

      // Mutations work again
      engine.setWorkingMemory(taskId, 'status', 'RESUMED');
      expect(engine.getWorkingMemory(taskId, 'status')).toBe('RESUMED');
    });
  });
});
