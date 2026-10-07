import { QueueOptions, WorkerOptions } from 'bullmq';
import { redisConnection, redisQueuePrefix } from '../../../configs/redis';
import { appSettings } from '../../../configs/app-settings';

/**
 * Production-Ready configuration for BullMQ
 * - Retry mechanism with exponential backoff
 * - Dead-letter queue for failed jobs
 * - Job retention policy
 * - Graceful shutdown
 */

// Retry Strategy: Exponential backoff with a max of 5 retries
export const defaultRetryStrategy = {
  attempts: 5,
  backoff: {
    type: 'exponential' as const,
    delay: 2000, // Start at 2s, then increase exponentially
  },
};

// Common Queue Options for all queues
export const baseQueueOptions: QueueOptions = {
  connection: redisConnection,
  prefix: redisQueuePrefix,
  defaultJobOptions: {
    attempts: defaultRetryStrategy.attempts,
    backoff: defaultRetryStrategy.backoff,
    removeOnComplete: {
      age: 3600 * 24, // Keep successful jobs for 24h
      count: 1000, // Or keep the last 1000 jobs
    },
    removeOnFail: false, // Do NOT auto-delete failed jobs - let the DLQ handle them
  },
};

// Worker Options chung
export const baseWorkerOptions: WorkerOptions = {
  connection: redisConnection,
  prefix: redisQueuePrefix,
  // Image compression (sharp) is very CPU-heavy — limit to 2 concurrent jobs so it doesn't eat up all cores
  // (a batch recompress of 1425 images once pushed CPU to ~258%). Single uploads still run smoothly.
  concurrency: 2,
  removeOnComplete: {
    age: 3600 * 24, // 24 hours
    count: 1000,
  },
  removeOnFail: {
    age: 3600 * 24 * 7, // Keep failed jobs for 7 days
    count: 500,
  },
  // Graceful shutdown settings
  lockDuration: 30000, // 30s - max time to process 1 job
  maxStalledCount: 3, // Max number of times a job can stall before failing
  stalledInterval: 5000, // Check stalled jobs every 5s
};

// Dead Letter Queue Options - with a higher retry limit
export const dlqQueueOptions: QueueOptions = {
  connection: redisConnection,
  prefix: redisQueuePrefix,
  defaultJobOptions: {
    attempts: 3, // DLQ has fewer attempts
    backoff: {
      type: 'exponential' as const,
      delay: 10000, // Longer delay: 10s, 20s, 40s
    },
    removeOnComplete: {
      age: 3600 * 24 * 7, // Keep for 7 days
      count: 500,
    },
    removeOnFail: {
      age: 3600 * 24 * 30, // Keep failed jobs for 30 days for investigation
      count: 100,
    },
  },
};

// Worker Options for DLQ - lower concurrency since these jobs have already failed many times
export const dlqWorkerOptions: WorkerOptions = {
  connection: redisConnection,
  prefix: redisQueuePrefix,
  concurrency: 2, // Run slower and more carefully
  removeOnComplete: {
    age: 3600 * 24 * 7,
    count: 500,
  },
  removeOnFail: {
    age: 3600 * 24 * 30,
    count: 100,
  },
  lockDuration: 60000, // 60s - allow more processing time
  maxStalledCount: 1, // Only allow stalling once
  stalledInterval: 10000,
};

// Queue Names - add APP_NAME from ENV to avoid conflicts when sharing Redis
const APP_PREFIX = appSettings.appName || 'APP';

export const QueueNames = {
  CREATE: `${APP_PREFIX}-compress-queue-create`,
  UPDATE: `${APP_PREFIX}-compress-queue-update`,
  DELETE: `${APP_PREFIX}-compress-queue-delete`,
  // Dead Letter Queues
  CREATE_DLQ: `${APP_PREFIX}-compress-queue-create-dlq`,
  UPDATE_DLQ: `${APP_PREFIX}-compress-queue-update-dlq`,
  DELETE_DLQ: `${APP_PREFIX}-compress-queue-delete-dlq`,
} as const;

// Job Priority Levels
export enum JobPriority {
  CRITICAL = 1,
  HIGH = 2,
  NORMAL = 3,
  LOW = 4,
}

// Job Types for better tracking
export enum JobType {
  CREATE = 'CREATE',
  UPDATE = 'UPDATE',
  DELETE = 'DELETE',
  DLQ_RETRY = 'DLQ_RETRY',
}
