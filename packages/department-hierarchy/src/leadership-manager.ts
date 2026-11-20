import { randomUUID, createHmac } from 'node:crypto';
import {
  OWNER_PRINCIPAL_ID,
  CANONICAL_OWNER_PRINCIPAL,
  CANONICAL_FOUNDING_AGENTS,
  type AgentRecord,
  type Department,
  type DepartmentId,
} from '@vme/shared-types';
import { UnauthorizedHierarchyActionError } from './delegation-rules.js';

export interface LeadershipAppointmentRecord {
  appointmentId: string;
  departmentId: DepartmentId;
  previousDirectorId: string | null;
  previousDirectorCode?: string;
  newDirectorId: string;
  newDirectorCode: string;
  appointedBy: string;
  reason: string;
  effectiveDate: string;
  authorizationSignature?: string;
}

export function computeAppointmentAuthorizationSignature(
  record: {
    appointmentId: string;
    departmentId: DepartmentId;
    newDirectorId: string;
    newDirectorCode: string;
    appointedBy: string;
    effectiveDate: string;
    reason?: string;
  },
  secret: string = process.env.DB_SESSION_SECRET || 'vme-canonical-hierarchy-authority-secret-2026'
): string {
  const canonical = [
    'APPOINTMENT_AUTH_V1',
    record.appointmentId,
    record.departmentId,
    record.newDirectorId,
    record.newDirectorCode,
    record.appointedBy,
    record.effectiveDate,
    record.reason ?? '',
  ].join(':');
  return createHmac('sha256', secret).update(canonical).digest('hex');
}

export function verifyAppointmentAuthorizationSignature(
  record: LeadershipAppointmentRecord,
  secret: string = process.env.DB_SESSION_SECRET || 'vme-canonical-hierarchy-authority-secret-2026'
): boolean {
  if (!record.authorizationSignature || typeof record.authorizationSignature !== 'string') {
    return false;
  }
  const expectedSig = computeAppointmentAuthorizationSignature(record, secret);
  return record.authorizationSignature === expectedSig;
}

export class DepartmentLeadershipManager {
  private readonly appointmentHistory: LeadershipAppointmentRecord[] = [];

  constructor(
    private readonly departments: Map<DepartmentId, Department>,
    private readonly agents: Map<string, AgentRecord>
  ) {}

  /**
   * Retrieves the active Director or Executive for a given department.
   */
  getDepartmentDirector(departmentId: DepartmentId): AgentRecord | null {
    const dept = this.departments.get(departmentId);
    if (!dept) return null;

    if (dept.directorId && this.agents.has(dept.directorId)) {
      const dir = this.agents.get(dept.directorId)!;
      if (dir.operationalStatus === 'ACTIVE') {
        return dir;
      }
    }

    // Fallback: search for active Director or Executive assigned to this department
    return (
      Array.from(this.agents.values()).find(
        (a) =>
          a.departmentId === departmentId &&
          (a.level === 'DIRECTOR' || a.level === 'EXECUTIVE') &&
          a.operationalStatus === 'ACTIVE'
      ) ?? null
    );
  }

  /**
   * Returns all recorded leadership appointments, optionally filtered by department.
   */
  getLeadershipHistory(departmentId?: DepartmentId): LeadershipAppointmentRecord[] {
    if (departmentId) {
      return this.appointmentHistory.filter((h) => h.departmentId === departmentId);
    }
    return [...this.appointmentHistory];
  }

