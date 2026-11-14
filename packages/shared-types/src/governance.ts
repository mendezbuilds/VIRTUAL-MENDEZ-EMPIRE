import { z } from 'zod';

export const EmergencyTierSchema = z.enum([
  'TIER_1_PROCESS_ATOMIC',   // Local in-memory atomic barrier
  'TIER_2_DISTRIBUTED_STATE', // Redis / PostgreSQL control flag
  'TIER_3_FILE_LOCK',         // Host filesystem EMERGENCY_HALT.lock
  'TIER_4_OS_WATCHDOG',       // Host process supervisor kill
]);

export type EmergencyTier = z.infer<typeof EmergencyTierSchema>;

export const EmergencyStatusSchema = z.object({
  isHalted: z.boolean(),
  activeTiers: z.array(EmergencyTierSchema),
  reason: z.string().optional(),
  triggeredBy: z.string().optional(),
  triggeredAt: z.string().datetime().optional(),
});

export type EmergencyStatus = z.infer<typeof EmergencyStatusSchema>;

export const FinancialOrderStatusSchema = z.enum([
  'PENDING_SUBMISSION',
  'SUBMITTED',
  'PENDING_CANCELLATION',
  'CANCELLED_CONFIRMED',
  'FILLED',
  'REJECTED',
]);

export type FinancialOrderStatus = z.infer<typeof FinancialOrderStatusSchema>;

export const FinancialOrderSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  symbol: z.string(),
  side: z.enum(['BUY', 'SELL']),
  quantity: z.string(),
  price: z.string().optional(),
  orderType: z.enum(['MARKET', 'LIMIT', 'STOP']),
  status: FinancialOrderStatusSchema,
  externalOrderId: z.string().optional(),
  externalReceiptHash: z.string().optional(),
  cancellationRequestedAt: z.string().datetime().optional(),
  cancellationConfirmedAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type FinancialOrder = z.infer<typeof FinancialOrderSchema>;

export const SecurityContextSchema = z.object({
  tenantId: z.string().uuid(),
  userId: z.string().uuid(),
  departmentId: z.string(),
  roles: z.array(z.string()),
  permissions: z.array(z.string()),
  isOwner: z.boolean(),
  tokenIssuedAt: z.number(),
  tokenExpiresAt: z.number(),
});

export type SecurityContext = z.infer<typeof SecurityContextSchema>;
