import { z } from 'zod';
import { DepartmentIdSchema } from './departments.js';

export const EpisodicMemoryRecordSchema = z.object({
  id: z.string().uuid(),
  agentId: z.string().uuid(),
  departmentId: DepartmentIdSchema,
  taskId: z.string().uuid(),
  actionType: z.string(),
  inputSummary: z.string(),
  decisionRationale: z.string(),
  outcome: z.string(),
  lessonsLearned: z.string().optional(),
  recordedAt: z.string().datetime(),
});

export type EpisodicMemoryRecord = z.infer<typeof EpisodicMemoryRecordSchema>;

export const SemanticKnowledgeItemSchema = z.object({
  id: z.string().uuid(),
  category: z.string(),
  title: z.string(),
  content: z.string(),
  embedding: z.array(z.number()),
  metadata: z.record(z.unknown()).default({}),
  createdAt: z.string().datetime(),
});

export type SemanticKnowledgeItem = z.infer<typeof SemanticKnowledgeItemSchema>;
