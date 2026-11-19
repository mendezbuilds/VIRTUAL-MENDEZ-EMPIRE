import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DepartmentRegistry } from '@vme/department-hierarchy';
import { EmergencySupervisor } from '@vme/security-governance';
import {
  ConsequentialPolicyEngine,
  OwnerAuthenticationService,
  computeParameterHash,
} from '@vme/agent-communication';
import { OWNER_PRINCIPAL_ID, CANONICAL_OWNER_PRINCIPAL } from '@vme/shared-types';
import {
  ToolExecutionRuntime,
  ToolExecutionError,
  QuarantinedActionError,
  type ToolExecutionContext,
} from './tool-runtime.js';

describe('ToolExecutionRuntime — Consequential Action Approval Binding & Replay Protection', () => {
  const secretKey = 'vme-canonical-owner-hmac-secret-test-32b-length';
  const credentials = 'vme-owner-secure-cryptographic-master-key-2026';

  let testSandboxDir: string;
  let hierarchy: DepartmentRegistry;
  let supervisor: EmergencySupervisor;
  let authService: OwnerAuthenticationService;
  let policyEngine: ConsequentialPolicyEngine;
  let runtime: ToolExecutionRuntime;
  let defaultContext: ToolExecutionContext;

  beforeEach(() => {
    process.env.OWNER_AUTH_SECRET = secretKey;
    process.env.OWNER_AUTH_CREDENTIALS = credentials;

    testSandboxDir = mkdtempSync(join(tmpdir(), 'vme-tool-binding-test-'));

    hierarchy = new DepartmentRegistry();
    supervisor = new EmergencySupervisor(undefined, false);

    authService = new OwnerAuthenticationService({
      secretKey,
      requiredCredentials: credentials,
    });

    policyEngine = new ConsequentialPolicyEngine({
      authService,
    });

    runtime = new ToolExecutionRuntime(hierarchy, {
      emergencySupervisor: supervisor,
      workspaceRoot: testSandboxDir,
      policyEngine,
    });

    const techArch = hierarchy.getAgentRecord('TECH-ARCH')!;
    defaultContext = {
      agentId: techArch.id,
      agentCode: techArch.agentCode,
      departmentId: techArch.departmentId,
      taskId: 'task-test-consequential-001',
    };
  });

  afterEach(() => {
    try {
      rmSync(testSandboxDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error in temp directory
    }
  });

  it('1. Quarantines consequential tool action and cryptographically binds tool identifier, operation, and canonical parameters', async () => {
    const payload = {
      action: 'delete',
      relativePath: 'logs/scratch.log',
    };

    // Invoking without approvalRequestId triggers automatic quarantine
    let quarantinedError: QuarantinedActionError | undefined;
    try {
      await runtime.executeTool('real_filesystem', payload, defaultContext);
    } catch (err: unknown) {
      if (err instanceof QuarantinedActionError) {
        quarantinedError = err;
      }
    }

    expect(quarantinedError).toBeDefined();
    const record = quarantinedError!.approvalRequest;
    expect(record.status).toBe('PENDING_OWNER_REVIEW');
    expect(record.actionType).toBe('IRREVERSIBLE_OPERATION');

    // Verify cryptographic binding payload structure
    expect(record.payload).toEqual({
      tool: 'real_filesystem',
      operation: 'delete',
      parameters: payload,
    });

    // Verify parameter hash binds tool, operation, and parameters
    const expectedHash = computeParameterHash({
      tool: 'real_filesystem',
      operation: 'delete',
      parameters: payload,
    });
    expect(record.parameterHash).toBe(expectedHash);
  });

  it('2. Prevents tool substitution: approval granted for tool A cannot be used to execute tool B', async () => {
    const payload = {
      action: 'delete',
      relativePath: 'temp/to_delete.txt',
    };

    // Step A: Quarantine action for real_filesystem
    let approvalRequestId: string | undefined;
    try {
      await runtime.executeTool('real_filesystem', payload, defaultContext);
    } catch (err: unknown) {
      if (err instanceof QuarantinedActionError) {
        approvalRequestId = err.approvalRequest.id;
      }
    }
    expect(approvalRequestId).toBeDefined();

    // Step B: Authenticated Owner approves the action for real_filesystem
    const ownerSession = authService.createOwnerSession({
      principalId: OWNER_PRINCIPAL_ID,
      email: CANONICAL_OWNER_PRINCIPAL.email,
      credentials,
    });
    await policyEngine.resolveAuthorization(approvalRequestId!, 'APPROVED', ownerSession);

    // Step C: Attacker attempts to execute a DIFFERENT tool ('real_terminal_command') using the approval
    await expect(
      runtime.executeTool(
        'real_terminal_command',
        { command: 'rm -rf temp/to_delete.txt' },
        defaultContext,
        { approvalRequestId: approvalRequestId! }
      )
    ).rejects.toThrow(/Tool substitution rejected/i);

    // Verify approval was NOT consumed by the unauthorized tool
    const record = await policyEngine.getRequestById(approvalRequestId!);
    expect(record?.status).toBe('APPROVED');
  });

  it('3. Prevents operation substitution: approval granted for operation A cannot be used for operation B', async () => {
    // Register custom tool with distinct operations
    let executedOperation = '';
    runtime.registerTool({
      name: 'financial_ledger_tool',
      description: 'Performs balance audits or irreversible ledger adjustments',
      requiredCapability: 'software_architecture',
      departmentScope: 'technology_engineering',
      consequentialType: (input: { operation?: string }) =>
        input.operation === 'ADJUST' ? 'IRREVERSIBLE_OPERATION' : null,
      execute: async (input: { operation: string; account: string; amount: number }) => {
        executedOperation = input.operation;
        return { success: true, operation: input.operation };
      },
    });

    // Step A: Quarantine an ADJUST operation
    const adjustPayload = {
      operation: 'ADJUST',
      account: 'ACC-001',
      amount: -50000,
    };

    let approvalRequestId: string | undefined;
    try {
      await runtime.executeTool('financial_ledger_tool', adjustPayload, defaultContext);
    } catch (err: unknown) {
      if (err instanceof QuarantinedActionError) {
        approvalRequestId = err.approvalRequest.id;
      }
    }
    expect(approvalRequestId).toBeDefined();

    // Step B: Owner approves ADJUST
    const ownerSession = authService.createOwnerSession({
      principalId: OWNER_PRINCIPAL_ID,
      email: CANONICAL_OWNER_PRINCIPAL.email,
      credentials,
    });
    await policyEngine.resolveAuthorization(approvalRequestId!, 'APPROVED', ownerSession);

    // Step C: Attacker attempts operation substitution with 'RESET' or 'AUDIT' using the ADJUST approval
    const substitutedPayload = {
      operation: 'RESET',
      account: 'ACC-001',
      amount: -50000,
    };

    await expect(
      runtime.executeTool('financial_ledger_tool', substitutedPayload, defaultContext, {
        approvalRequestId: approvalRequestId!,
      })
    ).rejects.toThrow(/Operation substitution rejected/i);

    expect(executedOperation).toBe('');
  });

  it('4. Prevents parameter substitution: approval granted for parameter A cannot execute with parameter B', async () => {
    const safePayload = {
      action: 'delete',
      relativePath: 'temp/safe_file.txt',
    };

    // Quarantine and approve safe file deletion
    let approvalRequestId: string | undefined;
    try {
      await runtime.executeTool('real_filesystem', safePayload, defaultContext);
    } catch (err: unknown) {
      if (err instanceof QuarantinedActionError) {
        approvalRequestId = err.approvalRequest.id;
      }
    }

    const ownerSession = authService.createOwnerSession({
      principalId: OWNER_PRINCIPAL_ID,
      email: CANONICAL_OWNER_PRINCIPAL.email,
      credentials,
    });
    await policyEngine.resolveAuthorization(approvalRequestId!, 'APPROVED', ownerSession);

    // Tampered payload with malicious target
    const tamperedPayload = {
      action: 'delete',
      relativePath: 'system/sensitive_database.db',
    };

    await expect(
      runtime.executeTool('real_filesystem', tamperedPayload, defaultContext, {
        approvalRequestId: approvalRequestId!,
      })
    ).rejects.toThrow(/parameter hash mismatch|parameter tampering/i);
  });

  it('5. Ensures atomic approval consumption and blocks concurrent replay attempts', async () => {
    // Create physical file in sandbox to delete
    const targetFile = 'to_delete_concurrent.txt';
    writeFileSync(join(testSandboxDir, targetFile), 'Content to delete');

    const payload = {
      action: 'delete',
      relativePath: targetFile,
    };

    let approvalRequestId: string | undefined;
    try {
      await runtime.executeTool('real_filesystem', payload, defaultContext);
    } catch (err: unknown) {
      if (err instanceof QuarantinedActionError) {
        approvalRequestId = err.approvalRequest.id;
      }
    }

    const ownerSession = authService.createOwnerSession({
      principalId: OWNER_PRINCIPAL_ID,
      email: CANONICAL_OWNER_PRINCIPAL.email,
      credentials,
    });
    await policyEngine.resolveAuthorization(approvalRequestId!, 'APPROVED', ownerSession);

    // Trigger concurrent executions simultaneously
    const results = await Promise.allSettled([
      runtime.executeTool('real_filesystem', payload, defaultContext, {
        approvalRequestId: approvalRequestId!,
      }),
      runtime.executeTool('real_filesystem', payload, defaultContext, {
        approvalRequestId: approvalRequestId!,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // Exactly one execution must succeed, the other MUST fail closed
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const errorMsg = (rejected[0] as PromiseRejectedResult).reason.message;
    expect(errorMsg).toMatch(/already locked|already been executed|concurrent/i);
  });

  it('6. Prevents serial replay after execution has completed', async () => {
    const targetFile = 'to_delete_serial.txt';
    writeFileSync(join(testSandboxDir, targetFile), 'Serial test content');

    const payload = {
      action: 'delete',
      relativePath: targetFile,
    };

    let approvalRequestId: string | undefined;
    try {
      await runtime.executeTool('real_filesystem', payload, defaultContext);
    } catch (err: unknown) {
      if (err instanceof QuarantinedActionError) {
        approvalRequestId = err.approvalRequest.id;
      }
    }

    const ownerSession = authService.createOwnerSession({
      principalId: OWNER_PRINCIPAL_ID,
      email: CANONICAL_OWNER_PRINCIPAL.email,
      credentials,
    });
    await policyEngine.resolveAuthorization(approvalRequestId!, 'APPROVED', ownerSession);

    // First execution succeeds
    const firstResult = (await runtime.executeTool('real_filesystem', payload, defaultContext, {
      approvalRequestId: approvalRequestId!,
    })) as any;
    expect(firstResult.action).toBe('delete');

    // Second execution with same consumed approval MUST fail closed
    await expect(
      runtime.executeTool('real_filesystem', payload, defaultContext, {
        approvalRequestId: approvalRequestId!,
      })
    ).rejects.toThrow(/already been executed/i);
  });

  it('7. Fails closed if approval is missing, expired, or unapproved', async () => {
    const payload = {
      action: 'delete',
      relativePath: 'temp/dummy.txt',
    };

    // A. Missing approval request ID
    await expect(
      runtime.executeTool('real_filesystem', payload, defaultContext, {
        approvalRequestId: `missing-auth-${randomUUID()}`,
      })
    ).rejects.toThrow(/was not found|not found/i);

    // B. Unapproved request (still PENDING_OWNER_REVIEW)
    let pendingApprovalId: string | undefined;
    try {
      await runtime.executeTool('real_filesystem', payload, defaultContext);
    } catch (err: unknown) {
      if (err instanceof QuarantinedActionError) {
        pendingApprovalId = err.approvalRequest.id;
      }
    }
    expect(pendingApprovalId).toBeDefined();

    await expect(
      runtime.executeTool('real_filesystem', payload, defaultContext, {
        approvalRequestId: pendingApprovalId!,
      })
    ).rejects.toThrow(/status is 'PENDING_OWNER_REVIEW'. Authentic Owner approval is required/i);

    // C. Expired approval request
    const shortPolicyEngine = new ConsequentialPolicyEngine({
      authService,
      policies: {
        IRREVERSIBLE_OPERATION: {
          actionType: 'IRREVERSIBLE_OPERATION',
          requiresOwnerApproval: true,
          maxValidityWindowMs: -1000, // already expired
          description: 'Expired test policy',
        },
      },
    });

    const shortRuntime = new ToolExecutionRuntime(hierarchy, {
      emergencySupervisor: supervisor,
      workspaceRoot: testSandboxDir,
      policyEngine: shortPolicyEngine,
    });

    let expiredReqId: string | undefined;
    try {
      await shortRuntime.executeTool('real_filesystem', payload, defaultContext);
    } catch (err: unknown) {
      if (err instanceof QuarantinedActionError) {
        expiredReqId = err.approvalRequest.id;
      }
    }
    expect(expiredReqId).toBeDefined();

    const ownerSession = authService.createOwnerSession({
      principalId: OWNER_PRINCIPAL_ID,
      email: CANONICAL_OWNER_PRINCIPAL.email,
      credentials,
    });

    // Attempt to authorize expired request fails or revalidating it fails closed
    await expect(
      shortPolicyEngine.resolveAuthorization(expiredReqId!, 'APPROVED', ownerSession)
    ).rejects.toThrow(/expired/i);

    await expect(
      shortRuntime.executeTool('real_filesystem', payload, defaultContext, {
        approvalRequestId: expiredReqId!,
      })
    ).rejects.toThrow(/approval .* status is 'PENDING_OWNER_REVIEW'|expired/i);
  });
});
