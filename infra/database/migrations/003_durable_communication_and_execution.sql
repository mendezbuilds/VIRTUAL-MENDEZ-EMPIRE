-- ============================================================================
-- VIRTUAL MENDEZ EMPIRE — DURABLE COMMUNICATION, EXECUTION & PERFORMANCE
-- Migration: 003_durable_communication_and_execution.sql
-- Covers: Persistent Message Queues, Dead Letter Queue, Consequential Authorization,
--         Task Execution Evidence, and Performance Events
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. DURABLE AGENT MESSAGES / ENVELOPES
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_communication_envelopes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL UNIQUE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sender_agent_id UUID NOT NULL,
  sender_agent_code VARCHAR(32) NOT NULL,
  sender_department_id VARCHAR(64) NOT NULL REFERENCES departments(id),
  recipient_agent_id UUID NOT NULL,
  recipient_agent_code VARCHAR(32) NOT NULL,
  recipient_department_id VARCHAR(64) NOT NULL REFERENCES departments(id),
  type VARCHAR(64) NOT NULL,
  priority VARCHAR(16) NOT NULL DEFAULT 'MEDIUM',
  task_id UUID,
  payload JSONB NOT NULL,
  correlation_id UUID NOT NULL,
  causation_id UUID,
  delivery_status VARCHAR(32) NOT NULL DEFAULT 'PENDING' CHECK (delivery_status IN ('PENDING', 'DELIVERED', 'ACKNOWLEDGED', 'FAILED', 'EXPIRED')),
  retry_count INT NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  requires_response BOOLEAN NOT NULL DEFAULT false,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  acknowledged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_msg_recipient_status ON agent_communication_envelopes(recipient_agent_id, delivery_status);
CREATE INDEX IF NOT EXISTS idx_msg_correlation ON agent_communication_envelopes(correlation_id);
CREATE INDEX IF NOT EXISTS idx_msg_next_retry ON agent_communication_envelopes(delivery_status, next_retry_at);

-- ----------------------------------------------------------------------------
-- 2. MESSAGE DELIVERY ACKNOWLEDGMENTS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS message_delivery_acknowledgments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  acknowledgment_id UUID NOT NULL UNIQUE,
  message_id UUID NOT NULL REFERENCES agent_communication_envelopes(message_id) ON DELETE CASCADE,
  recipient_agent_id UUID NOT NULL,
  status VARCHAR(32) NOT NULL CHECK (status IN ('ACCEPTED', 'REJECTED', 'QUEUED')),
  rejection_reason TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- ----------------------------------------------------------------------------
-- 3. MESSAGE DEAD-LETTER QUEUE
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS message_dead_letter_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sender_agent_id UUID NOT NULL,
  recipient_agent_id UUID NOT NULL,
  type VARCHAR(64) NOT NULL,
  payload JSONB NOT NULL,
  failure_reason TEXT NOT NULL,
  retry_attempts INT NOT NULL,
  failed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_dlq_message_id ON message_dead_letter_queue(message_id);

