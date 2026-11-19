import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  OWNER_PRINCIPAL_ID,
  CANONICAL_OWNER_PRINCIPAL,
  type DepartmentId,
} from '@vme/shared-types';

export type ConsequentialActionType =
  | 'LIVE_TRADING'
  | 'CAPITAL_TRANSFER'
  | 'EXTERNAL_OUTREACH'
  | 'BINDING_CONTRACT'
  | 'GOVERNANCE_OVERRIDE'
  | 'INFRASTRUCTURE_MUTATION';

export type ConsequentialAuthorizationStatus =
  | 'PENDING_OWNER_REVIEW'
  | 'APPROVED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'EXECUTED';

export interface ConsequentialPolicyRule {
  actionType: ConsequentialActionType;
  requiresOwnerApproval: boolean;
  maxValidityWindowMs: number;
  description: string;
}

export const CANONICAL_CONSEQUENTIAL_POLICIES: Record<ConsequentialActionType, ConsequentialPolicyRule> = {
  LIVE_TRADING: {
    actionType: 'LIVE_TRADING',
    requiresOwnerApproval: true,
    maxValidityWindowMs: 30 * 60 * 1000, // 30 minutes
    description: 'Execution of live financial market trades or orders deploying capital.',
  },
  CAPITAL_TRANSFER: {
    actionType: 'CAPITAL_TRANSFER',
    requiresOwnerApproval: true,
    maxValidityWindowMs: 15 * 60 * 1000, // 15 minutes
    description: 'Movement or allocation of real corporate funds or treasury assets.',
  },
  EXTERNAL_OUTREACH: {
    actionType: 'EXTERNAL_OUTREACH',
    requiresOwnerApproval: true,
    maxValidityWindowMs: 24 * 60 * 60 * 1000, // 24 hours
    description: 'Transmission of communications to external clients, counterparties, or public channels.',
  },
  BINDING_CONTRACT: {
    actionType: 'BINDING_CONTRACT',
    requiresOwnerApproval: true,
    maxValidityWindowMs: 48 * 60 * 60 * 1000, // 48 hours
    description: 'Execution or formal assent to legally binding agreements or contracts.',
  },
  GOVERNANCE_OVERRIDE: {
    actionType: 'GOVERNANCE_OVERRIDE',
    requiresOwnerApproval: true,
    maxValidityWindowMs: 10 * 60 * 1000, // 10 minutes
    description: 'Overriding security, compliance, or hierarchical workforce invariants.',
  },
  INFRASTRUCTURE_MUTATION: {
    actionType: 'INFRASTRUCTURE_MUTATION',
    requiresOwnerApproval: true,
    maxValidityWindowMs: 60 * 60 * 1000, // 1 hour
    description: 'Production infrastructure modifications or irreversible data destruction.',
  },
};

export interface ConsequentialAuthorizationRecord {
  id: string;
  tenantId: string;
  taskId: string;
  actionType: ConsequentialActionType;
  agentId: string;
  departmentId: DepartmentId;
  counterparty?: string;
  payload: Record<string, unknown>;
  parameterHash: string;
  status: ConsequentialAuthorizationStatus;
  requestedAt: string;
  validUntil: string;
  decidedBy?: string;
  decisionNotes?: string;
  decidedAt?: string;
  executedAt?: string;
  executionStatus?: string;
  executionResult?: Record<string, unknown>;
}

export class ConsequentialPolicyViolationError extends Error {
  constructor(message: string) {
    super(`CONSEQUENTIAL POLICY VIOLATION: ${message}`);
    this.name = 'ConsequentialPolicyViolationError';
  }
}

export class UnauthorizedOwnerDecisionError extends Error {
  constructor(message: string) {
    super(`OWNER GOVERNANCE VIOLATION: ${message}`);
    this.name = 'UnauthorizedOwnerDecisionError';
  }
}

/**
 * Computes a deterministic SHA-256 hash of normalized parameters.
 */
