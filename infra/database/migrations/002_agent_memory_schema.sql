-- ============================================================================
-- VIRTUAL MENDEZ EMPIRE — AGENT MEMORY SCHEMA & DUAL-LAYER ABAC / RLS
-- Migration: 002_agent_memory_schema.sql
-- Covers: Working, Episodic, Semantic (Flexible Dimension & Vector), Procedural Playbooks
-- Enforces: Attribute-Based Access Control (ABAC) at Database Engine Layer
-- ============================================================================

-- Optional pgvector extension (if available on host PostgreSQL engine)
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS "vector";
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pgvector extension not available; falling back to native array vector operations.';
END $$;

-- ----------------------------------------------------------------------------
-- 1. ABAC & SESSION CONTEXT SECURITY FUNCTIONS
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION get_current_agent_id() RETURNS UUID AS $$
BEGIN
  RETURN NULLIF(current_setting('app.current_agent_id', true), '')::UUID;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public;

CREATE OR REPLACE FUNCTION get_current_department_id() RETURNS VARCHAR AS $$
BEGIN
  RETURN NULLIF(current_setting('app.current_department_id', true), '');
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public;

CREATE OR REPLACE FUNCTION get_current_principal_level() RETURNS VARCHAR AS $$
BEGIN
  RETURN NULLIF(current_setting('app.current_principal_level', true), '');
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public;

CREATE OR REPLACE FUNCTION is_current_principal_owner() RETURNS BOOLEAN AS $$
BEGIN
  RETURN (current_setting('app.is_owner_authenticated', true) = 'true')
     AND (get_current_principal_level() = 'OWNER' 
          OR get_current_agent_id() = '00000000-0000-0000-0000-000000000000'::UUID);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public;

CREATE OR REPLACE FUNCTION is_current_principal_executive() RETURNS BOOLEAN AS $$
BEGIN
  RETURN is_current_principal_owner() 
      OR get_current_principal_level() = 'EXECUTIVE'
      OR get_current_department_id() = 'executive_office';
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public;

CREATE OR REPLACE FUNCTION is_current_principal_director() RETURNS BOOLEAN AS $$
BEGIN
  RETURN is_current_principal_executive() 
      OR get_current_principal_level() = 'DIRECTOR';
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public;

-- Flexible Dimension Cosine Similarity Function for any vector dimension
CREATE OR REPLACE FUNCTION cosine_similarity_array(a DOUBLE PRECISION[], b DOUBLE PRECISION[])
RETURNS DOUBLE PRECISION AS $$
DECLARE
  dot DOUBLE PRECISION := 0;
  norm_a DOUBLE PRECISION := 0;
  norm_b DOUBLE PRECISION := 0;
  i INT;
  len INT;
BEGIN
  len := array_length(a, 1);
  IF len IS NULL OR len != array_length(b, 1) THEN
    RETURN 0;
  END IF;
  FOR i IN 1..len LOOP
    dot := dot + (a[i] * b[i]);
    norm_a := norm_a + (a[i] * a[i]);
    norm_b := norm_b + (b[i] * b[i]);
  END LOOP;
  IF norm_a = 0 OR norm_b = 0 THEN
    RETURN 0;
  END IF;
  RETURN dot / (sqrt(norm_a) * sqrt(norm_b));
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ----------------------------------------------------------------------------
-- 2. WORKING MEMORY TABLE (Task-Scoped Scratchpads with TTL)
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
-- 3. EPISODIC MEMORIES TABLE (Time-Sequenced Interaction Log)
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
-- 4. SEMANTIC MEMORIES TABLE (Multi-Provider, Flexible Dimension Vectors)
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
  embedding DOUBLE PRECISION[] NOT NULL, -- Flexible dimension vector array
  embedding_provider VARCHAR(64) NOT NULL DEFAULT 'openai',
  embedding_model VARCHAR(64) NOT NULL DEFAULT 'text-embedding-3-small',
  embedding_dimension INT NOT NULL,
  embedding_version VARCHAR(32) NOT NULL DEFAULT '1.0.0',
  importance_score INT NOT NULL DEFAULT 5 CHECK (importance_score BETWEEN 1 AND 10),
  tags TEXT[] NOT NULL DEFAULT '{}',
  version VARCHAR(32) NOT NULL DEFAULT '1.0.0',
  supersedes_id UUID REFERENCES agent_semantic_memories(id) ON DELETE SET NULL,
  is_deprecated BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT chk_semantic_dim_positive CHECK (embedding_dimension > 0)
);

