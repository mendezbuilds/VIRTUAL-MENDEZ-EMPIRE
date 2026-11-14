import { describe, it, expect } from 'vitest';
import {
  DepartmentIdSchema,
  JournalEntrySchema,
  EmergencyTierSchema,
  FinancialOrderSchema,
} from './index.js';

describe('@vme/shared-types Domain Schemas', () => {
  it('validates 9 core empire departments', () => {
    const validDepts = [
      'executive_office',
      'financial_intelligence',
      'technology_engineering',
      'business_development',
      'marketing_growth',
      'operations_administration',
      'opportunity_acquisition',
      'research_intelligence',
      'security_governance',
    ];
    for (const dept of validDepts) {
      expect(DepartmentIdSchema.safeParse(dept).success).toBe(true);
    }
    expect(DepartmentIdSchema.safeParse('invalid_dept').success).toBe(false);
  });

  it('validates double-entry journal schema requirement for at least 2 postings', () => {
    const invalidEntry = {
      id: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
      tenantId: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
      entryNumber: 1,
      description: 'Capital Injection',
      referenceType: 'MANUAL',
      referenceId: 'REF-001',
      status: 'POSTED',
      postings: [
        {
          id: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6e',
          journalEntryId: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
          accountId: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6f',
          direction: 'DEBIT',
          amount: '1000.00',
          currency: 'USD',
        },
      ],
      previousHash: '0'.repeat(64),
      payloadHash: 'a'.repeat(64),
      entryHash: 'b'.repeat(64),
      txId: 'tx-100',
      committedAt: new Date().toISOString(),
    };
    // Should fail because double-entry requires at least 2 postings (debit + credit)
    const result = JournalEntrySchema.safeParse(invalidEntry);
    expect(result.success).toBe(false);
  });

  it('validates 4-tier emergency shutdown schema', () => {
    expect(EmergencyTierSchema.safeParse('TIER_1_PROCESS_ATOMIC').success).toBe(true);
    expect(EmergencyTierSchema.safeParse('TIER_2_DISTRIBUTED_STATE').success).toBe(true);
    expect(EmergencyTierSchema.safeParse('TIER_3_FILE_LOCK').success).toBe(true);
    expect(EmergencyTierSchema.safeParse('TIER_4_OS_WATCHDOG').success).toBe(true);
    expect(EmergencyTierSchema.safeParse('UNKNOWN_TIER').success).toBe(false);
  });
});
