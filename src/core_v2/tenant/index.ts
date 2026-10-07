/**
 * core_v2/tenant — Single-tenant: only withTenant (no-op) + context helpers remain,
 * keeping the old signature. Provider DI + SQLite context have been removed from the single-tenant runtime.
 */

export { withTenant } from './tenant-router';

// Re-export context primitives for consistent use from core_v2/tenant
export {
  setSingleTenantDb,
  runWithTenantDb,
  runWithTenantSlug,
  getTenantDb,
  getTenantId,
  getTenantSlug,
  getTenantTeamId,
  getTenantScope,
} from '../adapters/mongodb/tenant-context';