CREATE INDEX IF NOT EXISTS idx_semantic_scope_dept ON agent_semantic_memories(scope, department_id);
CREATE INDEX IF NOT EXISTS idx_semantic_provider_model ON agent_semantic_memories(embedding_provider, embedding_model, embedding_dimension);
CREATE INDEX IF NOT EXISTS idx_semantic_fulltext ON agent_semantic_memories USING gin(to_tsvector('english', title || ' ' || content));

-- ----------------------------------------------------------------------------
-- 5. PROCEDURAL MEMORIES TABLE (Versioned SOP Playbooks & Metrics)
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
-- 6. ADVANCED ROW-LEVEL SECURITY POLICIES (DATABASE-LEVEL ABAC)
-- ----------------------------------------------------------------------------

ALTER TABLE agent_working_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_working_memories FORCE ROW LEVEL SECURITY;

ALTER TABLE agent_episodic_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_episodic_memories FORCE ROW LEVEL SECURITY;

ALTER TABLE agent_semantic_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_semantic_memories FORCE ROW LEVEL SECURITY;

ALTER TABLE agent_procedural_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_procedural_memories FORCE ROW LEVEL SECURITY;

-- Drop existing generic and ABAC policies if any
DROP POLICY IF EXISTS working_mem_tenant_policy ON agent_working_memories;
DROP POLICY IF EXISTS episodic_mem_tenant_policy ON agent_episodic_memories;
DROP POLICY IF EXISTS semantic_mem_tenant_policy ON agent_semantic_memories;
DROP POLICY IF EXISTS procedural_mem_tenant_policy ON agent_procedural_memories;

DROP POLICY IF EXISTS working_mem_abac_policy ON agent_working_memories;
DROP POLICY IF EXISTS episodic_mem_abac_select_policy ON agent_episodic_memories;
DROP POLICY IF EXISTS episodic_mem_abac_insert_policy ON agent_episodic_memories;
DROP POLICY IF EXISTS episodic_mem_abac_delete_policy ON agent_episodic_memories;
DROP POLICY IF EXISTS semantic_mem_abac_select_policy ON agent_semantic_memories;
DROP POLICY IF EXISTS semantic_mem_abac_write_policy ON agent_semantic_memories;
DROP POLICY IF EXISTS semantic_mem_abac_update_policy ON agent_semantic_memories;
DROP POLICY IF EXISTS procedural_mem_abac_select_policy ON agent_procedural_memories;
DROP POLICY IF EXISTS procedural_mem_abac_write_policy ON agent_procedural_memories;
DROP POLICY IF EXISTS procedural_mem_abac_update_policy ON agent_procedural_memories;

-- A. Working Memory RLS
CREATE POLICY working_mem_abac_policy ON agent_working_memories
FOR ALL USING (
  tenant_id = get_current_tenant_id()
  AND (agent_id = get_current_agent_id() OR is_current_principal_owner())
);

-- B. Episodic Memory RLS
CREATE POLICY episodic_mem_abac_select_policy ON agent_episodic_memories
FOR SELECT USING (
  tenant_id = get_current_tenant_id()
  AND (
    (scope = 'AGENT_PRIVATE' AND (agent_id = get_current_agent_id() OR is_current_principal_owner()))
    OR (scope = 'DEPARTMENT_SCOPED' AND (department_id = get_current_department_id() OR is_current_principal_executive()))
    OR (scope = 'ORGANIZATION_WIDE')
  )
);

CREATE POLICY episodic_mem_abac_insert_policy ON agent_episodic_memories
FOR INSERT WITH CHECK (
  tenant_id = get_current_tenant_id()
  AND (
    (scope = 'AGENT_PRIVATE' AND (agent_id = get_current_agent_id() OR is_current_principal_owner()))
    OR (scope = 'DEPARTMENT_SCOPED' AND (department_id = get_current_department_id() OR is_current_principal_executive()))
    OR (scope = 'ORGANIZATION_WIDE' AND is_current_principal_executive())
  )
);

