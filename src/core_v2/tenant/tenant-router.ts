/**
 * Single-tenant: withTenant is a no-op (just runs fn).
 * Multi-tenant routing/AsyncLocalStorage still lives on the main branch.
 */

export async function withTenant<T>(
  _tenantId: string | undefined,
  run: () => Promise<T>
): Promise<T> {
  return run();
}
