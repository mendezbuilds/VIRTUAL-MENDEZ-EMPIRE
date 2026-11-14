export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerError';
  }
}

export class LedgerImbalanceError extends LedgerError {
  constructor(
    public readonly totalDebit: string,
    public readonly totalCredit: string,
    public readonly currency: string
  ) {
    super(
      `Double-entry imbalance: Total debits (${totalDebit} ${currency}) != Total credits (${totalCredit} ${currency})`
    );
    this.name = 'LedgerImbalanceError';
  }
}

export class ImmutableLedgerViolationError extends LedgerError {
  constructor(action: 'UPDATE' | 'DELETE' | 'TRUNCATE') {
    super(
      `CRITICAL SECURITY VIOLATION: Operation '${action}' is strictly prohibited on immutable financial ledger`
    );
    this.name = 'ImmutableLedgerViolationError';
  }
}

export class HashChainCorruptionError extends LedgerError {
  constructor(
    public readonly entryNumber: number,
    public readonly expectedHash: string,
    public readonly actualHash: string
  ) {
    super(
      `Cryptographic hash chain broken at entry #${entryNumber}. Expected ${expectedHash}, got ${actualHash}`
    );
    this.name = 'HashChainCorruptionError';
  }
}
