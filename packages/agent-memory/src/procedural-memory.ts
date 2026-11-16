import {
  type ProceduralPlaybook,
  type DepartmentId,
  type MemoryScope,
  type MemoryAccessPrincipal,
  ProceduralPlaybookSchema,
} from '@vme/shared-types';
import { SecretRedactor } from './secret-redactor.js';
import { MemoryAccessController, UnauthorizedMemoryAccessError } from './memory-access-controller.js';

export interface ProceduralQueryFilter {
  departmentId?: DepartmentId;
  scope?: MemoryScope;
  requiredCapability?: string;
  isApproved?: boolean;
  limit?: number;
}

export interface ProceduralStorage {
  savePlaybook(playbook: ProceduralPlaybook): Promise<void>;
  getPlaybookById(id: string): Promise<ProceduralPlaybook | undefined>;
  queryPlaybooks(filter: ProceduralQueryFilter): Promise<ProceduralPlaybook[]>;
  updateExecutionStats(id: string, success: boolean): Promise<void>;
  approvePlaybook(id: string, approvedBy: string): Promise<void>;
}

export class InMemoryProceduralStorage implements ProceduralStorage {
  private playbooks: ProceduralPlaybook[] = [];

  async savePlaybook(playbook: ProceduralPlaybook): Promise<void> {
    const idx = this.playbooks.findIndex((p) => p.id === playbook.id);
    if (idx !== -1) {
      this.playbooks[idx] = structuredClone(playbook);
    } else {
      this.playbooks.push(structuredClone(playbook));
    }
  }

  async getPlaybookById(id: string): Promise<ProceduralPlaybook | undefined> {
    const found = this.playbooks.find((p) => p.id === id);
    return found ? structuredClone(found) : undefined;
  }

  async queryPlaybooks(filter: ProceduralQueryFilter): Promise<ProceduralPlaybook[]> {
    return this.playbooks
      .filter((p) => {
        if (filter.departmentId && p.departmentId !== filter.departmentId) return false;
        if (filter.scope && p.scope !== filter.scope) return false;
        if (filter.isApproved !== undefined && p.isApproved !== filter.isApproved) return false;
        if (filter.requiredCapability && !p.requiredCapabilities.includes(filter.requiredCapability)) {
          return false;
        }
        return true;
      })
      .slice(0, filter.limit ?? 50)
      .map((p) => structuredClone(p));
  }

  async updateExecutionStats(id: string, success: boolean): Promise<void> {
    const playbook = this.playbooks.find((p) => p.id === id);
    if (playbook) {
      if (success) {
        playbook.successCount += 1;
      } else {
        playbook.failureCount += 1;
      }
      playbook.updatedAt = new Date().toISOString();
    }
  }

  async approvePlaybook(id: string, approvedBy: string): Promise<void> {
    const playbook = this.playbooks.find((p) => p.id === id);
    if (playbook) {
      playbook.isApproved = true;
      playbook.authorizedBy = approvedBy;
      playbook.updatedAt = new Date().toISOString();
    }
  }
}

export class ProceduralMemory {
  constructor(private readonly storage: ProceduralStorage) {}

  async storePlaybook(
    playbook: ProceduralPlaybook,
    principal?: MemoryAccessPrincipal
  ): Promise<void> {
    if (principal) {
      MemoryAccessController.assertAccess(
        principal,
        {
          scope: playbook.scope,
          authorAgentId: playbook.authorAgentId,
          departmentId: playbook.departmentId,
        },
        'WRITE'
      );

      // Creating a pre-approved playbook requires Director or Executive authority
      if (playbook.isApproved) {
        if (
          principal.principalType !== 'OWNER_PRINCIPAL' &&
          principal.level !== 'EXECUTIVE' &&
          principal.level !== 'DIRECTOR'
        ) {
          throw new UnauthorizedMemoryAccessError(
            `Agent '${principal.principalId}' cannot directly author pre-approved procedural playbooks. Approval must be granted by a Director or Executive.`
          );
        }
      }
    }

    const sanitized = SecretRedactor.sanitize(playbook, true);
    const parsed = ProceduralPlaybookSchema.parse(sanitized);

    await this.storage.savePlaybook(parsed);
  }

  async approvePlaybook(
    playbookId: string,
    principal: MemoryAccessPrincipal
  ): Promise<void> {
    const playbook = await this.storage.getPlaybookById(playbookId);
    if (!playbook) {
      throw new Error(`Playbook with id '${playbookId}' not found.`);
    }

    // Require Director, Executive, or Owner
    if (
      principal.principalType !== 'OWNER_PRINCIPAL' &&
      principal.level !== 'EXECUTIVE' &&
      principal.level !== 'DIRECTOR'
    ) {
      throw new UnauthorizedMemoryAccessError(
        `Approval of procedural playbooks requires Director or Executive authority. Principal '${principal.principalId}' is '${principal.level}'.`
      );
    }

    // If departmental, director must belong to that department (unless Executive or Owner)
    if (
      playbook.scope === 'DEPARTMENT_SCOPED' &&
      principal.level === 'DIRECTOR' &&
      principal.departmentId !== playbook.departmentId
    ) {
      throw new UnauthorizedMemoryAccessError(
        `Director '${principal.principalId}' of department '${principal.departmentId}' cannot approve playbook for department '${playbook.departmentId}'.`
      );
    }

    await this.storage.approvePlaybook(playbookId, principal.principalId);
  }

  async getPlaybook(
    id: string,
    principal?: MemoryAccessPrincipal
  ): Promise<ProceduralPlaybook | undefined> {
    const playbook = await this.storage.getPlaybookById(id);
    if (!playbook) return undefined;

    if (principal) {
      MemoryAccessController.assertAccess(
        principal,
        {
          scope: playbook.scope,
          authorAgentId: playbook.authorAgentId,
          departmentId: playbook.departmentId,
        },
        'READ'
      );
    }

    return playbook;
  }

  async queryPlaybooks(
    filter: ProceduralQueryFilter,
    principal?: MemoryAccessPrincipal
  ): Promise<ProceduralPlaybook[]> {
    const playbooks = await this.storage.queryPlaybooks(filter);

    if (!principal) {
      return playbooks;
    }

    return playbooks.filter((p) => {
      try {
        MemoryAccessController.assertAccess(
          principal,
          {
            scope: p.scope,
            authorAgentId: p.authorAgentId,
            departmentId: p.departmentId,
          },
          'READ'
        );
        return true;
      } catch {
        return false;
      }
    });
  }

  async recordExecutionOutcome(playbookId: string, success: boolean): Promise<void> {
    await this.storage.updateExecutionStats(playbookId, success);
  }
}
