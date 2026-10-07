/**
 * Test: Core A → REST adapter → Core B
 * Run: npx tsx scripts/test-rest-adapter.ts
 */

import { adapterRegistry, restApiAdapterFactory } from '../src/core_v2';
import { IntermediateQuery } from '../src/core_v2/query/intermediate';

const BASE_URL = 'http://localhost:5556/api/v1';
const API_KEY = 'core-b-secret';

async function main() {
  console.log('\n=== Core A → REST adapter → Core B ===\n');

  // 1. Register + initialize REST adapter
  adapterRegistry.registerFactory(restApiAdapterFactory);

  await adapterRegistry.initializeAdapter({
    type: 'rest',
    baseUrl: BASE_URL,
    auth: { type: 'apikey', token: API_KEY, headerName: 'X-Api-Key' },
  } as any);

  const adapter = adapterRegistry.getAdapter('rest');
  console.log('✓ REST adapter initialized');

  // 2. Health check
  const healthy = await adapter.healthCheck();
  console.log(`✓ Core B health: ${healthy ? 'OK' : 'FAIL'}`);

  // 3. Build IntermediateQuery
  const query: IntermediateQuery = {
    type: 'read',
    collection: 'product',
    securityFilters: [],
    select: { include: ['title', 'price', 'status'] },
    sort: [{ field: 'price', direction: 'asc' }],
    pagination: { limit: 10, offset: 0 },
    metadata: {
      user: { user_id: 'core-a-user', roles: ['admin'] },
      source: 'core-a',
    },
  };

  // 4. Convert to native REST query (via adapter so auth headers are included)
  const native = await adapter.convertQuery(query);

  console.log('\n--- Native REST query ---');
  console.log('URL:', native.url);
  console.log('Params:', native.params);
  console.log('Headers:', native.headers);

  // 5. Execute
  const result = await adapter.executeQuery('product', query, native);

  console.log('\n--- Result ---');
  console.log('Count:', result.count);
  console.log('Data:', JSON.stringify(result.data, null, 2));

  // 6. Test with filter
  const filteredQuery: IntermediateQuery = {
    ...query,
    securityFilters: [{ field: 'status', operator: 'eq', value: 'active' }],
  };
  const filteredNative = await adapter.convertQuery(filteredQuery);
  const filtered = await adapter.executeQuery('product', filteredQuery, filteredNative);
  console.log('\n--- Filtered (status=active) ---');
  console.log('Count:', filtered.count, '| Data:', filtered.data.map(d => d.title));

  await adapter.dispose();
  console.log('\n✓ Done');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
