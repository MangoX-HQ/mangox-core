import { getCoreUnified, ICoreUnified } from "../configs/core";
import { PermissionAdapter } from "../core_v2/compat";
import { AppError } from "../utils/app-error";



class RbacMiddleware {
  private rbacValidator: PermissionAdapter | null = null;
  constructor() {
    // Lazy initialization - don't call getCoreUnified() here as core may not be ready
  }

  getPermissionAdapter() {
    if (!this.rbacValidator) {
      const adapter = getCoreUnified().getAdapter?.('mongodb');
      if (adapter) {
        this.rbacValidator = new PermissionAdapter(adapter);
      }
    }
    return this.rbacValidator;
  }

  async hasAccess(
    entityName: string,
    method: string,
    userRoles: string[]
  ) {

    if (!this.rbacValidator) {
      this.rbacValidator = this.getPermissionAdapter();
    }

    const hasAccess = await this.rbacValidator?.hasAccess(
      entityName,
      method,
      userRoles
    );

    if (!hasAccess) {
      throw new AppError({ statusCode: 403, code: 'FORBIDDEN', message: 'Access denied' });
    }
  }
}

export const rbacMiddleware = new RbacMiddleware();