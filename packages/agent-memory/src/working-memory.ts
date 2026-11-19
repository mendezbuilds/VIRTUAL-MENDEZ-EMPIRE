import { SecretRedactor } from './secret-redactor.js';

export interface ScratchpadEntry {
  key: string;
  value: unknown;
  updatedAt: number;
  expiresAt?: number;
}

export interface WorkingMemoryStorage {
  set(
    taskId: string,
    key: string,
    value: unknown,
    expiresAt: Date,
    agentId?: string
  ): Promise<void>;
  get<T>(taskId: string, key: string): Promise<T | undefined>;
  getAll(taskId: string): Promise<Record<string, unknown>>;
  clear(taskId: string): Promise<void>;
  cleanupExpired(): Promise<number>;
}

export class InMemoryWorkingStorage implements WorkingMemoryStorage {
  private store = new Map<string, Map<string, { value: unknown; expiresAt: Date }>>();

  async set(
    taskId: string,
    key: string,
    value: unknown,
    expiresAt: Date,
    _agentId?: string
  ): Promise<void> {
    let taskMap = this.store.get(taskId);
    if (!taskMap) {
      taskMap = new Map();
      this.store.set(taskId, taskMap);
    }
    taskMap.set(key, { value, expiresAt });
  }

  async get<T>(taskId: string, key: string): Promise<T | undefined> {
    const taskMap = this.store.get(taskId);
    if (!taskMap) return undefined;
    const item = taskMap.get(key);
    if (!item) return undefined;
    if (new Date() > item.expiresAt) {
      taskMap.delete(key);
      return undefined;
    }
    return item.value as T;
  }

  async getAll(taskId: string): Promise<Record<string, unknown>> {
    const taskMap = this.store.get(taskId);
    if (!taskMap) return {};
    const res: Record<string, unknown> = {};
    const now = new Date();
    for (const [k, v] of taskMap.entries()) {
      if (now <= v.expiresAt) {
        res[k] = v.value;
      }
    }
    return res;
  }

  async clear(taskId: string): Promise<void> {
    this.store.delete(taskId);
  }

  async cleanupExpired(): Promise<number> {
    const now = new Date();
    let purged = 0;
    for (const [tId, map] of this.store.entries()) {
      for (const [k, v] of map.entries()) {
        if (now > v.expiresAt) {
          map.delete(k);
          purged++;
        }
      }
      if (map.size === 0) this.store.delete(tId);
    }
    return purged;
  }
}

export interface WorkingMemoryOptions {
  defaultTtlSeconds?: number;
  storage?: WorkingMemoryStorage;
}

export class WorkingMemory {
  private scratchpads = new Map<string, Map<string, ScratchpadEntry>>(); // taskId -> (key -> entry)
  private defaultTtlSeconds?: number;
  public readonly storage?: WorkingMemoryStorage;

  constructor(options?: WorkingMemoryOptions) {
    this.defaultTtlSeconds = options?.defaultTtlSeconds;
    this.storage = options?.storage;
  }

  set(taskId: string, key: string, value: unknown, ttlSeconds?: number, agentId?: string): void {
    let taskMap = this.scratchpads.get(taskId);
    if (!taskMap) {
      taskMap = new Map();
      this.scratchpads.set(taskId, taskMap);
    }

    const sanitizedValue = SecretRedactor.sanitize(value, false);
    const now = Date.now();
    const effectiveTtl = ttlSeconds ?? this.defaultTtlSeconds ?? 3600;
    const expiresAt = now + effectiveTtl * 1000;

    taskMap.set(key, {
      key,
      value: sanitizedValue,
      updatedAt: now,
      expiresAt,
    });

    if (this.storage) {
      this.storage
        .set(taskId, key, sanitizedValue, new Date(expiresAt), agentId)
        .catch(() => {});
    }
  }