-- ----------------------------------------------------------------------------
-- 4. CONSEQUENTIAL ACTION AUTHORIZATION REQUESTS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS consequential_authorization_requests (
  id VARCHAR(128) PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id UUID NOT NULL,
  action_type VARCHAR(64) NOT NULL CHECK (action_type IN ('LIVE_TRADING', 'CAPITAL_TRANSFER', 'EXTERNAL_OUTREACH', 'BINDING_CONTRACT', 'GOVERNANCE_OVERRIDE')),
  agent_id UUID NOT NULL,
  department_id VARCHAR(64) NOT NULL REFERENCES departments(id),
  counterparty VARCHAR(256),
  parameter_hash VARCHAR(64) NOT NULL, -- SHA-256 of normalized parameters
  payload JSONB NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'PENDING_OWNER_REVIEW' CHECK (status IN ('PENDING_OWNER_REVIEW', 'APPROVED', 'REJECTED', 'EXPIRED', 'EXECUTED')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  valid_until TIMESTAMPTZ NOT NULL,
  decided_by VARCHAR(128),
  decided_at TIMESTAMPTZ,
  decision_notes TEXT,
  executed_at TIMESTAMPTZ,
  execution_status VARCHAR(32),
  execution_result JSONB
);

CREATE INDEX IF NOT EXISTS idx_conseq_auth_status ON consequential_authorization_requests(status);
CREATE INDEX IF NOT EXISTS idx_conseq_auth_task ON consequential_authorization_requests(task_id);

-- ----------------------------------------------------------------------------
-- 5. TASK EXECUTION EVIDENCE RECORDS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS task_execution_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id UUID NOT NULL,
  assigned_agent_id UUID NOT NULL,
  tool_invoked VARCHAR(64) NOT NULL,
  authorized_capability VARCHAR(64) NOT NULL,
  execution_status VARCHAR(32) NOT NULL CHECK (execution_status IN ('PLANNED', 'ASSIGNED', 'RUNNING', 'COMPLETED', 'FAILED', 'AWAITING_APPROVAL', 'CANCELLED')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  completed_at TIMESTAMPTZ,
  duration_ms INT,
  output_data JSONB,
  artifact_references TEXT[] NOT NULL DEFAULT '{}',
  error_message TEXT,
  retry_count INT NOT NULL DEFAULT 0,
  verification_result VARCHAR(32)
);

CREATE INDEX IF NOT EXISTS idx_task_exec_task ON task_execution_records(task_id);
CREATE INDEX IF NOT EXISTS idx_task_exec_agent ON task_execution_records(assigned_agent_id);

-- ----------------------------------------------------------------------------
-- 6. PERSISTENT PERFORMANCE EVENTS & AUDIT LOGS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS performance_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL,
  department_id VARCHAR(64) NOT NULL REFERENCES departments(id),
  task_id UUID NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  duration_ms INT NOT NULL,
  tokens_used INT NOT NULL DEFAULT 0,
  cost_usd NUMERIC(12, 6) NOT NULL DEFAULT 0,
  task_complexity NUMERIC(4, 2) NOT NULL DEFAULT 1.0,
  quality_score NUMERIC(4, 2) NOT NULL DEFAULT 1.0,
  is_successful BOOLEAN NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_perf_agent_time ON performance_events(agent_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_perf_dept_time ON performance_events(department_id, recorded_at DESC);

-- ----------------------------------------------------------------------------
-- 7. AGENT PERFORMANCE REVIEWS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_performance_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL,
  agent_code VARCHAR(32) NOT NULL,
  department_id VARCHAR(64) NOT NULL REFERENCES departments(id),
  evaluation_period VARCHAR(32) NOT NULL,
  tasks_assigned INT NOT NULL DEFAULT 0,
  tasks_completed INT NOT NULL DEFAULT 0,
  tasks_failed INT NOT NULL DEFAULT 0,
  performance_score NUMERIC(5, 2) NOT NULL DEFAULT 100,
  kpi_summary JSONB,
  overall_rating VARCHAR(32) NOT NULL CHECK (overall_rating IN ('EXCEEDS_EXPECTATIONS', 'MEETS_EXPECTATIONS', 'NEEDS_IMPROVEMENT', 'CRITICAL_CONCERN')),
  strengths TEXT[] NOT NULL DEFAULT '{}',
  areas_for_improvement TEXT[] NOT NULL DEFAULT '{}',
  recommendations JSONB NOT NULL DEFAULT '[]'::jsonb,
  reviewed_by VARCHAR(128) NOT NULL,
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_perf_reviews_agent ON agent_performance_reviews(agent_id);

-- ----------------------------------------------------------------------------
-- 8. ROW LEVEL SECURITY (RLS) FOR COMMUNICATION & EXECUTION
-- ----------------------------------------------------------------------------
ALTER TABLE agent_communication_envelopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_communication_envelopes FORCE ROW LEVEL SECURITY;

ALTER TABLE message_delivery_acknowledgments ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_delivery_acknowledgments FORCE ROW LEVEL SECURITY;

ALTER TABLE message_dead_letter_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_dead_letter_queue FORCE ROW LEVEL SECURITY;

ALTER TABLE consequential_authorization_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE consequential_authorization_requests FORCE ROW LEVEL SECURITY;

ALTER TABLE task_execution_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_execution_records FORCE ROW LEVEL SECURITY;

ALTER TABLE performance_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE performance_events FORCE ROW LEVEL SECURITY;

ALTER TABLE agent_performance_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_performance_reviews FORCE ROW LEVEL SECURITY;

-- Communication Envelopes RLS
CREATE POLICY comm_envelopes_abac_policy ON agent_communication_envelopes
FOR ALL USING (
  tenant_id = get_current_tenant_id()
  AND (
    sender_agent_id = get_current_agent_id()
    OR recipient_agent_id = get_current_agent_id()
    OR is_current_principal_executive()
  )
);

-- Consequential Authorization Requests RLS
CREATE POLICY conseq_auth_abac_policy ON consequential_authorization_requests
FOR ALL USING (
  tenant_id = get_current_tenant_id()
  AND (
    agent_id = get_current_agent_id()
    OR is_current_principal_owner()
    OR is_current_principal_executive()
  )
);

-- Task Execution Records RLS
CREATE POLICY task_exec_abac_policy ON task_execution_records
FOR ALL USING (
  tenant_id = get_current_tenant_id()
);

-- Performance Events RLS
CREATE POLICY perf_events_abac_policy ON performance_events
FOR ALL USING (
  tenant_id = get_current_tenant_id()
);

-- Performance Reviews RLS
CREATE POLICY perf_reviews_abac_policy ON agent_performance_reviews
FOR ALL USING (
  tenant_id = get_current_tenant_id()
);
