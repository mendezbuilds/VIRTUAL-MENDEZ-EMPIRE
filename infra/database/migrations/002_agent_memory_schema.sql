-- ============================================================================
-- VIRTUAL MENDEZ EMPIRE — AGENT MEMORY SCHEMA & ROW-LEVEL SECURITY
-- Migration: 002_agent_memory_schema.sql
-- Covers: Working, Episodic, Semantic (pgvector HNSW), Procedural Playbooks
-- ============================================================================

-- Ensure required pgvector extension
CREATE EXTENSION IF NOT EXISTS "vector";

-- ----------------------------------------------------------------------------
-- 1. WORKING MEMORY TABLE (Ephemeral / Task-Scoped Scratchpads)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_working_memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id UUID NOT NULL,
  agent_id UUID NOT NULL,
  key VARCHAR(128) NOT NULL,
  value JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_working_mem_task_key UNIQUE (tenant_id, task_id, key)
);

CREATE INDEX IF NOT EXISTS idx_working_mem_expires ON agent_working_memories(expires_at);
CREATE INDEX IF NOT EXISTS idx_working_mem_task_agent ON agent_working_memories(task_id, agent_id);

-- ----------------------------------------------------------------------------
-- 2. EPISODIC MEMORIES TABLE (Persistent Time-Series Interaction Log)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_episodic_memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL,
  agent_code VARCHAR(32) NOT NULL,
  department_id VARCHAR(64) NOT NULL REFERENCES departments(id),
  task_id UUID NOT NULL,
  action_type VARCHAR(64) NOT NULL,
  input_summary TEXT NOT NULL,
  decision_rationale TEXT NOT NULL,
  outcome TEXT NOT NULL,
  lessons_learned TEXT,
  execution_duration_ms INT,
  status VARCHAR(16) NOT NULL DEFAULT 'SUCCESS' CHECK (status IN ('SUCCESS', 'FAILURE', 'QUARANTINED', 'ESCALATED')),
  scope VARCHAR(32) NOT NULL DEFAULT 'AGENT_PRIVATE' CHECK (scope IN ('AGENT_PRIVATE', 'DEPARTMENT_SCOPED', 'ORGANIZATION_WIDE')),
  importance_score INT NOT NULL DEFAULT 5 CHECK (importance_score BETWEEN 1 AND 10),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_episodic_agent_time ON agent_episodic_memories(agent_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_episodic_dept_time ON agent_episodic_memories(department_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_episodic_action ON agent_episodic_memories(action_type);
CREATE INDEX IF NOT EXISTS idx_episodic_task ON agent_episodic_memories(task_id);

-- ----------------------------------------------------------------------------
-- 3. SEMANTIC MEMORIES TABLE (Vector-Indexed Corporate & Domain Knowledge)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_semantic_memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope VARCHAR(32) NOT NULL DEFAULT 'ORGANIZATION_WIDE' CHECK (scope IN ('AGENT_PRIVATE', 'DEPARTMENT_SCOPED', 'ORGANIZATION_WIDE')),
  department_id VARCHAR(64) REFERENCES departments(id),
  author_agent_id UUID,
  category VARCHAR(64) NOT NULL,
  title VARCHAR(256) NOT NULL,
  content TEXT NOT NULL,
  embedding vector(1536) NOT NULL, -- Standard 1536-dimensional vector embedding
  embedding_provider VARCHAR(64) NOT NULL DEFAULT 'mock',
  embedding_model VARCHAR(64) NOT NULL DEFAULT 'mock-embedding-v1',
  embedding_dimension INT NOT NULL DEFAULT 1536,
  embedding_version VARCHAR(32) NOT NULL DEFAULT '1.0.0',
  importance_score INT NOT NULL DEFAULT 5 CHECK (importance_score BETWEEN 1 AND 10),
  tags TEXT[] NOT NULL DEFAULT '{}',
  version VARCHAR(32) NOT NULL DEFAULT '1.0.0',
  supersedes_id UUID REFERENCES agent_semantic_memories(id) ON DELETE SET NULL,
  is_deprecated BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- HNSW Vector Index for Cosine Similarity Search
CREATE INDEX IF NOT EXISTS idx_semantic_embedding_hnsw ON agent_semantic_memories 
USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_semantic_scope_dept ON agent_semantic_memories(scope, department_id);
CREATE INDEX IF NOT EXISTS idx_semantic_fulltext ON agent_semantic_memories USING gin(to_tsvector('english', title || ' ' || content));

-- ----------------------------------------------------------------------------
-- 4. PROCEDURAL MEMORIES TABLE (Versioned SOPs & Operational Playbooks)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_procedural_memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope VARCHAR(32) NOT NULL DEFAULT 'DEPARTMENT_SCOPED' CHECK (scope IN ('AGENT_PRIVATE', 'DEPARTMENT_SCOPED', 'ORGANIZATION_WIDE')),
  department_id VARCHAR(64) REFERENCES departments(id),
  author_agent_id UUID NOT NULL,
  author_agent_code VARCHAR(32),
  authorized_by VARCHAR(128) NOT NULL,
  name VARCHAR(128) NOT NULL,
  description TEXT NOT NULL,
  trigger_condition TEXT NOT NULL,
  required_capabilities TEXT[] NOT NULL,
  steps JSONB NOT NULL,
  success_count INT NOT NULL DEFAULT 0,
  failure_count INT NOT NULL DEFAULT 0,
  version VARCHAR(32) NOT NULL DEFAULT '1.0.0',
  is_approved BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_procedural_scope_dept ON agent_procedural_memories(scope, department_id);
CREATE INDEX IF NOT EXISTS idx_procedural_name ON agent_procedural_memories(name);

-- ----------------------------------------------------------------------------
-- 5. ROW-LEVEL SECURITY POLICIES
-- ----------------------------------------------------------------------------
ALTER TABLE agent_working_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_working_memories FORCE ROW LEVEL SECURITY;

ALTER TABLE agent_episodic_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_episodic_memories FORCE ROW LEVEL SECURITY;

ALTER TABLE agent_semantic_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_semantic_memories FORCE ROW LEVEL SECURITY;

ALTER TABLE agent_procedural_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_procedural_memories FORCE ROW LEVEL SECURITY;

-- Tenant Isolation Policies
CREATE POLICY working_mem_tenant_policy ON agent_working_memories
FOR ALL USING (tenant_id = get_current_tenant_id());

CREATE POLICY episodic_mem_tenant_policy ON agent_episodic_memories
FOR ALL USING (tenant_id = get_current_tenant_id());

CREATE POLICY semantic_mem_tenant_policy ON agent_semantic_memories
FOR ALL USING (tenant_id = get_current_tenant_id());

CREATE POLICY procedural_mem_tenant_policy ON agent_procedural_memories
FOR ALL USING (tenant_id = get_current_tenant_id());