  async setAsync(
    taskId: string,
    key: string,
    value: unknown,
    ttlSeconds?: number,
    agentId?: string
  ): Promise<void> {
    let taskMap = this.scratchpads.get(taskId);
    if (!taskMap) {
      taskMap = new Map();
      this.scratchpads.set(taskId, taskMap);
    }

    const sanitizedValue = SecretRedactor.sanitize(value, false);
    const now = Date.now();
    const effectiveTtl = ttlSeconds ?? this.defaultTtlSeconds ?? 3600;
    const expiresAt = now + effectiveTtl * 1000;

    taskMap.set(key, {
      key,
      value: sanitizedValue,
      updatedAt: now,
      expiresAt,
    });

    if (this.storage) {
      await this.storage.set(taskId, key, sanitizedValue, new Date(expiresAt), agentId);
    }
  }

  get<T>(taskId: string, key: string): T | undefined {
    const taskMap = this.scratchpads.get(taskId);
    if (!taskMap) return undefined;

    const entry = taskMap.get(key);
    if (!entry) return undefined;

    if (entry.expiresAt !== undefined && Date.now() > entry.expiresAt) {
      taskMap.delete(key);
      if (taskMap.size === 0) {
        this.scratchpads.delete(taskId);
      }
      return undefined;
    }

    return entry.value as T;
  }

  async getAsync<T>(taskId: string, key: string): Promise<T | undefined> {
    const cached = this.get<T>(taskId, key);
    if (cached !== undefined) return cached;

    if (this.storage) {
      const stored = await this.storage.get<T>(taskId, key);
      if (stored !== undefined) {
        let taskMap = this.scratchpads.get(taskId);
        if (!taskMap) {
          taskMap = new Map();
          this.scratchpads.set(taskId, taskMap);
        }
        taskMap.set(key, {
          key,
          value: stored,
          updatedAt: Date.now(),
          expiresAt: Date.now() + (this.defaultTtlSeconds ?? 3600) * 1000,
        });
        return stored;
      }
    }

    return undefined;
  }

  has(taskId: string, key: string): boolean {
    return this.get(taskId, key) !== undefined;
  }

  getAll(taskId: string): Record<string, unknown> {
    const taskMap = this.scratchpads.get(taskId);
    if (!taskMap) return {};

    const now = Date.now();
    const result: Record<string, unknown> = {};
    const toDelete: string[] = [];

    for (const [k, v] of taskMap.entries()) {
      if (v.expiresAt !== undefined && now > v.expiresAt) {
        toDelete.push(k);
      } else {
        result[k] = v.value;
      }
    }

    for (const k of toDelete) {
      taskMap.delete(k);
    }
    if (taskMap.size === 0) {
      this.scratchpads.delete(taskId);
    }

    return result;
  }

  async getAllAsync(taskId: string): Promise<Record<string, unknown>> {
    const local = this.getAll(taskId);
    if (Object.keys(local).length > 0) return local;

    if (this.storage) {
      const stored = await this.storage.getAll(taskId);
      for (const [k, v] of Object.entries(stored)) {
        this.set(taskId, k, v);
      }
      return stored;
    }

    return local;
  }

  cleanupExpired(): number {
    const now = Date.now();
    let purgedCount = 0;

    for (const [taskId, taskMap] of this.scratchpads.entries()) {
      for (const [key, entry] of taskMap.entries()) {
        if (entry.expiresAt !== undefined && now > entry.expiresAt) {
          taskMap.delete(key);
          purgedCount++;
        }
      }
      if (taskMap.size === 0) {
        this.scratchpads.delete(taskId);
      }
    }

    if (this.storage) {
      this.storage.cleanupExpired().catch(() => {});
    }

    return purgedCount;
  }

  async cleanupExpiredAsync(): Promise<number> {
    const localPurged = this.cleanupExpired();
    let storagePurged = 0;
    if (this.storage) {
      storagePurged = await this.storage.cleanupExpired();
    }
    return Math.max(localPurged, storagePurged);
  }

  clear(taskId: string): void {
    this.scratchpads.delete(taskId);
    if (this.storage) {
      this.storage.clear(taskId).catch(() => {});
    }
  }

  async clearAsync(taskId: string): Promise<void> {
    this.scratchpads.delete(taskId);
    if (this.storage) {
      await this.storage.clear(taskId);
    }
  }

  clearAll(): void {
    this.scratchpads.clear();
  }

  getActiveTaskCount(): number {
    return this.scratchpads.size;
  }
}