  /**
   * Evaluates if the authorizer is permitted to appoint leadership for a department.
   * Executive Office appointments strictly require the human Owner.
   * Functional department appointments require the human Owner or canonical EXEC-CEO.
   */
  private isAuthorizedToAppoint(departmentId: DepartmentId, authorizerIdOrCode: string): boolean {
    // Human Owner principal can appoint any director or executive
    if (
      authorizerIdOrCode === OWNER_PRINCIPAL_ID ||
      authorizerIdOrCode === CANONICAL_OWNER_PRINCIPAL.principalId
    ) {
      return true;
    }

    // Executive Office leadership strictly requires human Owner authorization
    if (departmentId === 'executive_office') {
      return false;
    }

    // Canonical Executive CEO can appoint functional department directors
    const canonicalCeo = CANONICAL_FOUNDING_AGENTS.find((a) => a.agentCode === 'EXEC-CEO');
    if (!canonicalCeo) return false;

    if (authorizerIdOrCode === 'EXEC-CEO' || authorizerIdOrCode === canonicalCeo.id) {
      const activeCeo = this.agents.get(canonicalCeo.id);
      if (
        activeCeo &&
        activeCeo.agentCode === 'EXEC-CEO' &&
        activeCeo.level === 'EXECUTIVE' &&
        activeCeo.operationalStatus === 'ACTIVE' &&
        activeCeo.departmentId === 'executive_office'
      ) {
        return true;
      }
    }

    return false;
  }

  /**
   * Appoints a new Director for a corporate department.
   */
  appointDirector(params: {
    departmentId: DepartmentId;
    newDirectorIdOrCode: string;
    authorizedBy: string;
    reason: string;
    effectiveDate?: string;
  }): { success: boolean; record: LeadershipAppointmentRecord } {
    const dept = this.departments.get(params.departmentId);
    if (!dept) {
      throw new UnauthorizedHierarchyActionError(`Unknown department '${params.departmentId}'`);
    }

    // 1. Verify appointment authorization
    if (!this.isAuthorizedToAppoint(params.departmentId, params.authorizedBy)) {
      throw new UnauthorizedHierarchyActionError(
        `Unauthorized leadership appointment: '${params.authorizedBy}' lacks authority to appoint director for '${params.departmentId}'`
      );
    }

    // 2. Locate the new director agent
    const newDirector =
      this.agents.get(params.newDirectorIdOrCode) ??
      Array.from(this.agents.values()).find((a) => a.agentCode === params.newDirectorIdOrCode);

    if (!newDirector) {
      throw new UnauthorizedHierarchyActionError(
        `Agent '${params.newDirectorIdOrCode}' not found in workforce registry`
      );
    }

    if (newDirector.operationalStatus !== 'ACTIVE') {
      throw new UnauthorizedHierarchyActionError(
        `Cannot appoint inactive agent ${newDirector.agentCode} (${newDirector.operationalStatus}) as Director`
      );
    }

    // 3. Seniority validation: Director or Executive level required
    if (newDirector.level !== 'DIRECTOR' && newDirector.level !== 'EXECUTIVE') {
      throw new UnauthorizedHierarchyActionError(
        `Seniority violation: agent ${newDirector.agentCode} has level '${newDirector.level}', expected 'DIRECTOR' or 'EXECUTIVE'`
      );
    }

    const previousDirectorId = dept.directorId ?? null;
    const previousDirectorCode = dept.directorCode;

    // 4. Update department leadership reference
    dept.directorId = newDirector.id;
    dept.directorCode = newDirector.agentCode;
    dept.updatedAt = params.effectiveDate ?? new Date().toISOString();

    // 5. Construct cryptographically verifiable deep-frozen leadership appointment record
    const appointmentId = randomUUID();
    const effectiveDate = params.effectiveDate ?? new Date().toISOString();
    const secret = process.env.DB_SESSION_SECRET || 'vme-canonical-hierarchy-authority-secret-2026';
    const signature = computeAppointmentAuthorizationSignature(
      {
        appointmentId,
        departmentId: params.departmentId,
        newDirectorId: newDirector.id,
        newDirectorCode: newDirector.agentCode,
        appointedBy: params.authorizedBy,
        effectiveDate,
        reason: params.reason,
      },
      secret
    );

    const record: LeadershipAppointmentRecord = Object.freeze({
      appointmentId,
      departmentId: params.departmentId,
      previousDirectorId,
      previousDirectorCode,
      newDirectorId: newDirector.id,
      newDirectorCode: newDirector.agentCode,
      appointedBy: params.authorizedBy,
      reason: params.reason,
      effectiveDate,
      authorizationSignature: signature,
    });

    this.appointmentHistory.push(record);

    return {
      success: true,
      record,
    };
  }
}
