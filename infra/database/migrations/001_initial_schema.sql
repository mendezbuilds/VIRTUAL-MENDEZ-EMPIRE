-- ============================================================================
-- VIRTUAL MENDEZ EMPIRE — INITIAL DATABASE SCHEMA
-- Migration: 001_initial_schema.sql
-- Hardened for: Commit Ordering, Immutability, Pinned Search Path, Concurrency Idempotency
-- ============================================================================

-- Ensure required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";

-- ----------------------------------------------------------------------------
-- 1. SECURITY DEFINER HARDENING & TENANT FUNCTIONS
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_current_tenant_id()
RETURNS UUID AS $$
BEGIN
  RETURN NULLIF(current_setting('app.current_tenant_id', true), '')::UUID;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public;

REVOKE EXECUTE ON FUNCTION get_current_tenant_id() FROM PUBLIC;

-- ----------------------------------------------------------------------------
-- 2. TENANTS & DEPARTMENTS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(128) NOT NULL,
  slug VARCHAR(64) UNIQUE NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS departments (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  description TEXT NOT NULL,
  budget_monthly_usd NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- Seed Initial 9 Departments
INSERT INTO departments (id, name, description, budget_monthly_usd) VALUES
  ('executive_office', 'Executive Office', 'Autonomous corporate steering, board oversight & strategic directives', 10000.00),
  ('financial_intelligence', 'Financial Intelligence', 'Treasury, double-entry accounting, FX & Crypto trading research', 50000.00),
  ('technology_engineering', 'Technology & Engineering', 'Software architecture, core platform development & tooling', 25000.00),
  ('business_development', 'Business Development', 'Strategic partnerships, B2B sales & subsidiary expansion', 15000.00),
  ('marketing_growth', 'Marketing & Growth', 'Brand intelligence, content distribution & audience acquisition', 12000.00),
  ('operations_administration', 'Operations & Administration', 'Infrastructure workflows, compliance & process auditing', 8000.00),
  ('opportunity_acquisition', 'Opportunity Acquisition', 'Dual-track job/contract discovery & client lead generation', 10000.00),
  ('research_intelligence', 'Research & Intelligence', 'Market forecasting, competitive intelligence & research papers', 7000.00),
  ('security_governance', 'Security & Governance', 'Multi-tier circuit breakers, credential vault & access governance', 15000.00)
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 3. HARDENED IMMUTABLE FINANCIAL LEDGER
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ledger_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  code VARCHAR(32) NOT NULL,
  name VARCHAR(128) NOT NULL,
  type VARCHAR(16) NOT NULL CHECK (type IN ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE')),
  currency VARCHAR(8) NOT NULL,
  department_id VARCHAR(64) REFERENCES departments(id),
  balance NUMERIC(24, 8) NOT NULL DEFAULT 0.00000000,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_tenant_account_code UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS financial_journal_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  entry_number BIGINT NOT NULL,
  description VARCHAR(512) NOT NULL,
  reference_type VARCHAR(64) NOT NULL,
  reference_id VARCHAR(128) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED', 'VOIDED')),
  previous_hash CHAR(64) NOT NULL,
  payload_hash CHAR(64) NOT NULL,
  entry_hash CHAR(64) NOT NULL,
  tx_id VARCHAR(128) NOT NULL,
  committed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_tenant_entry_number UNIQUE (tenant_id, entry_number)
);

CREATE TABLE IF NOT EXISTS financial_ledger_postings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_entry_id UUID NOT NULL REFERENCES financial_journal_entries(id) ON DELETE RESTRICT,
  account_id UUID NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  direction VARCHAR(6) NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
  amount NUMERIC(24, 8) NOT NULL CHECK (amount > 0),
  currency VARCHAR(8) NOT NULL,
  description VARCHAR(256),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- Database-Level Immutability Trigger Functions
CREATE OR REPLACE FUNCTION prevent_ledger_modification()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'CRITICAL SECURITY VIOLATION: Operation % is strictly prohibited on immutable financial ledger table %',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;

CREATE OR REPLACE TRIGGER trg_immutable_journal_entries
BEFORE UPDATE OR DELETE ON financial_journal_entries
FOR EACH ROW EXECUTE FUNCTION prevent_ledger_modification();

CREATE OR REPLACE TRIGGER trg_immutable_ledger_postings
BEFORE UPDATE OR DELETE ON financial_ledger_postings
FOR EACH ROW EXECUTE FUNCTION prevent_ledger_modification();

-- ----------------------------------------------------------------------------
-- 4. CONCURRENCY-SAFE IDEMPOTENCY
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS idempotency_records (
  key VARCHAR(256) NOT NULL,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  payload_hash CHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL CHECK (status IN ('PROCESSING', 'COMPLETED', 'FAILED')),
  status_code INT,
  response_headers JSONB,
  response_body JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, key)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_records(expires_at);

-- ----------------------------------------------------------------------------
-- 5. RELIABLE TRANSACTIONAL OUTBOX
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS system_outbox_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  stream_id VARCHAR(128) NOT NULL,
  sequence_number BIGINT NOT NULL,
  aggregate_type VARCHAR(64) NOT NULL,
  aggregate_id VARCHAR(128) NOT NULL,
  event_type VARCHAR(128) NOT NULL,
  payload JSONB NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  correlation_id UUID NOT NULL,
  causation_id UUID,
  status VARCHAR(16) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PUBLISHED', 'FAILED', 'DEAD_LETTER')),
  retry_count INT NOT NULL DEFAULT 0,
  last_error TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  published_at TIMESTAMPTZ,
  CONSTRAINT uq_stream_sequence UNIQUE (stream_id, sequence_number)
);

CREATE INDEX IF NOT EXISTS idx_outbox_pending ON system_outbox_events(status, occurred_at) WHERE status = 'PENDING';

-- ----------------------------------------------------------------------------
-- 6. MULTI-TIER EMERGENCY SHUTDOWN CONTROL
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS system_controls (
  control_key VARCHAR(64) PRIMARY KEY,
  is_active BOOLEAN NOT NULL DEFAULT false,
  reason TEXT,
  triggered_by VARCHAR(128),
  triggered_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO system_controls (control_key, is_active, reason)
VALUES ('EMERGENCY_HALT', false, 'System normal')
ON CONFLICT (control_key) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 7. ROW-LEVEL SECURITY ENFORCEMENT
-- ----------------------------------------------------------------------------
ALTER TABLE ledger_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_accounts FORCE ROW LEVEL SECURITY;

ALTER TABLE financial_journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_journal_entries FORCE ROW LEVEL SECURITY;

ALTER TABLE idempotency_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_records FORCE ROW LEVEL SECURITY;

ALTER TABLE system_outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_outbox_events FORCE ROW LEVEL SECURITY;

