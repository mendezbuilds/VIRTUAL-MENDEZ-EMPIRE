import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import type { EmergencyTier, EmergencyStatus } from '@vme/shared-types';

export class EmergencyHaltError extends Error {
  constructor(public readonly tier: EmergencyTier, reason?: string) {
    super(`CIRCUIT BREAKER TRIGGERED [${tier}]: All agent operations halted. ${reason ?? ''}`);
    this.name = 'EmergencyHaltError';
  }
}

export interface DistributedControlStorage {
  getHaltFlag(): Promise<{ isHalted: boolean; reason?: string }>;
  setHaltFlag(halted: boolean, reason?: string): Promise<void>;
}

export class EmergencySupervisor {
  // Tier 1: In-memory atomic flag (<1ms execution barrier)
  private tier1Halted: boolean = false;
  private haltReason?: string;
  private triggeredBy?: string;
  private triggeredAt?: string;

  private readonly lockFilePath: string | false;

  constructor(
    private readonly distributedStorage?: DistributedControlStorage,
    lockFilePath?: string | false
  ) {
    if (lockFilePath === false) {
      this.lockFilePath = false;
    } else {
      this.lockFilePath = lockFilePath ?? resolve(process.cwd(), 'EMERGENCY_HALT.lock');
    }
  }

  /**
   * Fast-path check executed before every agent step, tool execution, and ledger write.
   */
  assertOperational(): void {
    // 1. Check Tier 1 (Memory)
    if (this.tier1Halted) {
      throw new EmergencyHaltError('TIER_1_PROCESS_ATOMIC', this.haltReason);
    }

    // 2. Check Tier 3 (Host Signal File)
    if (this.lockFilePath && existsSync(this.lockFilePath)) {
      this.tier1Halted = true;
      this.haltReason = 'Host signal file EMERGENCY_HALT.lock detected';
      throw new EmergencyHaltError('TIER_3_FILE_LOCK', this.haltReason);
    }
  }

  isHalted(): boolean {
    if (this.tier1Halted) {
      return true;
    }
    if (this.lockFilePath && existsSync(this.lockFilePath)) {
      return true;
    }
    return false;
  }

  getStatus(): EmergencyStatus {
    const activeTiers: EmergencyTier[] = [];
    if (this.tier1Halted) activeTiers.push('TIER_1_PROCESS_ATOMIC');
    if (this.lockFilePath && existsSync(this.lockFilePath)) activeTiers.push('TIER_3_FILE_LOCK');

    return {
      isHalted: activeTiers.length > 0,
      activeTiers,
      reason: this.haltReason,
      triggeredBy: this.triggeredBy,
      triggeredAt: this.triggeredAt,
    };
  }

  /**
   * Triggers emergency halt across Tier 1, Tier 2, and Tier 3.
   */
  async triggerHalt(reason: string, triggeredBy: string = 'SYSTEM'): Promise<void> {
    const timestamp = new Date().toISOString();
    this.tier1Halted = true;
    this.haltReason = reason;
    this.triggeredBy = triggeredBy;
    this.triggeredAt = timestamp;

    // Trigger Tier 3: Create signal lock file if enabled
    if (this.lockFilePath) {
      try {
        writeFileSync(this.lockFilePath, JSON.stringify({ reason, triggeredBy, timestamp }), 'utf-8');
      } catch {
        // Ignore write errors in restricted sandboxes
      }
    }

    // Trigger Tier 2: Distributed flag
    if (this.distributedStorage) {
      await this.distributedStorage.setHaltFlag(true, reason);
    }
  }

  /**
   * Resets emergency halt (Owner-authorized recovery).
   */
  async resumeOperations(authorizedBy: string): Promise<void> {
    this.tier1Halted = false;
    this.haltReason = undefined;
    this.triggeredBy = undefined;
    this.triggeredAt = undefined;

    if (this.lockFilePath && existsSync(this.lockFilePath)) {
      try {
        unlinkSync(this.lockFilePath);
      } catch {
        // Ignore unlink error
      }
    }

    if (this.distributedStorage) {
      await this.distributedStorage.setHaltFlag(false);
    }
  }
}
