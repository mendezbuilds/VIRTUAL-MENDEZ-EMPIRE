import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

const execFileAsync = promisify(execFile);

export class ExecutionSandboxError extends Error {
  constructor(message: string) {
    super(`EXECUTION SANDBOX VIOLATION: ${message}`);
    this.name = 'ExecutionSandboxError';
  }
}

export interface FileSystemToolInput {
  action: 'read' | 'write' | 'list' | 'stat' | 'exists';
  relativePath: string;
  content?: string;
}

export interface FileSystemToolOutput {
  action: string;
  relativePath: string;
  absolutePath: string;
  content?: string;
  bytesWritten?: number;
  files?: string[];
  size?: number;
  exists?: boolean;
  verified: boolean;
}

/**
 * Sandboxed real filesystem adapter. Confines all file operations within workspaceRoot.
 */
export class RealFileSystemAdapter {
  constructor(private readonly workspaceRoot: string = process.cwd()) {}

  private resolveSandboxedPath(relativePath: string): string {
    const resolved = path.resolve(this.workspaceRoot, relativePath);
    const normalizedRoot = path.resolve(this.workspaceRoot);
    if (!resolved.startsWith(normalizedRoot)) {
      throw new ExecutionSandboxError(
        `Path traversal attempt outside workspace sandbox: '${relativePath}' -> '${resolved}'`
      );
    }
    return resolved;
  }

  async execute(input: FileSystemToolInput): Promise<FileSystemToolOutput> {
    const targetPath = this.resolveSandboxedPath(input.relativePath);

    switch (input.action) {
      case 'read': {
        const content = await fs.readFile(targetPath, 'utf8');
        return {
          action: 'read',
          relativePath: input.relativePath,
          absolutePath: targetPath,
          content,
          size: Buffer.byteLength(content),
          verified: true,
        };
      }
      case 'write': {
        const dir = path.dirname(targetPath);
        await fs.mkdir(dir, { recursive: true });
        const content = input.content ?? '';
        await fs.writeFile(targetPath, content, 'utf8');
        const stat = await fs.stat(targetPath);
        return {
          action: 'write',
          relativePath: input.relativePath,
          absolutePath: targetPath,
          bytesWritten: stat.size,
          verified: true,
        };
      }
      case 'list': {
        const files = await fs.readdir(targetPath);
        return {
          action: 'list',
          relativePath: input.relativePath,
          absolutePath: targetPath,
          files,
          verified: true,
        };
      }
      case 'stat': {
        const stat = await fs.stat(targetPath);
        return {
          action: 'stat',
          relativePath: input.relativePath,
          absolutePath: targetPath,
          size: stat.size,
          verified: true,
        };
      }
      case 'exists': {
        try {
          await fs.access(targetPath);
          return {
            action: 'exists',
            relativePath: input.relativePath,
            absolutePath: targetPath,
            exists: true,
            verified: true,
          };
        } catch {
          return {
            action: 'exists',
            relativePath: input.relativePath,
            absolutePath: targetPath,
            exists: false,
            verified: true,
          };
        }
      }
      default:
        throw new Error(`Unsupported filesystem action: ${(input as any).action}`);
    }
  }
}

export interface TerminalCommandInput {
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
}

export interface TerminalCommandOutput {
  command: string;
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  verified: boolean;
}

/**
 * Sandboxed real terminal execution adapter. Executes processes with timeout controls and sandboxing.
 */
export class RealTerminalCommandAdapter {
  constructor(private readonly workspaceRoot: string = process.cwd()) {}

  async execute(input: TerminalCommandInput): Promise<TerminalCommandOutput> {
    const startTime = Date.now();
    const timeout = input.timeoutMs ?? 10000;
    const workingDir = input.cwd
      ? path.resolve(this.workspaceRoot, input.cwd)
      : this.workspaceRoot;

    if (!workingDir.startsWith(path.resolve(this.workspaceRoot))) {
      throw new ExecutionSandboxError(
        `Execution working directory '${workingDir}' outside workspace sandbox.`
      );
    }

    try {
      const { stdout, stderr } = await execFileAsync(input.command, input.args ?? [], {
        cwd: workingDir,
        timeout,
        maxBuffer: 10 * 1024 * 1024,
      });

      return {
        command: input.command,
        args: input.args ?? [],
        exitCode: 0,
        stdout: String(stdout),
        stderr: String(stderr),
        durationMs: Date.now() - startTime,
        verified: true,
      };
    } catch (err: any) {
      return {
        command: input.command,
        args: input.args ?? [],
        exitCode: err.code ?? (typeof err.status === 'number' ? err.status : 1),
        stdout: err.stdout ? String(err.stdout) : '',
        stderr: err.stderr ? String(err.stderr) : err.message,
        durationMs: Date.now() - startTime,
        verified: false,
      };
    }
  }
}

