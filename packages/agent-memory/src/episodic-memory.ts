import type { EpisodicMemoryRecord, DepartmentId } from '@vme/shared-types';

export interface EpisodicMemoryStorage {
  saveRecord(record: EpisodicMemoryRecord): Promise<void>;
  queryRecords(filter: {
    agentId?: string;
    departmentId?: DepartmentId;
    actionType?: string;
    limit?: number;
  }): Promise<EpisodicMemoryRecord[]>;
}

export class InMemoryEpisodicStorage implements EpisodicMemoryStorage {
  private records: EpisodicMemoryRecord[] = [];

  async saveRecord(record: EpisodicMemoryRecord): Promise<void> {
    this.records.push({ ...record });
  }

  async queryRecords(filter: {
    agentId?: string;
    departmentId?: DepartmentId;
    actionType?: string;
    limit?: number;
  }): Promise<EpisodicMemoryRecord[]> {
    return this.records
      .filter((r) => {
        if (filter.agentId && r.agentId !== filter.agentId) return false;
        if (filter.departmentId && r.departmentId !== filter.departmentId) return false;
        if (filter.actionType && r.actionType !== filter.actionType) return false;
        return true;
      })
      .slice(-(filter.limit ?? 50));
  }
}

export class EpisodicMemory {
  constructor(private readonly storage: EpisodicMemoryStorage) {}

  async recordExecution(record: EpisodicMemoryRecord): Promise<void> {
    await this.storage.saveRecord(record);
  }

  async getRecentContext(params: {
    agentId?: string;
    departmentId?: DepartmentId;
    actionType?: string;
    limit?: number;
  }): Promise<EpisodicMemoryRecord[]> {
    return this.storage.queryRecords(params);
  }
}

