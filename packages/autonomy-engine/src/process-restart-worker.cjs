/**
 * Autonomous Multi-Process Restart Verification Worker
 * Executed in genuine isolated child processes to prove that
 * application state persists across real process deaths and restarts.
 */
const { Pool } = require('pg');

const mode = process.argv[2]; // 'write' or 'read'
const tenantId = process.argv[3];
const agentId = process.argv[4];
const taskId = process.argv[5];
const recordId = process.argv[6] || '00000000-0000-0000-0000-000000000999';

if (!mode || !tenantId || !agentId || !taskId) {
  console.error('Usage: node process-restart-worker.cjs <write|read> <tenantId> <agentId> <taskId> [recordId]');
  process.exit(1);
}

const pool = new Pool({
  host: process.env.VME_POSTGRES_HOST || 'localhost',
  port: Number(process.env.VME_POSTGRES_PORT || 5432),
  user: process.env.VME_POSTGRES_APP_USER || 'vme_app',
  password: process.env.VME_POSTGRES_APP_PASSWORD || 'vme_app_secure_password_2026',
  database: process.env.VME_POSTGRES_DB || 'virtual_mendez_empire',
  max: 2,
  idleTimeoutMillis: 5000,
});

async function run() {
  const client = await pool.connect();
  try {
    if (mode === 'write') {
      await client.query('BEGIN');
      await client.query(`
        SELECT 
          set_config('app.current_tenant_id', $1, true),
          set_config('app.current_agent_id', $2, true),
          set_config('app.current_department_id', 'technology_engineering', true),
          set_config('app.current_principal_level', 'EXECUTIVE', true),
          set_config('app.is_owner_authenticated', 'true', true)
      `, [tenantId, agentId]);

      // 1. Working memory
      await client.query(`
        INSERT INTO agent_working_memories (tenant_id, task_id, agent_id, key, value, expires_at)
        VALUES ($1, $2, $3, 'process_token', '"restart_resilience_verified"', NOW() + INTERVAL '2 hours')
        ON CONFLICT (tenant_id, task_id, key) DO UPDATE SET value = EXCLUDED.value
      `, [tenantId, taskId, agentId]);

      // 2. Episodic memory
      await client.query(`
        INSERT INTO agent_episodic_memories (
          id, tenant_id, agent_id, agent_code, department_id, task_id,
          action_type, input_summary, decision_rationale, outcome, scope,
          importance_score, status, metadata, recorded_at
        ) VALUES (
          $1, $2, $3, 'TECH-1', 'technology_engineering', $4,
          'SYSTEM_CHECK', 'Multi-process persistent memory verification',
          'Prove persistence across genuine process exit', 'PERSISTED', 'AGENT_PRIVATE',
          9, 'SUCCESS', '{}'::jsonb, NOW()
        ) ON CONFLICT (id) DO NOTHING
      `, [recordId, tenantId, agentId, taskId]);

      // 3. Semantic memory
      await client.query(`
        INSERT INTO agent_semantic_memories (
          id, tenant_id, category, title, content, embedding,
          embedding_provider, embedding_model, embedding_dimension, embedding_version,
          importance_score, tags, version, scope, is_deprecated, metadata, created_at
        ) VALUES (
          $1, $2, 'ARCHITECTURE', 'Process Isolation and Durable State Architecture',
          'Guarantees durable state recovery across real process restarts',
          '{0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8}',
          'openai', 'text-embedding-3-small', 8, '1.0.0',
          9, '{"architecture","recovery"}', '1.0.0', 'ORGANIZATION_WIDE', false, '{}'::jsonb, NOW()
        ) ON CONFLICT (id) DO NOTHING
      `, [recordId, tenantId]);

      // 4. Procedural memory
      await client.query(`
        INSERT INTO agent_procedural_memories (
          id, tenant_id, author_agent_id, author_agent_code, authorized_by,
          name, description, trigger_condition, required_capabilities, steps,
          scope, is_approved, success_count, failure_count, version, metadata, created_at
        ) VALUES (
          $1, $2, $3, 'TECH-1', 'OWNER',
          'Multi-Process Resilience Playbook', 'Procedures for node recovery',
          'On node termination', '{"process_management"}',
          '[{"stepNumber":1,"name":"spawn_worker","instruction":"reconnect"}]'::jsonb,
          'ORGANIZATION_WIDE', true, 0, 0, '1.0.0', '{}'::jsonb, NOW()
        ) ON CONFLICT (id) DO NOTHING
      `, [recordId, tenantId, agentId]);

      // 5. Consequential authorization request
      await client.query(`
        INSERT INTO consequential_authorization_requests (
          id, tenant_id, task_id, action_type, agent_id, department_id,
          parameter_hash, payload, status, requested_at, valid_until
        ) VALUES (
          $1, $2, $3, 'CAPITAL_TRANSFER', $4, 'financial_intelligence',
          'paramhash_restart', '{"amount":5000}'::jsonb, 'APPROVED', NOW(), NOW() + INTERVAL '2 hours'
        ) ON CONFLICT (id) DO NOTHING
      `, [recordId, tenantId, taskId, agentId]);

      // 6. Performance event
      await client.query(`
        INSERT INTO performance_events (
          id, tenant_id, agent_id, department_id, task_id, event_type,
          duration_ms, tokens_used, cost_usd, task_complexity, quality_score,
          is_successful, recorded_at
        ) VALUES (
          $1, $2, $3, 'technology_engineering', $4, 'PROCESS_RESTART_BENCHMARK',
          250, 1200, 0.002, 1.0, 1.0, true, NOW()
        ) ON CONFLICT (id) DO NOTHING
      `, [recordId, tenantId, agentId, taskId]);

      await client.query('COMMIT');
      console.log('WRITE_COMPLETE');
    } else if (mode === 'read') {
      await client.query('BEGIN');
      await client.query(`
        SELECT 
          set_config('app.current_tenant_id', $1, true),
          set_config('app.current_agent_id', $2, true),
          set_config('app.current_department_id', 'technology_engineering', true),
          set_config('app.current_principal_level', 'EXECUTIVE', true),
          set_config('app.is_owner_authenticated', 'true', true)
      `, [tenantId, agentId]);

      // 1. Verify working memory
      const wmRes = await client.query(`
        SELECT value FROM agent_working_memories WHERE tenant_id = $1 AND task_id = $2 AND key = 'process_token'
      `, [tenantId, taskId]);
      if (wmRes.rows.length === 0 || wmRes.rows[0].value !== 'restart_resilience_verified') {
        throw new Error(`Working memory recovery failed: expected 'restart_resilience_verified', got ${JSON.stringify(wmRes.rows[0])}`);
      }

      // 2. Verify episodic memory
      const epRes = await client.query(`
        SELECT id, input_summary FROM agent_episodic_memories WHERE id = $1 AND tenant_id = $2
      `, [recordId, tenantId]);
      if (epRes.rows.length === 0 || epRes.rows[0].input_summary !== 'Multi-process persistent memory verification') {
        throw new Error(`Episodic memory recovery failed: ${JSON.stringify(epRes.rows)}`);
      }

      // 3. Verify semantic memory
      const semRes = await client.query(`
        SELECT id, title, cosine_similarity_array(embedding, '{0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8}') as similarity
        FROM agent_semantic_memories WHERE id = $1 AND tenant_id = $2
      `, [recordId, tenantId]);
      if (semRes.rows.length === 0 || semRes.rows[0].similarity < 0.99) {
        throw new Error(`Semantic memory recovery failed: ${JSON.stringify(semRes.rows)}`);
      }

      // 4. Verify procedural memory
      const procRes = await client.query(`
        SELECT id, name, is_approved FROM agent_procedural_memories WHERE id = $1 AND tenant_id = $2
      `, [recordId, tenantId]);
      if (procRes.rows.length === 0 || procRes.rows[0].is_approved !== true) {
        throw new Error(`Procedural memory recovery failed: ${JSON.stringify(procRes.rows)}`);
      }

      // 5. Verify consequential authorization request
      const authRes = await client.query(`
        SELECT id, status FROM consequential_authorization_requests WHERE id = $1 AND tenant_id = $2
      `, [recordId, tenantId]);
      if (authRes.rows.length === 0 || authRes.rows[0].status !== 'APPROVED') {
        throw new Error(`Consequential authorization recovery failed: ${JSON.stringify(authRes.rows)}`);
      }

      // 6. Verify performance event
      const perfRes = await client.query(`
        SELECT id, event_type FROM performance_events WHERE id = $1 AND tenant_id = $2
      `, [recordId, tenantId]);
      if (perfRes.rows.length === 0 || perfRes.rows[0].event_type !== 'PROCESS_RESTART_BENCHMARK') {
        throw new Error(`Performance event recovery failed: ${JSON.stringify(perfRes.rows)}`);
      }

      // 7. Verify cross-tenant isolation under vme_app (RLS returns 0 rows)
      await client.query(`SELECT set_config('app.current_tenant_id', '00000000-0000-0000-0000-000000000002', true)`);
      const crossTenantRes = await client.query(`SELECT * FROM agent_working_memories WHERE key = 'process_token'`);
      if (crossTenantRes.rows.length !== 0) {
        throw new Error(`Cross-tenant RLS isolation failed: foreign tenant saw ${crossTenantRes.rows.length} rows`);
      }

      await client.query('COMMIT');
      console.log('READ_COMPLETE');
    }
  } finally {
    client.release();
    await pool.end();
  }
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('WORKER_ERROR:', err.message);
    process.exit(1);
  });
