import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface PostgresTestConfig {
  host: string;
  port: number;
  adminUser: string;
  adminPassword: string;
  appUser: string;
  appPassword: string;
  roUser: string;
  roPassword: string;
  database: string;
}

export const DEFAULT_PG_CONFIG: PostgresTestConfig = {
  host: process.env.VME_POSTGRES_HOST ?? 'localhost',
  port: Number(process.env.VME_POSTGRES_PORT ?? 5432),
  adminUser: process.env.VME_POSTGRES_USER ?? 'vme_admin',
  adminPassword: process.env.VME_POSTGRES_PASSWORD ?? 'vme_secure_dev_password_change_in_prod',
  appUser: process.env.VME_POSTGRES_APP_USER ?? 'vme_app',
  appPassword: process.env.VME_POSTGRES_APP_PASSWORD ?? 'vme_app_secure_password_2026',
  roUser: process.env.VME_POSTGRES_RO_USER ?? 'vme_readonly',
  roPassword: process.env.VME_POSTGRES_RO_PASSWORD ?? 'vme_readonly_secure_password_2026',
  database: process.env.VME_POSTGRES_DB ?? 'virtual_mendez_empire',
};

/**
 * Creates a pool for the admin/superuser role.
 */
export function createAdminPool(config: PostgresTestConfig = DEFAULT_PG_CONFIG): Pool {
  return new Pool({
    host: config.host,
    port: config.port,
    user: config.adminUser,
    password: config.adminPassword,
    database: config.database,
    max: 10,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 5000,
  });
}

/**
 * Creates a pool for the least-privilege application role (vme_app: NOSUPERUSER, NOBYPASSRLS).
 */
export function createAppPool(config: PostgresTestConfig = DEFAULT_PG_CONFIG, max = 10): Pool {
  return new Pool({
    host: config.host,
    port: config.port,
    user: config.appUser,
    password: config.appPassword,
    database: config.database,
    max,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 5000,
  });
}

/**
 * Creates a pool for the read-only auditor role (vme_readonly: NOSUPERUSER, NOBYPASSRLS, SELECT only).
 */
export function createReadOnlyPool(config: PostgresTestConfig = DEFAULT_PG_CONFIG): Pool {
  return new Pool({
    host: config.host,
    port: config.port,
    user: config.roUser,
    password: config.roPassword,
    database: config.database,
    max: 5,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 5000,
  });
}

/**
 * Ensures genuine PostgreSQL is available. Fails immediately and explicitly if unreachable.
 * Never falls back to pg-mem, mocks, or in-memory implementations.
 */
export async function assertGenuinePostgresAvailable(pool: Pool): Promise<{
  version: string;
  currentUser: string;
  currentDatabase: string;
}> {
  try {
    const res = await pool.query(`
      SELECT 
        version() as version,
        current_user as "currentUser",
        current_database() as "currentDatabase"
    `);
    const row = res.rows[0];
    if (!row || !row.version.includes('PostgreSQL')) {
      throw new Error(
        `GENUINE POSTGRESQL VALIDATION FAILED: Server returned unexpected version string: '${row?.version}'. Real PostgreSQL instance required.`
      );
    }
    return row;
  } catch (err: unknown) {
    throw new Error(
      `GENUINE POSTGRESQL UNAVAILABLE: Failed connecting to actual PostgreSQL database. Real PostgreSQL instance is required for integration tests. Mocks and pg-mem are strictly forbidden. Cause: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Applies all canonical Phase 2 migrations (001, 002, 003, 004) in sequence against PostgreSQL.
 */
export async function executeRealMigrations(pool: Pool): Promise<string[]> {
  // Resolve migrations directory relative to workspace root
  const candidates = [
    resolve(process.cwd(), 'infra/database/migrations'),
    resolve(process.cwd(), '../../infra/database/migrations'),
    resolve(__dirname, '../../../infra/database/migrations'),
  ];

  let migrationsDir: string | undefined;
  for (const dir of candidates) {
    try {
      const testFile = join(dir, '001_initial_schema.sql');
      readFileSync(testFile);
      migrationsDir = dir;
      break;
    } catch {
      // continue search
    }
  }

  if (!migrationsDir) {
    throw new Error('Unable to locate migrations directory (infra/database/migrations).');
  }

  const migrationFiles = [
    '001_initial_schema.sql',
    '002_agent_memory_schema.sql',
    '003_durable_communication_and_execution.sql',
    '004_least_privilege_roles.sql',
  ];

  const executed: string[] = [];

  for (const file of migrationFiles) {
    const fullPath = join(migrationsDir, file);
    const sql = readFileSync(fullPath, 'utf-8');
    const client = await pool.connect();
    try {
      await client.query(sql);
      executed.push(file);
    } finally {
      client.release();
    }
  }

  return executed;
}
