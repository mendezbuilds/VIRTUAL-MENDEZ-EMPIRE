import { z } from 'zod';
import { DepartmentIdSchema } from './organization.js';
import { OrganizationalLevelSchema } from './organization.js';

/**
 * Three-tier boundary isolation scopes for agent memory.
 */
export const MemoryScopeSchema = z.enum([
  'AGENT_PRIVATE',       // Accessible exclusively by the owning agent
  'DEPARTMENT_SCOPED',   // Accessible by all active agents in the department
  'ORGANIZATION_WIDE',   // Accessible empire-wide across all 30 workforce agents
]);

export type MemoryScope = z.infer<typeof MemoryScopeSchema>;

/**
 * Metadata defining embedding provider and space compatibility.
 * Prevents cross-comparison between incompatible embedding spaces.
 */
export const EmbeddingMetadataSchema = z.object({
  provider: z.string().min(1).default('mock'),
  model: z.string().min(1).default('mock-embedding-v1'),
  dimension: z.number().int().positive().default(1536),
  version: z.string().default('1.0.0'),
});

export type EmbeddingMetadata = z.infer<typeof EmbeddingMetadataSchema>;

/**
 * Persistent Episodic Memory Record (Tier 1)
 * Records time-sequenced decision summaries, action outcomes, and lessons learned.
 * Private hidden reasoning traces or raw model dumps are barred.
 */
export const EpisodicMemoryRecordSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid().optional(),
  agentId: z.string().uuid(),
  agentCode: z.string().optional(),
  departmentId: DepartmentIdSchema,
  taskId: z.string().uuid(),
  actionType: z.string().min(1),
  inputSummary: z.string().min(1),
  decisionRationale: z.string().min(1),
  outcome: z.string().min(1),
  lessonsLearned: z.string().optional(),
  executionDurationMs: z.number().int().nonnegative().optional(),
  status: z.enum(['SUCCESS', 'FAILURE', 'QUARANTINED', 'ESCALATED']).default('SUCCESS'),
  scope: MemoryScopeSchema.default('AGENT_PRIVATE'),
  importanceScore: z.number().min(1).max(10).default(5),
  metadata: z.record(z.unknown()).default({}),
  recordedAt: z.string().datetime(),
});

export type EpisodicMemoryRecord = z.infer<typeof EpisodicMemoryRecordSchema>;

/**
 * Persistent Semantic Knowledge Item (Tier 2)
 * Vector-indexed corporate and domain knowledge for cosine similarity and hybrid search.
 */
export const SemanticKnowledgeItemSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid().optional(),
  scope: MemoryScopeSchema.default('ORGANIZATION_WIDE'),
  departmentId: DepartmentIdSchema.optional(),
  authorAgentId: z.string().uuid().optional(),
  category: z.string().min(1),
  title: z.string().min(1),
  content: z.string().min(1),
  embedding: z.array(z.number()),
  embeddingMetadata: EmbeddingMetadataSchema.default({
    provider: 'mock',
    model: 'mock-embedding-v1',
    dimension: 1536,
    version: '1.0.0',
  }),
  importanceScore: z.number().min(1).max(10).default(5),
  tags: z.array(z.string()).default([]),
  version: z.string().default('1.0.0'),
  supersedesId: z.string().uuid().optional(),
  isDeprecated: z.boolean().default(false),
  metadata: z.record(z.unknown()).default({}),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime().optional(),
});

export type SemanticKnowledgeItem = z.infer<typeof SemanticKnowledgeItemSchema>;

/**
 * Procedural Memory Step (Tier 3)
 */
export const ProceduralStepSchema = z.object({
  stepNumber: z.number().int().positive(),
  name: z.string().min(1),
  instruction: z.string().min(1),
  requiredCapability: z.string().min(1),
  toolName: z.string().optional(),
  timeoutMs: z.number().int().positive().default(30000),
  retryLimit: z.number().int().nonnegative().default(2),
  fallbackStep: z.number().int().positive().optional(),
});

export type ProceduralStep = z.infer<typeof ProceduralStepSchema>;

/**
 * Persistent Procedural Memory Playbook (Tier 3)
 * Versioned SOPs, workflows, and operational procedures with approval states.
 */
export const ProceduralPlaybookSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid().optional(),
  scope: MemoryScopeSchema.default('DEPARTMENT_SCOPED'),
  departmentId: DepartmentIdSchema.optional(),
  authorAgentId: z.string().uuid(),
  authorAgentCode: z.string().optional(),
  authorizedBy: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  triggerCondition: z.string().min(1),
  requiredCapabilities: z.array(z.string()).min(1),
  steps: z.array(ProceduralStepSchema).min(1),
  successCount: z.number().int().nonnegative().default(0),
  failureCount: z.number().int().nonnegative().default(0),
  version: z.string().regex(/^\d+\.\d+\.\d+$/).default('1.0.0'),
  isApproved: z.boolean().default(false),
  metadata: z.record(z.unknown()).default({}),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime().optional(),
});

export type ProceduralPlaybook = z.infer<typeof ProceduralPlaybookSchema>;

/**
 * Memory Access Request Principal
 * Used for Centralized Attribute-Based Access Control (ABAC).
 */
export const MemoryAccessPrincipalSchema = z.object({
  principalId: z.string().min(1),
  principalType: z.enum(['AGENT', 'OWNER_PRINCIPAL']),
  agentCode: z.string().optional(),
  departmentId: DepartmentIdSchema.optional(),
  level: OrganizationalLevelSchema,
  isActive: z.boolean().default(true),
});

export type MemoryAccessPrincipal = z.infer<typeof MemoryAccessPrincipalSchema>;
