import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  LedgerEngine,
  InMemoryStorageAdapter,
  LedgerImbalanceError,
  ImmutableLedgerViolationError,
  HashChainCorruptionError,
} from './index.js';
import type { LedgerAccount } from '@vme/shared-types';

describe('@vme/ledger-core Hardened Double-Entry Ledger', () => {
  const tenantId = randomUUID();
  const cashAccountId = randomUUID();
  const equityAccountId = randomUUID();
  const expenseAccountId = randomUUID();

  const initialAccounts: LedgerAccount[] = [
    {
      id: cashAccountId,
      code: '1000',
      name: 'Central Operating Cash (USD)',
      type: 'ASSET',
      currency: 'USD',
      departmentId: 'financial_intelligence',
      tenantId,
      isActive: true,
      balance: '0.00',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: equityAccountId,
      code: '3000',
      name: "Owner's Contributed Capital",
      type: 'EQUITY',
      currency: 'USD',
      departmentId: 'financial_intelligence',
      tenantId,
      isActive: true,
      balance: '0.00',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: expenseAccountId,
      code: '5000',
      name: 'Server & Cloud Hosting Expense',
      type: 'EXPENSE',
      currency: 'USD',
      departmentId: 'technology_engineering',
      tenantId,
      isActive: true,
      balance: '0.00',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];

  let storage: InMemoryStorageAdapter;
  let ledger: LedgerEngine;

  beforeEach(() => {
    storage = new InMemoryStorageAdapter(initialAccounts);
    ledger = new LedgerEngine(storage);
  });

  it('posts a perfectly balanced capital injection and updates account balances', async () => {
    const entry = await ledger.postTransaction({
      tenantId,
      description: 'Initial Owner Capital Injection',
      referenceType: 'CAPITAL_CONTRIBUTION',
      referenceId: 'CC-001',
      postings: [
        {
          accountId: cashAccountId,
          direction: 'DEBIT',
          amount: '50000.00',
          currency: 'USD',
        },
        {
          accountId: equityAccountId,
          direction: 'CREDIT',
          amount: '50000.00',
          currency: 'USD',
        },
      ],
    });

    expect(entry.entryNumber).toBe(1);
    expect(entry.status).toBe('POSTED');
    expect(entry.previousHash).toBe('0'.repeat(64));
    expect(entry.entryHash).toHaveLength(64);

    const cashAccount = await storage.getAccount(cashAccountId);
    const equityAccount = await storage.getAccount(equityAccountId);

    expect(cashAccount?.balance).toBe('50000.00');
    expect(equityAccount?.balance).toBe('50000.00');
  });

  it('strictly rejects imbalanced transactions and performs zero mutations', async () => {
    await expect(
      ledger.postTransaction({
        tenantId,
        description: 'Faulty Imbalanced Entry',
        referenceType: 'MANUAL',
        referenceId: 'ERR-001',
        postings: [
          {
            accountId: cashAccountId,
            direction: 'DEBIT',
            amount: '100.00',
            currency: 'USD',
          },
          {
            accountId: equityAccountId,
            direction: 'CREDIT',
            amount: '90.00',
            currency: 'USD',
          },
        ],
      })
    ).rejects.toThrow(LedgerImbalanceError);

    // Verify account balances remain untouched at 0.00
    const cashAccount = await storage.getAccount(cashAccountId);
    expect(cashAccount?.balance).toBe('0.00');

    // Verify no journal entries were saved
    const journals = await storage.getAllJournalEntries(tenantId);
    expect(journals).toHaveLength(0);
  });

  it('enforces immutability: updates and deletes are rejected at the engine level', async () => {
    await expect(ledger.updateJournalEntry()).rejects.toThrow(ImmutableLedgerViolationError);
    await expect(ledger.deleteJournalEntry()).rejects.toThrow(ImmutableLedgerViolationError);
  });

  it('maintains valid cryptographic hash chaining across multiple entries', async () => {
    // Transaction 1: Capital injection ($50,000)
    const entry1 = await ledger.postTransaction({
      tenantId,
      description: 'Capital Injection',
      referenceType: 'EQUITY',
      referenceId: 'EQ-001',
      postings: [
        { accountId: cashAccountId, direction: 'DEBIT', amount: '50000.00', currency: 'USD' },
        { accountId: equityAccountId, direction: 'CREDIT', amount: '50000.00', currency: 'USD' },
      ],
    });

    // Transaction 2: Server hosting payment ($500)
    const entry2 = await ledger.postTransaction({
      tenantId,
      description: 'Cloud Infrastructure Payment',
      referenceType: 'EXPENSE',
      referenceId: 'INV-102',
      postings: [
        { accountId: expenseAccountId, direction: 'DEBIT', amount: '500.00', currency: 'USD' },
        { accountId: cashAccountId, direction: 'CREDIT', amount: '500.00', currency: 'USD' },
      ],
    });

    expect(entry2.previousHash).toBe(entry1.entryHash);
    expect(entry2.entryNumber).toBe(2);

    // Verify chain integrity passes
    const isValid = await ledger.verifyChain(tenantId);
    expect(isValid).toBe(true);

    const cashAccount = await storage.getAccount(cashAccountId);
    expect(cashAccount?.balance).toBe('49500.00'); // 50000 - 500
  });

  it('detects tampering with historical journal entries immediately', async () => {
    await ledger.postTransaction({
      tenantId,
      description: 'Legitimate Entry 1',
      referenceType: 'EQUITY',
      referenceId: 'EQ-001',
      postings: [
        { accountId: cashAccountId, direction: 'DEBIT', amount: '1000.00', currency: 'USD' },
        { accountId: equityAccountId, direction: 'CREDIT', amount: '1000.00', currency: 'USD' },
      ],
    });

    await ledger.postTransaction({
      tenantId,
      description: 'Legitimate Entry 2',
      referenceType: 'EXPENSE',
      referenceId: 'EXP-001',
      postings: [
        { accountId: expenseAccountId, direction: 'DEBIT', amount: '100.00', currency: 'USD' },
        { accountId: cashAccountId, direction: 'CREDIT', amount: '100.00', currency: 'USD' },
      ],
    });

    // Maliciously tamper with Entry 1 description in storage
    storage.tamperJournalEntry(0, 'Tampered description by attacker');

    // Verification must fail and throw HashChainCorruptionError
    await expect(ledger.verifyChain(tenantId)).rejects.toThrow(HashChainCorruptionError);
  });
});