export function computeParameterHash(payload: Record<string, unknown>): string {
  const sortedKeys = Object.keys(payload).sort();
  const normalized: Record<string, unknown> = {};
  for (const k of sortedKeys) {
    normalized[k] = payload[k];
  }
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

export interface ConsequentialPolicyEngineOptions {
  pool?: Pool;
  tenantId?: string;
  policies?: Partial<Record<ConsequentialActionType, ConsequentialPolicyRule>>;
}

/**
 * Production-Grade Consequential Action Policy Engine.
 * Enforces the complete 10-step Owner Authorization & Execution Lifecycle.
 */
export class ConsequentialPolicyEngine {
  private inMemoryRecords = new Map<string, ConsequentialAuthorizationRecord>();
  private readonly pool?: Pool;
  private readonly tenantId: string;
  private readonly policies: Record<ConsequentialActionType, ConsequentialPolicyRule>;

  constructor(options?: ConsequentialPolicyEngineOptions) {
    this.pool = options?.pool;
    this.tenantId = options?.tenantId ?? '00000000-0000-0000-0000-000000000001';
    this.policies = { ...CANONICAL_CONSEQUENTIAL_POLICIES, ...(options?.policies ?? {}) };
  }

  /**
   * Step 1 & 2 & 3 & 4: Ingest proposed action, classify against policy,
   * quarantine, compute SHA-256 parameter hash, and generate bound authorization request.
   */
  async quarantineAction(params: {
    taskId: string;
    actionType: ConsequentialActionType;
    agentId: string;
    departmentId: DepartmentId;
    payload: Record<string, unknown>;
    counterparty?: string;
  }): Promise<ConsequentialAuthorizationRecord> {
    const policy = this.policies[params.actionType];
    if (!policy) {
      throw new ConsequentialPolicyViolationError(
        `Unknown consequential action classification: ${params.actionType}`
      );
    }

    const parameterHash = computeParameterHash(params.payload);
    const requestedAt = new Date().toISOString();
    const validUntil = new Date(Date.now() + policy.maxValidityWindowMs).toISOString();
    const id = `auth-${Date.now()}-${randomUUID().slice(0, 8)}`;

    const record: ConsequentialAuthorizationRecord = {
      id,
      tenantId: this.tenantId,
      taskId: params.taskId,
      actionType: params.actionType,
      agentId: params.agentId,
      departmentId: params.departmentId,
      counterparty: params.counterparty,
      payload: params.payload,
      parameterHash,
      status: 'PENDING_OWNER_REVIEW',
      requestedAt,
      validUntil,
    };

    if (this.pool) {
      const client = await this.pool.connect();
      try {
        await client.query(
          `INSERT INTO consequential_authorization_requests (
            id, tenant_id, task_id, action_type, agent_id, department_id,
            counterparty, parameter_hash, payload, status, requested_at, valid_until
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            record.id,
            record.tenantId,
            record.taskId,
            record.actionType,
            record.agentId,
            record.departmentId,
            record.counterparty ?? null,
            record.parameterHash,
            JSON.stringify(record.payload),
            record.status,
            record.requestedAt,
            record.validUntil,
          ]
        );
      } finally {
        client.release();
      }
    } else {
      this.inMemoryRecords.set(record.id, record);
    }

    return record;
  }

  /**
   * Step 5: Owner Authorization & Sign-off.
   * Strictly enforces that ONLY authentic Owner principal can approve or reject.
   */
  async resolveAuthorization(
    requestId: string,
    decision: 'APPROVED' | 'REJECTED',
    decidedBy: string,
    decisionNotes?: string
  ): Promise<ConsequentialAuthorizationRecord> {
    const isOwner =
      decidedBy === OWNER_PRINCIPAL_ID || decidedBy === CANONICAL_OWNER_PRINCIPAL.principalId;

    if (!isOwner) {
      throw new UnauthorizedOwnerDecisionError(
        `Consequential actions can exclusively be authorized by the Owner principal (Stephen Mendez). Agent or caller '${decidedBy}' cannot approve or reject consequential actions.`
      );
    }

    const record = await this.getRequestById(requestId);
    if (!record) {
      throw new ConsequentialPolicyViolationError(
        `Authorization request not found: ${requestId}`
      );
    }

    if (record.status !== 'PENDING_OWNER_REVIEW') {
      throw new ConsequentialPolicyViolationError(
        `Cannot resolve request ${requestId}: current status is '${record.status}'.`
      );
    }

    // Check expiration
    if (new Date(record.validUntil).getTime() < Date.now()) {
      record.status = 'EXPIRED';
      await this.updateRecordStatus(record);
      throw new ConsequentialPolicyViolationError(
        `Authorization request ${requestId} has expired (valid until ${record.validUntil}).`
      );
    }

    record.status = decision;
    record.decidedBy = decidedBy;
    record.decidedAt = new Date().toISOString();
    record.decisionNotes = decisionNotes;

    await this.updateRecordStatus(record);
    return record;
  }

  /**
   * Step 6: Pre-Execution Revalidation.
   * Verifies that the approval is valid, not expired, and that the payload has NOT been altered
   * by verifying the cryptographic parameter hash.
   */
  async revalidateForExecution(
    requestId: string,
    payloadToExecute: Record<string, unknown>
  ): Promise<ConsequentialAuthorizationRecord> {
    const record = await this.getRequestById(requestId);
    if (!record) {
      throw new ConsequentialPolicyViolationError(
        `Authorization request not found for revalidation: ${requestId}`
      );
    }

    if (record.status !== 'APPROVED') {
      throw new ConsequentialPolicyViolationError(
        `Cannot execute consequential action ${requestId}: status is '${record.status}'. Owner approval is required.`
      );
    }

    // Check validity window
    if (new Date(record.validUntil).getTime() < Date.now()) {
      record.status = 'EXPIRED';
      await this.updateRecordStatus(record);
      throw new ConsequentialPolicyViolationError(
        `Cannot execute consequential action ${requestId}: approval has expired.`
      );
    }

    // Cryptographic Parameter Hash Verification
    const currentHash = computeParameterHash(payloadToExecute);
    if (currentHash !== record.parameterHash) {
      throw new ConsequentialPolicyViolationError(
        `Cryptographic parameter hash mismatch! Authorized hash '${record.parameterHash}' does not match execution payload hash '${currentHash}'. Parameter tampering detected.`
      );
    }

    return record;
  }

  /**
   * Step 7 & 8: Record Execution Outcome and Evidence.
   */
  async recordExecutionOutcome(
    requestId: string,
    executionStatus: 'SUCCESS' | 'FAILED',
    executionResult: Record<string, unknown>
  ): Promise<void> {
    const record = await this.getRequestById(requestId);
    if (!record) return;

    record.status = 'EXECUTED';
    record.executedAt = new Date().toISOString();
    record.executionStatus = executionStatus;
    record.executionResult = executionResult;

    await this.updateRecordStatus(record);
  }

  async getRequestById(id: string): Promise<ConsequentialAuthorizationRecord | undefined> {
    if (this.pool) {
      const client = await this.pool.connect();
      try {
        const res = await client.query(
          `SELECT id, tenant_id as "tenantId", task_id as "taskId", action_type as "actionType",
                  agent_id as "agentId", department_id as "departmentId", counterparty,
                  parameter_hash as "parameterHash", payload, status, requested_at as "requestedAt",
                  valid_until as "validUntil", decided_by as "decidedBy", decided_at as "decidedAt",
                  decision_notes as "decisionNotes", executed_at as "executedAt",
                  execution_status as "executionStatus", execution_result as "executionResult"
           FROM consequential_authorization_requests
           WHERE id = $1 AND tenant_id = $2`,
          [id, this.tenantId]
        );
        if (res.rows.length === 0) return undefined;
        const row = res.rows[0];
        return {
          ...row,
          payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload ?? {}),
          executionResult: typeof row.executionResult === 'string' ? JSON.parse(row.executionResult) : (row.executionResult ?? undefined),
        };
      } finally {
        client.release();
      }
    } else {
      return this.inMemoryRecords.get(id);
    }
  }

  async getPendingRequests(): Promise<ConsequentialAuthorizationRecord[]> {
    if (this.pool) {
      const client = await this.pool.connect();
      try {
        const res = await client.query(
          `SELECT id, tenant_id as "tenantId", task_id as "taskId", action_type as "actionType",
                  agent_id as "agentId", department_id as "departmentId", counterparty,
                  parameter_hash as "parameterHash", payload, status, requested_at as "requestedAt",
                  valid_until as "validUntil", decided_by as "decidedBy", decided_at as "decidedAt",
                  decision_notes as "decisionNotes", executed_at as "executedAt",
                  execution_status as "executionStatus", execution_result as "executionResult"
           FROM consequential_authorization_requests
           WHERE tenant_id = $1 AND status = 'PENDING_OWNER_REVIEW'
           ORDER BY requested_at ASC`,
          [this.tenantId]
        );
        return res.rows.map((row) => ({
          ...row,
          payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload ?? {}),
        }));
      } finally {
        client.release();
      }
    } else {
      return Array.from(this.inMemoryRecords.values()).filter(
        (r) => r.status === 'PENDING_OWNER_REVIEW'
      );
    }
  }

  private async updateRecordStatus(record: ConsequentialAuthorizationRecord): Promise<void> {
    if (this.pool) {
      const client = await this.pool.connect();
      try {
        await client.query(
          `UPDATE consequential_authorization_requests
           SET status = $1, decided_by = $2, decided_at = $3, decision_notes = $4,
               executed_at = $5, execution_status = $6, execution_result = $7
           WHERE id = $8 AND tenant_id = $9`,
          [
            record.status,
            record.decidedBy ?? null,
            record.decidedAt ?? null,
            record.decisionNotes ?? null,
            record.executedAt ?? null,
            record.executionStatus ?? null,
            record.executionResult ? JSON.stringify(record.executionResult) : null,
            record.id,
            this.tenantId,
          ]
        );
      } finally {
        client.release();
      }
    } else {
      this.inMemoryRecords.set(record.id, record);
    }
  }
}
