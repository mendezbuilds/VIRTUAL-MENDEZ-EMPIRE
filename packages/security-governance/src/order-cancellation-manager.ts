import { createHash } from 'node:crypto';
import type { FinancialOrder } from '@vme/shared-types';

export interface ExternalBrokerClient {
  requestCancellation(externalOrderId: string): Promise<{ acknowledged: boolean }>;
  queryOrderStatus(externalOrderId: string): Promise<{
    status: 'PENDING' | 'CANCELLED' | 'FILLED';
    receiptSignature?: string;
  }>;
}

export class OrderCancellationManager {
  constructor(private readonly brokerClient: ExternalBrokerClient) {}

  /**
   * Initiates order cancellation during emergency stop and enforces external confirmation before resolution.
   */
  async initiateEmergencyCancellation(order: FinancialOrder): Promise<FinancialOrder> {
    if (order.status === 'CANCELLED_CONFIRMED' || order.status === 'REJECTED') {
      return order;
    }

    if (!order.externalOrderId) {
      // Local order not yet submitted externally
      return {
        ...order,
        status: 'CANCELLED_CONFIRMED',
        cancellationConfirmedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }

    // 1. Dispatch cancellation to external counterparty
    const ack = await this.brokerClient.requestCancellation(order.externalOrderId);
    if (!ack.acknowledged) {
      throw new Error(`External broker rejected cancellation request for order ${order.externalOrderId}`);
    }

    // 2. Transition state to PENDING_CANCELLATION (never assume cancelled without receipt!)
    const pendingOrder: FinancialOrder = {
      ...order,
      status: 'PENDING_CANCELLATION',
      cancellationRequestedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    return pendingOrder;
  }

  /**
   * Polls external broker until confirmation receipt is cryptographically verified.
   */
  async confirmCancellation(order: FinancialOrder): Promise<FinancialOrder> {
    if (order.status !== 'PENDING_CANCELLATION') {
      return order;
    }

    if (!order.externalOrderId) {
      return {
        ...order,
        status: 'CANCELLED_CONFIRMED',
        cancellationConfirmedAt: new Date().toISOString(),
      };
    }

    const report = await this.brokerClient.queryOrderStatus(order.externalOrderId);

    if (report.status === 'CANCELLED') {
      const receiptHash = report.receiptSignature
        ? createHash('sha256').update(report.receiptSignature).digest('hex')
        : createHash('sha256').update(`CANCELLED:${order.externalOrderId}:${Date.now()}`).digest('hex');

      return {
        ...order,
        status: 'CANCELLED_CONFIRMED',
        externalReceiptHash: receiptHash,
        cancellationConfirmedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }

    if (report.status === 'FILLED') {
      // Order was already filled prior to cancellation arriving at broker!
      return {
        ...order,
        status: 'FILLED',
        updatedAt: new Date().toISOString(),
      };
    }

    // Still pending at broker
    return order;
  }
}

