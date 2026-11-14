import type { JournalEntry, LedgerAccount, LedgerPosting } from '@vme/shared-types';
import type { StorageAdapter } from './ledger-engine.js';

export class InMemoryStorageAdapter implements StorageAdapter {
  private accounts = new Map<string, LedgerAccount>();
  private journals: JournalEntry[] = [];
  private postings: LedgerPosting[] = [];

  constructor(initialAccounts: LedgerAccount[] = []) {
    for (const acc of initialAccounts) {
      this.accounts.set(acc.id, { ...acc });
    }
  }

  async getLatestJournalEntry(tenantId: string): Promise<JournalEntry | null> {
    const tenantJournals = this.journals.filter((j) => j.tenantId === tenantId);
    if (tenantJournals.length === 0) return null;
    return tenantJournals[tenantJournals.length - 1] ?? null;
  }

  async saveJournalEntry(entry: JournalEntry, newPostings: LedgerPosting[]): Promise<void> {
    // Append-only simulation
    this.journals.push(JSON.parse(JSON.stringify(entry)));
    this.postings.push(...JSON.parse(JSON.stringify(newPostings)));
  }

  async getAllJournalEntries(tenantId: string): Promise<JournalEntry[]> {
    return this.journals.filter((j) => j.tenantId === tenantId);
  }

  async getAccount(accountId: string): Promise<LedgerAccount | null> {
    const acc = this.accounts.get(accountId);
    return acc ? { ...acc } : null;
  }

  async updateAccountBalance(accountId: string, newBalance: string): Promise<void> {
    const acc = this.accounts.get(accountId);
    if (acc) {
      acc.balance = newBalance;
      acc.updatedAt = new Date().toISOString();
    }
  }

  // Helper for tests to simulate malicious tampering
  tamperJournalEntry(index: number, modifiedDescription: string): void {
    if (this.journals[index]) {
      this.journals[index].description = modifiedDescription;
    }
  }
}

