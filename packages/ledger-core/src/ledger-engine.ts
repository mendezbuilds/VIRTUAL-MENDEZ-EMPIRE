import { randomUUID } from 'node:crypto';
import type {
  JournalEntry,
  LedgerAccount,
  LedgerPosting,
  CurrencyCode,
} from '@vme/shared-types';
import {
  LedgerImbalanceError,
  ImmutableLedgerViolationError,
  HashChainCorruptionError,
} from './errors.js';
import {
  computePayloadHash,
  computeEntryHash,
  verifyJournalIntegrity,
  GENESIS_HASH,
} from './hasher.js';
import { parseToMicroUnits, formatFromMicroUnits } from './decimal.js';

export interface StorageAdapter {
  getLatestJournalEntry(tenantId: string): Promise<JournalEntry | null>;
  saveJournalEntry(entry: JournalEntry, postings: LedgerPosting[]): Promise<void>;
  getAllJournalEntries(tenantId: string): Promise<JournalEntry[]>;
  getAccount(accountId: string): Promise<LedgerAccount | null>;
  updateAccountBalance(accountId: string, newBalance: string): Promise<void>;
}

export interface PostTransactionParams {
  tenantId: string;
  description: string;
  referenceType: string;
  referenceId: string;
  txId?: string;
  postings: Array<{
    accountId: string;
    direction: 'DEBIT' | 'CREDIT';
    amount: string;
    currency: CurrencyCode;
    description?: string;
  }>;
}

export class LedgerEngine {
  constructor(private readonly storage: StorageAdapter) {}

  /**
   * Posts an atomic, balanced, cryptographically chained double-entry journal entry.
   */
  async postTransaction(params: PostTransactionParams): Promise<JournalEntry> {
    if (params.postings.length < 2) {
      throw new LedgerImbalanceError('0', '0', 'EMPTY');
    }

    // 1. Verify currency-by-currency zero-sum balance
    const balanceByCurrency = new Map<CurrencyCode, { debit: bigint; credit: bigint }>();

    for (const posting of params.postings) {
      const units = parseToMicroUnits(posting.amount);
      if (units <= 0n) {
        throw new Error(`Invalid posting amount: ${posting.amount}. Amount must be positive.`);
      }

      const current = balanceByCurrency.get(posting.currency) ?? { debit: 0n, credit: 0n };
      if (posting.direction === 'DEBIT') {
        current.debit += units;
      } else {
        current.credit += units;
      }
      balanceByCurrency.set(posting.currency, current);
    }

    for (const [currency, { debit, credit }] of balanceByCurrency.entries()) {
      if (debit !== credit) {
        throw new LedgerImbalanceError(
          formatFromMicroUnits(debit),
          formatFromMicroUnits(credit),
          currency
        );
      }
    }

    // 2. Fetch latest journal entry for monotonic sequence & hash chaining
    const latestEntry = await this.storage.getLatestJournalEntry(params.tenantId);
    const previousHash = latestEntry ? latestEntry.entryHash : GENESIS_HASH;
    const nextEntryNumber = latestEntry ? latestEntry.entryNumber + 1 : 1;

    // 3. Compute cryptographic hashes
    const payloadHash = computePayloadHash(
      params.postings,
      params.description,
      params.referenceType,
      params.referenceId
    );

    const committedAt = new Date().toISOString();
    const journalEntryId = randomUUID();
    const txId = params.txId ?? `tx-${Date.now()}-${randomUUID().slice(0, 8)}`;

    const entryHash = computeEntryHash(
      previousHash,
      payloadHash,
      nextEntryNumber,
      txId,
      committedAt
    );

    // 4. Map postings with foreign keys
    const ledgerPostings: LedgerPosting[] = params.postings.map((p) => ({
      id: randomUUID(),
      journalEntryId,
      accountId: p.accountId,
      direction: p.direction,
      amount: p.amount,
      currency: p.currency,
      description: p.description,
    }));

    const journalEntry: JournalEntry = {
      id: journalEntryId,
      tenantId: params.tenantId,
      entryNumber: nextEntryNumber,
      description: params.description,
      referenceType: params.referenceType,
      referenceId: params.referenceId,
      status: 'POSTED',
      postings: ledgerPostings,
      previousHash,
      payloadHash,
      entryHash,
      txId,
      committedAt,
    };

    // 5. Update account balances according to normal balance rules
    for (const posting of ledgerPostings) {
      const account = await this.storage.getAccount(posting.accountId);
      if (!account) {
        throw new Error(`Account not found: ${posting.accountId}`);
      }

      const postingUnits = parseToMicroUnits(posting.amount);
      const currentUnits = parseToMicroUnits(account.balance);
      let updatedUnits = currentUnits;

      // Normal balance rules:
      // ASSET & EXPENSE: Debit = (+), Credit = (-)
      // LIABILITY, EQUITY, REVENUE: Credit = (+), Debit = (-)
      const isDebitNormal = account.type === 'ASSET' || account.type === 'EXPENSE';
      if (posting.direction === 'DEBIT') {
        updatedUnits = isDebitNormal ? currentUnits + postingUnits : currentUnits - postingUnits;
      } else {
        updatedUnits = isDebitNormal ? currentUnits - postingUnits : currentUnits + postingUnits;
      }

      await this.storage.updateAccountBalance(account.id, formatFromMicroUnits(updatedUnits));
    }

    // 6. Atomically persist immutable journal and postings
    await this.storage.saveJournalEntry(journalEntry, ledgerPostings);

    return journalEntry;
  }

  /**
   * Prohibits update operations on ledger records.
   */
  async updateJournalEntry(): Promise<never> {
    throw new ImmutableLedgerViolationError('UPDATE');
  }

  /**
   * Prohibits delete operations on ledger records.
   */
  async deleteJournalEntry(): Promise<never> {
    throw new ImmutableLedgerViolationError('DELETE');
  }

  /**
   * Verifies the cryptographic integrity of the entire journal chain.
   */
  async verifyChain(tenantId: string): Promise<boolean> {
    const entries = await this.storage.getAllJournalEntries(tenantId);
    const result = verifyJournalIntegrity(entries);
    if (!result.isValid) {
      throw new HashChainCorruptionError(
        result.brokenAtIndex ?? -1,
        'Valid Hash',
        result.reason ?? 'Integrity failure'
      );
    }
    return true;
  }
}
