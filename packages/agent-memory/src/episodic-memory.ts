import {
  type EpisodicMemoryRecord,
  type DepartmentId,
  type MemoryScope,
  type MemoryAccessPrincipal,
  EpisodicMemoryRecordSchema,
} from '@vme/shared-types';
import { SecretRedactor } from './secret-redactor.js';
import { MemoryAccessController } from './memory-access-controller.js';

export interface EpisodicMemoryFilter {
  agentId?: string;
  departmentId?: DepartmentId;
  actionType?: string;
  status?: 'SUCCESS' | 'FAILURE' | 'QUARANTINED' | 'ESCALATED';
  scope?: MemoryScope;
  since?: string;
  until?: string;
  limit?: number;
}

export interface EpisodicMemoryStorage {
  saveRecord(record: EpisodicMemoryRecord): Promise<void>;
  queryRecords(filter: EpisodicMemoryFilter): Promise<EpisodicMemoryRecord[]>;
  getRecordById(id: string): Promise<EpisodicMemoryRecord | undefined>;
  archiveOlderThan(cutoffIsoDate: string): Promise<number>;
  deleteRecords(filter: EpisodicMemoryFilter): Promise<number>;
}

export class InMemoryEpisodicStorage implements EpisodicMemoryStorage {
  private records: EpisodicMemoryRecord[] = [];
  private archivedRecords: EpisodicMemoryRecord[] = [];

  async saveRecord(record: EpisodicMemoryRecord): Promise<void> {
    this.records.push(structuredClone(record));
  }

  async getRecordById(id: string): Promise<EpisodicMemoryRecord | undefined> {
    const record = this.records.find((r) => r.id === id);
    return record ? structuredClone(record) : undefined;
  }

  async queryRecords(filter: EpisodicMemoryFilter): Promise<EpisodicMemoryRecord[]> {
    return this.records
      .filter((r) => {
        if (filter.agentId && r.agentId !== filter.agentId) return false;
        if (filter.departmentId && r.departmentId !== filter.departmentId) return false;
        if (filter.actionType && r.actionType !== filter.actionType) return false;
        if (filter.status && r.status !== filter.status) return false;
        if (filter.scope && r.scope !== filter.scope) return false;
        if (filter.since && new Date(r.recordedAt).getTime() < new Date(filter.since).getTime()) return false;
        if (filter.until && new Date(r.recordedAt).getTime() > new Date(filter.until).getTime()) return false;
        return true;
      })
      .slice(-(filter.limit ?? 50))
      .map((r) => structuredClone(r));
  }

  async archiveOlderThan(cutoffIsoDate: string): Promise<number> {
    const cutoffTime = new Date(cutoffIsoDate).getTime();
    const remaining: EpisodicMemoryRecord[] = [];
    let archivedCount = 0;

    for (const record of this.records) {
      if (new Date(record.recordedAt).getTime() < cutoffTime) {
        this.archivedRecords.push(record);
        archivedCount++;
      } else {
        remaining.push(record);
      }
    }

    this.records = remaining;
    return archivedCount;
  }

  async deleteRecords(filter: EpisodicMemoryFilter): Promise<number> {
    const initialCount = this.records.length;
    this.records = this.records.filter((r) => {
      if (filter.agentId && r.agentId !== filter.agentId) return true;
      if (filter.departmentId && r.departmentId !== filter.departmentId) return true;
      if (filter.actionType && r.actionType !== filter.actionType) return true;
      if (filter.status && r.status !== filter.status) return true;
      if (filter.scope && r.scope !== filter.scope) return true;
      return false; // match -> remove
    });
    return initialCount - this.records.length;
  }

  getArchivedCount(): number {
    return this.archivedRecords.length;
  }
}

export class EpisodicMemory {
  constructor(private readonly storage: EpisodicMemoryStorage) {}

  async recordExecution(
    record: EpisodicMemoryRecord,
    principal?: MemoryAccessPrincipal
  ): Promise<void> {
    // ABAC assertion if principal provided
    if (principal) {
      MemoryAccessController.assertAccess(
        principal,
        {
          scope: record.scope,
          agentId: record.agentId,
          departmentId: record.departmentId,
        },
        'WRITE'
      );
    }

    // Strict credential check and redaction
    const sanitized = SecretRedactor.sanitize(record, true);
    const parsed = EpisodicMemoryRecordSchema.parse(sanitized);

    await this.storage.saveRecord(parsed);
  }

  async getRecentContext(
    filter: EpisodicMemoryFilter,
    principal?: MemoryAccessPrincipal
  ): Promise<EpisodicMemoryRecord[]> {
    const records = await this.storage.queryRecords(filter);

    if (!principal) {
      return records;
    }

    // Filter by ABAC access permissions
    return records.filter((r) => {
      try {
        MemoryAccessController.assertAccess(
          principal,
          {
            scope: r.scope,
            agentId: r.agentId,
            departmentId: r.departmentId,
          },
          'READ'
        );
        return true;
      } catch {
        return false;
      }
    });
  }

  async archiveOlderThan(
    cutoffIsoDate: string,
    principal?: MemoryAccessPrincipal
  ): Promise<number> {
    if (principal) {
      // Archival requires Executive or Director or Owner
      if (
        principal.principalType !== 'OWNER_PRINCIPAL' &&
        principal.level !== 'EXECUTIVE' &&
        principal.level !== 'DIRECTOR'
      ) {
        throw new Error(
          `Archival of episodic memory requires Director or Executive authority. Principal '${principal.principalId}' is '${principal.level}'.`
        );
      }
    }
    return this.storage.archiveOlderThan(cutoffIsoDate);
  }

  async deleteRecords(
    filter: EpisodicMemoryFilter,
    principal: MemoryAccessPrincipal
  ): Promise<number> {
    // Assert deletion authority
    MemoryAccessController.assertAccess(
      principal,
      {
        scope: filter.scope ?? 'DEPARTMENT_SCOPED',
        agentId: filter.agentId,
        departmentId: filter.departmentId,
      },
      'DELETE'
    );

    return this.storage.deleteRecords(filter);
  }
}
