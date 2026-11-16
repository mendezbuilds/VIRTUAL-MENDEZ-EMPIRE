import { SecretRedactor } from './secret-redactor.js';

export interface ScratchpadEntry {
  key: string;
  value: unknown;
  updatedAt: number;
  expiresAt?: number;
}

export class WorkingMemory {
  private scratchpads = new Map<string, Map<string, ScratchpadEntry>>(); // taskId -> (key -> entry)
  private defaultTtlSeconds?: number;

  constructor(options?: { defaultTtlSeconds?: number }) {
    this.defaultTtlSeconds = options?.defaultTtlSeconds;
  }

  set(taskId: string, key: string, value: unknown, ttlSeconds?: number): void {
    let taskMap = this.scratchpads.get(taskId);
    if (!taskMap) {
      taskMap = new Map();
      this.scratchpads.set(taskId, taskMap);
    }

    const sanitizedValue = SecretRedactor.sanitize(value, false);
    const now = Date.now();
    const effectiveTtl = ttlSeconds ?? this.defaultTtlSeconds;
    const expiresAt = effectiveTtl !== undefined ? now + effectiveTtl * 1000 : undefined;

    taskMap.set(key, {
      key,
      value: sanitizedValue,
      updatedAt: now,
      expiresAt,
    });
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

    return purgedCount;
  }

  clear(taskId: string): void {
    this.scratchpads.delete(taskId);
  }

  clearAll(): void {
    this.scratchpads.clear();
  }

  getActiveTaskCount(): number {
    return this.scratchpads.size;
  }
}
