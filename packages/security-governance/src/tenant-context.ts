import type { SecurityContext } from '@vme/shared-types';

export class UnauthorizedTenantError extends Error {
  constructor(message: string) {
    super(`SECURITY VIOLATION [Tenant Isolation]: ${message}`);
    this.name = 'UnauthorizedTenantError';
  }
}

export class InsufficientPermissionError extends Error {
  constructor(permission: string, departmentId: string) {
    super(
      `SECURITY VIOLATION [RBAC]: Missing permission '${permission}' in department '${departmentId}'`
    );
    this.name = 'InsufficientPermissionError';
  }
}

export class TenantSecurityManager {
  /**
   * Asserts that the executing context matches the target tenant.
   */
  assertTenantAccess(context: SecurityContext, targetTenantId: string): void {
    if (context.tenantId !== targetTenantId) {
      throw new UnauthorizedTenantError(
        `Cross-tenant access prohibited. Context tenant: ${context.tenantId}, Target tenant: ${targetTenantId}`
      );
    }

    if (Date.now() > context.tokenExpiresAt) {
      throw new UnauthorizedTenantError('Security token has expired');
    }
  }

  /**
   * Asserts that the context possesses the specified permission attribute.
   */
  assertPermission(context: SecurityContext, requiredPermission: string): void {
    if (context.isOwner) {
      return; // Owner holds unrestricted governance authority
    }

    if (!context.permissions.includes(requiredPermission) && !context.permissions.includes('*')) {
      throw new InsufficientPermissionError(requiredPermission, context.departmentId);
    }
  }
}

