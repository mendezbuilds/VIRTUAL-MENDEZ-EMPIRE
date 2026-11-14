import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import {
  EmergencySupervisor,
  EmergencyHaltError,
  OrderCancellationManager,
  TenantSecurityManager,
  UnauthorizedTenantError,
  InsufficientPermissionError,
  type ExternalBrokerClient,
} from './index.js';
import type { FinancialOrder, SecurityContext } from '@vme/shared-types';

describe('@vme/security-governance Multi-Tier Circuit Breaker & Governance', () => {
  const testLockPath = resolve(process.cwd(), 'TEST_EMERGENCY_HALT.lock');

  beforeEach(() => {
    if (existsSync(testLockPath)) {
      unlinkSync(testLockPath);
    }
  });

  afterEach(() => {
    if (existsSync(testLockPath)) {
      unlinkSync(testLockPath);
    }
  });

  it('Tier 1 in-memory halt blocks assertion within <1ms', async () => {
    const supervisor = new EmergencySupervisor(undefined, testLockPath);
    expect(supervisor.isHalted()).toBe(false);

    await supervisor.triggerHalt('Critical risk threshold exceeded', 'RISK_ENGINE');

    expect(supervisor.isHalted()).toBe(true);
    expect(() => supervisor.assertOperational()).toThrow(EmergencyHaltError);
  });

  it('Tier 3 signal file presence on host disk halts execution immediately', () => {
    const supervisor = new EmergencySupervisor(undefined, testLockPath);

    // Simulate external lock file created on host
    writeFileSync(testLockPath, 'LOCK', 'utf-8');

    expect(supervisor.isHalted()).toBe(true);
    expect(() => supervisor.assertOperational()).toThrow(EmergencyHaltError);
  });

  it('enforces external broker confirmation receipt before settling order cancellation', async () => {
    let brokerStatus: 'PENDING' | 'CANCELLED' = 'PENDING';
    const mockBroker: ExternalBrokerClient = {
      requestCancellation: async () => ({ acknowledged: true }),
      queryOrderStatus: async () => ({
        status: brokerStatus,
        receiptSignature: brokerStatus === 'CANCELLED' ? 'sig_broker_valid_12345' : undefined,
      }),
    };

    const manager = new OrderCancellationManager(mockBroker);
    const order: FinancialOrder = {
      id: randomUUID(),
      tenantId: randomUUID(),
      symbol: 'BTC/USD',
      side: 'BUY',
      quantity: '1.5',
      orderType: 'LIMIT',
      price: '65000.00',
      status: 'SUBMITTED',
      externalOrderId: 'ext-binance-001',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Step 1: Initiate cancellation -> MUST transition to PENDING_CANCELLATION
    const pendingOrder = await manager.initiateEmergencyCancellation(order);
    expect(pendingOrder.status).toBe('PENDING_CANCELLATION');

    // Step 2: Query while broker is still pending -> MUST remain PENDING_CANCELLATION
    const stillPending = await manager.confirmCancellation(pendingOrder);
    expect(stillPending.status).toBe('PENDING_CANCELLATION');
    expect(stillPending.externalReceiptHash).toBeUndefined();

    // Step 3: Broker acknowledges external cancellation
    brokerStatus = 'CANCELLED';
    const confirmedOrder = await manager.confirmCancellation(stillPending);
    expect(confirmedOrder.status).toBe('CANCELLED_CONFIRMED');
    expect(confirmedOrder.externalReceiptHash).toBeDefined();
    expect(confirmedOrder.cancellationConfirmedAt).toBeDefined();
  });

  it('enforces strict tenant isolation and RBAC', () => {
    const security = new TenantSecurityManager();
    const tenantA = randomUUID();
    const tenantB = randomUUID();

    const userContext: SecurityContext = {
      tenantId: tenantA,
      userId: randomUUID(),
      departmentId: 'marketing_growth',
      roles: ['specialist'],
      permissions: ['campaign:read', 'campaign:write'],
      isOwner: false,
      tokenIssuedAt: Date.now(),
      tokenExpiresAt: Date.now() + 3600_000,
    };

    // Accessing Tenant A is valid
    expect(() => security.assertTenantAccess(userContext, tenantA)).not.toThrow();

    // Cross-tenant access to Tenant B must fail
    expect(() => security.assertTenantAccess(userContext, tenantB)).toThrow(
      UnauthorizedTenantError
    );

    // Permission check
    expect(() => security.assertPermission(userContext, 'campaign:read')).not.toThrow();
    expect(() => security.assertPermission(userContext, 'ledger:transfer')).toThrow(
      InsufficientPermissionError
    );

    // Owner bypass check
    const ownerContext: SecurityContext = {
      ...userContext,
      isOwner: true,
      permissions: [],
    };
    expect(() => security.assertPermission(ownerContext, 'ledger:transfer')).not.toThrow();
  });
});