CREATE POLICY episodic_mem_abac_delete_policy ON agent_episodic_memories
FOR DELETE USING (
  tenant_id = get_current_tenant_id()
  AND (
    (scope = 'AGENT_PRIVATE' AND (agent_id = get_current_agent_id() OR is_current_principal_owner()))
    OR (scope = 'DEPARTMENT_SCOPED' AND ((department_id = get_current_department_id() AND is_current_principal_director()) OR is_current_principal_executive()))
    OR (scope = 'ORGANIZATION_WIDE' AND is_current_principal_executive())
  )
);

-- C. Semantic Memory RLS
CREATE POLICY semantic_mem_abac_select_policy ON agent_semantic_memories
FOR SELECT USING (
  tenant_id = get_current_tenant_id()
  AND (
    (scope = 'AGENT_PRIVATE' AND (author_agent_id = get_current_agent_id() OR is_current_principal_owner()))
    OR (scope = 'DEPARTMENT_SCOPED' AND (department_id = get_current_department_id() OR is_current_principal_executive()))
    OR (scope = 'ORGANIZATION_WIDE')
  )
);

CREATE POLICY semantic_mem_abac_write_policy ON agent_semantic_memories
FOR INSERT WITH CHECK (
  tenant_id = get_current_tenant_id()
  AND (
    (scope = 'AGENT_PRIVATE' AND (author_agent_id = get_current_agent_id() OR is_current_principal_owner()))
    OR (scope = 'DEPARTMENT_SCOPED' AND ((department_id = get_current_department_id() AND is_current_principal_director()) OR is_current_principal_executive()))
    OR (scope = 'ORGANIZATION_WIDE' AND is_current_principal_executive())
  )
);

CREATE POLICY semantic_mem_abac_update_policy ON agent_semantic_memories
FOR UPDATE USING (
  tenant_id = get_current_tenant_id()
  AND (
    (scope = 'AGENT_PRIVATE' AND (author_agent_id = get_current_agent_id() OR is_current_principal_owner()))
    OR (scope = 'DEPARTMENT_SCOPED' AND ((department_id = get_current_department_id() AND is_current_principal_director()) OR is_current_principal_executive()))
    OR (scope = 'ORGANIZATION_WIDE' AND is_current_principal_executive())
  )
);

-- D. Procedural Memory RLS
CREATE POLICY procedural_mem_abac_select_policy ON agent_procedural_memories
FOR SELECT USING (
  tenant_id = get_current_tenant_id()
  AND (
    (scope = 'AGENT_PRIVATE' AND (author_agent_id = get_current_agent_id() OR is_current_principal_owner()))
    OR (scope = 'DEPARTMENT_SCOPED' AND (department_id = get_current_department_id() OR is_current_principal_executive()))
    OR (scope = 'ORGANIZATION_WIDE')
  )
);

CREATE POLICY procedural_mem_abac_write_policy ON agent_procedural_memories
FOR INSERT WITH CHECK (
  tenant_id = get_current_tenant_id()
  AND (
    (scope = 'AGENT_PRIVATE' AND (author_agent_id = get_current_agent_id() OR is_current_principal_owner()))
    OR (scope = 'DEPARTMENT_SCOPED' AND ((department_id = get_current_department_id() AND is_current_principal_director()) OR is_current_principal_executive()))
    OR (scope = 'ORGANIZATION_WIDE' AND is_current_principal_executive())
  )
);

CREATE POLICY procedural_mem_abac_update_policy ON agent_procedural_memories
FOR UPDATE USING (
  tenant_id = get_current_tenant_id()
  AND (
    (scope = 'AGENT_PRIVATE' AND (author_agent_id = get_current_agent_id() OR is_current_principal_owner()))
    OR (scope = 'DEPARTMENT_SCOPED' AND ((department_id = get_current_department_id() AND is_current_principal_director()) OR is_current_principal_executive()))
    OR (scope = 'ORGANIZATION_WIDE' AND is_current_principal_executive())
  )
);
