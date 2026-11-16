import {
  RAW_CREDENTIAL_PATTERN,
  DISALLOWED_CREDENTIAL_PROPERTY_NAMES,
  assertNoRawCredentials,
} from '@vme/shared-types';

export class SecretRedactionError extends Error {
  constructor(message: string) {
    super(`SECURITY VIOLATION: ${message}`);
    this.name = 'SecretRedactionError';
  }
}

/**
 * Cycle-safe deep credential inspection and automatic redaction engine.
 * Ensures raw API keys, bearer tokens, passwords, and sensitive property names
 * are stripped or sanitized before entering memory storage.
 */
export class SecretRedactor {
  /**
   * Deeply sanitizes any memory payload by redacting raw secrets.
   * If strictMode is enabled, throws SecretRedactionError when credentials are discovered.
   */
  static sanitize<T>(data: T, strictMode = false): T {
    if (!data || typeof data !== 'object') {
      if (typeof data === 'string' && RAW_CREDENTIAL_PATTERN.test(data)) {
        if (strictMode) {
          throw new SecretRedactionError(
            `Raw credential detected in string payload: storing raw credentials in memory is prohibited.`
          );
        }
        return '[REDACTED_CREDENTIAL]' as unknown as T;
      }
      return data;
    }

    const seen = new WeakSet<object>();

    function deepCloneAndSanitize(value: unknown): unknown {
      if (!value) return value;

      if (typeof value === 'string') {
        if (RAW_CREDENTIAL_PATTERN.test(value)) {
          if (strictMode) {
            throw new SecretRedactionError(
              `Raw credential detected: storing raw credentials in memory is strictly prohibited.`
            );
          }
          return '[REDACTED_CREDENTIAL]';
        }
        return value;
      }

      if (typeof value !== 'object') {
        return value;
      }

      if (seen.has(value)) {
        return '[CIRCULAR_REF]';
      }
      seen.add(value);

      if (Array.isArray(value)) {
        return value.map(deepCloneAndSanitize);
      }

      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) {
        const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (DISALLOWED_CREDENTIAL_PROPERTY_NAMES.has(normalizedKey)) {
          if (strictMode) {
            throw new SecretRedactionError(
              `Disallowed credential property '${key}' detected in memory item.`
            );
          }
          result[key] = '[REDACTED_SENSITIVE_FIELD]';
          continue;
        }

        result[key] = deepCloneAndSanitize(val);
      }

      return result;
    }

    const sanitized = deepCloneAndSanitize(data) as T;

    // Final verification barrier
    if (strictMode) {
      const check = assertNoRawCredentials(sanitized, 'memory_item');
      if (!check.valid) {
        throw new SecretRedactionError(check.errors.join('; '));
      }
    }

    return sanitized;
  }
}
