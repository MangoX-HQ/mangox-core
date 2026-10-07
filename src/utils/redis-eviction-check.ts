import Redis from 'ioredis';
import { redisConnection } from '../configs/redis';

/**
 * Check and fix Redis eviction policy for BullMQ compatibility
 * BullMQ requires 'noeviction' policy to ensure jobs are not evicted
 */
export async function checkAndFixRedisEvictionPolicy(): Promise<boolean> {
  let client: Redis | null = null;
  
  try {
    // Create temporary connection (spread redisConnection to include db too)
    client = new Redis({
      ...redisConnection,
      password: redisConnection.password || undefined,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });

    await client.connect();

    // Get current eviction policy
    const currentPolicy = await client.config('GET', 'maxmemory-policy');
    // Config returns [key, value] array
    const policyValue = Array.isArray(currentPolicy) ? currentPolicy[1] : null;

    if (policyValue === 'noeviction') {
      console.log('✅ Redis eviction policy is correctly set to "noeviction"');
      return true;
    }

    console.warn(`⚠️  Redis eviction policy is "${policyValue}" but BullMQ requires "noeviction"`);
    console.log('🔄 Attempting to set eviction policy to "noeviction"...');

    try {
      // Try to set policy (requires Redis to have maxmemory set)
      await client.config('SET', 'maxmemory-policy', 'noeviction');
      
      // Verify it was set
      const verifyPolicy = await client.config('GET', 'maxmemory-policy');
      // Config returns [key, value] array
      const newPolicyValue = Array.isArray(verifyPolicy) ? verifyPolicy[1] : null;

      if (newPolicyValue === 'noeviction') {
        console.log('✅ Successfully set Redis eviction policy to "noeviction"');
        console.warn('⚠️  NOTE: This change is temporary. To make it permanent, add to redis.conf:');
        console.warn('      maxmemory-policy noeviction');
        return true;
      } else {
        console.error(`❌ Failed to set eviction policy. Current value: "${newPolicyValue}"`);
        return false;
      }
    } catch (error: any) {
      // If setting fails, it might be because maxmemory is not set
      if (error.message.includes('ERR CONFIG') || error.message.includes('maxmemory')) {
        console.error('❌ Failed to set eviction policy. Error:', error.message);
        console.warn('💡 Solution: Set maxmemory in Redis config first, then set maxmemory-policy');
        console.warn('   Or run manually:');
        console.warn(`   redis-cli -h ${redisConnection.host} -p ${redisConnection.port} CONFIG SET maxmemory-policy noeviction`);
      } else {
        throw error;
      }
      return false;
    }
  } catch (error: any) {
    console.warn('⚠️  Could not check Redis eviction policy:', error.message);
    console.warn('💡 To fix manually, run:');
    console.warn(`   redis-cli -h ${redisConnection.host} -p ${redisConnection.port} CONFIG SET maxmemory-policy noeviction`);
    return false;
  } finally {
    if (client) {
      await client.quit();
    }
  }
}

