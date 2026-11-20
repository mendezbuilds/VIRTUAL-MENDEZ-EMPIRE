import { randomUUID, createHmac } from 'node:crypto';
import {
  type AgentRecord,
  type Department,
  type DepartmentId,
} from '@vme/shared-types';
import { UnauthorizedHierarchyActionError } from './delegation-rules.js';
import {
  getHierarchyAuthoritySecret,
  verifyHierarchyAuthorization,
  ExecutiveAuthenticationService,
} from './hierarchy-authorizer.js';
import { OwnerAuthenticationService } from '@vme/security-governance';

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

export interface AppointDirectorParams {
  departmentId: DepartmentId;
  newDirectorIdOrCode: string;
  reason: string;
  authorizedBy?: unknown;
  authorizerSession?: unknown;
  ownerSession?: unknown;
  executiveSession?: unknown;
  effectiveDate?: string;
  ownerAuthService?: OwnerAuthenticationService;
  executiveAuthService?: ExecutiveAuthenticationService;
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
  secret: string = getHierarchyAuthoritySecret()
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
  secret: string = getHierarchyAuthoritySecret()
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
    private readonly agents: Map<string, AgentRecord>,
    public readonly ownerAuthService?: OwnerAuthenticationService,
    public readonly executiveAuthService?: ExecutiveAuthenticationService
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
   * Appoints a new Director for a corporate department.
   * Authenticates the authorizing principal BEFORE mutation.
   * Fails closed if authentication is missing or invalid, or if DB_SESSION_SECRET is unprovisioned.
   */
  appointDirector(params: AppointDirectorParams): { success: boolean; record: LeadershipAppointmentRecord } {
    const dept = this.departments.get(params.departmentId);
    if (!dept) {
      throw new UnauthorizedHierarchyActionError(`Unknown department '${params.departmentId}'`);
    }

    // 1. Verify that securely provisioned DB_SESSION_SECRET exists BEFORE any mutation
    const secret = getHierarchyAuthoritySecret();

    // 2. Authenticate the authorizing principal and verify authority BEFORE mutation
    const verifiedAuthorizer = verifyHierarchyAuthorization(
      params,
      'APPOINT_DIRECTOR',
      params.departmentId,
      null,
      this.agents,
      secret,
      params.ownerAuthService ?? this.ownerAuthService,
      params.executiveAuthService ?? this.executiveAuthService
    );

    // 3. Locate the new director agent BEFORE mutation
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

    // 4. Seniority validation: Director or Executive level required BEFORE mutation
    if (newDirector.level !== 'DIRECTOR' && newDirector.level !== 'EXECUTIVE') {
      throw new UnauthorizedHierarchyActionError(
        `Seniority violation: agent ${newDirector.agentCode} has level '${newDirector.level}', expected 'DIRECTOR' or 'EXECUTIVE'`
      );
    }

    // 5. All authorization and validations passed. Now perform mutation
    const previousDirectorId = dept.directorId ?? null;
    const previousDirectorCode = dept.directorCode;

    dept.directorId = newDirector.id;
    dept.directorCode = newDirector.agentCode;
    dept.updatedAt = params.effectiveDate ?? new Date().toISOString();

    // 6. Construct cryptographically verifiable deep-frozen leadership appointment record
    const appointmentId = randomUUID();
    const effectiveDate = params.effectiveDate ?? new Date().toISOString();
    const signature = computeAppointmentAuthorizationSignature(
      {
        appointmentId,
        departmentId: params.departmentId,
        newDirectorId: newDirector.id,
        newDirectorCode: newDirector.agentCode,
        appointedBy: verifiedAuthorizer,
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
      appointedBy: verifiedAuthorizer,
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
