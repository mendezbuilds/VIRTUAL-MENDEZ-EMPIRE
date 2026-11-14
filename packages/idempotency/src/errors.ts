export class IdempotencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdempotencyError';
  }
}

export class IdempotencyPayloadMismatchError extends IdempotencyError {
  constructor(
    public readonly key: string,
    public readonly expectedHash: string,
    public readonly actualHash: string
  ) {
    super(
      `Idempotency violation: Key '${key}' was already submitted with a different payload. Expected SHA-256 ${expectedHash}, got ${actualHash}`
    );
    this.name = 'IdempotencyPayloadMismatchError';
  }
}

export class IdempotencyConcurrentConflictError extends IdempotencyError {
  constructor(public readonly key: string) {
    super(
      `Idempotency conflict: Key '${key}' is currently in PROCESSING state by a concurrent worker. Please retry with backoff.`
    );
    this.name = 'IdempotencyConcurrentConflictError';
  }
}