export interface HttpNetworkInput {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

export interface HttpNetworkOutput {
  url: string;
  method: string;
  statusCode: number;
  statusText: string;
  headers: Record<string, string>;
  data: unknown;
  durationMs: number;
  verified: boolean;
}

/**
 * Real HTTP network execution adapter.
 */
export class RealHttpNetworkAdapter {
  async execute(input: HttpNetworkInput): Promise<HttpNetworkOutput> {
    const startTime = Date.now();
    const timeout = input.timeoutMs ?? 5000;
    const method = input.method ?? 'GET';

    const reqHeaders: Record<string, string> = {
      'User-Agent': 'VirtualMendezEmpire-Worker/2.0',
      ...(input.headers ?? {}),
    };

    let reqBody: string | undefined = undefined;
    if (input.body !== undefined && method !== 'GET') {
      reqBody = typeof input.body === 'string' ? input.body : JSON.stringify(input.body);
      if (!reqHeaders['Content-Type']) {
        reqHeaders['Content-Type'] = 'application/json';
      }
    }

    const signal = AbortSignal.timeout(timeout);
    const response = await fetch(input.url, {
      method,
      headers: reqHeaders,
      body: reqBody,
      signal,
    });

    const durationMs = Date.now() - startTime;
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    let data: unknown;
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      data = await response.json();
    } else {
      data = await response.text();
    }

    return {
      url: input.url,
      method,
      statusCode: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      data,
      durationMs,
      verified: response.ok,
    };
  }
}

export interface TaskExecutionRecord {
  id: string;
  tenantId: string;
  taskId: string;
  assignedAgentId: string;
  toolInvoked: string;
  authorizedCapability: string;
  executionStatus: 'PLANNED' | 'ASSIGNED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'AWAITING_APPROVAL' | 'CANCELLED';
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  outputData?: Record<string, unknown>;
  artifactReferences: string[];
  errorMessage?: string;
  retryCount: number;
  verificationResult?: string;
}

/**
 * Verifiable Task Execution Recorder.
 * Records start / end timestamps, duration, exit codes / status codes, outputs, and artifacts.
 * Persists into PostgreSQL when pool is provided.
 */
export class TaskExecutionRecorder {
  private records = new Map<string, TaskExecutionRecord>();

  constructor(
    private readonly pool?: Pool,
    private readonly tenantId: string = '00000000-0000-0000-0000-000000000001'
  ) {}

  async startExecution(params: {
    taskId: string;
    agentId: string;
    toolInvoked: string;
    authorizedCapability: string;
  }): Promise<TaskExecutionRecord> {
    const id = randomUUID();
    const record: TaskExecutionRecord = {
      id,
      tenantId: this.tenantId,
      taskId: params.taskId,
      assignedAgentId: params.agentId,
      toolInvoked: params.toolInvoked,
      authorizedCapability: params.authorizedCapability,
      executionStatus: 'RUNNING',
      startedAt: new Date().toISOString(),
      artifactReferences: [],
      retryCount: 0,
    };

    this.records.set(id, record);

    if (this.pool) {
      const client = await this.pool.connect();
      try {
        await client.query(
          `INSERT INTO task_execution_records (
            id, tenant_id, task_id, assigned_agent_id, tool_invoked,
            authorized_capability, execution_status, started_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            record.id,
            record.tenantId,
            record.taskId,
            record.assignedAgentId,
            record.toolInvoked,
            record.authorizedCapability,
            record.executionStatus,
            record.startedAt,
          ]
        );
      } finally {
        client.release();
      }
    }

    return record;
  }

  async completeExecution(params: {
    recordId: string;
    status: 'COMPLETED' | 'FAILED';
    durationMs: number;
    outputData?: Record<string, unknown>;
    artifactReferences?: string[];
    errorMessage?: string;
    verificationResult?: string;
  }): Promise<TaskExecutionRecord> {
    const record = this.records.get(params.recordId);
    if (!record) {
      throw new Error(`TaskExecutionRecord '${params.recordId}' not found.`);
    }

    record.executionStatus = params.status;
    record.completedAt = new Date().toISOString();
    record.durationMs = params.durationMs;
    record.outputData = params.outputData;
    record.artifactReferences = params.artifactReferences ?? [];
    record.errorMessage = params.errorMessage;
    record.verificationResult = params.verificationResult ?? (params.status === 'COMPLETED' ? 'VERIFIED_SUCCESS' : 'VERIFIED_FAILURE');

    if (this.pool) {
      const client = await this.pool.connect();
      try {
        await client.query(
          `UPDATE task_execution_records
           SET execution_status = $1, completed_at = $2, duration_ms = $3,
               output_data = $4, artifact_references = $5, error_message = $6,
               verification_result = $7
           WHERE id = $8 AND tenant_id = $9`,
          [
            record.executionStatus,
            record.completedAt,
            record.durationMs,
            record.outputData ? JSON.stringify(record.outputData) : null,
            record.artifactReferences,
            record.errorMessage ?? null,
            record.verificationResult,
            record.id,
            this.tenantId,
          ]
        );
      } finally {
        client.release();
      }
    }

    return record;
  }

  getRecord(id: string): TaskExecutionRecord | undefined {
    return this.records.get(id);
  }

  listRecords(): TaskExecutionRecord[] {
    return Array.from(this.records.values());
  }
}
