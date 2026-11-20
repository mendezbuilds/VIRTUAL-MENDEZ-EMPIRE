-- ============================================================================
-- VIRTUAL MENDEZ EMPIRE — SECURE DATABASE IDENTITY & VERIFIED ABAC CONTEXT
-- Migration: 005_secure_database_identity.sql
-- Enforces: Cryptographically Verified Database Identity Claims
-- Protects against: Caller-Supplied GUC Forgery and Privilege Elevation
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ----------------------------------------------------------------------------
-- 1. ISOLATED SYSTEM AUTH SECRETS TABLE
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS system_auth_secrets (
  key_name VARCHAR(64) PRIMARY KEY,
  secret_value TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- Deny all direct access to PUBLIC, vme_app, and vme_readonly
-- Only superuser / database owner can access this table directly
REVOKE ALL ON system_auth_secrets FROM PUBLIC, vme_app, vme_readonly;

-- Seed canonical default session signing secret
INSERT INTO system_auth_secrets (key_name, secret_value)
VALUES ('session_signing_secret', 'vme-canonical-db-auth-hmac-secret-2026')
ON CONFLICT (key_name) DO UPDATE SET 
  secret_value = EXCLUDED.secret_value,
  updated_at = clock_timestamp();

-- ----------------------------------------------------------------------------
-- 2. CANONICAL CLAIMS FORMATTER & VERIFICATION FUNCTIONS
-- ----------------------------------------------------------------------------

-- Canonicalize JSON claims into an immutable, deterministically-ordered string
-- Format: tenantId:agentId:departmentId:principalLevel:isOwner:expiresAt:nonce
CREATE OR REPLACE FUNCTION canonicalize_claims(claims JSONB)
RETURNS TEXT AS $$
BEGIN
  RETURN CONCAT(
    COALESCE(claims->>'tenantId', ''), ':',
    COALESCE(claims->>'agentId', ''), ':',
    COALESCE(claims->>'departmentId', ''), ':',
    COALESCE(claims->>'principalLevel', 'SPECIALIST'), ':',
    CASE WHEN (claims->>'isOwner')::BOOLEAN IS TRUE THEN 'true' ELSE 'false' END, ':',
    COALESCE(claims->>'expiresAt', '0'), ':',
    COALESCE(claims->>'nonce', '')
  );
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Internal helper: verifies current session claims against isolated signing secret
CREATE OR REPLACE FUNCTION get_verified_claims()
RETURNS JSONB AS $$
DECLARE
  v_claims_raw TEXT;
  v_sig_raw TEXT;
  v_claims JSONB;
  v_secret TEXT;
  v_canonical TEXT;
  v_expected_sig TEXT;
  v_expires_at BIGINT;
  v_now_epoch BIGINT;
BEGIN
  v_claims_raw := current_setting('app.verified_claims', true);
  v_sig_raw := current_setting('app.verified_signature', true);

  IF v_claims_raw IS NULL OR v_claims_raw = '' OR v_sig_raw IS NULL OR v_sig_raw = '' THEN
    RETURN NULL;
  END IF;

  BEGIN
    v_claims := v_claims_raw::JSONB;
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
  END;

  SELECT secret_value INTO v_secret FROM system_auth_secrets WHERE key_name = 'session_signing_secret';
  IF v_secret IS NULL THEN
    RETURN NULL;
  END IF;

  v_expires_at := (v_claims->>'expiresAt')::BIGINT;
  v_now_epoch := CAST(EXTRACT(EPOCH FROM clock_timestamp()) AS BIGINT);
  IF v_expires_at IS NULL OR v_expires_at < v_now_epoch THEN
    RETURN NULL;
  END IF;

  v_canonical := canonicalize_claims(v_claims);
  v_expected_sig := encode(hmac(v_canonical::bytea, v_secret::bytea, 'sha256'), 'hex');

  IF length(v_sig_raw) != 64 OR lower(v_sig_raw) != lower(v_expected_sig) THEN
    RETURN NULL;
  END IF;

  RETURN v_claims;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public;

-- Sets transaction-scoped verified claims with HMAC-SHA256 signature verification (JSONB)
CREATE OR REPLACE FUNCTION set_authenticated_session(claims JSONB, signature TEXT)
RETURNS BOOLEAN AS $$
DECLARE
  v_secret TEXT;
  v_canonical TEXT;
  v_expected_sig TEXT;
  v_expires_at BIGINT;
  v_now_epoch BIGINT;
BEGIN
  IF claims IS NULL OR signature IS NULL THEN
    RAISE EXCEPTION 'CRITICAL SECURITY VIOLATION: Missing claims or signature';
  END IF;

  SELECT secret_value INTO v_secret FROM system_auth_secrets WHERE key_name = 'session_signing_secret';
  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'CRITICAL SECURITY VIOLATION: Database session signing secret not configured';
  END IF;

  v_expires_at := (claims->>'expiresAt')::BIGINT;
  v_now_epoch := CAST(EXTRACT(EPOCH FROM clock_timestamp()) AS BIGINT);
  IF v_expires_at IS NULL OR v_expires_at < v_now_epoch THEN
    RAISE EXCEPTION 'CRITICAL SECURITY VIOLATION: Database session claims expired or invalid timestamp';
  END IF;

  v_canonical := canonicalize_claims(claims);
  v_expected_sig := encode(hmac(v_canonical::bytea, v_secret::bytea, 'sha256'), 'hex');

  IF length(signature) != 64 OR lower(signature) != lower(v_expected_sig) THEN
    RAISE EXCEPTION 'CRITICAL SECURITY VIOLATION: Invalid database session authentication signature';
  END IF;

  -- Store verified claims and signature in session settings
  PERFORM set_config('app.verified_claims', claims::text, false);
  PERFORM set_config('app.verified_signature', lower(signature), false);

  -- Set legacy session settings for backward-compatibility with non-RLS queries
  PERFORM set_config('app.current_tenant_id', COALESCE(claims->>'tenantId', ''), false);
  PERFORM set_config('app.current_agent_id', COALESCE(claims->>'agentId', ''), false);
  PERFORM set_config('app.current_department_id', COALESCE(claims->>'departmentId', ''), false);
  PERFORM set_config('app.current_principal_level', COALESCE(claims->>'principalLevel', 'SPECIALIST'), false);
  PERFORM set_config('app.is_owner_authenticated', CASE WHEN (claims->>'isOwner')::BOOLEAN IS TRUE THEN 'true' ELSE 'false' END, false);

  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;

-- Overload: accept JSON input and cast to JSONB
CREATE OR REPLACE FUNCTION set_authenticated_session(claims JSON, signature TEXT)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN set_authenticated_session(claims::JSONB, signature);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;

-- Clears session authentication state and verified claims
CREATE OR REPLACE FUNCTION clear_authenticated_session()
RETURNS VOID AS $$
BEGIN
  PERFORM set_config('app.verified_claims', '', false);
  PERFORM set_config('app.verified_signature', '', false);
  PERFORM set_config('app.current_tenant_id', '', false);
  PERFORM set_config('app.current_agent_id', '', false);
  PERFORM set_config('app.current_department_id', '', false);
  PERFORM set_config('app.current_principal_level', '', false);
  PERFORM set_config('app.is_owner_authenticated', 'false', false);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;

-- ----------------------------------------------------------------------------
-- 3. HARDENED ABAC & SESSION CONTEXT SECURITY FUNCTIONS
-- ----------------------------------------------------------------------------
-- These functions NO LONGER trust arbitrary caller-supplied GUC values.
-- They strictly extract attributes from cryptographically verified claims.

CREATE OR REPLACE FUNCTION get_current_tenant_id() RETURNS UUID AS $$
DECLARE
  v_claims JSONB := get_verified_claims();
BEGIN
  IF v_claims IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN NULLIF(v_claims->>'tenantId', '')::UUID;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public;

CREATE OR REPLACE FUNCTION get_current_agent_id() RETURNS UUID AS $$
DECLARE
  v_claims JSONB := get_verified_claims();
BEGIN
  IF v_claims IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN NULLIF(v_claims->>'agentId', '')::UUID;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public;

CREATE OR REPLACE FUNCTION get_current_department_id() RETURNS VARCHAR AS $$
DECLARE
  v_claims JSONB := get_verified_claims();
BEGIN
  IF v_claims IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN NULLIF(v_claims->>'departmentId', '');
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public;

CREATE OR REPLACE FUNCTION get_current_principal_level() RETURNS VARCHAR AS $$
DECLARE
  v_claims JSONB := get_verified_claims();
BEGIN
  IF v_claims IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN COALESCE(NULLIF(v_claims->>'principalLevel', ''), 'SPECIALIST');
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public;

CREATE OR REPLACE FUNCTION is_current_principal_owner() RETURNS BOOLEAN AS $$
DECLARE
  v_claims JSONB := get_verified_claims();
BEGIN
  IF v_claims IS NULL THEN
    RETURN FALSE;
  END IF;
  RETURN ((v_claims->>'isOwner')::BOOLEAN IS TRUE)
     AND (COALESCE(v_claims->>'principalLevel', '') = 'OWNER' 
          OR COALESCE(v_claims->>'agentId', '') = '00000000-0000-0000-0000-000000000000');
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public;

CREATE OR REPLACE FUNCTION is_current_principal_executive() RETURNS BOOLEAN AS $$
DECLARE
  v_claims JSONB := get_verified_claims();
BEGIN
  IF v_claims IS NULL THEN
    RETURN FALSE;
  END IF;
  RETURN is_current_principal_owner() 
      OR COALESCE(v_claims->>'principalLevel', '') = 'EXECUTIVE'
      OR COALESCE(v_claims->>'departmentId', '') = 'executive_office';
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public;

CREATE OR REPLACE FUNCTION is_current_principal_director() RETURNS BOOLEAN AS $$
DECLARE
  v_claims JSONB := get_verified_claims();
BEGIN
  IF v_claims IS NULL THEN
    RETURN FALSE;
  END IF;
  RETURN is_current_principal_executive() 
      OR COALESCE(v_claims->>'principalLevel', '') = 'DIRECTOR';
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public;

-- ----------------------------------------------------------------------------
-- 4. GRANTS TO LEAST-PRIVILEGE ROLES
-- ----------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION canonicalize_claims(JSONB) TO vme_app, vme_readonly;
GRANT EXECUTE ON FUNCTION get_verified_claims() TO vme_app, vme_readonly;
GRANT EXECUTE ON FUNCTION set_authenticated_session(JSONB, TEXT) TO vme_app, vme_readonly;
GRANT EXECUTE ON FUNCTION set_authenticated_session(JSON, TEXT) TO vme_app, vme_readonly;
GRANT EXECUTE ON FUNCTION clear_authenticated_session() TO vme_app, vme_readonly;

GRANT EXECUTE ON FUNCTION get_current_tenant_id() TO vme_app, vme_readonly;
GRANT EXECUTE ON FUNCTION get_current_agent_id() TO vme_app, vme_readonly;
GRANT EXECUTE ON FUNCTION get_current_department_id() TO vme_app, vme_readonly;
GRANT EXECUTE ON FUNCTION get_current_principal_level() TO vme_app, vme_readonly;
GRANT EXECUTE ON FUNCTION is_current_principal_owner() TO vme_app, vme_readonly;
GRANT EXECUTE ON FUNCTION is_current_principal_executive() TO vme_app, vme_readonly;
GRANT EXECUTE ON FUNCTION is_current_principal_director() TO vme_app, vme_readonly;
