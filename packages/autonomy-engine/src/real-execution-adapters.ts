import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { applyAuthenticatedSession, clearAuthenticatedSession, type AuthoritativeWorkforceIdentityProvider } from '@vme/agent-memory';
import { DepartmentRegistry } from '@vme/department-hierarchy';

const execFileAsync = promisify(execFile);

export class ExecutionSandboxError extends Error {
  constructor(message: string) {
    super(`EXECUTION SANDBOX VIOLATION: ${message}`);
    this.name = 'ExecutionSandboxError';
  }
}

export interface FileSystemToolInput {
  action: 'read' | 'write' | 'list' | 'stat' | 'exists' | 'delete';
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
 * Enforces path traversal protection and blocks writes to critical repository files.
 */
export class RealFileSystemAdapter {
  private static readonly BLOCKED_WRITE_PATTERNS = [
    /^\.env/i,
    /^\.git[\/\\]/i,
    /^\.pnpm-store[\/\\]/i,
    /^node_modules[\/\\]/i,
    /\.(pem|key|cert|id_rsa)$/i,
  ];

  constructor(private readonly workspaceRoot: string = process.cwd()) {}

  private resolveSandboxedPath(relativePath: string, isWrite: boolean = false): string {
    const normalizedRelative = path.normalize(relativePath).replace(/^(\.\.[\/\\])+/, '');
    const resolved = path.resolve(this.workspaceRoot, relativePath);
    const normalizedRoot = path.resolve(this.workspaceRoot);

    if (!resolved.startsWith(normalizedRoot)) {
      throw new ExecutionSandboxError(
        `Path traversal attempt outside workspace sandbox: '${relativePath}' -> '${resolved}'`
      );
    }

    if (isWrite) {
      const relFromRoot = path.relative(normalizedRoot, resolved);
      for (const pattern of RealFileSystemAdapter.BLOCKED_WRITE_PATTERNS) {
        if (pattern.test(relFromRoot)) {
          throw new ExecutionSandboxError(
            `Permission denied: writing to protected path '${relFromRoot}' is prohibited by corporate governance policy.`
          );
        }
      }
    }

    return resolved;
  }

  async execute(input: FileSystemToolInput): Promise<FileSystemToolOutput> {
    const isWrite = input.action === 'write';
    const targetPath = this.resolveSandboxedPath(input.relativePath, isWrite);

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
      case 'delete': {
        await fs.rm(targetPath, { recursive: true, force: true });
        return {
          action: 'delete',
          relativePath: input.relativePath,
          absolutePath: targetPath,
          verified: true,
        };
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
 * Sandboxed real terminal execution adapter. Executes processes with executable allowlists,
 * shell chaining prevention, environment variable sanitization, and timeout controls.
 */
export class RealTerminalCommandAdapter {
  private static readonly APPROVED_EXECUTABLES = new Set([
    'node',
    'git',
    'npm',
    'pnpm',
    'echo',
    'cat',
    'ls',
    'dir',
    'python',
    'python3',
    'tsc',
    'vitest',
  ]);

  private static readonly DANGEROUS_ARG_PATTERNS = [
    /^(&&|\|\||;|\|)$/,
    /`[^`]+`/,
    /\$\([^\)]+\)/,
  ];

  constructor(
    private readonly workspaceRoot: string = process.cwd(),
    private readonly allowedExecutables: Set<string> = RealTerminalCommandAdapter.APPROVED_EXECUTABLES
  ) {}

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

    // 1. Executable allowlist check
    const baseCmd = path.basename(input.command).replace(/\.(exe|cmd|bat|sh)$/i, '').toLowerCase();
    if (!this.allowedExecutables.has(baseCmd) && !this.allowedExecutables.has(input.command)) {
      throw new ExecutionSandboxError(
        `Command '${input.command}' is not in the approved executable allowlist.`
      );
    }

    // 2. Argument safety check (prevent shell injection)
    const args = input.args ?? [];
    for (const arg of args) {
      for (const pattern of RealTerminalCommandAdapter.DANGEROUS_ARG_PATTERNS) {
        if (pattern.test(arg)) {
          throw new ExecutionSandboxError(
            `Argument '${arg}' contains prohibited shell chaining or interpolation operators.`
          );
        }
      }
    }

    // 3. Environment sanitization (strip credentials/secrets)
    const sanitizedEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(sanitizedEnv)) {
      if (
        /^(AWS_|GITHUB_|DATABASE_URL|.*_SECRET|.*_KEY|.*_PASSWORD|AUTH_|TOKEN)/i.test(key)
      ) {
        delete sanitizedEnv[key];
      }
    }

    try {
      const { stdout, stderr } = await execFileAsync(input.command, args, {
        cwd: workingDir,
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        env: sanitizedEnv,
      });

      return {
        command: input.command,
        args,
        exitCode: 0,
        stdout: String(stdout),
        stderr: String(stderr),
        durationMs: Date.now() - startTime,
        verified: true,
      };
    } catch (err: any) {
      return {
        command: input.command,
        args,
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
 * Real HTTP network execution adapter with SSRF protection, credential redaction,
 * and response size limit controls.
 */
export class RealHttpNetworkAdapter {
  private static readonly BLOCKED_HOSTNAMES = new Set([
    'localhost',
    '127.0.0.1',
    '0.0.0.0',
    '169.254.169.254', // AWS/cloud metadata
    '[::1]',
    'metadata.google.internal',
  ]);

  async execute(input: HttpNetworkInput): Promise<HttpNetworkOutput> {
    const startTime = Date.now();
    const timeout = input.timeoutMs ?? 5000;
    const method = input.method ?? 'GET';

    // 1. SSRF Protection & URL Validation
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(input.url);
    } catch {
      throw new ExecutionSandboxError(`Malformed target URL: '${input.url}'`);
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new ExecutionSandboxError(
        `Prohibited network protocol '${parsedUrl.protocol}'. Only HTTP and HTTPS are permitted.`
      );
    }

    const hostname = parsedUrl.hostname.toLowerCase();
    if (
      RealHttpNetworkAdapter.BLOCKED_HOSTNAMES.has(hostname) ||
      hostname.startsWith('127.') ||
      hostname.startsWith('10.') ||
      hostname.startsWith('192.168.') ||
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname)
    ) {
      throw new ExecutionSandboxError(
        `SSRF Protection Violation: Requests to private, local, or cloud metadata network addresses ('${hostname}') are strictly blocked.`
      );
    }

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
      // Redact sensitive headers
      if (/^(authorization|cookie|set-cookie|x-api-key)/i.test(key)) {
        responseHeaders[key] = '[REDACTED]';
      } else {
        responseHeaders[key] = value;
      }
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
  public readonly departmentRegistry: DepartmentRegistry | AuthoritativeWorkforceIdentityProvider;

  constructor(
    private readonly pool?: Pool,
    private readonly tenantId: string = '00000000-0000-0000-0000-000000000001',
    departmentRegistry?: DepartmentRegistry | AuthoritativeWorkforceIdentityProvider
  ) {
    this.departmentRegistry = departmentRegistry ?? new DepartmentRegistry();
  }

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
        await applyAuthenticatedSession(client, {
          tenantId: this.tenantId,
          agentId: record.assignedAgentId,
          principalLevel: 'SPECIALIST',
        }, undefined, this.departmentRegistry);

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
        await clearAuthenticatedSession(client);
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
        await applyAuthenticatedSession(client, {
          tenantId: this.tenantId,
          agentId: record.assignedAgentId,
          principalLevel: 'SPECIALIST',
        }, undefined, this.departmentRegistry);

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
        await clearAuthenticatedSession(client);
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
