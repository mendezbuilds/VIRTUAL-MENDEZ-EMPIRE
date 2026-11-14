import { z } from 'zod';

export const CurrencyCodeSchema = z.enum([
  'USD',
  'EUR',
  'GBP',
  'NGN',
  'BTC',
  'ETH',
  'SOL',
  'USDC',
  'USDT',
]);

export type CurrencyCode = z.infer<typeof CurrencyCodeSchema>;

export const AccountTypeSchema = z.enum([
  'ASSET',
  'LIABILITY',
  'EQUITY',
  'REVENUE',
  'EXPENSE',
]);

export type AccountType = z.infer<typeof AccountTypeSchema>;

export const LedgerAccountSchema = z.object({
  id: z.string().uuid(),
  code: z.string().min(3).max(32),
  name: z.string(),
  type: AccountTypeSchema,
  currency: CurrencyCodeSchema,
  departmentId: z.string(),
  tenantId: z.string().uuid(),
  isActive: z.boolean().default(true),
  balance: z.string(), // high precision numeric representation
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type LedgerAccount = z.infer<typeof LedgerAccountSchema>;

export const PostingDirectionSchema = z.enum(['DEBIT', 'CREDIT']);
export type PostingDirection = z.infer<typeof PostingDirectionSchema>;

export const LedgerPostingSchema = z.object({
  id: z.string().uuid(),
  journalEntryId: z.string().uuid(),
  accountId: z.string().uuid(),
  direction: PostingDirectionSchema,
  amount: z.string().regex(/^\d+(\.\d{1,8})?$/, 'Amount must be a positive decimal string'),
  currency: CurrencyCodeSchema,
  description: z.string().max(256).optional(),
});

export type LedgerPosting = z.infer<typeof LedgerPostingSchema>;

export const JournalEntryStatusSchema = z.enum(['POSTED', 'VOIDED']);
export type JournalEntryStatus = z.infer<typeof JournalEntryStatusSchema>;

export const JournalEntrySchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  entryNumber: z.number().int().positive(),
  description: z.string().min(1).max(512),
  referenceType: z.string().max(64),
  referenceId: z.string().max(128),
  status: JournalEntryStatusSchema.default('POSTED'),
  postings: z.array(LedgerPostingSchema).min(2),
  previousHash: z.string().length(64), // SHA-256 of previous journal entry
  payloadHash: z.string().length(64),  // SHA-256 of current postings & payload
  entryHash: z.string().length(64),    // SHA-256(previousHash + payloadHash + entryNumber + committedAt)
  txId: z.string(),
  committedAt: z.string().datetime(),
});

export type JournalEntry = z.infer<typeof JournalEntrySchema>;

