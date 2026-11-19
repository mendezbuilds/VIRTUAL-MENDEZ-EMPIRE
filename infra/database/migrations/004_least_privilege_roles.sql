-- ============================================================================
-- VIRTUAL MENDEZ EMPIRE — LEAST-PRIVILEGE APPLICATION & AUDIT ROLES
-- Migration: 004_least_privilege_roles.sql
-- Enforces: Principle of Least Privilege, Non-Bypass RLS Enforcement,
--           Read-Only Audit Isolation, and Explicit Permission Scoping
-- ============================================================================

DO $$
BEGIN
  -- 1. Application Execution Role (Least-Privilege: NO Superuser, NO BypassRLS)
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'vme_app') THEN
    CREATE ROLE vme_app WITH 
      LOGIN 
      PASSWORD 'vme_app_secure_password_2026'
      NOSUPERUSER 
      NOCREATEDB 
      NOCREATEROLE 
      NOBYPASSRLS;
  END IF;

  -- 2. Read-Only Auditor Role (Read-Only: SELECT and USAGE only, NO Mutation)
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'vme_readonly') THEN
    CREATE ROLE vme_readonly WITH 
      LOGIN 
      PASSWORD 'vme_readonly_secure_password_2026'
      NOSUPERUSER 
      NOCREATEDB 
      NOCREATEROLE 
      NOBYPASSRLS;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 3. SCHEMA & DATABASE CONNECTIVITY GRANTS
-- ----------------------------------------------------------------------------
GRANT CONNECT ON DATABASE virtual_mendez_empire TO vme_app, vme_readonly;
GRANT USAGE ON SCHEMA public TO vme_app, vme_readonly;

-- ----------------------------------------------------------------------------
-- 4. APPLICATION ROLE PERMISSIONS (DML + Sequences + Functions)
-- ----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO vme_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO vme_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO vme_app;

-- Explicitly grant execute on security functions so RLS evaluation succeeds
GRANT EXECUTE ON FUNCTION get_current_tenant_id() TO vme_app, vme_readonly;
GRANT EXECUTE ON FUNCTION get_current_agent_id() TO vme_app, vme_readonly;
GRANT EXECUTE ON FUNCTION get_current_department_id() TO vme_app, vme_readonly;
GRANT EXECUTE ON FUNCTION get_current_principal_level() TO vme_app, vme_readonly;
GRANT EXECUTE ON FUNCTION is_current_principal_owner() TO vme_app, vme_readonly;
GRANT EXECUTE ON FUNCTION is_current_principal_executive() TO vme_app, vme_readonly;
GRANT EXECUTE ON FUNCTION is_current_principal_director() TO vme_app, vme_readonly;
GRANT EXECUTE ON FUNCTION cosine_similarity_array(DOUBLE PRECISION[], DOUBLE PRECISION[]) TO vme_app, vme_readonly;

-- ----------------------------------------------------------------------------
-- 5. READ-ONLY AUDIT ROLE PERMISSIONS (SELECT + USAGE only, NO Mutations)
-- ----------------------------------------------------------------------------
GRANT SELECT ON ALL TABLES IN SCHEMA public TO vme_readonly;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO vme_readonly;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM vme_readonly;

-- ----------------------------------------------------------------------------
-- 6. DEFAULT PRIVILEGES FOR FUTURE OBJECTS
-- ----------------------------------------------------------------------------
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vme_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO vme_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO vme_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO vme_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO vme_readonly;
