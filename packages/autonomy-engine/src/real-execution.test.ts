import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { newDb, DataType } from 'pg-mem';
import type { Pool } from 'pg';
import { DepartmentRegistry } from '@vme/department-hierarchy';
import { EmergencySupervisor, EmergencyHaltError } from '@vme/security-governance';
import {
  RealFileSystemAdapter,
  RealTerminalCommandAdapter,
  RealHttpNetworkAdapter,
  ExecutionSandboxError,
  TaskExecutionRecorder,
} from './real-execution-adapters.js';
import { ToolExecutionRuntime, ToolExecutionError } from './tool-runtime.js';

describe('M2.5 Real Execution Adapters & Task Execution Records', () => {
  let tempSandboxDir: string;
  let hierarchy: DepartmentRegistry;
  let supervisor: EmergencySupervisor;
  let pool: Pool;
  const tenantId = '00000000-0000-0000-0000-000000000001';

  beforeEach(async () => {
    process.env.DB_SESSION_SECRET = 'test-secret-with-at-least-32-chars-entropy-abc123';
    hierarchy = new DepartmentRegistry();
    supervisor = new EmergencySupervisor(undefined, false);

    // Create a real temporary sandbox folder in project workspace
    tempSandboxDir = path.resolve(process.cwd(), '.tmp-test-sandbox-' + randomUUID().slice(0, 8));
    await fs.mkdir(tempSandboxDir, { recursive: true });

    // Setup pg-mem for persistent execution records verification
    const db = newDb();
    db.public.registerFunction({
      name: 'clock_timestamp',
      args: [],
      returns: DataType.timestamptz,
      implementation: () => new Date(),
    });
    db.public.registerFunction({
      name: 'gen_random_uuid',
      args: [],
      returns: DataType.text,
      implementation: () => randomUUID(),
    });

    db.public.none(`
      CREATE TABLE task_execution_records (
        id text PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id text NOT NULL,
        task_id text NOT NULL,
        assigned_agent_id text NOT NULL,
        tool_invoked text NOT NULL,
        authorized_capability text NOT NULL,
        execution_status text NOT NULL,
        started_at timestamptz NOT NULL DEFAULT now(),
        completed_at timestamptz,
        duration_ms int,
        output_data jsonb,
        artifact_references text[] NOT NULL DEFAULT '{}',
        error_message text,
        retry_count int NOT NULL DEFAULT 0,
        verification_result text
      );
    `);

    const { Pool: PgPool } = db.adapters.createPg();
    pool = new PgPool() as unknown as Pool;
  });

  afterEach(async () => {
    // Clean up temporary sandbox directory
    try {
      await fs.rm(tempSandboxDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  describe('RealFileSystemAdapter', () => {
    it('performs genuine write, read, stat, list, and exists operations within workspace sandbox', async () => {
      const adapter = new RealFileSystemAdapter(tempSandboxDir);

      // 1. Genuine File Write
      const testContent = 'Empire Autonomous Execution Artifact — Hash 998811';
      const writeResult = await adapter.execute({
        action: 'write',
        relativePath: 'artifacts/generated_spec.txt',
        content: testContent,
      });

      expect(writeResult.verified).toBe(true);
      expect(writeResult.bytesWritten).toBe(Buffer.byteLength(testContent));
      expect(await fs.readFile(writeResult.absolutePath, 'utf8')).toBe(testContent);

      // 2. Genuine File Read
      const readResult = await adapter.execute({
        action: 'read',
        relativePath: 'artifacts/generated_spec.txt',
      });
      expect(readResult.content).toBe(testContent);
      expect(readResult.size).toBe(Buffer.byteLength(testContent));

      // 3. Genuine Stat & Exists
      const statResult = await adapter.execute({
        action: 'stat',
        relativePath: 'artifacts/generated_spec.txt',
      });
      expect(statResult.size).toBe(Buffer.byteLength(testContent));

      const existsResult = await adapter.execute({
        action: 'exists',
        relativePath: 'artifacts/generated_spec.txt',
      });
      expect(existsResult.exists).toBe(true);

      // 4. Genuine Directory List
      const listResult = await adapter.execute({
        action: 'list',
        relativePath: 'artifacts',
      });
      expect(listResult.files).toContain('generated_spec.txt');
    });

    it('strictly prevents path traversal / sandbox escape attempts', async () => {
      const adapter = new RealFileSystemAdapter(tempSandboxDir);

      await expect(
        adapter.execute({
          action: 'read',
          relativePath: '../../../etc/passwd',
        })
      ).rejects.toThrow(ExecutionSandboxError);

      await expect(
        adapter.execute({
          action: 'write',
          relativePath: '../../outside.txt',
          content: 'malicious',
        })
      ).rejects.toThrow(ExecutionSandboxError);
    });
  });

  describe('RealTerminalCommandAdapter', () => {
    it('executes a real subprocess and captures real exit codes, stdout, and timing', async () => {
      const adapter = new RealTerminalCommandAdapter(tempSandboxDir);

      const result = await adapter.execute({
        command: 'node',
        args: ['-e', 'console.log("VME_REAL_SUBPROCESS_EXECUTED")'],
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('VME_REAL_SUBPROCESS_EXECUTED');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.verified).toBe(true);
    });

    it('captures non-zero exit codes and stderr for failed subprocesses', async () => {
      const adapter = new RealTerminalCommandAdapter(tempSandboxDir);

      const result = await adapter.execute({
        command: 'node',
        args: ['-e', 'console.error("Deliberate fatal error"); process.exit(42);'],
      });

      expect(result.exitCode).toBe(42);
      expect(result.stderr).toContain('Deliberate fatal error');
      expect(result.verified).toBe(false);
    });

    it('rejects execution when working directory attempts sandbox traversal', async () => {
      const adapter = new RealTerminalCommandAdapter(tempSandboxDir);

      await expect(
        adapter.execute({
          command: 'node',
          args: ['-v'],
          cwd: '../../outside',
        })
      ).rejects.toThrow(ExecutionSandboxError);
    });
  });

  describe('ToolExecutionRuntime & Verifiable TaskExecutionRecords', () => {
    it('executes real tools and records verifiable TaskExecutionRecords in PostgreSQL', async () => {
      const runtime = new ToolExecutionRuntime(hierarchy, {
        emergencySupervisor: supervisor,
        pool,
        tenantId,
        workspaceRoot: tempSandboxDir,
      });

      const techSpecialist = hierarchy.getAgentRecord('TECH-ARCH')!;
      const taskId = randomUUID();

      // Execute real filesystem tool through runtime
      const result = (await runtime.executeTool(
        'real_filesystem',
        {
          action: 'write',
          relativePath: 'src/solution.ts',
          content: 'export const status = "ACTIVE";',
        },
        {
          agentId: techSpecialist.id,
          agentCode: techSpecialist.agentCode,
          departmentId: techSpecialist.departmentId,
          taskId,
        }
      )) as any;

      expect(result.verified).toBe(true);
      expect(result.bytesWritten).toBeGreaterThan(0);

      // Verify task execution record was created and completed
      const records = runtime.getExecutionRecords();
      expect(records).toHaveLength(1);
      const record = records[0]!;
      expect(record.taskId).toBe(taskId);
      expect(record.toolInvoked).toBe('real_filesystem');
      expect(record.authorizedCapability).toBe('software_architecture');
      expect(record.executionStatus).toBe('COMPLETED');
      expect(record.durationMs).toBeGreaterThanOrEqual(0);
      expect(record.verificationResult).toBe('VERIFIED_SUCCESS');
      expect(record.artifactReferences).toContain(result.absolutePath);

      // Verify PostgreSQL persistent table contains record
      const client = await pool.connect();
      try {
        const dbRes = await client.query(
          `SELECT tool_invoked, execution_status, verification_result, duration_ms
           FROM task_execution_records WHERE task_id = $1`,
          [taskId]
        );
        expect(dbRes.rows).toHaveLength(1);
        expect(dbRes.rows[0].tool_invoked).toBe('real_filesystem');
        expect(dbRes.rows[0].execution_status).toBe('COMPLETED');
        expect(dbRes.rows[0].verification_result).toBe('VERIFIED_SUCCESS');
      } finally {
        client.release();
      }
    });

    it('enforces capability authorization and rejects unpermitted tool execution', async () => {
      const runtime = new ToolExecutionRuntime(hierarchy, {
        emergencySupervisor: supervisor,
        workspaceRoot: tempSandboxDir,
      });

      // Finance specialist attempts to execute technology filesystem tool
      const finSpecialist = hierarchy.getAgentRecord('FIN-FXA')!;
      const taskId = randomUUID();

      await expect(
        runtime.executeTool(
          'real_filesystem',
          { action: 'read', relativePath: 'src/solution.ts' },
          {
            agentId: finSpecialist.id,
            agentCode: finSpecialist.agentCode,
            departmentId: finSpecialist.departmentId,
            taskId,
          }
        )
      ).rejects.toThrow(ToolExecutionError);
    });

    it('immediately freezes tool execution during active emergency halt', async () => {
      const runtime = new ToolExecutionRuntime(hierarchy, {
        emergencySupervisor: supervisor,
        workspaceRoot: tempSandboxDir,
      });

      const techSpecialist = hierarchy.getAgentRecord('TECH-ARCH')!;
      const taskId = randomUUID();

      // Trigger emergency halt
      supervisor.triggerHalt('Security containment drill', 'EXEC-CISO');

      // Execution must immediately throw EmergencyHaltError
      await expect(
        runtime.executeTool(
          'real_terminal_command',
          { command: 'node', args: ['-v'] },
          {
            agentId: techSpecialist.id,
            agentCode: techSpecialist.agentCode,
            departmentId: techSpecialist.departmentId,
            taskId,
          }
        )
      ).rejects.toThrow(EmergencyHaltError);
    });
  });
});
