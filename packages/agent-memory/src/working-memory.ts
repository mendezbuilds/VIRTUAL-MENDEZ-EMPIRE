export interface ScratchpadEntry {
  key: string;
  value: unknown;
  updatedAt: number;
}

export class WorkingMemory {
  private scratchpads = new Map<string, Map<string, ScratchpadEntry>>(); // taskId -> (key -> entry)

  set(taskId: string, key: string, value: unknown): void {
    let taskMap = this.scratchpads.get(taskId);
    if (!taskMap) {
      taskMap = new Map();
      this.scratchpads.set(taskId, taskMap);
    }
    taskMap.set(key, {
      key,
      value,
      updatedAt: Date.now(),
    });
  }

  get<T>(taskId: string, key: string): T | undefined {
    const taskMap = this.scratchpads.get(taskId);
    if (!taskMap) return undefined;
    const entry = taskMap.get(key);
    return entry ? (entry.value as T) : undefined;
  }

  getAll(taskId: string): Record<string, unknown> {
    const taskMap = this.scratchpads.get(taskId);
    if (!taskMap) return {};
    const result: Record<string, unknown> = {};
    for (const [k, v] of taskMap.entries()) {
      result[k] = v.value;
    }
    return result;
  }

  clear(taskId: string): void {
    this.scratchpads.delete(taskId);
  }
}

